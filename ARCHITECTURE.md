# Architecture Documentation

This document describes the technical architecture of the Claude Code Slack Bot.

## Table of Contents

1. [System Overview](#system-overview)
2. [Component Architecture](#component-architecture)
3. [Data Flow](#data-flow)
4. [Session Management](#session-management)
5. [Claude SDK Integration](#claude-sdk-integration)
6. [Slack Integration](#slack-integration)
7. [Terminal Integration](#terminal-integration)
8. [Error Handling](#error-handling)
9. [Testing Architecture](#testing-architecture)

---

## System Overview

The Claude Code Slack Bot is a Node.js application that bridges Slack and the Claude Code SDK, enabling real-time collaboration with Claude's AI coding assistant.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SLACK BOT ENTRY POINT                     │
│                      (index.ts)                              │
│              startBot() → refreshModelCache()                │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────▼──────────────┐
        │  Slack Bolt App            │
        │  Socket Mode Connection    │
        └─────────────┬──────────────┘
                      │
        ┌─────────────┴──────────────────────────────┐
        │                                            │
    ┌───▼────┐     ┌────────┐     ┌──────────┐      │
    │Messages│     │@mentions│    │Commands   │  (app.event)
    │(DM)    │     │(channel)│    │(/cmd)     │
    └───┬────┘     └────┬────┘    └─────┬─────┘
        │               │               │
        └───────────────┴───────────────┘
                        │
        ┌───────────────▼────────────────┐
        │  handleMessage()               │
        │  Parse & Route Message         │
        └───────────────┬────────────────┘
                        │
        ┌───────────────┴──────────────────┐
        │                                  │
    ┌───▼──────────┐   ┌──────────────┐  ┌▼───────────┐
    │Slash Command │   │Claude Query  │  │Special Cmd │
    │  Execution   │   │  Processing  │  │(/watch,/ff)│
    └──────────────┘   └──────┬───────┘  └────────────┘
                              │
            ┌─────────────────┴──────────────────┐
            │                                    │
    ┌───────▼──────────┐           ┌────────────▼───────┐
    │ startClaudeQuery │           │ Terminal Sync      │
    │   (SDK)          │           │  (/watch, /ff)     │
    └────────┬─────────┘           └────────┬───────────┘
             │                              │
    ┌────────▼──────────────┐    ┌─────────▼──────┐
    │ Stream Processing     │    │ Terminal Watch │
    │ - Updates status      │    │ - Poll JSONL   │
    │ - Tracks activity     │    │ - Post messages│
    │ - Handles tools       │    │ - Update-place │
    └────────┬──────────────┘    └─────────┬──────┘
             │                             │
    ┌────────▼─────────────────────────────▼────┐
    │         sessions.json                      │
    │    (Persistent Session Storage)            │
    └───────────────────────────────────────────┘
             │
    ┌────────▼────────────────────┐
    │  ~/.claude/projects/        │
    │    {workingDir}/{id}.jsonl  │
    │  SDK Session Files          │
    └─────────────────────────────┘
```

### Key Design Principles

1. **Never Crash** - All handlers wrapped in try-catch with graceful error messages
2. **Real-time Feedback** - Streaming updates and activity logging
3. **Session Continuity** - Conversations persist across restarts
4. **Concurrent Safety** - Mutex protection for session modifications
5. **Graceful Degradation** - Fallbacks for non-critical features

---

## Component Architecture

### Core Components

| File | Lines | Purpose |
|------|-------|---------|
| `slack-bot.ts` | ~6,400 | Main orchestrator: event handlers, button handlers, message processing |
| `blocks.ts` | ~86KB | Block Kit UI builders for all interactive elements |
| `session-manager.ts` | ~800 | Session CRUD with mutex-protected persistence |
| `claude-client.ts` | ~200 | Thin SDK wrapper for query() function |
| `streaming.ts` | ~400 | Slack streaming API with chat.update fallback |
| `commands.ts` | ~300 | Slash command parsing and routing |

### Supporting Components

| File | Purpose |
|------|---------|
| `session-reader.ts` | Parse SDK JSONL session files |
| `session-event-stream.ts` | Async generator for session file reading |
| `terminal-watcher.ts` | Poll terminal sessions for updates |
| `message-sync.ts` | Sync engine for /watch and /ff |
| `activity-thread.ts` | Post activity entries as thread replies |
| `file-handler.ts` | Download and process Slack file uploads |
| `content-builder.ts` | Build Claude-compatible content blocks |
| `markdown-png.ts` | Markdown to PNG via Puppeteer |
| `errors.ts` | Typed errors with user-friendly messages |
| `retry.ts` | Exponential backoff with jitter |
| `abort-tracker.ts` | Track aborted queries |
| `ff-abort-tracker.ts` | Track aborted fast-forward syncs |
| `model-cache.ts` | Cache available models (1-hour TTL) |

---

## Data Flow

### Message Processing Flow

```
User Message (@mention or DM)
         │
         ▼
┌─────────────────────────────┐
│ handleMessage()             │
│ - Parse slash commands      │
│ - Extract inline mode       │
│ - Process file attachments  │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ Check Active Query          │
│ - If busy, queue message    │
│ - If idle, continue         │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ Post Status Message         │
│ - Header (mode, model)      │
│ - Activity log (empty)      │
│ - Status panel (starting)   │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ startClaudeQuery()          │
│ - SDK query() call          │
│ - Returns async iterator    │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ Stream Processing Loop      │
│ for await (msg of query)    │
│ - Handle message types      │
│ - Update status every N sec │
│ - Track activity entries    │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ Post Final Response         │
│ - Truncate if needed        │
│ - Upload .md/.png if long   │
│ - Add Fork button           │
└─────────────────────────────┘
```

### Stream Message Types

| Type | Handling |
|------|----------|
| `system` (init) | Capture session_id |
| `assistant` | Track response text, token usage |
| `stream_event` | Real-time activity (thinking, tool_start, tool_complete) |
| `content_block_start/stop` | Tool use detection |
| `tool_use` | Tool execution tracking |
| `tool_result` | Tool output aggregation |
| `result` | Final response with metrics |

---

## Session Management

### Dual Storage Architecture

The bot maintains two types of session storage:

#### 1. Bot Session Records (`sessions.json`)

Lightweight metadata for fast lookups:

```typescript
interface SessionStore {
  channels: {
    [channelId: string]: {
      sessionId: string | null;
      previousSessionIds: string[];  // For time-travel forking
      workingDir: string;
      mode: PermissionMode;
      model?: string;

      // Path configuration (immutable after set)
      pathConfigured: boolean;
      configuredPath?: string;
      configuredBy?: string;
      configuredAt?: number;

      // Settings
      maxThinkingTokens?: number;
      updateRateSeconds?: number;
      threadCharLimit?: number;
      lastUsage?: TokenUsage;

      // Plan mode
      planFilePath?: string;
      planPresentationCount?: number;

      // Terminal sync tracking
      syncedMessageUuids: string[];
      slackOriginatedUserUuids: string[];

      // Fork metadata
      forkedFromChannelId?: string;
      forkedFromMessageTs?: string;
      forkedFromSdkMessageId?: string;
      forkedFromSessionId?: string;

      // Thread sessions
      threads: { [threadTs: string]: ThreadSession };

      // Message mapping for point-in-time forks
      messageMap: { [slackTs: string]: MessageMapping };
    }
  }
}
```

#### 2. SDK Session Files (`~/.claude/projects/`)

Full conversation transcripts managed by the SDK:

```
~/.claude/projects/
└── -Users-egx-ai-ccslack/     # workingDir with / → -
    ├── abc-123-def-456.jsonl   # Main session
    ├── def-456-ghi-789.jsonl   # Thread session
    └── ...
```

Format: JSONL (one JSON object per line)

### Session Lifecycle

| Event | Action |
|-------|--------|
| First message | Create new session, save to both stores |
| Subsequent message | Resume session from SDK file |
| Thread reply | Fork session with parent context |
| `/clear` | Archive sessionId to previousSessionIds, start fresh |
| Channel deleted | Delete bot records and SDK files |
| "Fork here" button | Create new channel with point-in-time fork |

### Mutex Protection

All session modifications wrapped in `sessionsMutex.runExclusive()`:

```typescript
await sessionsMutex.runExclusive(async () => {
  const session = loadSessions();
  // modify session
  saveSessions(session);
});
```

---

## Claude SDK Integration

### SDK Wrapper (`claude-client.ts`)

Thin wrapper around `@anthropic-ai/claude-agent-sdk`:

```typescript
function startClaudeQuery(
  prompt: string | ContentBlock[] | null,
  options: {
    sessionId?: string;
    workingDir?: string;
    mode?: PermissionMode;
    model?: string;
    forkSession?: boolean;
    resumeSessionAt?: string;
    canUseTool?: CanUseToolCallback;
    maxThinkingTokens?: number;
  }
): ClaudeQuery
```

### Permission Modes

| Mode | SDK `permissionMode` | Tool Approval |
|------|---------------------|---------------|
| Plan | `plan` | SDK handles via ExitPlanMode tool |
| Ask (Default) | `default` | `canUseTool` callback with buttons |
| Accept Edits | `acceptEdits` | Auto-approve edits, prompt for others |
| Bypass | `bypassPermissions` | All tools auto-allowed |

### canUseTool Callback

In `default` mode:

```typescript
canUseTool: async (tool, input) => {
  // Post approval buttons to Slack
  // Wait for user response (7-day timeout)
  // Return { behavior: 'allow' } or { behavior: 'deny', message }
}
```

### Multi-modal Content

The SDK accepts multi-modal content:

```typescript
const content: ContentBlock[] = [
  { type: 'text', text: 'Analyze this image:' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' }}
];
```

---

## Slack Integration

### Connection Mode

Uses **Socket Mode** for WebSocket-based event delivery (no public URL required).

### Event Handlers

| Event | Handler |
|-------|---------|
| `app.message` | DM messages |
| `app.event('app_mention')` | @mentions in channels |
| `app.event('channel_deleted')` | Cleanup on channel deletion |

### Action Handlers (Buttons)

| Pattern | Purpose |
|---------|---------|
| `abort_query_*` | Stop current query |
| `mode_*` | Switch permission mode |
| `model_select_*` | Change model |
| `plan_*` | Plan approval buttons |
| `tool_approve/deny_*` | Tool approval |
| `sdkq_*` | SDK question responses |
| `fork_here_*` | Create forked channel |
| `stop_terminal_watch` | Stop /watch |
| `stop_ff_sync` | Abort /ff |

### Streaming Strategy

```
Primary: Slack Streaming API (Oct 2025)
├── chat.startStream
├── chat.appendStream
└── chat.stopStream

Fallback: chat.update
├── Throttled at 2-second intervals
└── 30 updates/minute (under 50/min limit)
```

### Message Truncation

Long responses are:
1. Truncated at `threadCharLimit` (default 500, max 36,000)
2. Uploaded as `.md` file attachment
3. Optionally rendered as `.png` via Puppeteer

---

## Terminal Integration

### Terminal Watcher (`terminal-watcher.ts`)

Polls SDK session files for changes:

```typescript
interface WatchState {
  conversationKey: string;
  sessionId: string;
  workingDir: string;
  fileOffset: number;      // Current read position
  intervalId: NodeJS.Timer;
  statusMsgTs: string;
  updateRateMs: number;
  activityMessages: Map<string, string>;
  planFilePath?: string;
}
```

### Message Sync Engine (`message-sync.ts`)

Shared sync logic for `/watch` and `/ff`:

```typescript
async function syncMessagesFromOffset(
  state: MessageSyncState,
  fromOffset: number,
  options: {
    infiniteRetry: boolean;    // /ff=true, /watch=false
    isAborted: () => boolean;
    onProgress: (status) => void;
    pacingDelayMs: number;     // 500ms between messages
    postTextMessage: (text) => Promise<string>;
    charLimit: number;
    onExitPlanMode: (path) => void;
  }
): Promise<SyncResult>
```

### Turn-Based Posting

Messages grouped by user turn for CLI fidelity:

```
Terminal Session:
├── User: "fix the bug"
├── Assistant: [thinking] → [tool: Edit] → [text response]
├── User: "now add tests"
└── Assistant: [thinking] → [tool: Write] → [text response]

Slack Posts:
├── Turn 1: User input + Claude's full response
└── Turn 2: User input + Claude's full response
```

---

## Error Handling

### Error Types (`errors.ts`)

```typescript
enum ErrorCode {
  // Slack
  SLACK_RATE_LIMITED,
  SLACK_CHANNEL_NOT_FOUND,
  SLACK_MESSAGE_TOO_LONG,

  // Claude
  CLAUDE_SDK_ERROR,
  CLAUDE_TIMEOUT,

  // Session
  SESSION_NOT_FOUND,
  SESSION_FILE_MISSING,
  SESSION_FILE_CORRUPTED,

  // File system
  WORKING_DIR_NOT_FOUND,
  FILE_READ_ERROR,
  FILE_WRITE_ERROR,

  // Input
  INVALID_INPUT,
  EMPTY_MESSAGE
}
```

### Error Response

```typescript
class SlackBotError {
  code: ErrorCode;
  recoverable: boolean;

  toUserMessage(): string {
    // User-friendly message, no stack traces
  }
}
```

### Retry Strategy (`retry.ts`)

```typescript
await withRetry(fn, {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  // Exponential: base × 2^(attempt-1)
  // Jitter: ±100ms
});

await withSlackRetry(fn);
// Respects Retry-After headers
```

---

## Testing Architecture

### Test Organization

```
src/__tests__/
├── unit/           (28 files) - Isolated function tests
├── integration/    (23 files) - Full flow tests with mocks
├── sdk-live/       (50 files) - Real API tests
└── __fixtures__/   (2 files)  - Mock data generators
```

### Test Types

| Type | Mocking | Purpose |
|------|---------|---------|
| **Unit** | All dependencies mocked | Individual function behavior |
| **Integration** | Slack + SDK mocked | Full message flow |
| **SDK Live** | No mocking | Real SDK behavior |

### Mocking Strategy

**Slack App:**
```typescript
vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    event(name, handler) { registeredHandlers[`event_${name}`] = handler; }
    message(handler) { registeredHandlers['message'] = handler; }
    action(pattern, handler) { registeredHandlers[`action_${pattern}`] = handler; }
  }
}));
```

**Claude SDK:**
```typescript
vi.mocked(startClaudeQuery).mockReturnValue({
  [Symbol.asyncIterator]: async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'new-session' };
    yield { type: 'assistant', content: 'response' };
    yield { type: 'result' };
  },
  interrupt: vi.fn(),
});
```

### Running Tests

```bash
make test           # Unit + integration (JOBS=4)
make sdk-test       # Live SDK tests (SDKJOBS=4)
make all-test       # All tests
make test-coverage  # With coverage report
```

### Test Configuration

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

---

## Activity Tracking

### Activity Entry Types

```typescript
type ActivityEntryType =
  | 'starting'       // Query initialization
  | 'thinking'       // Extended thinking block
  | 'tool_start'     // Tool execution started
  | 'tool_complete'  // Tool execution finished
  | 'error'          // Processing error
  | 'generating'     // Text streaming progress
  | 'aborted'        // User abort
  | 'mode_changed'   // Permission mode switch
  | 'context_cleared'// Session clear
  | 'session_changed';// Session resume

interface ActivityEntry {
  timestamp: number;
  type: ActivityEntryType;

  // Thinking
  thinkingContent?: string;
  thinkingTruncated?: boolean;

  // Generation
  generatingChunks?: number;
  generatingChars?: number;

  // Tool execution
  tool?: string;
  toolInput?: any;
  durationMs?: number;
  toolOutput?: string;
  toolIsError?: boolean;
}
```

### Display Modes

- **Inline** - Activity shown in status message during processing
- **Rolling Window** - Last 20 entries when >300 total
- **Thread Replies** - Activity posted as thread under status message

---

## Emoji Indicators

| Emoji | Meaning |
|-------|---------|
| `:eyes:` | Processing in progress |
| `:question:` | Waiting for user input |
| `:page_with_curl:` | Plan file being presented |
| `:x:` | Error occurred |
| `:octagonal_sign:` | Processing stopped/aborted |
| `:gear:` | Compaction in progress |
| `:checkered_flag:` | Compaction completed |

Emoji updates use per-message mutex serialization to prevent race conditions.

---

## Auto-Compaction

Triggered when context usage reaches 80% of remaining output capacity:

```
Context: 150,000 / 200,000 tokens (75%)
Output capacity remaining: 50,000 tokens
Trigger threshold: 80% of 50,000 = 40,000 tokens
```

Auto-compaction:
- Requires no user prompt
- Shows stats after completion
- Distinguishes from manual `/compact` via `compactIsManual` flag

---

## Fork Here Feature

Point-in-time forking creates new channels with context up to a specific message:

```
Original Channel:
├── Message 1 (ts: 1234.001) → SDK msg: uuid-001
├── Message 2 (ts: 1234.002) → SDK msg: uuid-002
├── Message 3 (ts: 1234.003) → SDK msg: uuid-003  ← Fork Here clicked
└── Message 4 (ts: 1234.004) → SDK msg: uuid-004

New Forked Channel:
├── Context includes: Messages 1, 2, 3 only
├── Independent session from fork point
└── Stored metadata: forkedFromChannelId, forkedFromMessageTs, forkedFromSdkMessageId
```

---

## Configuration Inheritance

Thread sessions inherit from main channel:

| Setting | Inherited |
|---------|-----------|
| `workingDir` | Yes |
| `pathConfigured` | Yes |
| `maxThinkingTokens` | Yes |
| `updateRateSeconds` | Yes |
| `threadCharLimit` | Yes |
| `planFilePath` | **No** (per-thread) |
| `mode` | Yes (can override) |

---

## Further Reading

- [SETUP.md](./SETUP.md) - Complete Slack app setup guide
- [CLAUDE.md](./CLAUDE.md) - Development guide and patterns
- [docs/architecture/session-management.md](./docs/architecture/session-management.md) - Session management details
