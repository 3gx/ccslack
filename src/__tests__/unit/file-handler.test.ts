import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isImageFile,
  isTextFile,
  isTextFileByExtension,
  isBinaryFile,
  formatFileSize,
  processSlackFiles,
  downloadSlackFile,
  SlackFile,
} from '../../file-handler.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock sharp
vi.mock('sharp', () => {
  return {
    default: vi.fn(() => ({
      resize: vi.fn().mockReturnThis(),
      jpeg: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-image')),
    })),
  };
});

describe('file-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isImageFile', () => {
    it('returns true for supported image mimetypes', () => {
      expect(isImageFile('image/jpeg')).toBe(true);
      expect(isImageFile('image/png')).toBe(true);
      expect(isImageFile('image/gif')).toBe(true);
      expect(isImageFile('image/webp')).toBe(true);
    });

    it('returns false for non-image mimetypes', () => {
      expect(isImageFile('text/plain')).toBe(false);
      expect(isImageFile('application/pdf')).toBe(false);
      expect(isImageFile('image/svg+xml')).toBe(false); // SVG not supported
    });
  });

  describe('isTextFile', () => {
    it('returns true for text mimetypes', () => {
      expect(isTextFile('text/plain')).toBe(true);
      expect(isTextFile('text/html')).toBe(true);
      expect(isTextFile('text/css')).toBe(true);
      expect(isTextFile('text/javascript')).toBe(true);
    });

    it('returns true for application types that are text-based', () => {
      expect(isTextFile('application/json')).toBe(true);
      expect(isTextFile('application/javascript')).toBe(true);
      expect(isTextFile('application/typescript')).toBe(true);
      expect(isTextFile('application/xml')).toBe(true);
      expect(isTextFile('application/x-yaml')).toBe(true);
    });

    it('returns false for binary types', () => {
      expect(isTextFile('application/pdf')).toBe(false);
      expect(isTextFile('image/png')).toBe(false);
      expect(isTextFile('application/octet-stream')).toBe(false);
    });
  });

  describe('isTextFileByExtension', () => {
    it('returns true for .md files', () => {
      expect(isTextFileByExtension('readme.md')).toBe(true);
      expect(isTextFileByExtension('NOTES.MD')).toBe(true);
    });

    it('returns true for .txt files', () => {
      expect(isTextFileByExtension('file.txt')).toBe(true);
      expect(isTextFileByExtension('FILE.TXT')).toBe(true);
    });

    it('returns true for code files', () => {
      expect(isTextFileByExtension('script.js')).toBe(true);
      expect(isTextFileByExtension('app.ts')).toBe(true);
      expect(isTextFileByExtension('main.py')).toBe(true);
      expect(isTextFileByExtension('config.json')).toBe(true);
      expect(isTextFileByExtension('style.css')).toBe(true);
    });

    it('returns false for binary extensions', () => {
      expect(isTextFileByExtension('image.png')).toBe(false);
      expect(isTextFileByExtension('doc.pdf')).toBe(false);
      expect(isTextFileByExtension('archive.zip')).toBe(false);
      expect(isTextFileByExtension('video.mp4')).toBe(false);
    });

    it('returns false for files without extension', () => {
      expect(isTextFileByExtension('Makefile')).toBe(false);
      expect(isTextFileByExtension('noextension')).toBe(false);
    });
  });

  describe('isBinaryFile', () => {
    it('returns true for audio files', () => {
      expect(isBinaryFile('audio/mp3')).toBe(true);
      expect(isBinaryFile('audio/wav')).toBe(true);
      expect(isBinaryFile('audio/ogg')).toBe(true);
    });

    it('returns true for video files', () => {
      expect(isBinaryFile('video/mp4')).toBe(true);
      expect(isBinaryFile('video/webm')).toBe(true);
    });

    it('returns true for PDFs', () => {
      expect(isBinaryFile('application/pdf')).toBe(true);
    });

    it('returns true for archive files', () => {
      expect(isBinaryFile('application/zip')).toBe(true);
      expect(isBinaryFile('application/x-tar')).toBe(true);
      expect(isBinaryFile('application/x-gzip')).toBe(true);
    });

    it('returns true for Office documents', () => {
      expect(isBinaryFile('application/msword')).toBe(true);
      expect(isBinaryFile('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
      expect(isBinaryFile('application/vnd.ms-excel')).toBe(true);
    });

    it('returns false for text files', () => {
      expect(isBinaryFile('text/plain')).toBe(false);
      expect(isBinaryFile('application/json')).toBe(false);
    });
  });

  describe('formatFileSize', () => {
    it('formats bytes', () => {
      expect(formatFileSize(0)).toBe('0B');
      expect(formatFileSize(512)).toBe('512B');
      expect(formatFileSize(1023)).toBe('1023B');
    });

    it('formats kilobytes', () => {
      expect(formatFileSize(1024)).toBe('1.0KB');
      expect(formatFileSize(1536)).toBe('1.5KB');
      expect(formatFileSize(102400)).toBe('100.0KB');
    });

    it('formats megabytes', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.0MB');
      expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0MB');
      expect(formatFileSize(10.5 * 1024 * 1024)).toBe('10.5MB');
    });
  });

  describe('downloadSlackFile', () => {
    it('downloads file with authorization header', async () => {
      const mockBuffer = Buffer.from('file content');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockBuffer.buffer.slice(mockBuffer.byteOffset, mockBuffer.byteOffset + mockBuffer.byteLength)),
      });

      const file: SlackFile = {
        id: 'F123',
        name: 'test.txt',
        url_private_download: 'https://files.slack.com/test.txt',
      };

      const result = await downloadSlackFile(file, 'xoxb-token');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://files.slack.com/test.txt',
        expect.objectContaining({
          headers: { 'Authorization': 'Bearer xoxb-token' },
        })
      );
      expect(result).toBeInstanceOf(Buffer);
    });

    it('uses url_private as fallback when url_private_download is undefined', async () => {
      const mockBuffer = Buffer.from('file content');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockBuffer.buffer.slice(mockBuffer.byteOffset, mockBuffer.byteOffset + mockBuffer.byteLength)),
      });

      const file: SlackFile = {
        id: 'F123',
        name: 'test.txt',
        url_private: 'https://files.slack.com/fallback.txt',
      };

      await downloadSlackFile(file, 'xoxb-token');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://files.slack.com/fallback.txt',
        expect.any(Object)
      );
    });

    it('throws error when no URL is available', async () => {
      const file: SlackFile = {
        id: 'F123',
        name: 'test.txt',
      };

      await expect(downloadSlackFile(file, 'xoxb-token')).rejects.toThrow('No download URL available');
    });

    it('throws error on HTTP failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      const file: SlackFile = {
        id: 'F123',
        name: 'test.txt',
        url_private_download: 'https://files.slack.com/test.txt',
      };

      await expect(downloadSlackFile(file, 'xoxb-token')).rejects.toThrow('HTTP 403: Forbidden');
    });
  });

  describe('processSlackFiles', () => {
    it('processes text files correctly', async () => {
      const textContent = 'Hello, world!';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(textContent).buffer),
      });

      const files: SlackFile[] = [{
        id: 'F123',
        name: 'hello.txt',
        mimetype: 'text/plain',
        size: textContent.length,
        created: 1000,
        url_private_download: 'https://files.slack.com/hello.txt',
      }];

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('hello.txt');
      expect(result.files[0].isText).toBe(true);
      expect(result.files[0].isImage).toBe(false);
      expect(result.files[0].buffer.toString()).toBe(textContent);
      expect(result.warnings).toHaveLength(0);
    });

    it('processes image files with base64 encoding', async () => {
      const imageData = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG header
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
      });

      const files: SlackFile[] = [{
        id: 'F123',
        name: 'image.png',
        mimetype: 'image/png',
        size: imageData.length,
        created: 1000,
        url_private_download: 'https://files.slack.com/image.png',
      }];

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files).toHaveLength(1);
      expect(result.files[0].isImage).toBe(true);
      expect(result.files[0].base64).toBeDefined();
    });

    it('skips binary files with warning', async () => {
      const files: SlackFile[] = [{
        id: 'F123',
        name: 'document.pdf',
        mimetype: 'application/pdf',
        size: 1000,
        created: 1000,
        url_private_download: 'https://files.slack.com/document.pdf',
      }];

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('PDF');
      expect(result.warnings[0]).toContain('not supported');
    });

    it('skips files over 30MB with warning', async () => {
      const files: SlackFile[] = [{
        id: 'F123',
        name: 'large.txt',
        mimetype: 'text/plain',
        size: 35 * 1024 * 1024, // 35MB
        created: 1000,
        url_private_download: 'https://files.slack.com/large.txt',
      }];

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('too large');
      expect(result.warnings[0]).toContain('max 30MB');
    });

    it('limits to 20 files with warning', async () => {
      const files: SlackFile[] = Array.from({ length: 25 }, (_, i) => ({
        id: `F${i}`,
        name: `file${i}.txt`,
        mimetype: 'text/plain',
        size: 10,
        created: 1000 + i,
        url_private_download: `https://files.slack.com/file${i}.txt`,
      }));

      // Mock fetch for each of the 20 files that will be processed
      for (let i = 0; i < 20; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new TextEncoder().encode(`content ${i}`).buffer),
        });
      }

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files).toHaveLength(20);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('5 additional files skipped');
      expect(result.warnings[0]).toContain('max 20');
    });

    it('sorts files by created timestamp', async () => {
      const files: SlackFile[] = [
        { id: 'F3', name: 'third.txt', mimetype: 'text/plain', size: 5, created: 3000, url_private_download: 'https://example.com/3' },
        { id: 'F1', name: 'first.txt', mimetype: 'text/plain', size: 5, created: 1000, url_private_download: 'https://example.com/1' },
        { id: 'F2', name: 'second.txt', mimetype: 'text/plain', size: 5, created: 2000, url_private_download: 'https://example.com/2' },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('content').buffer),
      });

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files[0].name).toBe('first.txt');
      expect(result.files[1].name).toBe('second.txt');
      expect(result.files[2].name).toBe('third.txt');
    });

    it('uses array index as tiebreaker for same timestamp', async () => {
      const files: SlackFile[] = [
        { id: 'FA', name: 'a.txt', mimetype: 'text/plain', size: 5, created: 1000, url_private_download: 'https://example.com/a' },
        { id: 'FB', name: 'b.txt', mimetype: 'text/plain', size: 5, created: 1000, url_private_download: 'https://example.com/b' },
        { id: 'FC', name: 'c.txt', mimetype: 'text/plain', size: 5, created: 1000, url_private_download: 'https://example.com/c' },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('content').buffer),
      });

      const result = await processSlackFiles(files, 'xoxb-token');

      // Should maintain original order when timestamps are equal
      expect(result.files[0].name).toBe('a.txt');
      expect(result.files[1].name).toBe('b.txt');
      expect(result.files[2].name).toBe('c.txt');
    });

    it('assigns 1-based indices correctly', async () => {
      const files: SlackFile[] = [
        { id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 5, created: 1000, url_private_download: 'https://example.com/a' },
        { id: 'F2', name: 'b.txt', mimetype: 'text/plain', size: 5, created: 2000, url_private_download: 'https://example.com/b' },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('content').buffer),
      });

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files[0].index).toBe(1);
      expect(result.files[1].index).toBe(2);
    });

    it('generates fallback name when file.name is null', async () => {
      const files: SlackFile[] = [{
        id: 'F123ABC',
        name: null,
        mimetype: 'text/plain',
        filetype: 'txt',
        size: 10,
        created: 1000,
        url_private_download: 'https://files.slack.com/file',
      }];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('content').buffer),
      });

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files[0].name).toBe('F123ABC-unnamed.txt');
    });

    it('handles download errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const files: SlackFile[] = [{
        id: 'F123',
        name: 'test.txt',
        mimetype: 'text/plain',
        size: 10,
        created: 1000,
        url_private_download: 'https://files.slack.com/test.txt',
      }];

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files).toHaveLength(1);
      expect(result.files[0].error).toBe('Network error');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('could not be downloaded');
    });

    it('processes .md files with application/octet-stream mimetype', async () => {
      const mdContent = '# Hello\n\nThis is markdown';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(mdContent).buffer),
      });

      const files: SlackFile[] = [{
        id: 'F123',
        name: 'readme.md',
        mimetype: 'application/octet-stream',
        size: mdContent.length,
        created: 1000,
        url_private_download: 'https://files.slack.com/readme.md',
      }];

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files).toHaveLength(1);
      expect(result.files[0].isText).toBe(true);
      expect(result.files[0].buffer.toString()).toBe(mdContent);
      expect(result.warnings).toHaveLength(0);  // Not skipped as binary
    });

    it('processes .txt files with application/octet-stream mimetype', async () => {
      const txtContent = 'Plain text content';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(txtContent).buffer),
      });

      const files: SlackFile[] = [{
        id: 'F456',
        name: 'notes.txt',
        mimetype: 'application/octet-stream',
        size: txtContent.length,
        created: 1000,
        url_private_download: 'https://files.slack.com/notes.txt',
      }];

      const result = await processSlackFiles(files, 'xoxb-token');

      expect(result.files).toHaveLength(1);
      expect(result.files[0].isText).toBe(true);
      expect(result.files[0].buffer.toString()).toBe(txtContent);
      expect(result.warnings).toHaveLength(0);
    });
  });
});
