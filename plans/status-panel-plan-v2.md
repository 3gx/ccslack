# Status Panel Gap Fixes

## Problem

Status panel at completion should show context % and cost like Claude Code CLI:
```
🧠 Context Remaining: 88%
💰 $0.0123
```

But currently shows NOTHING for context/cost because of a bug.

## Root Cause: modelUsage Access Bug

**SDK Type Definition:**
```typescript
modelUsage: {
    [modelName: string]: ModelUsage;  // Dictionary keyed by model name!
};

type ModelUsage = {
    inputTokens: number;
    outputTokens: number;
    contextWindow: number;
    costUSD: number;
};
```

**Current WRONG code (slack-bot.ts ~line 1056):**
```typescript
if (resultMsg.modelUsage?.contextWindow) {  // WRONG - modelUsage is a dict!
  contextWindow = resultMsg.modelUsage.contextWindow;
```

**Should be:**
```typescript
if (resultMsg.modelUsage && processingState.model) {
  const modelData = resultMsg.modelUsage[processingState.model];
  if (modelData) {
    contextWindow = modelData.contextWindow;
  }
}
```

## SDK Data Availability

| Data | When Available |
|------|----------------|
| Model name | Early (system init) |
| Tool name | During (stream_event) |
| Input/output tokens | **End only** (result message) |
| Context window | **End only** (modelUsage[model].contextWindow) |
| Cost | **End only** (total_cost_usd) |

**Note:** Context % and cost can ONLY be shown at completion, not during processing (SDK limitation)

---

## Visual Layout

### During Processing

**Message 1 (Status Panel):**
```
:robot_face: Claude is working... ◐
─────────────────────────────────────
Mode: Plan | Model: claude-sonnet
Running: Edit | Tools: 2 | 12s
                                [Abort]
```
Spinner cycles `◐ → ◓ → ◑ → ◒` with each 3s update (proves bot is alive)

**Message 2 (Activity Log):**
```
:brain: Thinking... [0.5s]
> Let me analyze this request...

:mag: Read [1.2s]
:white_check_mark: Read complete (0.7s)
:memo: Edit [2.1s] (in progress)
```

Each entry shows elapsed time since processing started. Entries accumulate (ADD, not replace).

### After Completion

**Message 1 (Status Panel - Final):**
```
:white_check_mark: Complete
─────────────────────────────────────
Mode: Plan | Model: claude-sonnet
1,234 in / 567 out | 45% ctx | $0.012 | 5.2s
```

**Message 2 (Activity Log - Collapsed):**
```
:clipboard: Activity: 3 tools completed in 5.2s
                    [View Log] [Download .txt]
```

**Modal (when "View Log" clicked):**
```
┌─────────────────────────────────────────┐
│  Activity Log                      [X]  │
├─────────────────────────────────────────┤
│  :brain: Analyzing request...           │
│  :mag: Reading: src/Button.tsx          │
│  :white_check_mark: Read complete (0.3s)│
│  :memo: Editing: src/Button.tsx         │
│  :white_check_mark: Edit complete (1.2s)│
│  :brain: Reviewing changes...           │
│  :white_check_mark: Complete            │
└─────────────────────────────────────────┘
```

---

## Already Implemented (Phase 1)

- Two-message architecture (status panel + activity log)
- ProcessingState interface with activity tracking
- Thinking block detection via stream_event
- Tool start/complete detection
- Modal with pagination UI (buildActivityLogModalView)
- Download .txt functionality
- Abort button with mutex protection

---

# Implementation Plan: Gap Fixes

## Fix 1: modelUsage Access Bug (CRITICAL)

**File:** `src/slack-bot.ts` (~line 1056)

**Before:**
```typescript
// Model usage contains context window
if (resultMsg.modelUsage?.contextWindow) {
  contextWindow = resultMsg.modelUsage.contextWindow;
  processingState.contextWindow = contextWindow;
}
```

**After:**
```typescript
// Model usage is a dictionary keyed by model name
if (resultMsg.modelUsage && processingState.model) {
  const modelData = resultMsg.modelUsage[processingState.model];
  if (modelData?.contextWindow) {
    processingState.contextWindow = modelData.contextWindow;
  }
}
```

## Fix 2: Remove Debug Logs

**File:** `src/slack-bot.ts`

Remove these debug console.log statements:
- Line ~945: `console.log(\`[DEBUG] SDK message type...`
- Line ~947: `console.log(\`[DEBUG] stream_event...`
- Line ~1017: `console.log(\`[DEBUG] User message - parent_tool_use_id...`

**File:** `src/session-manager.ts`

Remove these debug statements:
- `console.log(\`[DEBUG saveActivityLog]...`
- `console.log(\`[DEBUG getActivityLog]...`

## Fix 3: Show Duration for Each Activity Entry

**Current behavior:** Duration only shown on `tool_complete` entries

**Required behavior:** Show elapsed time since activity started for ALL entries

**File:** `src/blocks.ts` - `buildActivityLogText()`

**Before:**
```typescript
case 'tool_start':
  const startEmoji = getToolEmoji(entry.tool);
  lines.push(`${startEmoji} *${entry.tool}*`);
  break;
```

**After:**
```typescript
case 'thinking':
  const thinkingDuration = entry.durationMs
    ? ` [${(entry.durationMs / 1000).toFixed(1)}s]`
    : '';
  lines.push(`:brain: *Thinking...*${thinkingDuration}`);
  // ... rest of thinking display
  break;

case 'tool_start':
  const startEmoji = getToolEmoji(entry.tool);
  const startDuration = entry.durationMs
    ? ` [${(entry.durationMs / 1000).toFixed(1)}s]`
    : ' (in progress)';
  lines.push(`${startEmoji} *${entry.tool}*${startDuration}`);
  break;
```

**Also update `logToolStart()` in slack-bot.ts** to calculate duration from processing start:
```typescript
const logToolStart = (toolName: string) => {
  const elapsedMs = Date.now() - processingState.startTime;
  processingState.activityLog.push({
    timestamp: Date.now(),
    type: 'tool_start',
    tool: formatToolName(toolName),
    durationMs: elapsedMs,  // Time since processing started
  });
  // ...
};
```

## Fix 4: Verify Activity Log Shows All Entries (ADD not REPLACE)

**Current behavior:** `buildActivityLogText()` rebuilds entire text on each update via `chat.update()`, which REPLACES the message content. But all entries ARE accumulated in the array.

**Verify:** The activity log message shows ALL accumulated entries (up to rolling window limit of 300). Each update adds to the array, and `buildActivityLogText()` renders all entries.

**Expected live display:**
```
:brain: *Thinking...* [0.5s]
> Let me analyze this request...

:mag: *Read* [1.2s]
:white_check_mark: Read complete (0.7s)
:memo: *Edit* (in progress)
```

## Fix 5: Add "Alive" Spinner That Updates With Each Cycle

**Goal:** Visual proof bot is actively working - spinner only changes when bot posts an update (every 3s)

**File:** `src/slack-bot.ts`

Add spinner state to ProcessingState:
```typescript
interface ProcessingState {
  // ... existing fields
  spinnerIndex: number;  // 0-7, cycles through spinner frames
}

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];  // Quarter circle rotation
// Or: ['🟢', '⚫'] for green/black flash
// Or: ['⣾', '⣽', '⣻', '⣯', '⣟', '⡿', '⢿', '⣷'] for braille spinner
```

**Update spinner on each 3s update cycle:**
```typescript
processingState.spinnerIndex = (processingState.spinnerIndex + 1) % SPINNER_FRAMES.length;
const spinner = SPINNER_FRAMES[processingState.spinnerIndex];
```

**File:** `src/blocks.ts` - `buildStatusPanelBlocks()`

Add spinner param and display:
```typescript
export interface StatusPanelParams {
  // ... existing fields
  spinner?: string;  // Current spinner frame
}

// In 'thinking' and 'tool' cases:
blocks.push({
  type: 'section',
  text: {
    type: 'mrkdwn',
    text: `:robot_face: *Claude is working...* ${spinner || ''}`,
  },
});
```

**Expected during processing:**
```
:robot_face: Claude is working... ◐     (update 1)
:robot_face: Claude is working... ◓     (update 2)
:robot_face: Claude is working... ◑     (update 3)
:robot_face: Claude is working... ◒     (update 4)
```

The spinner ONLY changes when the bot posts an update, proving it's alive.

## Fix 6: Verify Modal Pagination Handler Exists

**File:** `src/slack-bot.ts`

Verify handler exists at ~line 1973:
```typescript
app.action(/^activity_log_page_(\d+)$/, async ({ action, ack, body, client }) => {
```

If missing, add it per the original plan Step 10.

---

## Expected Completion Status Panel

After fixes, completion should show:
```
:white_check_mark: Complete
_Plan | claude-opus-4-5-20251101 | 1,234 in / 567 out | 12% ctx | $0.0123 | 5.2s_
```

Where:
- `1,234 in / 567 out` = input/output tokens
- `12% ctx` = (inputTokens / contextWindow) * 100
- `$0.0123` = total_cost_usd from result message

---

## Automated Tests

### Test File: `src/__tests__/unit/blocks.test.ts`

**Test: buildActivityLogText shows duration for each entry**
```typescript
describe('buildActivityLogText with durations', () => {
  it('should show elapsed time for tool_start entries', () => {
    const entries: ActivityEntry[] = [
      { timestamp: 1000, type: 'tool_start', tool: 'Read', durationMs: 1200 },
    ];
    const text = buildActivityLogText(entries, true);
    expect(text).toContain(':mag: *Read* [1.2s]');
  });

  it('should show elapsed time for thinking entries', () => {
    const entries: ActivityEntry[] = [
      { timestamp: 1000, type: 'thinking', durationMs: 500, thinkingTruncated: 'test' },
    ];
    const text = buildActivityLogText(entries, true);
    expect(text).toContain(':brain: *Thinking...* [0.5s]');
  });

  it('should show (in progress) when no duration', () => {
    const entries: ActivityEntry[] = [
      { timestamp: 1000, type: 'tool_start', tool: 'Edit' },
    ];
    const text = buildActivityLogText(entries, true);
    expect(text).toContain(':memo: *Edit* (in progress)');
  });
});
```

**Test: buildStatusPanelBlocks shows spinner**
```typescript
describe('buildStatusPanelBlocks with spinner', () => {
  it('should include spinner in working state', () => {
    const blocks = buildStatusPanelBlocks({
      status: 'thinking',
      mode: 'plan',
      toolsCompleted: 0,
      elapsedMs: 5000,
      conversationKey: 'test',
      spinner: '◐',
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('Claude is working');
    expect(text).toContain('◐');
  });

  it('should show context % and cost at completion', () => {
    const blocks = buildStatusPanelBlocks({
      status: 'complete',
      mode: 'plan',
      model: 'claude-sonnet',
      toolsCompleted: 2,
      elapsedMs: 5000,
      inputTokens: 1234,
      outputTokens: 567,
      contextPercent: 12,
      costUsd: 0.0123,
      conversationKey: 'test',
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('1,234 in');
    expect(text).toContain('567 out');
    expect(text).toContain('12% ctx');
    expect(text).toContain('$0.0123');
  });
});
```

### Test File: `src/__tests__/unit/slack-bot.test.ts` (or integration)

**Test: modelUsage dictionary access**
```typescript
describe('result message parsing', () => {
  it('should extract contextWindow from modelUsage dictionary', () => {
    const resultMsg = {
      type: 'result',
      modelUsage: {
        'claude-sonnet-4-20250514': {
          inputTokens: 1234,
          outputTokens: 567,
          contextWindow: 200000,
          costUSD: 0.0123,
        },
      },
      total_cost_usd: 0.0123,
    };

    const model = 'claude-sonnet-4-20250514';
    const modelData = resultMsg.modelUsage[model];

    expect(modelData.contextWindow).toBe(200000);
    expect(modelData.inputTokens).toBe(1234);
  });
});
```

**Test: spinner cycles correctly**
```typescript
describe('spinner state', () => {
  it('should cycle through spinner frames', () => {
    const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
    let spinnerIndex = 0;

    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(SPINNER_FRAMES[spinnerIndex]);
      spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
    }

    expect(results).toEqual(['◐', '◓', '◑', '◒', '◐', '◓']);
  });
});
```

**Test: activity log accumulates entries**
```typescript
describe('activity log accumulation', () => {
  it('should accumulate entries over multiple updates', () => {
    const activityLog: ActivityEntry[] = [];

    // Simulate multiple tool starts
    activityLog.push({ timestamp: 1000, type: 'tool_start', tool: 'Read', durationMs: 500 });
    activityLog.push({ timestamp: 2000, type: 'tool_complete', tool: 'Read', durationMs: 700 });
    activityLog.push({ timestamp: 3000, type: 'tool_start', tool: 'Edit', durationMs: 1200 });

    const text = buildActivityLogText(activityLog, true);

    // All entries should be present
    expect(text).toContain('Read');
    expect(text).toContain('Edit');
    expect(activityLog.length).toBe(3);
  });
});
```

---

## Manual Verification

1. Send a message that uses tools (e.g., "read package.json")
2. **During processing**, verify:
   - Spinner cycles `◐ → ◓ → ◑ → ◒` every 3 seconds
   - Elapsed time updates (`12s → 15s → 18s`)
   - Activity log shows all entries with elapsed time: `:mag: Read [1.2s]`
3. **After completion**, verify status panel shows:
   - Token counts (in/out)
   - Context %
   - Cost in USD
   - Duration
4. Click "View Log" - modal should open with pagination if >15 entries
5. Click "Download .txt" - file should download

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/slack-bot.ts` | Fix modelUsage access, add elapsed time to log functions, add spinner state, remove debug logs |
| `src/blocks.ts` | Show duration for each activity entry, add spinner to status panel |
| `src/session-manager.ts` | Remove debug logs |
| `src/__tests__/unit/blocks.test.ts` | Add tests for duration display, spinner, context/cost |
| `src/__tests__/unit/slack-bot.test.ts` | Add tests for modelUsage parsing, spinner cycling, activity accumulation |
