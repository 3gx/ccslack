/**
 * Utility functions for the ccslack bot.
 */

/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Differences:
 * - Bold: **text** → *text*
 * - Italic: *text* → _text_
 * - Strikethrough: ~~text~~ → ~text~
 * - Links: [text](url) → <url|text>
 * - Headers: # Header → *Header*
 */
export function markdownToSlack(text: string): string {
  let result = text;

  // Protect code blocks from conversion
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `⟦CODE_BLOCK_${codeBlocks.length - 1}⟧`;
  });

  // Protect inline code
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `⟦INLINE_CODE_${inlineCode.length - 1}⟧`;
  });

  // Convert links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert headers: # Header → temporary marker (will become bold)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '⟦B⟧$1⟦/B⟧');

  // Convert bold: **text** → temporary marker
  result = result.replace(/\*\*(.+?)\*\*/g, '⟦B⟧$1⟦/B⟧');

  // Convert italic *text* → _text_ (safe now since bold/headers are marked)
  result = result.replace(/\*([^*\n]+)\*/g, '_$1_');

  // Restore bold markers to *text*
  result = result.replace(/⟦B⟧/g, '*').replace(/⟦\/B⟧/g, '*');

  // Convert strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Restore inline code
  for (let i = 0; i < inlineCode.length; i++) {
    result = result.replace(`⟦INLINE_CODE_${i}⟧`, inlineCode[i]);
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`⟦CODE_BLOCK_${i}⟧`, codeBlocks[i]);
  }

  return result;
}

/**
 * Format milliseconds remaining into "X days Y hours Z mins" format.
 */
export function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return '0 mins';

  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const mins = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins} min${mins !== 1 ? 's' : ''}`);

  return parts.join(' ');
}
