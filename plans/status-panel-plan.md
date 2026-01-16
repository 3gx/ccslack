# Real-Time Processing Feedback

## Problem

Currently when processing messages, user only sees `:eyes:` reaction with no visibility into:
- What Claude is doing (thinking vs running tool)
- Which tool is executing
- Token usage (only shown at END)
- Context usage %
- Cost estimate

Reference: Claude Code CLI shows real-time status with context %, cost, mode.

## Available Data from SDK

| Data | When Available |
|------|----------------|
| Model name | Early (system init) |
| Tool name + input | During (assistant message) |
| Input/output tokens | End (result message) |
| Duration (ms) | End (result message) |
| **total_cost_usd** | End (result message) |
| **contextWindow** | End (modelUsage) |

**Note:** Context % calculable from `inputTokens / contextWindow * 100`

## Slack API Constraints

| API | Rate Limit | Use Case |
|-----|------------|----------|
| Native streaming | Unlimited in stream | Live text updates |
| chat.update | 50/min (current: 30/min) | Periodic status |
| reactions.add | ~50/min | Instant indicators |
| chat.postEphemeral | Standard | Per-user messages |

---

## Design Options

### Option 1: Enhanced Reactions (Simple)

**Feedback:** Cycling emoji reactions to show processing phase

```
:eyes: → :brain: (thinking) → :mag: (reading) → :memo: (editing) → :white_check_mark:
```

**Pros:** Zero rate limit concerns, instant feedback, no clutter
**Cons:** Limited info, users must learn emoji meanings
**Effort:** 1-2 hours

---

### Option 2: Periodic Header Updates (Medium)

**Feedback:** Update header block every 2-3s with current activity

```
Starting:     _Plan_                                      [Abort]
Thinking:     _Plan | claude-sonnet | Thinking..._        [Abort]
Tool:         _Plan | claude-sonnet | Running: Edit..._   [Abort]
Complete:     _Plan | claude-sonnet | 1,234 tokens | 45% ctx | $0.01 | 5.2s_
```

**Pros:** Clear tool visibility, context %, familiar pattern
**Cons:** 2-3s update delay, no streaming text
**Effort:** 4-6 hours

---

### Option 3: Ephemeral Activity Feed (Medium-High)

**Feedback:** Per-user ephemeral messages showing activity log

```
[Only visible to you]
:brain: Analyzing request...
:mag: Reading: src/Button.tsx
:memo: Editing: src/Button.tsx
:white_check_mark: Edit complete (1.2s)
```

**Pros:** Detailed log, doesn't clutter channel, shows tool params
**Cons:** Messages pile up, can't reference later
**Effort:** 6-8 hours

---

### Option 4: Streaming Status Panel (Comprehensive)

**Feedback:** Rich status panel with all available data

```
+--------------------------------------------------+
| :robot_face: Claude is working...                |
+--------------------------------------------------+
| Mode: Plan | Model: claude-sonnet                |
| Tokens: 1,234 in / 567 out | Context: 45%        |
| Cost: $0.012                                     |
+--------------------------------------------------+
| Current: Running Edit on src/app.tsx (3/8 tools) |
+--------------------------------------------------+
| Preview: "I'll make these changes to..."         |
+--------------------------------------------------+
|                                          [Abort] |
+--------------------------------------------------+
```

**Pros:** Most comprehensive, shows cost, streaming preview
**Cons:** Highest complexity, rate limit management needed
**Effort:** 8-12 hours

---

## Comparison

| Feature | Opt 1 | Opt 2 | Opt 3 | Opt 4 |
|---------|-------|-------|-------|-------|
| Current activity | Emoji | Text | Detailed | Full |
| Tool visibility | Generic | Name | Name+params | Name+progress |
| Token usage | No | Intervals | No | Real-time |
| Context % | No | Yes | No | Yes |
| Cost | No | End only | No | Yes |
| Text preview | No | No | No | Yes |
| Complexity | Low | Medium | Med-High | High |

---

## Selected: Two-Message Hybrid Approach

**Architecture:** Two separate messages working together:

1. **Message 1: Status Panel** (Block Kit) - Compact stats + Abort button
2. **Message 2: Activity Log** (Text) - Real-time activity feed, collapses on complete

**Key constraints verified:**
- `total_cost_usd`, `contextWindow`, token counts ONLY available at END (in `result` message)
- Native streaming only supports TEXT, not Block Kit
- Block Kit requires `chat.update` (50/min rate limit)
- Rate limit math: 3s interval × 2 messages = ~40 updates/min (safe under 50/min)

---

## Visual Layout

### During Processing

**Message 1 (Status Panel):**
```
:robot_face: Claude is working...
─────────────────────────────────────
Mode: Plan | Model: claude-sonnet
Running: Edit | Tools: 2 | 12s
                                [Abort]
```

**Message 2 (Activity Log):**
```
:brain: Analyzing request...
:mag: Reading: src/Button.tsx
:memo: Editing: src/Button.tsx (in progress)
```

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

## Implementation Plan

### Step 1: Add Processing State Interface

**File:** `src/slack-bot.ts`

```typescript
interface ProcessingState {
  status: 'starting' | 'thinking' | 'tool' | 'complete' | 'error' | 'aborted';
  model?: string;
  currentTool?: string;
  toolsCompleted: number;
  thinkingBlockCount: number;           // NEW: Track thinking blocks
  startTime: number;
  lastUpdateTime: number;
  // Activity log entries (preserved for modal)
  activityLog: ActivityEntry[];
  // Temporary state for accumulating thinking content
  currentThinkingIndex?: number | null;  // NEW: Track which block we're in
  currentThinkingContent?: string;       // NEW: Accumulate thinking text
  // Only populated at completion (from result message)
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
  costUsd?: number;
  durationMs?: number;
}

interface ActivityEntry {
  timestamp: number;
  type: 'thinking' | 'tool_start' | 'tool_complete' | 'error';
  tool?: string;
  durationMs?: number;
  message?: string;
  // For thinking blocks
  thinkingContent?: string;     // Full content (stored for modal/download)
  thinkingTruncated?: string;   // First 500 chars (for live display)
}

// Constants
const THINKING_TRUNCATE_LENGTH = 500;
const MAX_LIVE_ENTRIES = 300;  // Switch to rolling window if exceeded
const ROLLING_WINDOW_SIZE = 20; // Show last N entries when in rolling mode
```

### Step 2: Extend ActiveQuery Interface

**File:** `src/slack-bot.ts`

```typescript
interface ActiveQuery {
  conversationKey: string;
  abortController: AbortController;
  statusMsgTs: string;        // Message 1: Status panel
  activityLogMsgTs: string;   // Message 2: Activity log
}
```

### Step 3: Create Block Builders

**File:** `src/blocks.ts`

```typescript
export interface StatusPanelParams {
  status: 'starting' | 'thinking' | 'tool' | 'complete' | 'error' | 'aborted';
  mode: PermissionMode;
  model?: string;
  currentTool?: string;
  toolsCompleted: number;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  contextPercent?: number;
  costUsd?: number;
  conversationKey: string;
  errorMessage?: string;
}

export function buildStatusPanelBlocks(params: StatusPanelParams): KnownBlock[];

// Build activity log text for live display (during processing)
export function buildActivityLogText(entries: ActivityEntry[], inProgress: boolean): string {
  // Apply rolling window if too many entries
  const displayEntries = entries.length > MAX_LIVE_ENTRIES
    ? entries.slice(-ROLLING_WINDOW_SIZE)
    : entries;

  const lines: string[] = [];

  // Show truncation notice if in rolling window mode
  if (entries.length > MAX_LIVE_ENTRIES) {
    const hiddenCount = entries.length - ROLLING_WINDOW_SIZE;
    lines.push(`... ${hiddenCount} earlier entries (see full log after completion) ...\n`);
  }

  for (const entry of displayEntries) {
    switch (entry.type) {
      case 'thinking':
        // Show truncated thinking (500 chars max)
        const thinkingText = entry.thinkingTruncated || entry.thinkingContent || '';
        const truncatedIndicator = entry.thinkingContent && entry.thinkingContent.length > THINKING_TRUNCATE_LENGTH
          ? ` [${entry.thinkingContent.length} chars]`
          : '';
        lines.push(`:brain: Thinking...${truncatedIndicator}`);
        // Indent thinking content
        const indentedThinking = thinkingText.split('\n').map(l => `  ${l}`).join('\n');
        lines.push(indentedThinking);
        lines.push('');  // Blank line after thinking
        break;
      case 'tool_start':
        const emoji = getToolEmoji(entry.tool);
        lines.push(`${emoji} ${entry.tool}`);
        break;
      case 'tool_complete':
        const duration = entry.durationMs ? ` (${(entry.durationMs / 1000).toFixed(1)}s)` : '';
        lines.push(`:white_check_mark: ${entry.tool} complete${duration}`);
        break;
      case 'error':
        lines.push(`:x: Error: ${entry.message}`);
        break;
    }
  }

  return lines.join('\n');
}

function getToolEmoji(toolName?: string): string {
  if (!toolName) return ':gear:';
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower.includes('glob') || lower.includes('grep')) return ':mag:';
  if (lower.includes('edit') || lower.includes('write')) return ':memo:';
  if (lower.includes('bash') || lower.includes('shell')) return ':computer:';
  if (lower.includes('web') || lower.includes('fetch')) return ':globe_with_meridians:';
  return ':gear:';
}

// Build collapsed summary for completion (handles no-tools case)
export function buildCollapsedActivityBlocks(
  thinkingBlockCount: number,
  toolsCompleted: number,
  durationMs: number,
  conversationKey: string
): KnownBlock[] {
  const durationSec = (durationMs / 1000).toFixed(1);

  // Build summary text based on what happened
  let summaryText: string;
  if (toolsCompleted === 0 && thinkingBlockCount === 0) {
    summaryText = `:clipboard: Completed in ${durationSec}s`;
  } else if (toolsCompleted === 0) {
    summaryText = `:clipboard: ${thinkingBlockCount} thinking block${thinkingBlockCount > 1 ? 's' : ''} in ${durationSec}s`;
  } else if (thinkingBlockCount === 0) {
    summaryText = `:clipboard: ${toolsCompleted} tool${toolsCompleted > 1 ? 's' : ''} completed in ${durationSec}s`;
  } else {
    summaryText = `:clipboard: ${thinkingBlockCount} thinking + ${toolsCompleted} tools in ${durationSec}s`;
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summaryText },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Log' },
          action_id: 'view_activity_log',
          value: conversationKey,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Download .txt' },
          action_id: 'download_activity_log',
          value: conversationKey,
        },
      ],
    },
  ];
}

export function formatToolName(sdkToolName: string): string {
  // "mcp__claude-code__Read" -> "Read"
  if (!sdkToolName.includes('__')) return sdkToolName;
  return sdkToolName.split('__').pop()!;
}
```

### Step 4: Post Two Messages on Start

**File:** `src/slack-bot.ts`

```typescript
// Post Message 1: Status panel (Block Kit with Abort)
const statusMsg = await withSlackRetry(() => client.chat.postMessage({
  channel: channelId,
  thread_ts: threadTs,
  blocks: buildStatusPanelBlocks({
    status: 'starting',
    mode,
    toolsCompleted: 0,
    elapsedMs: 0,
    conversationKey,
  }),
  text: 'Claude is starting...',
}));

// Post Message 2: Activity log (text)
const activityMsg = await withSlackRetry(() => client.chat.postMessage({
  channel: channelId,
  thread_ts: threadTs,
  text: ':brain: Analyzing request...',
}));

// Track both message timestamps
activeQueries.set(conversationKey, {
  conversationKey,
  abortController,
  statusMsgTs: statusMsg.ts!,
  activityLogMsgTs: activityMsg.ts!,
});
```

### Step 5: Handle stream_event Messages (Thinking + Tools)

**File:** `src/slack-bot.ts`

**Critical:** Current code ignores `stream_event` messages. Must add handling:

```typescript
// In the stream processing loop
for await (const msg of claudeQuery) {
  // ... existing system/assistant/result handling ...

  // NEW: Handle stream_event for real-time activity
  if (msg.type === 'stream_event') {
    const event = (msg as any).event;

    // Thinking block started
    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      state.currentThinkingIndex = event.index;
      state.currentThinkingContent = '';
      state.status = 'thinking';
    }

    // Thinking content streaming
    if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
      state.currentThinkingContent += event.delta.thinking || '';
    }

    // Thinking block completed - add to activity log
    if (event.type === 'content_block_stop' && state.currentThinkingIndex === event.index && state.currentThinkingContent) {
      logThinking(state, state.currentThinkingContent);
      state.currentThinkingContent = '';
      state.currentThinkingIndex = null;
    }

    // Tool use started
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      logToolStart(state, event.content_block.name);
    }

    // Tool execution completed (tool result comes as user message with parent_tool_use_id)
  }

  // Tool result detection (existing approach is correct)
  if (msg.type === 'user' && (msg as any).parent_tool_use_id) {
    logToolComplete(state);
  }
}
```

### Step 6: Activity Log Entry Functions

**File:** `src/slack-bot.ts`

```typescript
// Add thinking block to activity log
function logThinking(state: ProcessingState, content: string) {
  const truncated = content.length > THINKING_TRUNCATE_LENGTH
    ? content.substring(0, THINKING_TRUNCATE_LENGTH) + '...'
    : content;

  state.activityLog.push({
    timestamp: Date.now(),
    type: 'thinking',
    thinkingContent: content,        // Full content for modal/download
    thinkingTruncated: truncated,    // Truncated for live display
  });
  state.thinkingBlockCount++;
  state.status = 'thinking';
}

// Add tool start to activity log
function logToolStart(state: ProcessingState, toolName: string) {
  state.activityLog.push({
    timestamp: Date.now(),
    type: 'tool_start',
    tool: formatToolName(toolName),
  });
  state.currentTool = formatToolName(toolName);
  state.status = 'tool';
}

// Add tool complete to activity log
function logToolComplete(state: ProcessingState, durationMs?: number) {
  const lastToolStart = [...state.activityLog].reverse().find(e => e.type === 'tool_start');
  if (lastToolStart) {
    state.activityLog.push({
      timestamp: Date.now(),
      type: 'tool_complete',
      tool: lastToolStart.tool,
      durationMs,
    });
  }
  state.toolsCompleted++;
  state.currentTool = undefined;
  state.status = 'thinking';
}
```

### Step 6: Throttled Updates with Mutex

**File:** `src/slack-bot.ts`

```typescript
import { Mutex } from 'async-mutex';

const updateMutexes = new Map<string, Mutex>();
const STATUS_UPDATE_INTERVAL = 3000; // 3s = ~40 updates/min for 2 messages (under 50/min)

function getUpdateMutex(conversationKey: string): Mutex {
  if (!updateMutexes.has(conversationKey)) {
    updateMutexes.set(conversationKey, new Mutex());
  }
  return updateMutexes.get(conversationKey)!;
}

// In stream loop - both updates acquire same mutex
if (Date.now() - state.lastUpdateTime > STATUS_UPDATE_INTERVAL) {
  const mutex = getUpdateMutex(conversationKey);
  await mutex.runExclusive(async () => {
    if (!isAborted(conversationKey)) {
      const elapsedMs = Date.now() - state.startTime;

      // Update Message 1: Status panel
      await withSlackRetry(() => client.chat.update({
        channel: channelId,
        ts: activeQuery.statusMsgTs,
        blocks: buildStatusPanelBlocks({
          status: state.status,
          mode,
          model: state.model,
          currentTool: state.currentTool,
          toolsCompleted: state.toolsCompleted,
          elapsedMs,
          conversationKey,
        }),
        text: 'Claude is working...',
      }));

      // Update Message 2: Activity log (text)
      await withSlackRetry(() => client.chat.update({
        channel: channelId,
        ts: activeQuery.activityLogMsgTs,
        text: buildActivityLogText(state.activityLog, true),
      }));
    }
  });
  state.lastUpdateTime = Date.now();
}
```

### Step 7: Abort Handler with Mutex

**File:** `src/slack-bot.ts`

```typescript
// In abort button handler
const mutex = getUpdateMutex(conversationKey);
await mutex.runExclusive(async () => {
  markAborted(conversationKey);

  // Update Message 1: Status panel to aborted
  await client.chat.update({
    channel: channelId,
    ts: activeQuery.statusMsgTs,
    blocks: buildStatusPanelBlocks({ status: 'aborted', ... }),
    text: 'Aborted',
  });

  // Update Message 2: Activity log to aborted
  await client.chat.update({
    channel: channelId,
    ts: activeQuery.activityLogMsgTs,
    text: buildActivityLogText(state.activityLog, false) + '\n:octagonal_sign: Aborted by user',
  });
});
```

**Guarantee:** Mutex ensures abort update ALWAYS comes after any in-flight status update.

### Step 8: Completion - Collapse Activity Log

**File:** `src/slack-bot.ts`

```typescript
// After stream completes
const contextPercent = state.contextWindow && state.inputTokens
  ? Math.round((state.inputTokens / state.contextWindow) * 100)
  : undefined;

if (!isAborted(conversationKey)) {
  // Update Message 1: Final stats
  await withSlackRetry(() => client.chat.update({
    channel: channelId,
    ts: activeQuery.statusMsgTs,
    blocks: buildStatusPanelBlocks({
      status: 'complete',
      mode,
      model: state.model,
      toolsCompleted: state.toolsCompleted,
      elapsedMs: state.durationMs ?? (Date.now() - state.startTime),
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      contextPercent,
      costUsd: state.costUsd,
      conversationKey,
    }),
    text: 'Complete',
  }));

  // Update Message 2: Collapse to summary with buttons
  await withSlackRetry(() => client.chat.update({
    channel: channelId,
    ts: activeQuery.activityLogMsgTs,
    blocks: buildCollapsedActivityBlocks(
      state.thinkingBlockCount,  // NEW: Pass thinking count
      state.toolsCompleted,
      state.durationMs ?? (Date.now() - state.startTime),
      conversationKey
    ),
    text: `Activity: ${state.thinkingBlockCount} thinking + ${state.toolsCompleted} tools`,
  }));

  // Store activity log for modal/download
  await saveActivityLog(conversationKey, state.activityLog);
}

// Post actual response
await postSplitResponse(client, channelId, fullResponse, threadTs);
```

### Step 9: Activity Log Storage

**File:** `src/session-manager.ts`

```typescript
interface ChannelSession {
  sessionId: string;
  workingDir: string;
  mode: PermissionMode;
  createdAt: number;
  lastActiveAt: number;
  messageMap: Record<string, MessageMapping>;
  threads: Record<string, ThreadSession>;
  // NEW: Activity logs by conversationKey
  activityLogs?: Record<string, ActivityEntry[]>;
}

export async function saveActivityLog(
  conversationKey: string,
  entries: ActivityEntry[]
): Promise<void>;

export async function getActivityLog(
  conversationKey: string
): Promise<ActivityEntry[] | null>;
```

### Step 10: Modal Handler for "View Log" (with Pagination)

**File:** `src/slack-bot.ts`

```typescript
const MODAL_PAGE_SIZE = 15;  // Entries per page

// Handle "View Log" button click
app.action('view_activity_log', async ({ ack, body, client }) => {
  await ack();

  const conversationKey = (body as any).actions[0].value;
  const activityLog = await getActivityLog(conversationKey);

  // Error handling: Log not available
  if (!activityLog) {
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Activity Log' },
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: ':warning: Activity log is no longer available.\n\nThis can happen if the session was cleared or the bot was restarted.' }
        }],
      },
    });
    return;
  }

  // Open modal with first page
  const totalPages = Math.ceil(activityLog.length / MODAL_PAGE_SIZE);
  await client.views.open({
    trigger_id: (body as any).trigger_id,
    view: buildActivityLogModalView(activityLog, 1, totalPages, conversationKey),
  });
});

// Handle pagination buttons in modal
app.action(/^activity_log_page_/, async ({ ack, body, client }) => {
  await ack();

  const actionId = (body as any).actions[0].action_id;  // e.g., "activity_log_page_2"
  const page = parseInt(actionId.split('_').pop(), 10);
  const metadata = JSON.parse((body as any).view.private_metadata);
  const { conversationKey } = metadata;

  const activityLog = await getActivityLog(conversationKey);
  if (!activityLog) return;

  const totalPages = Math.ceil(activityLog.length / MODAL_PAGE_SIZE);

  // Update modal with new page (in-place pagination)
  await client.views.update({
    view_id: (body as any).view.id,
    view: buildActivityLogModalView(activityLog, page, totalPages, conversationKey),
  });
});

// Build modal view with pagination
function buildActivityLogModalView(
  entries: ActivityEntry[],
  currentPage: number,
  totalPages: number,
  conversationKey: string
): any {
  const startIdx = (currentPage - 1) * MODAL_PAGE_SIZE;
  const pageEntries = entries.slice(startIdx, startIdx + MODAL_PAGE_SIZE);

  const blocks: KnownBlock[] = [];

  // Page header
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Page ${currentPage} of ${totalPages} | ${entries.length} total entries`,
    }],
  });

  blocks.push({ type: 'divider' });

  // Build log content for this page
  for (const entry of pageEntries) {
    if (entry.type === 'thinking') {
      // Show FULL thinking content in modal (not truncated)
      const thinkingText = entry.thinkingContent || entry.thinkingTruncated || '';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:brain: *Thinking* [${thinkingText.length} chars]\n\`\`\`${thinkingText.substring(0, 2900)}\`\`\``,
        },
      });
    } else {
      const emoji = getToolEmoji(entry.tool);
      const duration = entry.durationMs ? ` (${(entry.durationMs / 1000).toFixed(1)}s)` : '';
      const text = entry.type === 'tool_complete'
        ? `:white_check_mark: ${entry.tool} complete${duration}`
        : `${emoji} ${entry.tool}`;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text },
      });
    }
  }

  // Pagination buttons
  const paginationElements: any[] = [];
  if (currentPage > 1) {
    paginationElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '◀ Prev' },
      action_id: `activity_log_page_${currentPage - 1}`,
    });
  }
  if (currentPage < totalPages) {
    paginationElements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Next ▶' },
      action_id: `activity_log_page_${currentPage + 1}`,
    });
  }

  if (paginationElements.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'actions', elements: paginationElements });
  }

  return {
    type: 'modal',
    private_metadata: JSON.stringify({ conversationKey, currentPage }),
    title: { type: 'plain_text', text: 'Activity Log' },
    blocks,
  };
}

function getToolEmoji(toolName?: string): string {
  if (!toolName) return ':gear:';
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower.includes('glob') || lower.includes('grep')) return ':mag:';
  if (lower.includes('edit') || lower.includes('write')) return ':memo:';
  if (lower.includes('bash') || lower.includes('shell')) return ':computer:';
  return ':gear:';
}
```

### Step 11: Download Handler (Full Content)

**File:** `src/slack-bot.ts`

```typescript
// Handle "Download .txt" button click
app.action('download_activity_log', async ({ ack, body, client }) => {
  await ack();

  const conversationKey = (body as any).actions[0].value;
  const channelId = (body as any).channel.id;
  const activityLog = await getActivityLog(conversationKey);

  if (!activityLog) {
    // Could show ephemeral message about unavailable log
    return;
  }

  // Format as plain text with FULL thinking content
  const lines: string[] = [];
  for (const entry of activityLog) {
    const timestamp = new Date(entry.timestamp).toISOString();
    const duration = entry.durationMs ? ` (${entry.durationMs}ms)` : '';

    if (entry.type === 'thinking') {
      // Include FULL thinking content in download
      lines.push(`[${timestamp}] THINKING:`);
      lines.push('---');
      lines.push(entry.thinkingContent || '');
      lines.push('---');
      lines.push('');
    } else {
      lines.push(`[${timestamp}] ${entry.type.toUpperCase()}: ${entry.tool || entry.message || ''}${duration}`);
    }
  }

  const content = lines.join('\n');

  // Upload as file snippet (requires files:write scope)
  await client.files.uploadV2({
    channel_id: channelId,
    content,
    filename: `activity-log-${conversationKey}.txt`,
    title: 'Activity Log',
  });
});
```

### Step 12: Thread Fork Handling

Each fork starts with fresh state - no parent activity carried over:

```typescript
// When creating forked session
const state: ProcessingState = {
  status: 'starting',
  toolsCompleted: 0,
  thinkingBlockCount: 0,  // NEW
  startTime: Date.now(),
  lastUpdateTime: 0,
  activityLog: [],        // Fresh log for fork
  currentThinkingIndex: null,
  currentThinkingContent: '',
};
```

### Step 13: OAuth Scope Setup

**Required Scopes:** The download feature requires `files:write` scope.

**Setup Instructions for Users:**

1. Go to https://api.slack.com/apps → Select your app
2. Navigate to **OAuth & Permissions** in the sidebar
3. Under **Bot Token Scopes**, add:
   - `files:write` - Upload files to channels
4. Click **Reinstall App** at the top of the page
5. Users will see a new permission prompt - approve it
6. The bot can now upload activity log files

**Current Required Scopes:**
| Scope | Purpose |
|-------|---------|
| `chat:write` | Post messages and updates |
| `reactions:write` | Add emoji reactions |
| `files:write` | Upload activity log downloads |
| `channels:history` | Read channel messages |
| `groups:history` | Read private channel messages |
| `im:history` | Read DM messages |

---

## Critical Files

| File | Changes |
|------|---------|
| `src/blocks.ts` | Add `buildStatusPanelBlocks()`, `buildActivityLogText()`, `buildCollapsedActivityBlocks()`, `formatToolName()` |
| `src/slack-bot.ts` | Add `ProcessingState`, `ActivityEntry`, dual-message updates, mutex, modal/download handlers |
| `src/session-manager.ts` | Add `activityLogs` to session storage, `saveActivityLog()`, `getActivityLog()` |
| `package.json` | Add `async-mutex` dependency |

---

## Issues Addressed (all verified)

| Issue | Fix | Verified |
|-------|-----|----------|
| Cost/context only at END | Separate "during" vs "complete" layouts | ✅ |
| Tool detection | Parse `stream_event` for `content_block_start` with `tool_use` | ✅ |
| Thinking detection | Parse `stream_event` for `thinking` blocks | ✅ |
| Abort race condition | **Mutex** - serializes all updates | ✅ |
| Tool name edge cases | Handle MCP and direct names | ✅ |
| Thread fork state | Fresh ProcessingState per fork | ✅ |
| Native streaming for Block Kit | Use chat.update instead | ✅ |
| Rate limit (50/min) | 3s throttle × 2 msgs = ~40/min | ✅ |
| Activity log preservation | Store in sessions.json, modal view | ✅ |
| Long activity logs | Rolling window (>300 entries) + modal pagination | ✅ |
| Extended thinking | Truncate to 500 chars live, full in modal/download | ✅ |
| No-tools case | Summary shows "Completed in X.Xs" (omits tool count) | ✅ |
| Modal size limits | In-place pagination (15 entries/page) | ✅ |
| Activity log unavailable | Error modal with explanation | ✅ |
| OAuth scope for download | Document `files:write` setup | ✅ |

---

## Verification

1. Send message requiring multiple tools (e.g., "read file X and edit Y")
2. Verify **two messages** appear: status panel + activity log
3. Verify **thinking blocks** appear with truncated content (500 chars)
4. Verify **tool activity** shows start/complete with emojis
5. Verify updates happen every ~3 seconds
6. Verify **rolling window** triggers if >300 entries
7. Verify **at completion**:
   - Status panel shows full stats (tokens, context %, cost)
   - Activity log collapses to summary: "X thinking + Y tools in Z.Zs"
8. Click "View Log":
   - Modal shows paginated content with Prev/Next
   - Full thinking content shown (not truncated)
9. Click "Download .txt":
   - File uploaded with FULL thinking content
10. Test **no-tools case** (simple question):
   - Summary shows "Completed in X.Xs" (no tool count)
11. Test **unavailable log**:
   - Error modal shows explanation
12. Verify Abort button works - both messages update, no further updates
13. Test in thread fork - should start fresh, independent logs
14. Monitor rate limits: ~40 updates/min max

---

## Verified Assumptions

| Assumption | Verified? | Evidence |
|------------|-----------|----------|
| `total_cost_usd` exists | ✅ YES | SDK types lines 315, 328 |
| `contextWindow` exists | ✅ YES | SDK types line 17 (ModelUsage) |
| `stream_event` message type | ✅ YES | SDK types: `SDKPartialAssistantMessage` with `type: 'stream_event'` |
| `content_block_start` event | ✅ YES | Anthropic docs + SDK: `BetaRawContentBlockStartEvent` |
| `content_block_delta` event | ✅ YES | Anthropic docs + SDK: `BetaRawContentBlockDeltaEvent` |
| `content_block_stop` event | ✅ YES | Anthropic docs + SDK: `BetaRawContentBlockStopEvent` |
| `thinking` content block type | ✅ YES | SDK: `BetaThinkingBlock` with `{ type: 'thinking', thinking: string }` |
| `thinking_delta` delta type | ✅ YES | SDK: `BetaThinkingDelta` with `{ type: 'thinking_delta', thinking: string }` |
| `tool_use` content block type | ✅ YES | SDK: `BetaToolUseBlock` with `{ type: 'tool_use', name: string, id: string }` |
| `parent_tool_use_id` for tool results | ✅ YES | SDK types - distinguishes tool results from user messages |
| Native streaming text-only | ✅ YES | Block Kit not supported |
| Abort race condition | ✅ REAL | Fix: Mutex |
| Modal pagination via views.update | ✅ YES | Slack API |
| Modal 100 blocks / 3k chars limits | ✅ YES | Slack docs |
| files.uploadV2 for download | ✅ YES | Slack API (requires files:write scope) |

### Stream Event JSON Structure (Verified)

**Thinking block start:**
```json
{"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}
```

**Thinking delta:**
```json
{"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Let me solve..."}}
```

**Tool use block start:**
```json
{"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_01...", "name": "Read", "input": {}}}
```

**Block stop:**
```json
{"type": "content_block_stop", "index": 0}
```

## Confidence: 95%

All assumptions verified with:
- Official Anthropic documentation
- SDK TypeScript type definitions (`BetaThinkingBlock`, `BetaToolUseBlock`, etc.)
- Exact JSON structure confirmed

Architecture is solid:
- SDK fields confirmed in type definitions
- Stream event structure fully documented
- Dual-message approach avoids thread collision
- Mutex guarantees no misleading abort state
- Rate limits safe at 3s interval
- Rolling window prevents Slack message limits
- Thinking truncation keeps live view readable
- Full content preserved for modal/download
