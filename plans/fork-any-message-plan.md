# Point-in-Time Thread Forking

## Summary

**Goal:** Enable thread forking from the exact conversation state at the parent message timestamp, not from the latest state.

**Current Behavior (WRONG):**
```
Main: A → B → C → D
User replies in thread to B
Thread forks from D (latest) → includes A, B, C, D ❌
```

**Desired Behavior (CORRECT):**
```
Main: A → B → C → D
User replies in thread to B
Thread forks from B → includes only A, B ✅
```

**Why This Matters:**
- Users want "what if" scenarios from any point in conversation
- Current behavior confuses threads with future context they shouldn't have
- SDK already supports this via `resumeSessionAt` parameter

---

## Technical Background

### SDK Capability

The Claude Code SDK supports point-in-time forking via `resumeSessionAt` parameter:

```typescript
sdk.query({
  resume: parentSessionId,
  forkSession: true,
  resumeSessionAt: "msg_017pagAKz...",  // Assistant message ID
  // Creates forked session with history up to this message only
});
```

**Key Requirements:**
- `resumeSessionAt` must be an **assistant message ID** (from `SDKAssistantMessage.message.id`)
- Assistant message IDs look like: `"msg_017pagAKz..."` or `"msg_bdrk_01Tp3g..."`
- User messages don't have message IDs (only assistant responses do)

### The Challenge

**Problem:** When user replies to Slack message with `thread_ts = "1234.002"`, we need to find the corresponding SDK assistant message ID.

**Current State:**
- Slack timestamps: `"1234.001"`, `"1234.002"`, `"1234.003"`
- SDK message IDs: `"msg_017pagAKz..."`, `"msg_bdrk_01Tp3..."`
- **No direct correlation exists between them**

### The Solution: Proactive Message Mapping

**Strategy:** Store mappings as messages are posted, look them up when creating thread forks.

```typescript
// After posting bot response to Slack
messageMap: {
  "1234.001": { sdkMessageId: "msg_017pagAKz...", type: "user" },
  "1234.002": { sdkMessageId: "msg_bdrk_01Tp3...", type: "assistant" },
  "1234.003": { sdkMessageId: "msg_019AbCd...", type: "assistant" },
}

// When thread created at "1234.002"
const mapping = messageMap["1234.002"];
// Use mapping.sdkMessageId for resumeSessionAt
```

---

## Architecture Changes

### Data Structures

**Add to `src/session-manager.ts`:**

```typescript
/**
 * Maps Slack message timestamps to SDK message IDs
 */
export interface SlackMessageMapping {
  /** SDK message ID (e.g., "msg_017pagAKz...") */
  sdkMessageId: string;

  /** Message type */
  type: 'user' | 'assistant';

  /** Parent Slack timestamp - links assistant response to user message that triggered it */
  parentSlackTs?: string;

  /** True if this is a continuation of a split message (not the first part) */
  isContinuation?: boolean;
}

export interface ChannelSession extends Session {
  threads?: Record<string, ThreadSession>;

  /** NEW: Map of Slack ts → SDK message ID */
  messageMap?: Record<string, SlackMessageMapping>;
}

export interface ThreadSession extends Session {
  forkedFrom: string;

  /** NEW: SDK message ID this thread forked from (for resumeSessionAt) */
  resumeSessionAtMessageId?: string;
}
```

**Storage Example:**

```json
{
  "channels": {
    "C123": {
      "sessionId": "abc-123",
      "workingDir": "/Users/egx/ai/ccslack",
      "messageMap": {
        "1234.001": {
          "sdkMessageId": "msg_user_001",
          "type": "user"
        },
        "1234.002": {
          "sdkMessageId": "msg_017pagAKz...",
          "type": "assistant",
          "parentSlackTs": "1234.001"
        },
        "1234.003": {
          "sdkMessageId": "msg_user_002",
          "type": "user"
        },
        "1234.004": {
          "sdkMessageId": "msg_bdrk_01Tp3...",
          "type": "assistant",
          "parentSlackTs": "1234.003"
        }
      },
      "threads": {
        "1234.002": {
          "sessionId": "forked-456",
          "forkedFrom": "abc-123",
          "resumeSessionAtMessageId": "msg_017pagAKz..."
        }
      }
    }
  }
}
```

---

## Implementation Plan

### Phase 1: Capture Message Mappings

**Goal:** Store Slack timestamp → SDK message ID mappings as messages are posted.

#### Step 1.1: Add Storage for Message Mappings

**File:** `src/session-manager.ts`

**Add interfaces** (see Data Structures section above):
- `SlackMessageMapping`
- Update `ChannelSession` to add `messageMap?: Record<string, SlackMessageMapping>`
- Update `ThreadSession` to add `resumeSessionAtMessageId?: string`

**Add helper functions** (after existing session functions):

```typescript
/**
 * Save a message mapping (Slack ts → SDK message ID)
 */
export function saveMessageMapping(
  channelId: string,
  slackTs: string,
  mapping: SlackMessageMapping
): void {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    console.warn(`Cannot save message mapping - channel ${channelId} has no session`);
    return;
  }

  // Initialize messageMap if needed
  if (!channelSession.messageMap) {
    channelSession.messageMap = {};
  }

  channelSession.messageMap[slackTs] = mapping;
  saveSessions(store);
}

/**
 * Get a message mapping by Slack timestamp
 */
export function getMessageMapping(
  channelId: string,
  slackTs: string
): SlackMessageMapping | null {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession?.messageMap) {
    return null;
  }

  return channelSession.messageMap[slackTs] ?? null;
}

/**
 * Find the SDK message ID to fork from, given a parent Slack timestamp
 *
 * Logic:
 * - If parent is assistant message: Use it directly
 * - If parent is user message: Find the LAST assistant message BEFORE this timestamp
 *   (not the response TO this message - we want past context, not future)
 */
export function findForkPointMessageId(
  channelId: string,
  parentSlackTs: string
): string | null {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession?.messageMap) {
    console.warn(`No message map found for channel ${channelId}`);
    return null;
  }

  const mapping = channelSession.messageMap[parentSlackTs];

  // If parent is assistant message, use it directly
  if (mapping?.type === 'assistant') {
    return mapping.sdkMessageId;
  }

  // Parent is user message (or not found) - find last assistant message BEFORE this timestamp
  // Sort all timestamps and find the most recent assistant message before parentSlackTs
  const sortedTimestamps = Object.keys(channelSession.messageMap)
    .filter(ts => ts < parentSlackTs)  // Only messages BEFORE the parent
    .sort((a, b) => parseFloat(b) - parseFloat(a));  // Sort descending (most recent first)

  for (const ts of sortedTimestamps) {
    const msg = channelSession.messageMap[ts];
    if (msg.type === 'assistant') {
      console.log(`Found last assistant message at ${ts} (before ${parentSlackTs})`);
      return msg.sdkMessageId;
    }
  }

  console.warn(`No assistant message found before ${parentSlackTs}`);
  return null;
}
```

#### Step 1.2: Capture User Message Timestamps

**File:** `src/slack-bot.ts`

**Location:** In `app.message` handler, after detecting thread vs main channel

**Current code** (around line 150-160):
```typescript
// Get or create session for this channel/thread
const session = thread_ts
  ? await getOrCreateThreadSession(channel, thread_ts, parentSession)
  : parentSession;
```

**Add BEFORE this** (to capture user message timestamp):
```typescript
// Capture user message timestamp for message mapping
if (!thread_ts) {
  // Main channel message - save user message mapping
  saveMessageMapping(channel, ts, {
    sdkMessageId: `user_${ts}`, // Placeholder - user messages don't have SDK IDs
    type: 'user',
  });
}
```

**Import at top:**
```typescript
import {
  getSession,
  saveSession,
  saveThreadSession,
  getOrCreateThreadSession,
  deleteSession,
  saveMessageMapping,  // ADD THIS
  findForkPointMessageId,  // ADD THIS
} from './session-manager.js';
```

#### Step 1.3: Extract Assistant Message IDs from SDK Stream

**File:** `src/slack-bot.ts`

**Location:** In `app.message` handler, in the stream processing loop

**Current code** (around line 230-240):
```typescript
for await (const chunk of stream) {
  if (chunk.type === 'init') {
    // Capture session ID
    if (!session.sessionId && chunk.session_id) {
      session.sessionId = chunk.session_id;
      // Save session...
    }
  }
  // ... handle other chunk types
}
```

**Add AFTER the `init` chunk handler**:
```typescript
if (chunk.type === 'init') {
  // Existing session ID capture code...
}

// NEW: Capture assistant message ID for message mapping
if (chunk.type === 'message' && chunk.message?.id) {
  const assistantMessageId = chunk.message.id;
  console.log(`[Mapping] Captured assistant message ID: ${assistantMessageId}`);

  // Store for later (we'll link it to Slack ts after posting)
  // Use a temporary variable to pass to postSplitResponse
  currentAssistantMessageId = assistantMessageId;
}
```

**Add variable at function scope** (top of message handler):
```typescript
let currentAssistantMessageId: string | null = null;
```

#### Step 1.4: Link Assistant Message IDs to Slack Timestamps

**File:** `src/slack-bot.ts`

**Location:** After `postSplitResponse` completes

**Current code** (around line 300):
```typescript
const slackMessages = await postSplitResponse(
  client,
  channel,
  text,
  threadTs,
  messageMap
);
```

**Add AFTER this**:
```typescript
// Link assistant message ID to Slack timestamps (including split messages)
if (currentAssistantMessageId && slackMessages.length > 0 && !thread_ts) {
  const userMessageTs = ts; // Original user message timestamp

  // Map ALL split message timestamps to the same SDK message ID
  slackMessages.forEach((slackMsg, index) => {
    const isFirst = index === 0;

    saveMessageMapping(channel, slackMsg.ts, {
      sdkMessageId: currentAssistantMessageId,
      type: 'assistant',
      parentSlackTs: isFirst ? userMessageTs : undefined,  // Only first links to user message
      isContinuation: !isFirst,  // Mark continuations
    });

    console.log(`[Mapping] Linked Slack ts ${slackMsg.ts} → SDK ${currentAssistantMessageId}${!isFirst ? ' (continuation)' : ''}`);
  });
}
```

**Note:** `postSplitResponse` needs to return Slack message timestamps. See Step 1.5.

#### Step 1.5: Update `postSplitResponse` to Return Timestamps

**File:** `src/streaming.ts`

**Current signature** (around line 80):
```typescript
export async function postSplitResponse(
  client: WebClient,
  channel: string,
  text: string,
  thread_ts?: string,
  initialMessageTs?: string
): Promise<void>
```

**Update to**:
```typescript
export async function postSplitResponse(
  client: WebClient,
  channel: string,
  text: string,
  thread_ts?: string,
  initialMessageTs?: string
): Promise<Array<{ ts: string }>>  // CHANGED: Now returns timestamps
```

**Update return statements**:
```typescript
// Collect posted message timestamps
const postedMessages: Array<{ ts: string }> = [];

// When posting first message
const result = await client.chat.postMessage({ ... });
postedMessages.push({ ts: result.ts as string });

// When posting subsequent messages
const result = await client.chat.postMessage({ ... });
postedMessages.push({ ts: result.ts as string });

// At end of function
return postedMessages;
```

---

### Phase 2: Use Mappings for Point-in-Time Forking

**Goal:** When creating thread forks, find the SDK message ID for the parent and pass `resumeSessionAt` to SDK.

#### Step 2.1: Find Fork Point Message ID

**File:** `src/slack-bot.ts`

**Location:** In `app.message` handler, when creating thread session

**Current code** (around line 155):
```typescript
const session = thread_ts
  ? await getOrCreateThreadSession(channel, thread_ts, parentSession)
  : parentSession;
```

**Replace with**:
```typescript
let session: Session;
let resumeSessionAtMessageId: string | null = null;

if (thread_ts) {
  // Thread message - find fork point for point-in-time forking
  resumeSessionAtMessageId = findForkPointMessageId(channel, thread_ts);

  if (resumeSessionAtMessageId) {
    console.log(`[Fork] Thread will fork from message ${resumeSessionAtMessageId}`);
  } else {
    console.warn(`[Fork] No message mapping found for ${thread_ts} - will fork from latest state`);
  }

  session = await getOrCreateThreadSession(
    channel,
    thread_ts,
    parentSession,
    resumeSessionAtMessageId  // NEW parameter
  );
} else {
  session = parentSession;
}
```

#### Step 2.2: Update `getOrCreateThreadSession` to Accept Message ID

**File:** `src/session-manager.ts`

**Current signature** (around line 140):
```typescript
export async function getOrCreateThreadSession(
  channelId: string,
  threadTs: string,
  parentSession: Session
): Promise<ThreadSession>
```

**Update to**:
```typescript
export async function getOrCreateThreadSession(
  channelId: string,
  threadTs: string,
  parentSession: Session,
  resumeSessionAtMessageId?: string | null  // NEW parameter
): Promise<ThreadSession>
```

**Inside function** (when creating new thread session):
```typescript
// Create new thread session by forking
const threadSession: ThreadSession = {
  ...parentSession,
  sessionId: null, // Will be set by SDK
  forkedFrom: parentSession.sessionId,
  resumeSessionAtMessageId: resumeSessionAtMessageId ?? undefined,  // NEW
};

saveThreadSession(channelId, threadTs, threadSession);
```

#### Step 2.3: Pass `resumeSessionAt` to SDK

**File:** `src/claude-client.ts`

**Current code** (around line 62-66):
```typescript
if (options.forkSession) {
  // Fork from the parent session - creates a new session with shared history
  queryOptions.resume = options.sessionId;
  queryOptions.forkSession = true;
  console.log(`Forking from session: ${options.sessionId}`);
}
```

**Update to**:
```typescript
if (options.forkSession) {
  // Fork from the parent session - creates a new session with shared history
  queryOptions.resume = options.sessionId;
  queryOptions.forkSession = true;

  // NEW: Add resumeSessionAt for point-in-time forking
  if (options.resumeSessionAt) {
    queryOptions.resumeSessionAt = options.resumeSessionAt;
    console.log(`Forking from session ${options.sessionId} at message ${options.resumeSessionAt}`);
  } else {
    console.log(`Forking from session ${options.sessionId} (latest state)`);
  }
}
```

**Update interface** (around line 15):
```typescript
export interface QueryOptions {
  prompt: string;
  sessionId: string | null;
  cwd: string;
  mode: 'plan' | 'auto' | 'default';
  forkSession?: boolean;
  resumeSessionAt?: string;  // NEW
  onApprovalNeeded?: (tool: string, args: unknown) => Promise<boolean>;
  onAskUser?: (question: string) => Promise<string>;
}
```

#### Step 2.4: Pass Fork Point from Session to SDK

**File:** `src/slack-bot.ts`

**Location:** When calling `runClaude()`

**Current code** (around line 180):
```typescript
const stream = await runClaude({
  prompt: text,
  sessionId: session.sessionId,
  cwd: session.workingDir,
  mode: session.mode || 'plan',
  forkSession: !!thread_ts && !session.sessionId,
  // ... other options
});
```

**Add**:
```typescript
const stream = await runClaude({
  prompt: text,
  sessionId: session.sessionId,
  cwd: session.workingDir,
  mode: session.mode || 'plan',
  forkSession: !!thread_ts && !session.sessionId,
  resumeSessionAt: (session as ThreadSession).resumeSessionAtMessageId,  // NEW
  // ... other options
});
```

---

### Phase 3: Edge Cases and Polish

#### Edge Case 1: User Replies to Their Own User Message

**Problem:** SDK's `resumeSessionAt` requires an ASSISTANT message ID, but user might reply to their own message (which has no SDK message ID).

**Key Insight:** We want to fork from the LAST assistant response BEFORE the user message, not the next one after it. Reasons:
- User might reply to a message that has no bot response yet
- Semantically correct: fork from what the bot knew at that point in time
- Avoids including "future" context in the fork

**Solution:** `findForkPointMessageId()` finds the most recent assistant message with timestamp < user message timestamp.

**Example Scenario:**
```
Timeline:
  1234.001  User: "What is 2+2?"
  1234.002  Bot:  "It's 4"           ← SDK msg_001
  1234.003  User: "Let me think..."  ← User replies HERE in thread
  1234.004  Bot:  "Sure, take your time" ← SDK msg_002
```

**Desired Behavior:**
```
User clicks "Reply in thread" on 1234.003 (their own message)
  → findForkPointMessageId("1234.003")
  → Find last assistant message WHERE ts < "1234.003"
  → Returns "msg_001" (from 1234.002)
  → Thread forks with history: [2+2, It's 4] ✅
  → Does NOT include "Sure, take your time" (that's in the future)
```

**Wrong Behavior (what we're avoiding):**
```
User clicks "Reply in thread" on 1234.003
  → Find assistant response TO this message
  → Returns "msg_002" (from 1234.004)
  → Thread would include future context ❌
```

#### Edge Case 2: Old Threads (Before Message Mapping)

**Problem:** Existing channels won't have message mappings yet.

**Solution:** Graceful degradation
- If `findForkPointMessageId()` returns `null`, log warning and fork from latest state
- Already handled in Step 2.1: `console.warn(...)`
- Threads created after deployment will have correct mappings

**User Impact:**
- Old threads: Fork from latest state (current behavior, no regression)
- New threads: Fork from point-in-time (new behavior)

#### Edge Case 3: Split Messages (Multiple Slack Messages)

**Problem:** Long assistant responses split into multiple Slack messages. User might click "Reply in thread" on any of them.

**Solution:** Map ALL split message timestamps to the same SDK message ID, marking continuations.

**Example Scenario:**
```
User: "Explain quantum computing"     [ts: 1234.001]
Bot:  "Quantum computing is... (part 1)"  [ts: 1234.002]  ← First message
Bot:  "...furthermore... (part 2)"        [ts: 1234.003]  ← Continuation
Bot:  "...in conclusion... (part 3)"      [ts: 1234.004]  ← Continuation
```

**Storage:**
```json
{
  "1234.001": { "sdkMessageId": "user_001", "type": "user" },
  "1234.002": { "sdkMessageId": "msg_017pagAKz", "type": "assistant", "parentSlackTs": "1234.001" },
  "1234.003": { "sdkMessageId": "msg_017pagAKz", "type": "assistant", "isContinuation": true },
  "1234.004": { "sdkMessageId": "msg_017pagAKz", "type": "assistant", "isContinuation": true }
}
```

**Behavior:**
| User clicks on | Lookup result | Fork point |
|----------------|---------------|------------|
| Part 1 (1234.002) | `msg_017pagAKz` | ✅ Forks correctly |
| Part 2 (1234.003) | `msg_017pagAKz` | ✅ Forks correctly |
| Part 3 (1234.004) | `msg_017pagAKz` | ✅ Forks correctly |

**Implementation:**
- `postSplitResponse` returns array of ALL posted message timestamps
- Loop through all timestamps, map each to the same SDK message ID
- First message: `isContinuation: false` (or omitted)
- Subsequent messages: `isContinuation: true`

#### Edge Case 4: Message Map Size Growth

**Problem:** Message maps could grow large over long conversations.

**Solution:** Accept growth for now, add cleanup later
- Each mapping is ~100 bytes
- 1000 messages = ~100KB (acceptable)
- Future enhancement: Trim old mappings (keep last 100 messages)

---

## Testing Strategy

### Unit Tests

**File:** `src/__tests__/unit/session-manager.test.ts`

**Add test suites:**

```typescript
describe('saveMessageMapping', () => {
  it('should save message mapping to channel session', () => {
    const session = createMockSession();
    saveSession('C123', session);

    saveMessageMapping('C123', '1234.001', {
      sdkMessageId: 'msg_017pagAKz',
      type: 'assistant',
    });

    const mapping = getMessageMapping('C123', '1234.001');
    expect(mapping?.sdkMessageId).toBe('msg_017pagAKz');
    expect(mapping?.type).toBe('assistant');
  });

  it('should handle multiple mappings', () => {
    const session = createMockSession();
    saveSession('C123', session);

    saveMessageMapping('C123', '1234.001', {
      sdkMessageId: 'msg_001',
      type: 'user',
    });

    saveMessageMapping('C123', '1234.002', {
      sdkMessageId: 'msg_002',
      type: 'assistant',
      parentSlackTs: '1234.001',
    });

    expect(getMessageMapping('C123', '1234.001')?.sdkMessageId).toBe('msg_001');
    expect(getMessageMapping('C123', '1234.002')?.sdkMessageId).toBe('msg_002');
  });
});

describe('findForkPointMessageId', () => {
  it('should return assistant message ID directly when clicking on bot message', () => {
    const session = createMockSession();
    saveSession('C123', session);

    saveMessageMapping('C123', '1234.002', {
      sdkMessageId: 'msg_017pagAKz',
      type: 'assistant',
    });

    const messageId = findForkPointMessageId('C123', '1234.002');
    expect(messageId).toBe('msg_017pagAKz');
  });

  it('should find LAST assistant message BEFORE user message (not response to it)', () => {
    const session = createMockSession();
    saveSession('C123', session);

    // Timeline: user → bot → user (clicking here) → bot
    saveMessageMapping('C123', '1234.001', { sdkMessageId: 'user_001', type: 'user' });
    saveMessageMapping('C123', '1234.002', { sdkMessageId: 'msg_001', type: 'assistant' });
    saveMessageMapping('C123', '1234.003', { sdkMessageId: 'user_002', type: 'user' });  // User clicks HERE
    saveMessageMapping('C123', '1234.004', { sdkMessageId: 'msg_002', type: 'assistant' });  // Response AFTER

    // Should return msg_001 (before .003), NOT msg_002 (after .003)
    const messageId = findForkPointMessageId('C123', '1234.003');
    expect(messageId).toBe('msg_001');
  });

  it('should return null if no assistant message before the timestamp', () => {
    const session = createMockSession();
    saveSession('C123', session);

    // User's first message - no bot response yet
    saveMessageMapping('C123', '1234.001', { sdkMessageId: 'user_001', type: 'user' });

    const messageId = findForkPointMessageId('C123', '1234.001');
    expect(messageId).toBeNull();
  });

  it('should work with split messages (continuation)', () => {
    const session = createMockSession();
    saveSession('C123', session);

    saveMessageMapping('C123', '1234.001', { sdkMessageId: 'user_001', type: 'user' });
    saveMessageMapping('C123', '1234.002', { sdkMessageId: 'msg_001', type: 'assistant' });
    saveMessageMapping('C123', '1234.003', { sdkMessageId: 'msg_001', type: 'assistant', isContinuation: true });
    saveMessageMapping('C123', '1234.004', { sdkMessageId: 'msg_001', type: 'assistant', isContinuation: true });

    // All should return the same SDK message ID
    expect(findForkPointMessageId('C123', '1234.002')).toBe('msg_001');
    expect(findForkPointMessageId('C123', '1234.003')).toBe('msg_001');
    expect(findForkPointMessageId('C123', '1234.004')).toBe('msg_001');
  });
});
```

### Integration Tests

**File:** `src/__tests__/integration/point-in-time-fork.test.ts` (NEW FILE)

**Create new file:**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveSession,
  saveMessageMapping,
  getOrCreateThreadSession,
} from '../../session-manager.js';
import type { Session } from '../../session-manager.js';

describe('point-in-time thread forking', () => {
  const mockSession: Session = {
    sessionId: 'main-session-123',
    workingDir: '/Users/testuser/projects/myapp',
    mode: 'plan',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: true,
    configuredPath: '/Users/testuser/projects/myapp',
    configuredBy: 'U123',
    configuredAt: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create thread session with resumeSessionAtMessageId', async () => {
    // Setup channel with message mappings
    saveSession('C123', mockSession);

    saveMessageMapping('C123', '1234.001', {
      sdkMessageId: 'user_001',
      type: 'user',
    });

    saveMessageMapping('C123', '1234.002', {
      sdkMessageId: 'msg_017pagAKz',
      type: 'assistant',
      parentSlackTs: '1234.001',
    });

    // Create thread at message B
    const threadSession = await getOrCreateThreadSession(
      'C123',
      '1234.002',
      mockSession,
      'msg_017pagAKz'
    );

    // Verify thread has fork point
    expect(threadSession.resumeSessionAtMessageId).toBe('msg_017pagAKz');
    expect(threadSession.forkedFrom).toBe('main-session-123');
  });

  it('should handle thread creation without message mapping', async () => {
    // Setup channel WITHOUT message mappings
    saveSession('C123', mockSession);

    // Create thread (no fork point available)
    const threadSession = await getOrCreateThreadSession(
      'C123',
      '1234.999',
      mockSession,
      null  // No message mapping
    );

    // Should still create thread, but without resumeSessionAtMessageId
    expect(threadSession.resumeSessionAtMessageId).toBeUndefined();
    expect(threadSession.forkedFrom).toBe('main-session-123');
  });
});
```

### Manual Testing

**Scenario:** Verify point-in-time forking works end-to-end

**Setup:**
1. Start bot: `npm run dev`
2. Create test channel: `#pit-fork-test`
3. Invite bot to channel
4. Configure path: `/set-current-path`

**Test Steps:**

```markdown
# Step 1: Create conversation history
Main channel:
@Claude Code what is 2+2?
  → Bot: "It's 4"  [Message A, ts: 1234.001]

@Claude Code what is 3+3?
  → Bot: "It's 6"  [Message B, ts: 1234.002]

@Claude Code what is 4+4?
  → Bot: "It's 8"  [Message C, ts: 1234.003]

# Step 2: Fork from message B
Reply in thread to message B (ts: 1234.002):
@Claude Code what did I just ask you?

# Expected: Thread should have history up to B only
Bot should respond: "You asked me what is 3+3, and I told you it's 6."
Bot should NOT mention 4+4 (message C is in the future)

# Step 3: Verify main channel still has full history
Main channel:
@Claude Code what was the last math problem?
  → Bot should say "4+4" (latest is C)

# Step 4: Verify thread has limited history
Thread:
@Claude Code what was the last math problem?
  → Bot should say "3+3" (thread only knows up to B)
```

**Success Criteria:**
1. Thread responses don't reference messages C or later ✅
2. Thread responses DO reference messages A and B ✅
3. Main channel still has full history ✅
4. Console logs show fork point message ID ✅
5. sessions.json shows `resumeSessionAtMessageId` in thread entry ✅

---

## Critical Files

| File | Changes | Purpose |
|------|---------|---------|
| `src/session-manager.ts` | Add `SlackMessageMapping`, `messageMap`, `resumeSessionAtMessageId` | Data structures |
| `src/session-manager.ts` | Add `saveMessageMapping()`, `getMessageMapping()`, `findForkPointMessageId()` | Message mapping helpers |
| `src/session-manager.ts` | Update `getOrCreateThreadSession()` to accept `resumeSessionAtMessageId` | Pass fork point to session |
| `src/slack-bot.ts` | Capture user message timestamps | Save user message mappings |
| `src/slack-bot.ts` | Extract assistant message IDs from SDK stream | Capture SDK message IDs |
| `src/slack-bot.ts` | Link assistant IDs to Slack timestamps after posting | Create mappings |
| `src/slack-bot.ts` | Find fork point before creating thread | Lookup message mapping |
| `src/slack-bot.ts` | Pass `resumeSessionAt` to SDK | Enable point-in-time forking |
| `src/claude-client.ts` | Add `resumeSessionAt` parameter and pass to SDK | SDK integration |
| `src/streaming.ts` | Return posted message timestamps from `postSplitResponse()` | Allow linking IDs to timestamps |

---

## Verification Checklist

### Code Implementation
- [ ] Add `SlackMessageMapping` interface to session-manager.ts
- [ ] Update `ChannelSession` to include `messageMap`
- [ ] Update `ThreadSession` to include `resumeSessionAtMessageId`
- [ ] Add `saveMessageMapping()` function
- [ ] Add `getMessageMapping()` function
- [ ] Add `findForkPointMessageId()` function
- [ ] Update `getOrCreateThreadSession()` signature
- [ ] Capture user message timestamps in slack-bot.ts
- [ ] Extract assistant message IDs from stream in slack-bot.ts
- [ ] Link assistant IDs to Slack timestamps in slack-bot.ts
- [ ] Find fork point before thread creation in slack-bot.ts
- [ ] Pass fork point to `getOrCreateThreadSession()`
- [ ] Pass `resumeSessionAt` to SDK in runClaude()
- [ ] Add `resumeSessionAt` to QueryOptions interface
- [ ] Update `postSplitResponse()` to return timestamps
- [ ] Pass `resumeSessionAt` to SDK query in claude-client.ts

### Testing
- [ ] Add unit tests for `saveMessageMapping()`
- [ ] Add unit tests for `getMessageMapping()`
- [ ] Add unit tests for `findForkPointMessageId()`
- [ ] Create integration test file `point-in-time-fork.test.ts`
- [ ] Add test for thread with fork point
- [ ] Add test for thread without fork point
- [ ] Run `npm test` - all tests pass
- [ ] Run `npm run build` - TypeScript compiles

### Manual Testing
- [ ] Create conversation with 3+ messages (A, B, C)
- [ ] Reply in thread to message B
- [ ] Ask thread: "what did I just ask?" - should only know up to B
- [ ] Verify thread doesn't reference message C
- [ ] Check sessions.json for `resumeSessionAtMessageId`
- [ ] Check console logs for fork point message ID
- [ ] Verify main channel still has full history

### Edge Cases
- [ ] Test replying to user message (should find assistant response)
- [ ] Test old channels without message mappings (graceful degradation)
- [ ] Test split responses (multiple Slack messages)
- [ ] Test thread at latest message (should fork from latest)

---

## Implementation Notes

### Why Proactive Mapping?

**Alternative 1: Parse .jsonl files on-demand**
- ❌ Too slow for large files (40MB+ conversations)
- ❌ Complex parsing of JSONL format
- ❌ Unreliable timestamp matching

**Alternative 2: Query SDK for history**
- ❌ SDK doesn't expose history query API
- ❌ Would need SDK changes

**Chosen: Proactive mapping**
- ✅ Fast lookups (in-memory hash map)
- ✅ Reliable (exact IDs, no guessing)
- ✅ Minimal overhead (save on every message)

### Migration Strategy

**Existing channels:**
- No message mappings yet
- Will fall back to latest-state forking
- No breaking changes

**New messages:**
- Start capturing mappings immediately
- Point-in-time forking works from first message after deployment

**Future enhancement:**
- Backfill mappings by parsing .jsonl files (optional)
- Low priority - new messages more important

---

## Expected Behavior After Implementation

### Before (Current)
```
Main: A (2+2=4) → B (3+3=6) → C (4+4=8)
User replies to B in thread
Thread context: A, B, C, D (has future context!) ❌
```

### After (Desired)
```
Main: A (2+2=4) → B (3+3=6) → C (4+4=8)
User replies to B in thread
Thread context: A, B (only up to fork point) ✅
```

### Console Logs
```
[Mapping] Captured assistant message ID: msg_017pagAKz...
[Mapping] Linked Slack ts 1234.002 → SDK msg_017pagAKz...
[Fork] Thread will fork from message msg_017pagAKz...
Forking from session abc-123 at message msg_017pagAKz...
```

### sessions.json
```json
{
  "channels": {
    "C123": {
      "sessionId": "abc-123",
      "messageMap": {
        "1234.001": { "sdkMessageId": "user_001", "type": "user" },
        "1234.002": {
          "sdkMessageId": "msg_017pagAKz",
          "type": "assistant",
          "parentSlackTs": "1234.001"
        }
      },
      "threads": {
        "1234.002": {
          "sessionId": "forked-456",
          "forkedFrom": "abc-123",
          "resumeSessionAtMessageId": "msg_017pagAKz"
        }
      }
    }
  }
}
```
