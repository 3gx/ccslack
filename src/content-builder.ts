/**
 * Content builder for Claude messages with file attachments.
 * Builds content blocks compatible with Claude's multi-modal API.
 */

import { ProcessedFile, formatFileSize } from './file-handler.js';

/**
 * Content block types for Claude messages.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Format the file list header for Claude.
 * Example:
 * "The user has uploaded the following files:
 *  File 1: screenshot.png (image/png, 45KB)
 *  File 2: code.ts (text/plain, 2KB)"
 */
function formatFilesHeader(files: ProcessedFile[]): string {
  const validFiles = files.filter(f => !f.error);
  if (validFiles.length === 0) return '';

  const lines = ['The user has uploaded the following files:'];
  for (const file of validFiles) {
    const sizeStr = formatFileSize(file.size);
    lines.push(`File ${file.index}: ${file.name} (${file.mimetype}, ${sizeStr})`);
  }
  return lines.join('\n');
}

/**
 * Build Claude-compatible content blocks from user text and processed files.
 *
 * Returns:
 * - Simple string if no files (for backwards compatibility)
 * - ContentBlock[] if files are present (for multi-modal support)
 */
export function buildMessageContent(
  userText: string,
  processedFiles: ProcessedFile[],
  warnings: string[] = []
): string | ContentBlock[] {
  // No files - return simple string
  if (processedFiles.length === 0 && warnings.length === 0) {
    return userText;
  }

  const blocks: ContentBlock[] = [];

  // Build the text content with file list header
  const textParts: string[] = [];

  // Add file list header
  const header = formatFilesHeader(processedFiles);
  if (header) {
    textParts.push(header);
  }

  // Add warnings about skipped/failed files
  if (warnings.length > 0) {
    textParts.push('');
    textParts.push('Note: ' + warnings.join('. '));
  }

  // Add user message
  textParts.push('');
  textParts.push('User message:');
  textParts.push(userText);

  blocks.push({
    type: 'text',
    text: textParts.join('\n'),
  });

  // Add image content blocks (Claude vision)
  for (const file of processedFiles) {
    if (file.isImage && file.base64 && !file.error) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimetype,
          data: file.base64,
        },
      });
    }
  }

  // Add text file contents inline
  for (const file of processedFiles) {
    if (file.isText && !file.error) {
      try {
        const textContent = file.buffer.toString('utf-8');
        blocks.push({
          type: 'text',
          text: `\n--- Content of File ${file.index}: ${file.name} ---\n${textContent}\n--- End of File ${file.index} ---`,
        });
      } catch {
        // If buffer can't be decoded as UTF-8, skip it
        console.log(`[ContentBuilder] Could not decode ${file.name} as UTF-8, skipping`);
      }
    }
  }

  return blocks;
}
