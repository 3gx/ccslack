import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadMarkdownAndPngWithResponse } from '../../streaming.js';
import { createMockSlackClient } from '../__fixtures__/slack-messages.js';

// Mock markdown-png to control PNG generation
vi.mock('../../markdown-png.js', () => ({
  markdownToPng: vi.fn(),
}));

import { markdownToPng } from '../../markdown-png.js';

describe('file upload filetype parameter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('uploadMarkdownAndPngWithResponse', () => {
    it('should set filetype: markdown for .md files in file_uploads array', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ts: '123.456' });
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({ ok: true });

      // No PNG - only markdown file
      vi.mocked(markdownToPng).mockResolvedValue(null);

      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Hello World',
        'Hello World',
        undefined,
        'U123'
      );

      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          file_uploads: expect.arrayContaining([
            expect.objectContaining({
              filename: expect.stringMatching(/\.md$/),
              filetype: 'markdown',
            }),
          ]),
        })
      );
    });

    it('should set filetype: png for .png files in file_uploads array', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ts: '123.456' });
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({ ok: true });

      // Return a mock PNG buffer
      vi.mocked(markdownToPng).mockResolvedValue(Buffer.from('fake-png'));

      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Hello World',
        'Hello World',
        undefined,
        'U123'
      );

      expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          file_uploads: expect.arrayContaining([
            expect.objectContaining({
              filename: expect.stringMatching(/\.png$/),
              filetype: 'png',
            }),
          ]),
        })
      );
    });

    it('should set correct filetypes for both md and png when PNG generation succeeds', async () => {
      const mockClient = createMockSlackClient();
      mockClient.chat.postMessage = vi.fn().mockResolvedValue({ ts: '123.456' });
      mockClient.files.uploadV2 = vi.fn().mockResolvedValue({ ok: true });

      // Return a mock PNG buffer
      vi.mocked(markdownToPng).mockResolvedValue(Buffer.from('fake-png'));

      await uploadMarkdownAndPngWithResponse(
        mockClient as any,
        'C123',
        '# Hello World',
        'Hello World',
        undefined,
        'U123'
      );

      const uploadCall = mockClient.files.uploadV2.mock.calls[0][0] as any;
      expect(uploadCall.file_uploads).toHaveLength(2);

      // First file should be markdown
      expect(uploadCall.file_uploads[0]).toMatchObject({
        filename: expect.stringMatching(/\.md$/),
        filetype: 'markdown',
      });

      // Second file should be PNG
      expect(uploadCall.file_uploads[1]).toMatchObject({
        filename: expect.stringMatching(/\.png$/),
        filetype: 'png',
      });
    });
  });
});
