# Implementation Plan: UTF-8 Box-Drawing Table Visualization

## Confidence: 92% ✓

**Validated:**
- User verified UTF-8 box characters render correctly in Slack
- `table` package API confirmed (TypeScript built-in, `getBorderCharacters('norc')` exists)
- Implementation path clear, no blockers

**Minor fixes needed:**
- Add `.trimEnd()` to handle trailing newline from `table()` output

---

## Goal

Enhance table rendering in Slack with UTF-8 box-drawing characters for a cleaner, more professional look.

**Current output:**
```
| Header | Value |
|--------|-------|
| Item   | 123   |
```

**Target output:**
```
┌────────┬───────┐
│ Header │ Value │
├────────┼───────┤
│ Item   │ 123   │
└────────┴───────┘
```

---

## Chosen Approach: Use `table` Package

**Package:** `table` (15.6M+ weekly downloads)
- Returns strings (not just prints to console)
- Built-in UTF-8 border styles via `getBorderCharacters()`
- Simple API
- Already handles alignment, padding, wrapping

---

## Implementation

### 1. Replace `markdown-table` with `table`

```bash
npm uninstall markdown-table
npm install table
```

### 2. Update `src/utils.ts`

```typescript
import removeMd from 'remove-markdown';
import { table, getBorderCharacters } from 'table';

/**
 * Normalize a markdown table: strip formatting, render with UTF-8 box chars.
 */
export function normalizeTable(tableText: string): string {
  const lines = tableText.trim().split('\n');
  if (lines.length < 2) return tableText;

  // Parse rows
  const headerCells = parseTableRow(lines[0]);
  const alignment = parseAlignment(lines[1]);
  const dataRows = lines.slice(2).map(parseTableRow);

  // Strip formatting from all cells
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
  }).trim();
}
```

### 3. Border Style Options

The `table` package provides these built-in styles:

| Style | Characters | Look |
|-------|------------|------|
| `norc` | `┌─┬─┐ │ ├─┼─┤ └─┴─┘` | Single line (recommended) |
| `honeywell` | `╔═╤═╗ ║ ╟─┼─╢ ╚═╧═╝` | Double outer, single inner |
| `ramac` | `+---+ | +---+` | ASCII fallback |
| `void` | (spaces only) | Borderless |

We'll use `norc` for clean single-line boxes, matching the user's examples.

---

## Files to Modify

| File | Changes |
|------|---------|
| `package.json` | Replace `markdown-table` with `table` |
| `src/utils.ts` | Update `normalizeTable()` to use `table` package |
| `src/__tests__/unit/utils.test.ts` | Update tests for new output format |

---

## Test Updates

```typescript
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
    const input = '| **Header** | **Value** |\n|---|----||\n| Item | 123 |';
    const result = normalizeTable(input);
    expect(result).not.toContain('**');
    expect(result).toContain('Header');
    expect(result).toContain('Value');
  });
});
```

---

## Expected Output

**Input (markdown with formatting):**
```markdown
|   | **1** | **2** | **3** |
|---|-------|-------|-------|
| **1** | 1 | 2 | 3 |
| **2** | 2 | 4 | 6 |
```

**Output (UTF-8 box table):**
```
┌───┬───┬───┬───┐
│   │ 1 │ 2 │ 3 │
├───┼───┼───┼───┤
│ 1 │ 1 │ 2 │ 3 │
│ 2 │ 2 │ 4 │ 6 │
└───┴───┴───┴───┘
```

---

## Verification

```bash
# Install new dependency
npm uninstall markdown-table && npm install table

# Type check
npx tsc --noEmit

# Run tests
make test

# Manual test
make dev
# In Slack: "@bot show me a 3x3 multiplication table"
# Expected: Box-drawn table with ┌─┬─┐ style borders
```

---

## Why This Approach

| Option | Pros | Cons |
|--------|------|------|
| `table` package | 15.6M downloads, battle-tested, built-in styles | Slightly larger than markdown-table |
| Custom implementation | Full control | ~100 lines to implement, edge cases |
| Keep markdown-table | Already working | Plain `|------|` separators, not as clean |

**Recommendation:** Use `table` package for reliability and clean output.

---

## ⚠️ Risk Analysis

### Top 3 Risks

| Rank | Risk | Severity | Mitigation |
|------|------|----------|------------|
| **1** | UTF-8 box chars misalign in Slack code blocks | **HIGH** | Test manually before shipping; have ASCII fallback ready |
| **2** | API migration introduces subtle formatting differences | **MEDIUM** | Snapshot tests comparing old vs new output |
| **3** | Bundle size increase with unused ANSI features | **LOW** | Accept for server-side app |

### Critical Issue: Slack Font Rendering

From [slackapi/python-slack-sdk#164](https://github.com/slackapi/python-slack-sdk/issues/164):
- Slack code blocks do **not guarantee true monospace** for Unicode characters
- Box-drawing characters (`┌─┬─┐`) may render at different widths than ASCII
- Alignment failures common with non-ASCII characters

### Required Pre-Implementation Test

**Before coding, manually test in Slack:**

Post this to a test channel:
```
┌────┬────┬────┐
│ A  │ B  │ C  │
├────┼────┼────┤
│ 1  │ 2  │ 3  │
└────┴────┴────┘
```

Check alignment on:
- [ ] Mac desktop Slack
- [ ] Windows desktop Slack
- [ ] Web browser Slack
- [ ] iOS Slack app
- [ ] Android Slack app

**If any show misalignment → use ASCII fallback (`ramac` style):**
```
+----+----+----+
| A  | B  | C  |
+----+----+----+
| 1  | 2  | 3  |
+----+----+----+
```

### Fallback Strategy

The `table` package supports both:
- `getBorderCharacters('norc')` → UTF-8: `┌─┬─┐`
- `getBorderCharacters('ramac')` → ASCII: `+---+`

**Option: Make configurable via env var:**
```typescript
const BORDER_STYLE = process.env.TABLE_BORDER_STYLE || 'ramac';
```

### Missing Test Cases

1. Slack rendering verification (manual only)
2. Cross-platform font rendering
3. Empty cell handling: `| | value |`
4. Escaped pipes: `| foo \| bar |`
5. Emoji/CJK in cells (fullwidth chars)
