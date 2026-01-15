import { describe, it, expect } from 'vitest';
import { formatTimeRemaining, markdownToSlack } from '../../utils.js';

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
  });
});
