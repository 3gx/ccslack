/**
 * File handling for Slack file uploads.
 * Downloads files to memory, resizes large images, and prepares them for Claude.
 * No disk storage - all processing is done in-memory.
 */

import sharp from 'sharp';

// Constants
const MAX_FILE_SIZE = 30 * 1024 * 1024;           // 30MB per file
const MAX_FILE_COUNT = 20;                         // 20 files per message
const DOWNLOAD_TIMEOUT_MS = 30000;                 // 30 seconds
const MAX_IMAGE_SIZE_BYTES = 3.75 * 1024 * 1024;  // Anthropic limit

/**
 * Slack file object from event payload.
 */
export interface SlackFile {
  id: string;
  name: string | null;
  mimetype?: string;
  filetype?: string;  // Fallback for extension if mimetype missing
  size?: number;
  created?: number;
  url_private_download?: string;
  url_private?: string;  // Fallback if url_private_download is undefined
}

/**
 * Processed file ready for content building.
 */
export interface ProcessedFile {
  index: number;         // 1-based index for user reference ("file 1", "file 2")
  name: string;          // Filename (or fallback: "{id}-unnamed.{ext}")
  mimetype: string;
  size: number;
  buffer: Buffer;        // Raw file content in memory
  base64?: string;       // Base64 encoded (for images)
  isImage: boolean;
  isText: boolean;
  error?: string;        // Error message if processing failed
}

/**
 * Result of processing files with any warnings.
 */
export interface ProcessFilesResult {
  files: ProcessedFile[];
  warnings: string[];    // Warnings about skipped files, etc.
}

/**
 * Check if mimetype is an image type supported by Claude.
 */
export function isImageFile(mimetype: string): boolean {
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimetype);
}

/**
 * Check if mimetype is a text-based file.
 */
export function isTextFile(mimetype: string): boolean {
  if (mimetype.startsWith('text/')) return true;
  const textMimetypes = [
    'application/json',
    'application/javascript',
    'application/typescript',
    'application/xml',
    'application/x-yaml',
    'application/x-sh',
    'application/x-python',
  ];
  return textMimetypes.includes(mimetype);
}

/**
 * Check if filename has a text file extension.
 */
export function isTextFileByExtension(filename: string): boolean {
  const textExtensions = [
    'txt', 'md', 'markdown',
    'json', 'yaml', 'yml',
    'js', 'ts', 'jsx', 'tsx',
    'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
    'html', 'css', 'scss', 'less',
    'xml', 'svg',
    'sh', 'bash', 'zsh',
    'toml', 'ini', 'cfg', 'conf',
    'sql', 'graphql',
    'csv', 'log',
  ];
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext ? textExtensions.includes(ext) : false;
}

/**
 * Check if file is a binary type that cannot be read by Claude.
 */
export function isBinaryFile(mimetype: string): boolean {
  const binaryPrefixes = ['audio/', 'video/'];
  const binaryMimetypes = [
    'application/pdf',
    'application/zip',
    'application/x-tar',
    'application/x-gzip',
    'application/octet-stream',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ];
  return binaryPrefixes.some(p => mimetype.startsWith(p)) || binaryMimetypes.includes(mimetype);
}

/**
 * Get file extension from mimetype or filetype.
 */
function getExtension(mimetype: string, filetype?: string): string {
  // Use filetype if available (Slack provides this)
  if (filetype) return filetype;

  // Fallback to deriving from mimetype
  const mimeToExt: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/css': 'css',
    'text/javascript': 'js',
    'application/json': 'json',
    'application/javascript': 'js',
    'application/typescript': 'ts',
    'application/xml': 'xml',
    'application/x-yaml': 'yaml',
  };
  return mimeToExt[mimetype] || 'bin';
}

/**
 * Generate fallback filename when file.name is null.
 */
function getFallbackName(file: SlackFile): string {
  const ext = getExtension(file.mimetype || 'application/octet-stream', file.filetype);
  return `${file.id}-unnamed.${ext}`;
}

/**
 * Download a file from Slack to memory.
 */
export async function downloadSlackFile(
  file: SlackFile,
  token: string
): Promise<Buffer> {
  const url = file.url_private_download || file.url_private;
  if (!url) {
    throw new Error('No download URL available');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resize an image if it exceeds the Anthropic size limit.
 * Uses sharp to resize while maintaining aspect ratio.
 */
export async function resizeImageIfNeeded(
  buffer: Buffer,
  mimetype: string
): Promise<Buffer> {
  if (buffer.length <= MAX_IMAGE_SIZE_BYTES) {
    return buffer;
  }

  console.log(`[FileHandler] Resizing image: ${(buffer.length / 1024 / 1024).toFixed(2)}MB > ${(MAX_IMAGE_SIZE_BYTES / 1024 / 1024).toFixed(2)}MB limit`);

  // First attempt: resize to 2048x2048 max
  let resized = await sharp(buffer)
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  if (resized.length <= MAX_IMAGE_SIZE_BYTES) {
    console.log(`[FileHandler] Resized to ${(resized.length / 1024 / 1024).toFixed(2)}MB`);
    return resized;
  }

  // Second attempt: resize to 1024x1024 if still too large
  resized = await sharp(buffer)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  console.log(`[FileHandler] Resized (aggressive) to ${(resized.length / 1024 / 1024).toFixed(2)}MB`);
  return resized;
}

/**
 * Process Slack files for Claude consumption.
 * Downloads, resizes images, and prepares content.
 */
export async function processSlackFiles(
  files: SlackFile[],
  token: string
): Promise<ProcessFilesResult> {
  const warnings: string[] = [];
  const processedFiles: ProcessedFile[] = [];

  // Enforce max file count
  let filesToProcess = files;
  if (files.length > MAX_FILE_COUNT) {
    warnings.push(`${files.length - MAX_FILE_COUNT} additional files skipped (max ${MAX_FILE_COUNT})`);
    filesToProcess = files.slice(0, MAX_FILE_COUNT);
  }

  // Sort by created timestamp, using array index as tiebreaker
  const sortedFiles = filesToProcess
    .map((file, originalIndex) => ({ file, originalIndex }))
    .sort((a, b) => {
      const createdA = a.file.created ?? 0;
      const createdB = b.file.created ?? 0;
      if (createdA !== createdB) return createdA - createdB;
      return a.originalIndex - b.originalIndex;
    });

  for (let i = 0; i < sortedFiles.length; i++) {
    const { file } = sortedFiles[i];
    const index = i + 1;  // 1-based index for user reference
    const name = file.name || getFallbackName(file);
    const mimetype = file.mimetype || 'application/octet-stream';
    const isImage = isImageFile(mimetype);
    const isText = isTextFile(mimetype) || isTextFileByExtension(name);
    const isBinary = isBinaryFile(mimetype) && !isText;  // Don't skip if extension says text

    // Skip binary files (PDF, audio, video, etc.)
    if (isBinary) {
      const typeLabel = mimetype.startsWith('audio/') ? 'audio' :
                        mimetype.startsWith('video/') ? 'video' :
                        mimetype === 'application/pdf' ? 'PDF' : 'binary';
      warnings.push(`File ${index} (${name}) skipped - ${typeLabel} files not supported`);
      continue;
    }

    // Check size before download
    if (file.size && file.size > MAX_FILE_SIZE) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      warnings.push(`File ${index} (${name}) too large (${sizeMB}MB, max 30MB)`);
      continue;
    }

    try {
      const originalBuffer = await downloadSlackFile(file, token);
      let buffer = originalBuffer;
      let base64: string | undefined;
      let finalMimetype = mimetype;

      // Process images
      if (isImage) {
        // Resize if needed
        buffer = await resizeImageIfNeeded(buffer, mimetype);
        base64 = buffer.toString('base64');
        // If resized, mimetype becomes JPEG (sharp converts to JPEG)
        if (buffer !== originalBuffer) {
          finalMimetype = 'image/jpeg';
        }
      }

      processedFiles.push({
        index,
        name,
        mimetype: finalMimetype,
        size: buffer.length,
        buffer,
        base64,
        isImage,
        isText,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';

      // Specific error handling
      if (errorMsg.includes('abort')) {
        warnings.push(`File ${index} (${name}) download timed out`);
      } else {
        warnings.push(`File ${index} (${name}) could not be downloaded: ${errorMsg}`);
      }

      // Add placeholder for failed file so numbering is consistent
      processedFiles.push({
        index,
        name,
        mimetype,
        size: 0,
        buffer: Buffer.alloc(0),
        isImage,
        isText,
        error: errorMsg,
      });
    }
  }

  return { files: processedFiles, warnings };
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
