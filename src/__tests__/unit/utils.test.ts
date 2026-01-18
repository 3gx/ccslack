import { describe, it, expect } from 'vitest';
import { formatTimeRemaining, markdownToSlack, normalizeTable } from '../../utils.js';

describe('utils', () => {
  describe('formatTimeRemaining', () => {
    it('should return "0 mins" for zero or negative values', () => {
      expect(formatTimeRemaining(0)).toBe('0 mins');
      expect(formatTimeRemaining(-1000)).toBe('0 mins');
    });

    it('should format minutes only', () => {
      expect(formatTimeRemaining(1 * 60 * 1000)).toBe('1 min');
      expect(formatTimeRemaining(30 * 60 * 1000)).toBe('30 mins');
    });

    it('should format hours only', () => {
      expect(formatTimeRemaining(1 * 60 * 60 * 1000)).toBe('1 hour');
      expect(formatTimeRemaining(3 * 60 * 60 * 1000)).toBe('3 hours');
    });

    it('should format days only', () => {
      expect(formatTimeRemaining(1 * 24 * 60 * 60 * 1000)).toBe('1 day');
      expect(formatTimeRemaining(5 * 24 * 60 * 60 * 1000)).toBe('5 days');
    });

    it('should format hours and minutes', () => {
      const twoHoursThirtyMins = 2 * 60 * 60 * 1000 + 30 * 60 * 1000;
      expect(formatTimeRemaining(twoHoursThirtyMins)).toBe('2 hours 30 mins');
    });

    it('should format days and hours', () => {
      const threeDaysFourHours = 3 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000;
      expect(formatTimeRemaining(threeDaysFourHours)).toBe('3 days 4 hours');
    });

    it('should format days, hours, and minutes', () => {
      const sixDaysTwentyHours = 6 * 24 * 60 * 60 * 1000 + 20 * 60 * 60 * 1000;
      expect(formatTimeRemaining(sixDaysTwentyHours)).toBe('6 days 20 hours');

      const fullExample = 2 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000 + 15 * 60 * 1000;
      expect(formatTimeRemaining(fullExample)).toBe('2 days 5 hours 15 mins');
    });

    it('should handle singular vs plural correctly', () => {
      const oneOfEach = 1 * 24 * 60 * 60 * 1000 + 1 * 60 * 60 * 1000 + 1 * 60 * 1000;
      expect(formatTimeRemaining(oneOfEach)).toBe('1 day 1 hour 1 min');
    });

    it('should skip zero components', () => {
      // 2 days exactly (no hours, no mins)
      expect(formatTimeRemaining(2 * 24 * 60 * 60 * 1000)).toBe('2 days');

      // 1 day and 30 mins (no hours)
      const oneDayThirtyMins = 1 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000;
      expect(formatTimeRemaining(oneDayThirtyMins)).toBe('1 day 30 mins');
    });

    it('should handle typical reminder scenarios (4-hour intervals over 7 days)', () => {
      // First reminder (after 4 hours, 6 days 20 hours remaining)
      const sixDaysTwentyHours = 6 * 24 * 60 * 60 * 1000 + 20 * 60 * 60 * 1000;
      expect(formatTimeRemaining(sixDaysTwentyHours)).toBe('6 days 20 hours');

      // Last reminder (4 hours remaining)
      expect(formatTimeRemaining(4 * 60 * 60 * 1000)).toBe('4 hours');
    });
  });

  describe('markdownToSlack', () => {
    it('should convert bold **text** to *text*', () => {
      expect(markdownToSlack('**bold text**')).toBe('*bold text*');
      expect(markdownToSlack('This is **bold** here')).toBe('This is *bold* here');
    });

    it('should convert italic *text* to _text_', () => {
      expect(markdownToSlack('*italic text*')).toBe('_italic text_');
      expect(markdownToSlack('This is *italic* here')).toBe('This is _italic_ here');
    });

    it('should handle both bold and italic', () => {
      expect(markdownToSlack('**bold** and *italic*')).toBe('*bold* and _italic_');
    });

    it('should convert strikethrough ~~text~~ to ~text~', () => {
      expect(markdownToSlack('~~strikethrough~~')).toBe('~strikethrough~');
    });

    it('should convert markdown links to Slack format', () => {
      expect(markdownToSlack('[Click here](https://example.com)')).toBe('<https://example.com|Click here>');
    });

    it('should convert headers to bold', () => {
      expect(markdownToSlack('# Header 1')).toBe('*Header 1*');
      expect(markdownToSlack('## Header 2')).toBe('*Header 2*');
      expect(markdownToSlack('### Header 3')).toBe('*Header 3*');
    });

    it('should preserve inline code', () => {
      expect(markdownToSlack('Use `**code**` here')).toBe('Use `**code**` here');
    });

    it('should preserve code blocks', () => {
      const input = '```\n**not bold**\n```';
      expect(markdownToSlack(input)).toBe('```\n**not bold**\n```');
    });

    it('should handle complex mixed content', () => {
      const input = '**Mainstream languages:** Python, JavaScript, *TypeScript*';
      const expected = '*Mainstream languages:* Python, JavaScript, _TypeScript_';
      expect(markdownToSlack(input)).toBe(expected);
    });

    it('should handle multiline content with headers and lists', () => {
      const input = `# Languages
**Mainstream:** Python, Go
- *Python* is great
- **JavaScript** too`;
      const expected = `*Languages*
*Mainstream:* Python, Go
- _Python_ is great
- *JavaScript* too`;
      expect(markdownToSlack(input)).toBe(expected);
    });

    it('should convert markdown tables to code blocks with normalized formatting', () => {
      const input = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;
      const result = markdownToSlack(input);
      expect(result).toContain('```');
      expect(result).toContain('Header 1');
      expect(result).toContain('Header 2');
      expect(result).toContain('Cell 1');
      expect(result).toContain('Cell 2');
    });

    it('should convert tables with surrounding text', () => {
      const input = `Here is a table:

| Name | Value |
|------|-------|
| foo  | 123   |

And some text after.`;
      const result = markdownToSlack(input);
      expect(result).toContain('Here is a table:');
      expect(result).toContain('And some text after.');
      expect(result).toContain('```');
      expect(result).toContain('Name');
      expect(result).toContain('Value');
    });

    it('should not convert pipe characters outside of tables', () => {
      const input = 'Use cmd | grep to filter';
      expect(markdownToSlack(input)).toBe('Use cmd | grep to filter');
    });

    it('should strip formatting from cells in tables', () => {
      const input = `| Issue | Severity |
|-------|----------|
| **Bug** | High |`;
      const result = markdownToSlack(input);
      // Formatting markers should be stripped
      expect(result).not.toContain('**');
      expect(result).toContain('Bug');
      expect(result).toContain('High');
      expect(result).toContain('```');
    });

    it('should convert horizontal rules (---) to unicode line', () => {
      expect(markdownToSlack('---')).toBe('────────────────────────────');
      expect(markdownToSlack('Text\n---\nMore text')).toBe('Text\n────────────────────────────\nMore text');
    });

    it('should convert horizontal rules (***) to unicode line', () => {
      expect(markdownToSlack('***')).toBe('────────────────────────────');
    });

    it('should convert horizontal rules (___) to unicode line', () => {
      expect(markdownToSlack('___')).toBe('────────────────────────────');
    });

    it('should handle horizontal rules with extra dashes', () => {
      expect(markdownToSlack('-----')).toBe('────────────────────────────');
      expect(markdownToSlack('----------')).toBe('────────────────────────────');
    });

    it('should not convert separator rows in tables as horizontal rules', () => {
      const input = `| Col1 | Col2 |
|------|------|
| A    | B    |`;
      // The table separator should NOT become a horizontal rule
      const result = markdownToSlack(input);
      expect(result).toContain('Col1');
      expect(result).toContain('Col2');
      expect(result).not.toContain('────────────────────────────');
    });

    it('should handle complex document with tables, rules, and formatting', () => {
      const input = `# Report

Here are the findings:

| Issue | Severity |
|-------|----------|
| Bug A | High     |
| Bug B | Medium   |

---

## Summary

**Total issues:** 2`;
      const result = markdownToSlack(input);

      // Should have header converted to bold
      expect(result).toContain('*Report*');
      expect(result).toContain('*Summary*');

      // Should have table in code block with content
      expect(result).toContain('```');
      expect(result).toContain('Issue');
      expect(result).toContain('Severity');
      expect(result).toContain('Bug A');
      expect(result).toContain('Bug B');

      // Should have horizontal rule converted
      expect(result).toContain('────────────────────────────');

      // Should have bold converted
      expect(result).toContain('*Total issues:* 2');
    });
  });

  describe('normalizeTable', () => {
    it('renders with UTF-8 box characters', () => {
      const input = '| A | B |\n|---|---|\n| 1 | 2 |';
      const result = normalizeTable(input);
      expect(result).toContain('┌');  // Top-left corner
      expect(result).toContain('│');  // Vertical border
      expect(result).toContain('─');  // Horizontal border
      expect(result).toContain('┘');  // Bottom-right corner
    });

    it('strips bold and shows clean table', () => {
      const input = '| **Header** | **Value** |\n|------------|-----------|\n| Item       | 123       |';
      const result = normalizeTable(input);
      expect(result).not.toContain('**');
      expect(result).toContain('Header');
      expect(result).toContain('Value');
      expect(result).toContain('┌');  // Has box borders
    });

    it('handles center alignment', () => {
      const input = '| **A** |\n|:---:|\n| B |';
      const result = normalizeTable(input);
      expect(result).not.toContain('**');
      expect(result).toContain('A');
      expect(result).toContain('B');
      expect(result).toContain('│');  // Vertical border
    });

    it('handles right alignment', () => {
      const input = '| **Num** |\n|---:|\n| 123 |';
      const result = normalizeTable(input);
      expect(result).not.toContain('**');
      expect(result).toContain('Num');
      expect(result).toContain('123');
      expect(result).toContain('│');  // Vertical border
    });

    it('strips links from cells', () => {
      const input = '| [Link](http://example.com) |\n|---|\n| text |';
      const result = normalizeTable(input);
      expect(result).toContain('Link');
      expect(result).not.toContain('http://');
      expect(result).not.toContain('[');
    });

    it('handles mixed formatting', () => {
      const input = '| **bold** and *italic* |\n|---|\n| text |';
      const result = normalizeTable(input);
      expect(result).toContain('bold and italic');
      expect(result).not.toContain('**');
      expect(result).not.toContain('*italic*');
    });

    it('handles multiplication table with bold diagonal', () => {
      const input = `|   | **1** | **2** | **3** |
|---|-------|-------|-------|
| **1** | 1 | 2 | **3** |
| **2** | 2 | **4** | 6 |
| **3** | **3** | 6 | **9** |`;
      const result = normalizeTable(input);
      // All bold markers should be stripped
      expect(result).not.toContain('**');
      // Numbers should be preserved
      expect(result).toContain('1');
      expect(result).toContain('2');
      expect(result).toContain('3');
      expect(result).toContain('4');
      expect(result).toContain('6');
      expect(result).toContain('9');
      // Has box borders
      expect(result).toContain('┌');
      expect(result).toContain('┘');
    });

    it('returns original text for invalid table (single line)', () => {
      const input = '| Just one line |';
      const result = normalizeTable(input);
      expect(result).toBe(input);
    });

    it('handles empty cells', () => {
      const input = `| Name | Value |
|------|-------|
|      | 123   |`;
      const result = normalizeTable(input);
      expect(result).toContain('Name');
      expect(result).toContain('Value');
      expect(result).toContain('123');
      expect(result).toContain('┌');
      expect(result).toContain('┘');
    });

    it('handles escaped pipes in cells', () => {
      const input = `| Command | Description |
|---------|-------------|
| foo \\| bar | pipes work |`;
      const result = normalizeTable(input);
      expect(result).toContain('foo | bar');  // Escaped pipe becomes literal pipe
      expect(result).toContain('pipes work');
      expect(result).not.toContain('\\|');  // No escaped pipe in output
    });

    it('handles emoji in cells', () => {
      const input = `| Icon | Name |
|------|------|
| 🎉   | Party |`;
      const result = normalizeTable(input);
      expect(result).toContain('🎉');
      expect(result).toContain('Party');
      expect(result).toContain('┌');
    });

    it('handles CJK characters in cells', () => {
      const input = `| 名前 | 値 |
|------|-----|
| テスト | 123 |`;
      const result = normalizeTable(input);
      expect(result).toContain('名前');
      expect(result).toContain('値');
      expect(result).toContain('テスト');
      expect(result).toContain('123');
      expect(result).toContain('┌');
    });
  });

  describe('markdownToSlack with tables', () => {
    it('normalizes tables inside code blocks', () => {
      const input = '| **A** | **B** |\n|---|---|\n| 1 | 2 |';
      const result = markdownToSlack(input);
      expect(result).toContain('```');
      expect(result).not.toContain('**');
    });

    it('preserves text around tables', () => {
      const input = 'Before\n| **X** |\n|---|\n| Y |\nAfter';
      const result = markdownToSlack(input);
      expect(result).toContain('Before');
      expect(result).toContain('After');
      expect(result).toContain('```');
      expect(result).not.toContain('**');
    });
  });
});
