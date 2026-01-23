import { describe, it, expect } from 'vitest';
import { buildMessageContent, ContentBlock } from '../../content-builder.js';
import { ProcessedFile } from '../../file-handler.js';

describe('content-builder', () => {
  describe('buildMessageContent', () => {
    it('returns simple string when no files', () => {
      const result = buildMessageContent('Hello Claude', []);
      expect(result).toBe('Hello Claude');
    });

    it('returns simple string when no files and no warnings', () => {
      const result = buildMessageContent('Test message', [], []);
      expect(result).toBe('Test message');
    });

    it('returns ContentBlock[] when files are present', () => {
      const files: ProcessedFile[] = [{
        index: 1,
        name: 'test.txt',
        mimetype: 'text/plain',
        size: 100,
        buffer: Buffer.from('file content'),
        isImage: false,
        isText: true,
      }];

      const result = buildMessageContent('Analyze this file', files);
      expect(Array.isArray(result)).toBe(true);
    });

    it('includes file list header in first text block', () => {
      const files: ProcessedFile[] = [{
        index: 1,
        name: 'screenshot.png',
        mimetype: 'image/png',
        size: 45000,
        buffer: Buffer.from('image-data'),
        base64: 'aW1hZ2UtZGF0YQ==',
        isImage: true,
        isText: false,
      }];

      const result = buildMessageContent('Describe this image', files) as ContentBlock[];

      expect(result[0].type).toBe('text');
      const textBlock = result[0] as { type: 'text'; text: string };
      expect(textBlock.text).toContain('The user has uploaded the following files:');
      expect(textBlock.text).toContain('File 1: screenshot.png');
      expect(textBlock.text).toContain('image/png');
      expect(textBlock.text).toContain('43.9KB');
    });

    it('includes user message in first text block', () => {
      const files: ProcessedFile[] = [{
        index: 1,
        name: 'test.txt',
        mimetype: 'text/plain',
        size: 100,
        buffer: Buffer.from('content'),
        isImage: false,
        isText: true,
      }];

      const result = buildMessageContent('Please review', files) as ContentBlock[];

      const textBlock = result[0] as { type: 'text'; text: string };
      expect(textBlock.text).toContain('User message:');
      expect(textBlock.text).toContain('Please review');
    });

    it('adds image content blocks for images', () => {
      const files: ProcessedFile[] = [{
        index: 1,
        name: 'photo.jpg',
        mimetype: 'image/jpeg',
        size: 50000,
        buffer: Buffer.from('jpeg-data'),
        base64: 'anBlZy1kYXRh',
        isImage: true,
        isText: false,
      }];

      const result = buildMessageContent('What is in this photo?', files) as ContentBlock[];

      const imageBlock = result.find(b => b.type === 'image');
      expect(imageBlock).toBeDefined();
      expect(imageBlock).toEqual({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: 'anBlZy1kYXRh',
        },
      });
    });

    it('adds text file contents inline', () => {
      const fileContent = 'console.log("hello");';
      const files: ProcessedFile[] = [{
        index: 1,
        name: 'code.js',
        mimetype: 'text/javascript',
        size: fileContent.length,
        buffer: Buffer.from(fileContent),
        isImage: false,
        isText: true,
      }];

      const result = buildMessageContent('Review this code', files) as ContentBlock[];

      const contentBlock = result.find(b =>
        b.type === 'text' && (b as { text: string }).text.includes('Content of File 1')
      );
      expect(contentBlock).toBeDefined();
      const textBlock = contentBlock as { type: 'text'; text: string };
      expect(textBlock.text).toContain('--- Content of File 1: code.js ---');
      expect(textBlock.text).toContain('console.log("hello");');
      expect(textBlock.text).toContain('--- End of File 1 ---');
    });

    it('handles multiple files correctly', () => {
      const files: ProcessedFile[] = [
        {
          index: 1,
          name: 'image1.png',
          mimetype: 'image/png',
          size: 1000,
          buffer: Buffer.from('png1'),
          base64: 'cG5nMQ==',
          isImage: true,
          isText: false,
        },
        {
          index: 2,
          name: 'code.ts',
          mimetype: 'text/typescript',
          size: 50,
          buffer: Buffer.from('const x = 1;'),
          isImage: false,
          isText: true,
        },
        {
          index: 3,
          name: 'image2.jpg',
          mimetype: 'image/jpeg',
          size: 2000,
          buffer: Buffer.from('jpg2'),
          base64: 'anBnMg==',
          isImage: true,
          isText: false,
        },
      ];

      const result = buildMessageContent('Compare these', files) as ContentBlock[];

      // Should have: 1 header text + 2 images + 1 text file content
      expect(result.length).toBe(4);

      // Check header lists all files
      const headerBlock = result[0] as { type: 'text'; text: string };
      expect(headerBlock.text).toContain('File 1: image1.png');
      expect(headerBlock.text).toContain('File 2: code.ts');
      expect(headerBlock.text).toContain('File 3: image2.jpg');

      // Check both images are included
      const imageBlocks = result.filter(b => b.type === 'image');
      expect(imageBlocks).toHaveLength(2);

      // Check text file content is included
      const textContentBlock = result.find(b =>
        b.type === 'text' && (b as { text: string }).text.includes('const x = 1')
      );
      expect(textContentBlock).toBeDefined();
    });

    it('includes warnings in output', () => {
      const files: ProcessedFile[] = [{
        index: 1,
        name: 'test.txt',
        mimetype: 'text/plain',
        size: 100,
        buffer: Buffer.from('content'),
        isImage: false,
        isText: true,
      }];

      const warnings = ['File 2 (large.bin) too large (35MB, max 30MB)'];
      const result = buildMessageContent('Process files', files, warnings) as ContentBlock[];

      const headerBlock = result[0] as { type: 'text'; text: string };
      expect(headerBlock.text).toContain('Note:');
      expect(headerBlock.text).toContain('too large');
    });

    it('skips files with errors', () => {
      const files: ProcessedFile[] = [
        {
          index: 1,
          name: 'good.txt',
          mimetype: 'text/plain',
          size: 100,
          buffer: Buffer.from('good content'),
          isImage: false,
          isText: true,
        },
        {
          index: 2,
          name: 'bad.txt',
          mimetype: 'text/plain',
          size: 0,
          buffer: Buffer.alloc(0),
          isImage: false,
          isText: true,
          error: 'Download failed',
        },
      ];

      const result = buildMessageContent('Check files', files) as ContentBlock[];

      // Header should only list the good file (files without errors)
      const headerBlock = result[0] as { type: 'text'; text: string };
      expect(headerBlock.text).toContain('File 1: good.txt');
      expect(headerBlock.text).not.toContain('File 2: bad.txt');

      // Content should only include the good file
      const contentBlocks = result.filter(b =>
        b.type === 'text' && (b as { text: string }).text.includes('Content of File')
      );
      expect(contentBlocks).toHaveLength(1);
      expect((contentBlocks[0] as { text: string }).text).toContain('good content');
    });

    it('skips images without base64 data', () => {
      const files: ProcessedFile[] = [{
        index: 1,
        name: 'broken.png',
        mimetype: 'image/png',
        size: 1000,
        buffer: Buffer.from('data'),
        // No base64 property
        isImage: true,
        isText: false,
      }];

      const result = buildMessageContent('Show image', files) as ContentBlock[];

      const imageBlocks = result.filter(b => b.type === 'image');
      expect(imageBlocks).toHaveLength(0);
    });

    it('returns ContentBlock[] with only warnings (no files)', () => {
      const warnings = ['3 additional files skipped (max 20)'];
      const result = buildMessageContent('Process', [], warnings) as ContentBlock[];

      expect(Array.isArray(result)).toBe(true);
      const textBlock = result[0] as { type: 'text'; text: string };
      expect(textBlock.text).toContain('Note:');
      expect(textBlock.text).toContain('3 additional files skipped');
    });
  });
});
