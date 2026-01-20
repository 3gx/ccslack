import { describe, it, expect } from 'vitest';
import { markdownToPng } from '../../markdown-png.js';

describe('markdownToPng (Puppeteer)', () => {
  describe('basic rendering', () => {
    it('should render simple markdown to PNG buffer', async () => {
      const png = await markdownToPng('# Hello\n\nWorld');
      expect(png).toBeInstanceOf(Buffer);
      expect(png!.length).toBeGreaterThan(0);
    }, 15000);

    it('should render code blocks with syntax highlighting', async () => {
      const png = await markdownToPng('```javascript\nconst x = 1;\n```');
      expect(png).toBeInstanceOf(Buffer);
    }, 15000);

    it('should render tables', async () => {
      const png = await markdownToPng('| A | B |\n|---|---|\n| 1 | 2 |');
      expect(png).toBeInstanceOf(Buffer);
    }, 15000);

    it('should handle RTL text (Arabic)', async () => {
      const png = await markdownToPng('مرحبا بالعالم');
      expect(png).toBeInstanceOf(Buffer); // Puppeteer handles this!
    }, 15000);

    it('should handle complex emoji', async () => {
      const png = await markdownToPng('Family emoji');
      expect(png).toBeInstanceOf(Buffer);
    }, 15000);

    it('should handle multiple markdown elements', async () => {
      const markdown = `# Heading 1

## Heading 2

Here's a **bold** and *italic* text.

- List item 1
- List item 2

> A blockquote

\`\`\`typescript
const hello = "world";
console.log(hello);
\`\`\`
`;
      const png = await markdownToPng(markdown);
      expect(png).toBeInstanceOf(Buffer);
      expect(png!.length).toBeGreaterThan(1000); // Should be a decent size
    }, 15000);
  });

  describe('custom width', () => {
    it('should render with custom width', async () => {
      const png = await markdownToPng('# Hello', 1200);
      expect(png).toBeInstanceOf(Buffer);
    }, 15000);
  });

  describe('error handling', () => {
    it('should return null on empty input', async () => {
      expect(await markdownToPng('')).toBeNull();
    });

    it('should return null on whitespace-only input', async () => {
      expect(await markdownToPng('   \n  \t  ')).toBeNull();
    });

    it('should return null on null input', async () => {
      expect(await markdownToPng(null as any)).toBeNull();
    });

    it('should return null on undefined input', async () => {
      expect(await markdownToPng(undefined as any)).toBeNull();
    });
  });
});
