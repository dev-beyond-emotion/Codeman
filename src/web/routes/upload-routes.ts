/**
 * @fileoverview File upload routes for the file browser.
 * Supports multi-file upload via multipart/form-data with drag-and-drop and picker.
 */

import { FastifyInstance } from 'fastify';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { findSessionOrFail } from '../route-helpers.js';
import type { SessionPort } from '../ports/index.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per file
const MAX_TOTAL_SIZE = 200 * 1024 * 1024; // 200 MB per request

/** Sanitize a filename: strip path components, reject traversal and shell metacharacters. */
function sanitizeFilename(raw: string): string | null {
  // Strip any path components — only keep the basename
  let name = basename(raw);
  // Reject obvious traversal
  if (name === '..' || name === '.' || name.includes('..')) return null;
  // Strip null bytes and control characters
  name = name.replace(/[\x00-\x1f]/g, '');
  // Reject empty after sanitization
  if (!name || name.length > 255) return null;
  return name;
}

interface UploadedFile {
  name: string;
  path: string;
  size: number;
}

interface UploadConflict {
  name: string;
  path: string;
}

interface UploadError {
  name: string;
  error: string;
}

export function registerUploadRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.post('/api/sessions/:id/upload', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { dir, overwrite } = req.query as { dir?: string; overwrite?: string };
    const session = findSessionOrFail(ctx, id);
    const workingDir = session.workingDir;

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected multipart/form-data');
    }

    // Parse multipart boundary
    const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
    if (!boundaryMatch) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing boundary');
    }

    // Resolve and validate target directory
    const targetRelative = dir || '';
    const targetDir = resolve(workingDir, targetRelative);

    // Security: ensure target is within workingDir
    let resolvedTarget: string;
    try {
      await fs.mkdir(targetDir, { recursive: true });
      resolvedTarget = realpathSync(targetDir);
    } catch {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Cannot create target directory');
    }
    const relCheck = relative(workingDir, resolvedTarget);
    if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Target directory must be within working directory');
    }

    // Validate target is actually a directory
    try {
      const stat = await fs.stat(resolvedTarget);
      if (!stat.isDirectory()) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Target path is not a directory');
      }
    } catch {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Target directory not found');
    }

    // Collect raw body with size limit
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req.raw) {
      totalSize += chunk.length;
      if (totalSize > MAX_TOTAL_SIZE) {
        reply.status(413);
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `Request too large (max ${MAX_TOTAL_SIZE / 1024 / 1024}MB)`
        );
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    // Parse multipart parts (same pattern as system-routes.ts screenshot upload)
    const boundary = '--' + boundaryMatch[1];
    const boundaryBuf = Buffer.from(boundary);
    const parts: { headers: string; data: Buffer }[] = [];
    let pos = 0;

    while (pos < body.length) {
      const start = body.indexOf(boundaryBuf, pos);
      if (start === -1) break;
      const afterBoundary = start + boundaryBuf.length;
      if (body[afterBoundary] === 0x2d && body[afterBoundary + 1] === 0x2d) break;
      const headerStart = afterBoundary + 2;
      const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
      if (headerEnd === -1) break;
      const headers = body.subarray(headerStart, headerEnd).toString();
      const dataStart = headerEnd + 4;
      const nextBoundary = body.indexOf(boundaryBuf, dataStart);
      const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2;
      parts.push({ headers, data: body.subarray(dataStart, dataEnd) });
      pos = nextBoundary === -1 ? body.length : nextBoundary;
    }

    // Filter parts with name="files" and a filename
    const fileParts = parts.filter((p) => {
      return p.headers.includes('name="files"') && p.headers.includes('filename=');
    });

    if (fileParts.length === 0) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No files in upload');
    }

    const uploaded: UploadedFile[] = [];
    const conflicts: UploadConflict[] = [];
    const errors: UploadError[] = [];

    for (const part of fileParts) {
      const filenameMatch = part.headers.match(/filename="(.+?)"/);
      if (!filenameMatch) continue;

      const rawName = filenameMatch[1];
      const safeName = sanitizeFilename(rawName);
      if (!safeName) {
        errors.push({ name: rawName, error: 'Invalid filename' });
        continue;
      }

      if (part.data.length > MAX_FILE_SIZE) {
        errors.push({ name: safeName, error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` });
        continue;
      }

      const filePath = join(resolvedTarget, safeName);

      // Final security check: resolved path must still be within workingDir
      const fileRelative = relative(workingDir, filePath);
      if (fileRelative.startsWith('..') || isAbsolute(fileRelative)) {
        errors.push({ name: safeName, error: 'Path traversal rejected' });
        continue;
      }

      // Check for existing file
      try {
        await fs.access(filePath);
        // File exists
        if (overwrite !== 'true') {
          conflicts.push({ name: safeName, path: fileRelative });
          continue;
        }
      } catch {
        // File doesn't exist — good
      }

      try {
        await fs.writeFile(filePath, part.data);
        uploaded.push({ name: safeName, path: fileRelative, size: part.data.length });
      } catch (err) {
        errors.push({ name: safeName, error: getErrorMessage(err) });
      }
    }

    return {
      success: uploaded.length > 0 || (conflicts.length === 0 && errors.length === 0),
      uploaded,
      conflicts,
      errors,
    };
  });
}
