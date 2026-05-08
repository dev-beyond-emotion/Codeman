/**
 * @fileoverview File upload functionality for the Codeman file browser.
 * Adds file picker, drag-and-drop, context menu upload, and progress display.
 * Uses the Object.assign mixin pattern (same as api-client.js, ralph-wizard.js).
 */

Object.assign(CodemanApp.prototype, {

  /** Open native file picker and upload selected files. */
  openFileUploadPicker(targetDir) {
    if (!this.activeSessionId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      if (input.files && input.files.length > 0) {
        this.uploadFiles(input.files, targetDir || '');
      }
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  },

  /** Upload files to the session working directory. */
  async uploadFiles(files, targetDir) {
    if (!this.activeSessionId || !files || files.length === 0) return;

    const statusEl = document.getElementById('fileBrowserStatus');
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file, file.name);
    }

    let url = '/api/sessions/' + this.activeSessionId + '/upload';
    const params = [];
    if (targetDir) params.push('dir=' + encodeURIComponent(targetDir));
    if (this._uploadOverwrite) {
      params.push('overwrite=true');
      this._uploadOverwrite = false;
    }
    if (params.length) url += '?' + params.join('&');

    // Show progress bar
    if (statusEl) {
      statusEl.innerHTML =
        '<div class="upload-progress"><div class="upload-progress-bar" id="uploadProgressBar"></div></div>' +
        '<span id="uploadProgressText">Uploading...</span>';
    }

    const self = this;
    return new Promise(function(resolve) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);

      // Add auth header if present
      const token = sessionStorage.getItem('codeman_auth_token') || localStorage.getItem('codeman_auth_token');
      if (token) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      }

      xhr.upload.addEventListener('progress', function(e) {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          const bar = document.getElementById('uploadProgressBar');
          const text = document.getElementById('uploadProgressText');
          if (bar) bar.style.width = pct + '%';
          if (text) text.textContent = 'Uploading... ' + pct + '%';
        }
      });

      xhr.addEventListener('load', function() {
        var result;
        try {
          result = JSON.parse(xhr.responseText);
        } catch (ex) {
          if (statusEl) statusEl.textContent = 'Upload failed: invalid response';
          resolve(null);
          return;
        }

        if (result.conflicts && result.conflicts.length > 0) {
          var names = result.conflicts.map(function(c) { return c.name; }).join(', ');
          var msg = names + ' already exist. Overwrite?';
          if (confirm(msg)) {
            self._uploadOverwrite = true;
            self.uploadFiles(files, targetDir).then(resolve);
            return;
          }
        }

        var uploadedCount = result.uploaded ? result.uploaded.length : 0;
        var errorCount = result.errors ? result.errors.length : 0;
        var conflictCount = result.conflicts ? result.conflicts.length : 0;
        var statusMsg = uploadedCount + ' file' + (uploadedCount !== 1 ? 's' : '') + ' uploaded';
        if (errorCount > 0) statusMsg += ', ' + errorCount + ' error' + (errorCount !== 1 ? 's' : '');
        if (conflictCount > 0) statusMsg += ', ' + conflictCount + ' skipped';
        if (statusEl) statusEl.textContent = statusMsg;

        // Refresh file tree
        if (uploadedCount > 0) {
          self.loadFileBrowser(self.activeSessionId);
        }

        // Clear status after a few seconds
        setTimeout(function() {
          if (statusEl && statusEl.textContent === statusMsg) {
            statusEl.textContent = '';
          }
        }, 4000);

        resolve(result);
      });

      xhr.addEventListener('error', function() {
        if (statusEl) statusEl.textContent = 'Upload failed: network error';
        resolve(null);
      });

      xhr.send(formData);
    });
  },

  /** Initialize drag-and-drop on the file browser panel. */
  setupFileBrowserDropZone() {
    var panel = document.getElementById('fileBrowserPanel');
    if (!panel) return;
    var self = this;
    var dragDepth = 0;

    panel.addEventListener('dragenter', function(e) {
      e.preventDefault();
      dragDepth++;
      if (dragDepth === 1) {
        panel.classList.add('file-drop-active');
      }
    });

    panel.addEventListener('dragleave', function(e) {
      e.preventDefault();
      dragDepth--;
      if (dragDepth <= 0) {
        dragDepth = 0;
        panel.classList.remove('file-drop-active');
      }
    });

    panel.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    panel.addEventListener('drop', function(e) {
      e.preventDefault();
      dragDepth = 0;
      panel.classList.remove('file-drop-active');

      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

      // Determine target directory from drop target
      var targetDir = '';
      var dirItem = e.target.closest && e.target.closest('.file-tree-item[data-type="directory"]');
      if (dirItem) {
        targetDir = dirItem.dataset.path || '';
      }

      self.uploadFiles(e.dataTransfer.files, targetDir);
    });
  },

  /** Show context menu on right-click for files and directories. */
  showFileTreeContextMenu(e, path, type) {
    e.preventDefault();
    this.closeFileTreeContextMenu();

    var menu = document.createElement('div');
    menu.className = 'file-tree-context-menu';
    menu.id = 'fileTreeContextMenu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    var self = this;

    if (type === 'file') {
      var dlItem = document.createElement('div');
      dlItem.className = 'context-menu-item';
      dlItem.textContent = 'Download';
      dlItem.addEventListener('click', function() {
        self.closeFileTreeContextMenu();
        self.downloadBrowserFile(path);
      });
      menu.appendChild(dlItem);
    }

    if (type === 'directory') {
      var uploadItem = document.createElement('div');
      uploadItem.className = 'context-menu-item';
      uploadItem.textContent = 'Upload here...';
      uploadItem.addEventListener('click', function() {
        self.closeFileTreeContextMenu();
        self.openFileUploadPicker(path);
      });
      menu.appendChild(uploadItem);
    }

    if (menu.children.length === 0) return;

    document.body.appendChild(menu);

    // Close on click outside
    var closeHandler = function(ev) {
      if (!menu.contains(ev.target)) {
        self.closeFileTreeContextMenu();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(function() { document.addEventListener('click', closeHandler, true); }, 0);
  },

  /** Remove the context menu from the DOM. */
  closeFileTreeContextMenu() {
    var existing = document.getElementById('fileTreeContextMenu');
    if (existing) existing.remove();
  },
});
