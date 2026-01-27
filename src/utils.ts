/**
 * Utility functions for the ccslack bot.
 */
import removeMd from 'remove-markdown';
import { table, getBorderCharacters } from 'table';

/**
 * Parse a markdown table row into cells.
 * Handles escaped pipes (\|) within cell content.
 */
function parseTableRow(line: string): string[] {
  // Replace escaped pipes with placeholder before splitting
  const placeholder = '\x00PIPE\x00';
  const escaped = line.replace(/\\\|/g, placeholder);
  return escaped
    .split('|')
    .slice(1, -1)  // Remove empty first/last from leading/trailing |
    .map(cell => cell.trim().replace(new RegExp(placeholder, 'g'), '|'));
}

/**
 * Detect column alignment from separator row.
 * :--- = left, :---: = center, ---: = right
 */
function parseAlignment(separatorLine: string): ('l' | 'c' | 'r')[] {
  return separatorLine
    .split('|')
    .slice(1, -1)
    .map(cell => {
      const trimmed = cell.trim();
      if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'c';
      if (trimmed.endsWith(':')) return 'r';
      return 'l';
    });
}

/**
 * Normalize a markdown table: strip formatting, render with UTF-8 box chars.
 *
 * TODO: Table normalization temporarily disabled - there's a bug with formatting
 * stripping that needs investigation. Currently returns input unchanged.
 */
export function normalizeTable(tableText: string): string {
  // TODO: Investigate and fix table normalization bug, then restore this code
  return tableText.trimEnd();

  /*
  const lines = tableText.trim().split('\n');
  if (lines.length < 2) return tableText;

  // Parse rows
  const headerCells = parseTableRow(lines[0]);
  const alignment = parseAlignment(lines[1]);
  const dataRows = lines.slice(2).map(parseTableRow);

  // Strip formatting from all cells using remove-markdown
  const cleanCell = (cell: string) => removeMd(cell).trim();
  const cleanedHeader = headerCells.map(cleanCell);
  const cleanedData = dataRows.map(row => row.map(cleanCell));

  // Build table data (header + data rows)
  const allRows = [cleanedHeader, ...cleanedData];

  // Map alignment to table package format
  const columnConfig: Record<number, { alignment: 'left' | 'center' | 'right' }> = {};
  alignment.forEach((align, i) => {
    columnConfig[i] = {
      alignment: align === 'c' ? 'center' : align === 'r' ? 'right' : 'left'
    };
  });

  // Render with single-line box characters
  return table(allRows, {
    border: getBorderCharacters('norc'),  // ┌─┬─┐ style
    columns: columnConfig,
    drawHorizontalLine: (lineIndex, rowCount) => {
      // Draw lines: top, after header, bottom
      return lineIndex === 0 || lineIndex === 1 || lineIndex === rowCount;
    }
  }).trimEnd();
  */
}

/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Differences:
 * - Bold: **text** or __text__ → *text*
 * - Italic: *text* or _text_ → _text_
 * - Bold+Italic: ***text*** or ___text___ → *_text_*
 * - Strikethrough: ~~text~~ → ~text~
 * - Links: [text](url) → <url|text>
 * - Headers: # Header → *Header*
 * - Tables: | col | col | → wrapped in code block (Slack doesn't support tables)
 * - Horizontal rules: --- → unicode line separator
 */
export function markdownToSlack(text: string): string {
  let result = text;

  // Protect code blocks from conversion
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `⟦CODE_BLOCK_${codeBlocks.length - 1}⟧`;
  });

  // Convert markdown tables to code blocks with normalized formatting
  // Match consecutive lines that start and end with |
  result = result.replace(
    /(?:^[ \t]*\|.+\|[ \t]*$\n?)+/gm,
    (table) => {
      const normalized = normalizeTable(table);
      const wrapped = '```\n' + normalized + '\n```';
      codeBlocks.push(wrapped);
      // If original table ended with newline, preserve it for spacing after code block
      const suffix = table.endsWith('\n') ? '\n' : '';
      return `⟦CODE_BLOCK_${codeBlocks.length - 1}⟧${suffix}`;
    }
  );

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

  // Convert bold+italic combinations FIRST (before bold/italic separately)
  // ***text*** → *_text_* (bold+italic with asterisks)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '⟦BI⟧$1⟦/BI⟧');
  // ___text___ → *_text_* (bold+italic with underscores)
  result = result.replace(/___(.+?)___/g, '⟦BI⟧$1⟦/BI⟧');

  // Convert bold: **text** or __text__ → temporary marker
  result = result.replace(/\*\*(.+?)\*\*/g, '⟦B⟧$1⟦/B⟧');
  result = result.replace(/__(.+?)__/g, '⟦B⟧$1⟦/B⟧');

  // Convert italic *text* → _text_ (safe now since bold/headers are marked)
  result = result.replace(/\*([^*\n]+)\*/g, '_$1_');

  // Restore bold+italic markers to _*text*_ (italic wrapping bold)
  result = result.replace(/⟦BI⟧/g, '_*').replace(/⟦\/BI⟧/g, '*_');

  // Restore bold markers to *text*
  result = result.replace(/⟦B⟧/g, '*').replace(/⟦\/B⟧/g, '*');

  // Convert strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Convert horizontal rules: --- or *** or ___ → unicode line
  result = result.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '────────────────────────────');

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

/**
 * Strip markdown code fence wrapper if present.
 *
 * Case A: Explicit ```markdown or ```md tag → Always strip
 * Case B: Code blocks with language tags (```python, etc.) → Never strip
 * Case C: Empty ``` (bare fence) → Don't strip (preserve as-is)
 *
 * @param content - The content to process
 */
export function stripMarkdownCodeFence(content: string): string {
  // Must start with ``` and end with ``` on its own line
  if (!content.startsWith('```')) return content;
  if (!/\n```\s*$/.test(content)) return content;

  // Find first newline
  const firstNewline = content.indexOf('\n');
  if (firstNewline === -1) return content;

  // Extract first word as language tag (handles "js filename=x" info strings)
  const tagLine = content.slice(3, firstNewline).trim();
  const tag = tagLine.split(/\s/)[0].toLowerCase();

  // Helper to extract inner content
  const extractInner = (): string | null => {
    const afterFirstLine = content.slice(firstNewline + 1);
    const match = afterFirstLine.match(/^([\s\S]*)\n```\s*$/);
    return match ? match[1].replace(/\r$/, '') : null;
  };

  // CASE A: Explicit markdown/md tag → strip
  if (tag === 'markdown' || tag === 'md') {
    return extractInner() ?? content;
  }

  // CASE B: Non-empty tag that isn't markdown/md → don't strip (it's code)
  if (tag !== '') {
    return content;
  }

  // CASE C: Empty tag (bare fence) → don't strip
  return content;
}

/**
 * Parse a Slack message link to extract channel ID and message timestamp.
 *
 * Slack message link formats:
 * - https://slack.com/archives/C123ABC/p1705123456789012
 * - https://workspace.slack.com/archives/C123ABC/p1705123456789012
 * - https://slack.com/archives/C123ABC/p1705123456789012?thread_ts=1705000000.000000
 *
 * @param link - The Slack message link to parse
 * @returns Parsed info { channelId, messageTs, threadTs? } or null if invalid
 */
export function parseSlackMessageLink(
  link: string
): { channelId: string; messageTs: string; threadTs?: string } | null {
  try {
    // Match archive links with channel ID (C/D/G prefix) and timestamp
    const archiveMatch = link.match(/\/archives\/([CDG][A-Z0-9]+)\/p(\d+)/i);
    if (!archiveMatch) {
      return null;
    }

    const channelId = archiveMatch[1];
    const rawTimestamp = archiveMatch[2];

    // Convert p-format timestamp to Slack ts format
    // p1705123456789012 → 1705123456.789012
    // The p-format is the ts with the dot removed
    if (rawTimestamp.length < 7) {
      return null;  // Too short to be valid
    }

    // Insert dot before last 6 digits
    const messageTs = rawTimestamp.slice(0, -6) + '.' + rawTimestamp.slice(-6);

    // Check for thread_ts query parameter
    let threadTs: string | undefined;
    try {
      const url = new URL(link);
      const threadTsParam = url.searchParams.get('thread_ts');
      if (threadTsParam) {
        threadTs = threadTsParam;
      }
    } catch {
      // If URL parsing fails, just skip thread_ts
    }

    return { channelId, messageTs, threadTs };
  } catch {
    return null;
  }
}
