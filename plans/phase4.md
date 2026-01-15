# Phase 4: Thread Forking, Error Handling & Documentation

## Summary

Phase 4 implements thread-based session forking, robust error handling, and production documentation. Based on slack-bot-v13.md.

**Current State:**
- Thread messages handled but all threads share main session (no forking)
- No retry logic, message splitting, or structured error handling
- README exists but no ARCHITECTURE.md

---

## Current vs Target

| Feature | Current | Target |
|---------|---------|--------|
| Thread detection | ✅ `thread_ts` handled | ✅ Done |
| Per-thread sessions | ❌ All share main session | Each thread = forked session |
| Auto-fork on reply | ❌ No | Fork when user replies in thread |
| Retry logic | ❌ None | Exponential backoff for Slack API |
| Message splitting | ❌ None | Split >4000 char responses |
| Error types | ❌ Generic errors | Typed `SlackBotError` class |
| ARCHITECTURE.md | ❌ Missing | Complete technical docs |

---

## Priority 1: Thread Session Forking

**Files:** `src/session-manager.ts`, `src/slack-bot.ts`

### Changes to session-manager.ts

Add thread session storage and retrieval:

```typescript
interface ThreadSession {
  sessionId: string;
  forkedFrom: string;    // Parent session ID
  workingDir: string;
  mode: 'plan' | 'auto' | 'ask';
  createdAt: number;
}

interface SessionData {
  // ... existing fields
  threads: Record<string, ThreadSession>;  // threadTs -> session
}

export async function getOrCreateThreadSession(
  channelId: string,
  userId: string,
  threadTs: string
): Promise<Session & { forkFrom?: string }>;

export async function saveThreadSession(
  userId: string,
  threadTs: string,
  session: ThreadSession
): Promise<void>;
```

### Changes to slack-bot.ts

Detect thread replies and auto-fork:

```typescript
// In DM message handler (~line 180)
if (event.thread_ts) {
  session = await getOrCreateThreadSession(channelId, userId, event.thread_ts);

  if (session.forkFrom) {
    // First message in thread - notify about fork
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: event.thread_ts,
      text: "🔀 _Forking session from main conversation..._",
    });
  }
} else {
  session = await getOrCreateSession(channelId, userId);
}
```

---

## Priority 2: Error Handling (NO CRASHES EVER)

**New file:** `src/errors.ts`

**Principle:** Bot must NEVER crash on invalid input. Always report error to user gracefully.

### Error Types

```typescript
export class SlackBotError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean = false
  ) {
    super(message);
    this.name = 'SlackBotError';
  }
}

export enum ErrorCode {
  // Slack errors
  SLACK_RATE_LIMITED = 'SLACK_RATE_LIMITED',
  SLACK_CHANNEL_NOT_FOUND = 'SLACK_CHANNEL_NOT_FOUND',
  SLACK_MESSAGE_TOO_LONG = 'SLACK_MESSAGE_TOO_LONG',

  // Claude errors
  CLAUDE_SDK_ERROR = 'CLAUDE_SDK_ERROR',
  CLAUDE_TIMEOUT = 'CLAUDE_TIMEOUT',

  // Session errors
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_FILE_MISSING = 'SESSION_FILE_MISSING',

  // File system errors
  WORKING_DIR_NOT_FOUND = 'WORKING_DIR_NOT_FOUND',
  FILE_READ_ERROR = 'FILE_READ_ERROR',
  FILE_WRITE_ERROR = 'FILE_WRITE_ERROR',

  // Git errors
  GIT_CONFLICT = 'GIT_CONFLICT',
}

export function toUserMessage(error: unknown): string;
export function isRecoverable(error: unknown): boolean;
```

### Graceful Failure Scenarios

| Scenario | Error Code | User Message | Recovery Action |
|----------|------------|--------------|-----------------|
| Session file missing | `SESSION_FILE_MISSING` | "Session `abc-123` not found. Starting new session." | Create new session |
| Invalid working dir | `WORKING_DIR_NOT_FOUND` | "Directory `/bad/path` not found. Use `@claude cwd /valid/path`" | Keep old cwd |
| Git conflicts | `GIT_CONFLICT` | "⚠️ Git conflicts detected. Proceeding anyway." | Continue with warning |
| SDK throws error | `CLAUDE_SDK_ERROR` | "Claude encountered an error: {message}" | Show error, don't crash |
| Rate limited | `SLACK_RATE_LIMITED` | _(silent retry)_ | Retry with backoff |
| Unicode path issues | `FILE_READ_ERROR` | "Could not read file: {path}" | Report error |
| Workspace archived | N/A | Log and exit cleanly | Graceful shutdown |

### Top-Level Error Wrapper

```typescript
// In slack-bot.ts - wrap ALL handlers
app.message(async ({ event, client }) => {
  try {
    await handleMessage(event, client);
  } catch (error) {
    // NEVER let errors escape - always report to user
    const userMessage = toUserMessage(error);
    await client.chat.postMessage({
      channel: event.channel,
      text: `❌ ${userMessage}`,
    });
    console.error('Handler error:', error);
  }
});
```

---

## Priority 3: Retry Logic

**New file:** `src/retry.ts`

### Implementation

```typescript
export interface RetryOptions {
  maxAttempts?: number;     // Default: 3
  baseDelayMs?: number;     // Default: 1000
  maxDelayMs?: number;      // Default: 10000
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T>;

export async function withSlackRetry<T>(
  fn: () => Promise<T>
): Promise<T>;  // Pre-configured for Slack rate limits
```

### Apply to Slack calls

```typescript
// In slack-bot.ts - wrap all Slack API calls
await withSlackRetry(() =>
  client.chat.postMessage({ channel, text })
);
```

---

## Priority 4: Message Splitting

**File:** `src/streaming.ts`

### Implementation

```typescript
const SLACK_MAX_LENGTH = 4000;

export function splitMessage(text: string): string[] {
  // Split at newlines or spaces, never mid-word
  // Add "... continued ..." indicator between parts
}

export async function postFinalResponse(
  client: WebClient,
  channelId: string,
  threadTs: string | undefined,
  response: string
): Promise<void> {
  const parts = splitMessage(response);
  for (const part of parts) {
    await withSlackRetry(() =>
      client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: part })
    );
  }
}
```

---

## Priority 5: Answer Timeout (Optional)

**File:** `src/mcp-server.ts`

Add 7-day timeout with reminder escalation:

```typescript
const ANSWER_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const REMINDER_INTERVALS = [1, 3, 6];  // Days

// In ask_user tool - add Promise.race with timeout
```

---

## Priority 6: Documentation

**New file:** `ARCHITECTURE.md`

### Contents

1. **Overview** - What the bot does
2. **Components** - File-by-file breakdown
3. **Data Flow** - Request → Response diagram
4. **Session Storage** - JSON schema
5. **Error Handling** - Error codes and recovery
6. **Testing** - How to run tests

---

## Implementation Order

| # | Task | Files | Effort |
|---|------|-------|--------|
| 1 | Thread session storage | `session-manager.ts` | Small |
| 2 | Thread detection + auto-fork | `slack-bot.ts` | Medium |
| 3 | Error types | `src/errors.ts` (new) | Small |
| 4 | Retry utilities | `src/retry.ts` (new) | Small |
| 5 | Apply retry to Slack calls | `slack-bot.ts`, `streaming.ts` | Small |
| 6 | Message splitting | `streaming.ts` | Small |
| 7 | Answer timeout | `mcp-server.ts` | Small |
| 8 | ARCHITECTURE.md | `ARCHITECTURE.md` (new) | Medium |
| 9 | Tests for new code | `__tests__/` | Medium |

---

## Files to Create/Modify

### New Files
- `src/errors.ts` - Error types and helpers
- `src/retry.ts` - Retry with exponential backoff
- `ARCHITECTURE.md` - Technical documentation

### Modified Files
- `src/session-manager.ts` - Add thread session support
- `src/slack-bot.ts` - Thread detection, auto-fork, retry wrapping
- `src/streaming.ts` - Message splitting, retry wrapping
- `src/mcp-server.ts` - Answer timeout (optional)

### New Test Files
- `src/__tests__/unit/errors.test.ts`
- `src/__tests__/unit/retry.test.ts`
- `src/__tests__/integration/thread-forking.test.ts`
- `src/__tests__/integration/graceful-failures.test.ts` **(NEW - Invalid Input Testing)**

---

## Verification

### Manual Testing

1. **Thread forking:**
   ```
   1. Send message in main DM
   2. Reply in thread → should see "🔀 Forking session..."
   3. Both conversations should be independent
   4. Check sessions.json has thread entry
   ```

2. **Error handling:**
   ```
   1. Set invalid cwd → should show user-friendly error
   2. Trigger rate limit → should retry automatically
   ```

3. **Message splitting:**
   ```
   1. Ask Claude for very long response (e.g., "explain all JS array methods")
   2. Response should split into multiple messages
   ```

### Invalid Input Testing (Graceful Failures)

**File:** `src/__tests__/integration/graceful-failures.test.ts`

Each test verifies: (1) no crash, (2) error message posted to Slack, (3) bot continues running.

```typescript
describe('graceful failures - no crashes on invalid input', () => {
  it('should handle missing session file gracefully', async () => {
    // Try to resume non-existent session
    // Verify: no throw, posts "Session not found. Starting new session."
  });

  it('should handle invalid working directory gracefully', async () => {
    // Set cwd to /nonexistent/path
    // Verify: no throw, posts "Directory not found" error message
  });

  it('should handle SDK errors gracefully', async () => {
    // Mock SDK to throw error
    // Verify: no throw, posts user-friendly error message
  });

  it('should handle malformed message input gracefully', async () => {
    // Send message with null/undefined text
    // Verify: no throw, handles gracefully
  });

  it('should handle invalid session ID format gracefully', async () => {
    // Try @claude --resume "not-a-valid-id!!!"
    // Verify: no throw, posts error message
  });

  it('should handle corrupted sessions.json gracefully', async () => {
    // Write invalid JSON to sessions.json
    // Verify: no throw, recreates file or posts error
  });

  it('should handle Slack API failures gracefully', async () => {
    // Mock Slack API to throw
    // Verify: no throw, logs error, doesn't crash bot
  });

  it('should handle empty message gracefully', async () => {
    // Send @claude with no text
    // Verify: no throw, posts helpful message
  });

  it('should handle very long input gracefully', async () => {
    // Send message with 100KB of text
    // Verify: no throw, either processes or posts error
  });

  it('should handle special characters in input gracefully', async () => {
    // Send message with unicode, emoji, control chars
    // Verify: no throw, processes normally
  });
});
```

### Automated Tests

```bash
npm test                                              # All tests
npm test -- src/__tests__/unit/errors.test.ts        # Error tests
npm test -- src/__tests__/unit/retry.test.ts         # Retry tests
npm test -- src/__tests__/integration/thread-forking.test.ts
npm test -- src/__tests__/integration/graceful-failures.test.ts  # Invalid input tests
```

---

## Success Criteria

### Thread Forking
- [ ] Thread reply creates forked session automatically
- [ ] "🔀 Forking session..." message shown on first thread reply
- [ ] Forked sessions stored in `sessions.json` under `threads`

### Error Handling (NO CRASHES)
- [ ] `SlackBotError` class with typed error codes exists
- [ ] Top-level try/catch wraps ALL handlers
- [ ] Missing session file → starts new session (no crash)
- [ ] Invalid working dir → shows error message (no crash)
- [ ] SDK errors → shows user-friendly message (no crash)
- [ ] Git conflicts → warns but continues (no crash)
- [ ] `graceful-failures.test.ts` exists with 10+ invalid input tests
- [ ] All graceful failure tests pass (no throws, proper error messages)

### Retry & Resilience
- [ ] `withRetry()` and `withSlackRetry()` utilities exist
- [ ] All Slack API calls wrapped with retry
- [ ] Long responses (>4000 chars) split correctly

### Documentation
- [ ] ARCHITECTURE.md exists with complete documentation
- [ ] All new code has tests
- [ ] All tests pass (`npm test`)
