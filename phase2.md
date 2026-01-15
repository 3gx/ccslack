# Phase 2: Interactive Questions via MCP - Implementation Plan

## Overview

Phase 2 enhances the MCP-based user interaction system with improved UI, multi-select support, abort commands, persistence, and message queuing.

**Timeline:** 10-14 days (Weeks 3-4 per slack-bot-v13.md)

---

## Current State (Phase 1 Complete)

| Component | Status | Location |
|-----------|--------|----------|
| MCP `ask_user` tool | ✅ | `src/mcp-server.ts:89-196` |
| MCP `approve_action` tool | ✅ | `src/mcp-server.ts:282-340` |
| File-based IPC | ✅ | `/tmp/ccslack-answers/*.json` |
| Button click handlers | ✅ | `src/slack-bot.ts:202-272` |
| Free text modal | ✅ | `src/slack-bot.ts:274-338` |
| Abort button | ✅ | Writes `__ABORTED__` to file |
| Streaming | ✅ | Native + fallback modes |

---

## Phase 2 Components

### 1. Enhanced Block Kit UI (`src/blocks.ts`) - NEW FILE

**Purpose:** Centralize Block Kit construction with richer formatting.

**Features:**
- Question blocks with header styling
- Code block support for technical questions
- Better visual hierarchy with dividers
- Confirmation context for approvals

**Implementation:**
```typescript
// src/blocks.ts
export function buildQuestionBlocks(params: {
  question: string;
  options?: string[];
  questionId: string;
  multiSelect?: boolean;
  codeContext?: string;
}): Block[];

export function buildApprovalBlocks(params: {
  action: string;
  details?: string;
  questionId: string;
}): Block[];

export function buildReminderBlocks(params: {
  originalQuestion: string;
  questionId: string;
  waitTime: string;
}): Block[];
```

**Files to modify:**
- Create `src/blocks.ts`
- Update `src/mcp-server.ts` to use new block builders

---

### 2. Multi-Select Support

**Current:** Single-select buttons only (1 click = 1 answer)

**Enhancement:** Use `multi_static_select` for multiple choices.

**Logic:**
- If `multiSelect: true` → use select menu
- If `options.length > 5` → use select menu (too many buttons)
- Otherwise → use buttons

**Implementation in `src/blocks.ts`:**
```typescript
if (multiSelect || options.length > 5) {
  // Multi-select dropdown
  blocks.push({
    type: "section",
    block_id: `multiselect_${questionId}`,
    text: { type: "mrkdwn", text: question },
    accessory: {
      type: "multi_static_select",
      action_id: `multiselect_${questionId}`,
      placeholder: { type: "plain_text", text: "Select options..." },
      options: options.map(opt => ({
        text: { type: "plain_text", text: opt },
        value: opt
      }))
    }
  });

  // IMPORTANT: Submit button required - multi_static_select doesn't auto-submit
  blocks.push({
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "Submit" },
      action_id: `multiselect_submit_${questionId}`,
      style: "primary"
    }]
  });
}
```

**New handlers in `src/slack-bot.ts`:**
```typescript
// Track pending multi-select selections
const pendingSelections = new Map<string, string[]>();

// Handle selection changes (store but don't submit yet)
app.action(/^multiselect_(.+)$/, async ({ action, ack }) => {
  await ack();
  const questionId = action.action_id.replace('multiselect_', '');
  const selections = action.selected_options?.map(o => o.value) || [];
  pendingSelections.set(questionId, selections);
});

// Handle submit button click
app.action(/^multiselect_submit_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();
  const questionId = action.action_id.replace('multiselect_submit_', '');
  const selections = pendingSelections.get(questionId) || [];
  const answer = selections.join(', ');
  writeAnswerFile(questionId, answer);
  pendingSelections.delete(questionId);

  // Update message to show selections
  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `You selected: *${answer}*`,
    blocks: []
  });
});
```

**Files to modify:**
- `src/blocks.ts` (new)
- `src/slack-bot.ts` (add multiselect handler)
- `src/mcp-server.ts` (update ask_user schema to accept multiSelect param)

---

### 3. Abort Button During Processing (NO NEW FILE)

**Current:** No way to abort while Claude is processing.

**Enhancement:** Show "Abort" button while :eyes: reaction is active, like pressing Escape in CLI.

**UX Flow:**
1. User sends message → :eyes: reaction added
2. Bot posts status message with red "⛔ Abort" button
3. User can click Abort anytime during processing
4. When done → button replaced with green "✅ Done" label

**Implementation in `src/slack-bot.ts`:**
```typescript
// Track active queries for abort capability
const activeQueries = new Map<string, {
  abortController: AbortController;
  statusMsgTs: string;
}>();

// When starting Claude query
const abortController = new AbortController();
const statusMsg = await client.chat.postMessage({
  channel: channelId,
  thread_ts: threadTs,
  blocks: [{
    type: "section",
    text: { type: "mrkdwn", text: "🔄 _Processing..._" }
  }, {
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "⛔ Abort" },
      style: "danger",
      action_id: `abort_query_${originalTs}`,
    }]
  }]
});

activeQueries.set(channelId, { abortController, statusMsgTs: statusMsg.ts });

// In streaming loop - check abort signal
for await (const msg of claudeStream) {
  if (abortController.signal.aborted) {
    await streamSession.error("Aborted by user");
    break;
  }
  // ... process message
}

// When done - update to green "Done" label
await client.chat.update({
  channel: channelId,
  ts: statusMsg.ts,
  blocks: [{
    type: "section",
    text: { type: "mrkdwn", text: "✅ *Done*" }
  }]
});
activeQueries.delete(channelId);
```

**Abort button handler:**
```typescript
app.action(/^abort_query_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();
  const originalTs = action.action_id.replace('abort_query_', '');
  const channelId = body.channel.id;

  const active = activeQueries.get(channelId);
  if (active) {
    active.abortController.abort();

    // Update status to "Aborted"
    await client.chat.update({
      channel: channelId,
      ts: active.statusMsgTs,
      blocks: [{
        type: "section",
        text: { type: "mrkdwn", text: "🛑 *Aborted*" }
      }]
    });
    activeQueries.delete(channelId);
  }
});
```

**Benefits:**
- No special commands to learn
- Visual feedback during processing
- Consistent with button-based UX
- Same mental model as Escape in terminal

**GUARANTEED Abort via SDK `interrupt()` Method:**

The Claude SDK Query object has a built-in `interrupt()` method - this is exactly how ESC works in the CLI:

```typescript
// The Query interface includes:
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;  // Immediately stops execution
}
```

**Implementation in `src/claude-client.ts`:**
```typescript
import { query, Query } from '@anthropic-ai/claude-code';

// Return the Query object so caller can call interrupt()
export function streamClaude(
  prompt: string,
  options: StreamOptions
): Query {
  const queryOptions = {
    outputFormat: 'stream-json',
    permissionMode: 'bypassPermissions',
    systemPrompt: 'claude_code',
    cwd: options.workingDir,
    resume: options.sessionId,
    // Pass abort controller for additional safety
    abortController: options.abortController,
  };

  return query({ prompt, options: queryOptions });
}
```

**Implementation in `src/slack-bot.ts`:**
```typescript
// Track active queries for TRUE abortion
const activeQueries = new Map<string, {
  query: Query;
  statusMsgTs: string;
}>();

// When starting Claude query:
const abortController = new AbortController();
const claudeQuery = streamClaude(userText, {
  ...options,
  abortController,
});

activeQueries.set(conversationKey, { query: claudeQuery, statusMsgTs: statusMsg.ts });

// In streaming loop:
try {
  for await (const msg of claudeQuery) {
    // Process messages...
  }
} finally {
  activeQueries.delete(conversationKey);
}
```

**Abort button handler - TRUE ABORTION:**
```typescript
app.action(/^abort_query_(.+)$/, async ({ action, ack, body, client }) => {
  await ack();
  const channelId = body.channel.id;
  const conversationKey = getConversationKey(channelId, body.message?.thread_ts);

  const active = activeQueries.get(conversationKey);
  if (active) {
    // TRUE ABORTION - same as ESC in CLI
    await active.query.interrupt();
    console.log(`Interrupted query for: ${conversationKey}`);

    await client.chat.update({
      channel: channelId,
      ts: active.statusMsgTs,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "🛑 *Aborted*" }}]
    });
    activeQueries.delete(conversationKey);
  }
});
```

**Why this is GUARANTEED:**
- `interrupt()` is the official SDK method for stopping execution
- Same mechanism used by CLI when ESC is pressed
- Properly signals the underlying Claude Code process
- No background execution continues

**Files to modify:**
- `src/slack-bot.ts` (add status message, abort handler, AbortController tracking)
- `src/claude-client.ts` (add signal check in streaming loop)

---

### 4. Busy State Handling (NO NEW FILE)

**Current:** Messages processed immediately, can interrupt pending questions.

**Enhancement:** Simple "I'm busy" response when Claude is processing.

**Implementation in `src/slack-bot.ts`:**
```typescript
// Track if currently processing per channel+thread (not just channel)
const busyConversations = new Set<string>();

// Helper to get conversation key
function getConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}_${threadTs}` : channelId;
}

// In handleMessage(), before processing:
const conversationKey = getConversationKey(channelId, threadTs);
if (busyConversations.has(conversationKey)) {
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "⏳ I'm busy with the current request. Please wait for it to complete, or click Abort."
  });
  return;
}

// Mark busy when starting
busyConversations.add(conversationKey);

// Clear when done (in finally block)
busyConversations.delete(conversationKey);
```

**Note:** This allows concurrent processing in different threads while blocking duplicate requests in the same conversation.

**Benefits:**
- No queuing complexity
- User knows to wait or abort
- Simple in-memory Set tracking

**Files to modify:**
- `src/slack-bot.ts` (add busy state check)

---

### 5. Daily Reminders (In-Memory Only)

**Current:** Not implemented.

**Enhancement:** Send reminders for unanswered questions while bot is running.

**Note:** Reminders are in-memory only. If bot restarts, reminders are lost - user just asks again (same as CLI crash).

**Implementation in `src/mcp-server.ts`:**
```typescript
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_REMINDERS = 7; // Stop after a week
const reminderIntervals = new Map<string, NodeJS.Timeout>();
const reminderCounts = new Map<string, number>();

function startReminder(questionId: string, question: string, channelId: string, threadTs?: string) {
  const interval = setInterval(async () => {
    const count = reminderCounts.get(questionId) || 0;

    if (count >= MAX_REMINDERS) {
      // Auto-expire after max reminders
      clearInterval(interval);
      reminderIntervals.delete(questionId);
      reminderCounts.delete(questionId);
      // Write abort to trigger MCP to stop waiting
      writeAbortFile(questionId);
      return;
    }

    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `⏰ Reminder: I'm still waiting for your answer to:\n"${question}"`
    });

    reminderCounts.set(questionId, count + 1);
  }, REMINDER_INTERVAL_MS);

  reminderIntervals.set(questionId, interval);
}

// Clear reminder when question answered
function clearReminder(questionId: string) {
  const interval = reminderIntervals.get(questionId);
  if (interval) {
    clearInterval(interval);
    reminderIntervals.delete(questionId);
    reminderCounts.delete(questionId);
  }
}
```

**Integration Point - Where to call startReminder():**
```typescript
// In handleAskUser() after posting question to Slack:
const msg = await slack.chat.postMessage({
  channel: slackContext.channel,
  thread_ts: slackContext.threadTs,
  blocks: buildQuestionBlocks(question, options, questionId)
});

// Start reminder AFTER posting question
startReminder(questionId, question, slackContext.channel, slackContext.threadTs);

// In waitForAnswer() after getting answer:
const answer = await waitForAnswer(questionId);
clearReminder(questionId);  // Stop reminder when answered
return answer;
```

**Files to modify:**
- `src/mcp-server.ts` (add reminder logic, integrate with ask_user flow)

---

## File Structure (After Phase 2)

```
src/
├── index.ts              # Entry point (unchanged)
├── slack-bot.ts          # Event handlers (add multiselect, abort button, busy state)
├── mcp-server.ts         # MCP tools (use blocks.ts, add reminders)
├── claude-client.ts      # SDK wrapper (unchanged)
├── session-manager.ts    # Session storage (unchanged)
├── streaming.ts          # Slack streaming (unchanged)
├── concurrent-check.ts   # Process detection (unchanged, disabled)
├── blocks.ts             # NEW: Block Kit builders
└── __tests__/
    ├── unit/
    │   ├── blocks.test.ts        # NEW
    │   └── ... (existing)
    └── integration/
        └── ... (existing)
```

---

## Implementation Order

| Day | Task | Files |
|-----|------|-------|
| 1-2 | Block Kit builders | `src/blocks.ts`, update `mcp-server.ts` |
| 3 | Multi-select support | `src/blocks.ts`, `src/slack-bot.ts` |
| 4 | Abort button + busy state | `src/slack-bot.ts` (AbortController, status msg) |
| 5-6 | Daily reminders (in-memory) | `src/mcp-server.ts` |
| 7-8 | Unit tests | `src/__tests__/unit/blocks.test.ts` |
| 9 | Integration tests, bug fixes | All files |

**Total: ~9 days**

---

## Dependencies to Add

No new dependencies needed! (Removed SQLite requirement)

---

## Testing Strategy

### Unit Tests

| Module | Test Cases |
|--------|------------|
| `blocks.ts` | Question blocks, approval blocks, multiselect blocks |
| `slack-bot.ts` | Abort button handler, status message updates, busy state |

### Integration Tests

| Scenario | Verification |
|----------|--------------|
| Multi-select flow | Select multiple options → answer contains all selections |
| Abort button | Click abort during processing → query stopped, "Aborted" shown |
| Status message flow | Processing shows red abort → Done shows green label |
| Busy state | Send message while busy → "I'm busy" response |

### Manual Testing

1. **Multi-select:** Ask question with 6+ options → verify dropdown appears
2. **Abort button:** Send message, click red "Abort" button → verify "Aborted" status
3. **Done status:** Send message, wait for response → verify green "Done" label
4. **Busy state:** Send message while processing → verify "I'm busy" response

---

## Success Criteria

- [ ] Multi-select questions show dropdown menu for >5 options
- [ ] Red "Abort" button shown during processing, clickable to stop query
- [ ] Green "Done" label shown after processing completes
- [ ] "I'm busy" response when message sent during processing
- [ ] Reminders sent after 24 hours (in-memory, lost on restart)
- [ ] `make test` passes with all new tests

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Reminder spam | Max 7 reminders, then auto-expire |
| Abort race condition | Check active query exists before aborting |
| Busy state not cleared | Use try/finally to always clear busyChannels |

---

## Verification Commands

```bash
# Run all tests
make test

# Run only Phase 2 tests (Vitest syntax)
npx vitest run --filter "blocks"

# Manual test multi-select
# In Slack: @claude what languages do you know? (give 6+ options)

# Manual test abort button
# In Slack: @claude explain quantum computing in detail
# While processing: Click the red "⛔ Abort" button
# Verify: Status changes to "🛑 Aborted"

# Manual test done status
# In Slack: @claude what is 2+2?
# Wait for response
# Verify: Status shows "✅ Done"

# Manual test busy state
# In Slack: @claude explain something long
# While processing: Send another message
# Verify: "I'm busy" response
```
