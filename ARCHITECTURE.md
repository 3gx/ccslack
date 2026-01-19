# Claude Code Slack Bot - Architecture

## Overview

The Slack bot enables interaction with Claude Code through Slack channels (via @mentions), providing:
- Real-time status panel with activity log during processing
- Interactive questions and tool approvals via Block Kit
- Session management with terminal handoff
- Thread-based session forking with point-in-time history
- Extended thinking with configurable budget
- Configurable update rate per session
- Multiple permission modes (plan, default, bypassPermissions, acceptEdits)
- Robust error handling with no crashes

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Slack Bot (Node.js + TypeScript)                        │
│                                                                             │
│  ┌───────────────────┐                                                      │
│  │   Slack Events    │     ┌────────────────────────────────────────────┐   │
│  │   (Socket Mode)   │────→│  Event Handlers                            │   │
│  │                   │     │  - app_mention: Channel @mentions          │   │
│  │  - app_mention    │     │  - message: DM handling (disabled)         │   │
│  │  - block_actions  │     │  - channel_deleted: Session cleanup        │   │
│  │  - channel_deleted│     │  - block_actions: Button clicks            │   │
│  └───────────────────┘     └────────────────────────────────────────────┘   │
│                                          ↓                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  Command Parser (commands.ts)                                        │   │
│  │  /status, /mode, /model, /cd, /ls, /set-current-path, /context,      │   │
│  │  /continue, /fork, /fork-thread, /clear, /compact,                   │   │
│  │  /max-thinking-tokens, /update-rate, /message-size, /strip-empty-tag │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                          ↓                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  Session Manager (session-manager.ts)                                │   │
│  │  - Channel → Session mapping (sessionId, mode, workingDir)           │   │
│  │  - Thread sessions (forked from channel)                             │   │
│  │  - Message mapping (Slack ts → SDK message ID)                       │   │
│  │  - Activity log storage                                              │   │
│  │  - Persist to sessions.json                                          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                          ↓                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  Claude Client (claude-client.ts)                                    │   │
│  │  - query() wrapper for Claude Agent SDK                              │   │
│  │  - Session resume/fork with resumeSessionAt                          │   │
│  │  - Extended thinking (maxThinkingTokens)                             │   │
│  │  - Model selection                                                   │   │
│  │  - MCP server configuration                                          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│            │                                       │                         │
│            ▼                                       ▼                         │
│  ┌────────────────────────┐          ┌───────────────────────────────────┐  │
│  │  Real-Time UI          │          │  MCP Server (mcp-server.ts)       │  │
│  │  (blocks.ts)           │          │  - ask_user tool                  │  │
│  │                        │          │  - approve_action tool            │  │
│  │  Message 1: Status     │          │  - File-based IPC                 │  │
│  │  - Mode | Model        │          │  - 7-day expiry with reminders    │  │
│  │  - Current activity    │          └───────────────────────────────────┘  │
│  │  - Abort button        │                                                  │
│  │  - Spinner animation   │                                                  │
│  │                        │                                                  │
│  │  Message 2: Activity   │                                                  │
│  │  - Tool executions     │                                                  │
│  │  - Thinking content    │                                                  │
│  │  - Generating status   │                                                  │
│  │                        │                                                  │
│  │  Message 3: Response   │                                                  │
│  │  - Claude's text       │                                                  │
│  └────────────────────────┘                                                  │
│                                                                             │
│  Storage:                                                                   │
│  └── sessions.json (bot state)                                              │
│  └── ~/.claude/projects/<path>/<sessionId>.jsonl (SDK sessions)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Components

### Entry Point (`src/index.ts`)
- Initializes Slack app with Socket Mode
- Loads environment variables
- Starts the bot

### Slack Bot (`src/slack-bot.ts`)
- Handles `app_mention` events for channel @mentions
- Handles `message.im` events for DM messages (currently limited)
- Handles `block_actions` for button clicks (abort, tool approval, mode selection)
- Handles `channel_deleted` for session cleanup
- Manages active queries with abort capability via `ClaudeQuery.interrupt()`
- Posts real-time status panel and activity log during processing
- Coordinates tool approval flow in `default` permission mode
- **Thread forking**: Detects `thread_ts` and auto-forks sessions with point-in-time history
- **Error handling**: Top-level try/catch wraps all handlers
- **Mutex locking**: Prevents race conditions during abort operations

### Claude Client (`src/claude-client.ts`)
- Wraps Claude Code SDK `query()` function
- Configures MCP server for `ask_user` and `approve_action` tools
- Maps permission modes directly to SDK (`plan`, `default`, `bypassPermissions`, `acceptEdits`)
- Supports `forkSession` and `resumeSessionAt` for point-in-time thread forking
- Configures `maxThinkingTokens` for extended thinking budget
- Enables `includePartialMessages` for real-time activity tracking

### MCP Server (`src/mcp-server.ts`)
- Standalone MCP server spawned by SDK as subprocess
- Implements `ask_user` tool for interactive Slack questions
- Implements `approve_action` tool for action approvals
- Uses file-based IPC via `/tmp/ccslack-answers/` directory
- Polls for answer files written by main process
- 7-day expiry with 4-hour reminder intervals
- Auto-abort after max reminders reached

### Session Manager (`src/session-manager.ts`)
- Persists sessions to `sessions.json`
- **Session interface**: `sessionId`, `workingDir`, `mode`, `model`, `pathConfigured`, `lastUsage`, `maxThinkingTokens`, `updateRateSeconds`, `threadCharLimit`, `stripEmptyTag`, `planFilePath`
- **ThreadSession interface**: Inherits from Session, adds `forkedFrom`, `forkedFromThreadTs`, `resumeSessionAtMessageId`
- **Message mapping**: `SlackMessageMapping` links Slack timestamps to SDK message IDs and session IDs
- **Activity log storage**: Stores activity entries by conversation key for View Log modal
- `previousSessionIds[]`: Tracks sessions before `/clear` for time-travel forking
- Handles corrupted session files gracefully with migration support

### Streaming (`src/streaming.ts`)
- Implements Slack native streaming API (chat.startStream/appendStream/stopStream)
- Falls back to throttled `chat.update` on errors (2-second interval)
- **Message splitting**: Splits long responses (>4000 chars) at natural boundaries
- `postSplitResponse()`: Posts multi-part messages with retry logic

### Blocks (`src/blocks.ts`)
- Block Kit builders for all message types
- **Status panel**: `buildStatusPanelBlocks()` - mode, model, current activity, spinner, abort button
- **Activity log**: `buildActivityLogText()` - thinking, tool executions, generating status
- **Collapsed activity**: `buildCollapsedActivityBlocks()` - summary with View Log/Download buttons
- **Modal view**: `buildActivityLogModalView()` - paginated activity log with full thinking content
- Question blocks with buttons/multi-select dropdowns
- Tool approval blocks for manual approval mode
- Plan approval blocks (proceed auto/manual, reject)
- Mode and model selection blocks
- Context usage display with visual progress bar

### Commands (`src/commands.ts`)
- Parses slash commands from user messages
- Implements: `/status`, `/mode`, `/model`, `/cd`, `/ls`, `/set-current-path`, `/context`, `/continue`, `/fork`, `/fork-thread`, `/resume`, `/clear`, `/compact`, `/max-thinking-tokens`, `/update-rate`, `/message-size`, `/strip-empty-tag`, `/wait`

### Error Handling (`src/errors.ts`)
- `SlackBotError` class with typed error codes
- `toUserMessage()` for user-friendly error messages
- `isRecoverable()` for retry decisions
- Error factory functions (`Errors.sessionNotFound()`, etc.)

### Retry Utilities (`src/retry.ts`)
- `withRetry()` for generic retry with backoff
- `withSlackRetry()` pre-configured for Slack API
- Exponential backoff with jitter
- Respects `Retry-After` headers

### Model Cache (`src/model-cache.ts`)
- Caches available models from SDK
- `getAvailableModels()`, `isModelAvailable()`, `refreshModelCache()`
- Used for `/model` command and model selection UI

### Markdown PNG (`src/markdown-png.ts`)
- Converts markdown to PNG images
- Used for rendering code blocks and formatted text as images

### Abort Tracker (`src/abort-tracker.ts`)
- Tracks aborted conversations to prevent race conditions
- `markAborted()`, `isAborted()`, `clearAborted()`
- Used during query interrupt flow

## Data Flow

```
@mention in Channel → Slack Socket Mode → slack-bot.ts
                                              │
                                    ┌─────────┴──────────┐
                                    │                    │
                              Main channel?         Thread reply?
                                    │                    │
                                    ▼                    ▼
                              Get Session      findForkPointMessageId()
                                    │                    │
                                    │           getOrCreateThreadSession(forkPoint)
                                    │                    │
                                    │              Is new fork?
                                    │                    │
                                    │             Yes ───┼─── No
                                    │              │     │     │
                                    │       Post fork    │  Use existing
                                    │       notification │  thread session
                                    │              │     │     │
                                    └──────┬───────┴─────┴─────┘
                                           │
                                           ▼
                              ┌─────────────────────────────┐
                              │  Post Status Panel (Msg 1)  │
                              │  Post Activity Log (Msg 2)  │
                              └─────────────────────────────┘
                                           │
                                           ▼
                              ┌─────────────────────────────┐
                              │  Start Claude SDK Query     │
                              │  - sessionId / forkSession  │
                              │  - resumeSessionAt (fork)   │
                              │  - maxThinkingTokens        │
                              │  - canUseTool callback      │
                              └─────────────────────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
                    ▼                      ▼                      ▼
            SDK stream_event        MCP ask_user tool      canUseTool callback
            (real-time updates)           │                (default mode)
                    │                      │                      │
                    ▼                      ▼                      ▼
            Update Status Panel    Block Kit Question      Tool Approval UI
            Update Activity Log           │                      │
                    │                      │                      │
                    │                      ▼                      ▼
                    │              User clicks button      User approves/denies
                    │                      │                      │
                    │                      ▼                      ▼
                    │              Write to /tmp file      Resolve Promise
                    │                      │                      │
                    │                      ▼                      │
                    │              Claude continues ◄─────────────┘
                    │
                    ▼
            ┌───────────────────────────────┐
            │  On result message:           │
            │  - Update Status (complete)   │
            │  - Collapse Activity Log      │
            │  - Post Response (Msg 3)      │
            │  - Save message mappings      │
            │  - Save session/usage data    │
            └───────────────────────────────┘
```

## Session Storage

Sessions are stored in `sessions.json`:

```json
{
  "channels": {
    "C123456789": {
      "sessionId": "abc-123-def",
      "previousSessionIds": ["old-session-1"],
      "workingDir": "/Users/you/project",
      "mode": "plan",
      "model": "claude-sonnet-4-5-20250929",
      "createdAt": 1705123456789,
      "lastActiveAt": 1705234567890,
      "pathConfigured": true,
      "configuredPath": "/Users/you/project",
      "configuredBy": "U12345678",
      "configuredAt": 1705123456789,
      "maxThinkingTokens": 31999,
      "updateRateSeconds": 2,
      "threadCharLimit": 500,
      "stripEmptyTag": false,
      "planFilePath": null,
      "lastUsage": {
        "inputTokens": 5000,
        "outputTokens": 1200,
        "cacheReadInputTokens": 3000,
        "contextWindow": 200000,
        "model": "claude-sonnet-4-5-20250929"
      },
      "messageMap": {
        "1234567890.001": {
          "sdkMessageId": "user_001",
          "sessionId": "abc-123-def",
          "type": "user"
        },
        "1234567890.002": {
          "sdkMessageId": "msg_017pagAKz",
          "sessionId": "abc-123-def",
          "type": "assistant",
          "parentSlackTs": "1234567890.001"
        }
      },
      "threads": {
        "1234567890.002": {
          "sessionId": "ghi-456-jkl",
          "forkedFrom": "abc-123-def",
          "forkedFromThreadTs": null,
          "resumeSessionAtMessageId": "msg_017pagAKz",
          "workingDir": "/Users/you/project",
          "mode": "plan",
          "model": "claude-sonnet-4-5-20250929",
          "createdAt": 1705345678901,
          "lastActiveAt": 1705456789012,
          "pathConfigured": true,
          "configuredPath": "/Users/you/project",
          "configuredBy": "U12345678",
          "configuredAt": 1705123456789,
          "maxThinkingTokens": 31999,
          "updateRateSeconds": 2,
          "threadCharLimit": 500,
          "stripEmptyTag": false,
          "planFilePath": null
        }
      },
      "activityLogs": {
        "C123456789_1234567890.001": [
          { "timestamp": 1705123456789, "type": "starting" },
          { "timestamp": 1705123457000, "type": "thinking", "thinkingContent": "..." },
          { "timestamp": 1705123458000, "type": "tool_start", "tool": "Read" },
          { "timestamp": 1705123459000, "type": "tool_complete", "tool": "Read", "durationMs": 1000 }
        ]
      }
    }
  }
}
```

### Key Storage Concepts

- **messageMap**: Links Slack message timestamps to SDK message IDs AND session IDs, enabling point-in-time forking even after `/clear`
- **previousSessionIds**: Tracks old session IDs after `/clear` for time-travel forking
- **resumeSessionAtMessageId**: SDK message ID to fork from (passed to `resumeSessionAt` in SDK query)
- **activityLogs**: Preserved activity entries by conversation key for View Log modal
- **pathConfigured**: Immutable after first set - prevents accidental working directory changes
- **threadCharLimit**: Message size limit before response truncation (default 500)
- **stripEmptyTag**: Whether to strip bare ``` wrappers (default false)
- **planFilePath**: Persistent plan file path for plan mode (detected from tool usage)

## Real-Time Updates Architecture

During query processing, the bot maintains two Slack messages that are updated in real-time:

### Message 1: Status Panel
Updated every `updateRateSeconds` (configurable 1-10s, default 2s):
- Header: "Claude is working..." with spinner animation
- Mode and model display
- Current activity (Thinking/Running: ToolName/Generating)
- Tools completed count
- Elapsed time
- Abort button

On completion:
- Shows final stats: tokens in/out, context %, cost, duration
- Removes abort button

### Message 2: Activity Log
Real-time log of processing activities:
- **starting**: Initial "Analyzing request..." entry
- **thinking**: Extended thinking content with rolling window (last 500 chars during processing)
- **tool_start**: Tool name with "in progress" indicator
- **tool_complete**: Checkmark with duration
- **generating**: Text generation progress (chunks, chars)
- **error**: Error messages

On completion:
- Collapses to summary: "X thinking + Y tools in Zs"
- View Log button: Opens modal with paginated full log
- Download .txt button: Exports full activity log

### Activity Entry Types
```typescript
interface ActivityEntry {
  timestamp: number;
  type: 'starting' | 'thinking' | 'tool_start' | 'tool_complete' | 'error' | 'generating';
  tool?: string;
  durationMs?: number;
  message?: string;
  thinkingContent?: string;     // Full content for modal
  thinkingTruncated?: string;   // Last 500 chars for live display
  thinkingInProgress?: boolean;
  generatingChunks?: number;
  generatingChars?: number;
  generatingInProgress?: boolean;
}
```

### Rolling Window Display
When activity entries exceed MAX_LIVE_ENTRIES (300), switches to rolling window mode showing only the last ROLLING_WINDOW_SIZE (20) entries, with a notice about hidden earlier entries.

## Error Handling Philosophy

**Principle: Bot must NEVER crash on invalid input. Always report error to user gracefully.**

### Error Codes

| Code | Description | Recoverable |
|------|-------------|-------------|
| `SLACK_RATE_LIMITED` | Rate limited by Slack | Yes |
| `SLACK_CHANNEL_NOT_FOUND` | Channel doesn't exist | No |
| `SLACK_MESSAGE_TOO_LONG` | Message exceeds Slack limit | No |
| `SLACK_API_ERROR` | Generic Slack API error | Yes |
| `CLAUDE_SDK_ERROR` | Claude SDK threw error | No |
| `CLAUDE_TIMEOUT` | Request timed out | Yes |
| `SESSION_NOT_FOUND` | Session ID doesn't exist | No |
| `SESSION_FILE_MISSING` | Session file deleted | No |
| `SESSION_FILE_CORRUPTED` | Invalid JSON in file | No |
| `WORKING_DIR_NOT_FOUND` | Directory doesn't exist | No |
| `FILE_READ_ERROR` | Could not read file | No |
| `FILE_WRITE_ERROR` | Could not write file | No |
| `GIT_CONFLICT` | Git conflicts detected | No |
| `INVALID_INPUT` | Invalid user input | No |
| `EMPTY_MESSAGE` | No message text provided | No |

### Recovery Actions

| Scenario | Action |
|----------|--------|
| Session file missing | Create new session |
| Invalid working directory | Show error, keep old cwd |
| Git conflicts | Warn but continue |
| SDK error | Show user-friendly message |
| Rate limited | Retry with backoff |
| Corrupted sessions.json | Reset to empty, log warning |

## Thread Forking (Point-in-Time)

Thread forking uses **point-in-time history** - the thread only knows about messages up to where it forked:

```
Main channel: A → B → C → D
User replies to B in thread
Thread context: A, B only (not C, D)
```

### How It Works

1. **Message Mapping**: As messages flow, bot captures Slack timestamps → SDK message IDs (with session ID)
2. **Fork Detection**: When user replies in thread, bot detects `thread_ts`
3. **Fork Point Lookup**: `findForkPointMessageId()` returns both SDK message ID AND session ID
4. **Session Resolution**: Uses session ID from message mapping (not current main session) - enables "time travel" forking after `/clear`
5. **Point-in-Time Fork**: SDK `resumeSessionAt` parameter creates fork with history only up to that point
6. **Notification**: Posts link to the exact message being forked from

### Fork Flow

1. Bot detects `thread_ts` in message event
2. Calls `findForkPointMessageId(channelId, threadTs)` to get fork point
3. Checks if thread already has a session via `getOrCreateThreadSession()`
4. If new thread:
   - Uses `forkPoint.sessionId` (NOT current main session) as parent
   - Uses `forkPoint.messageId` for `resumeSessionAt`
   - Forks from parent session using `forkSession: true`
   - Posts "Forked with conversation state through: [this message]" notification
5. Creates new SDK session with limited history
6. Saves thread session with `resumeSessionAtMessageId` to `sessions.json`

### Time Travel Forking

After `/clear`, users can still fork from old messages:
- `messageMap` entries include `sessionId` field
- `findForkPointMessageId()` returns the session where the message lives
- Thread forks from the OLD session, not the null current session
- `previousSessionIds[]` tracks cleared sessions for reference

### Thread-to-Thread Forking

Users can fork from within a thread using `> fork: description` or `/fork-thread description`:
1. Creates new top-level anchor message in channel
2. Creates thread session pointing to source thread's session
3. Posts link back to source thread's fork point
4. New thread has its own independent history from fork point

### Graceful Degradation

For older channels without message mappings:
- Falls back to forking from latest state
- New messages after migration will have proper mappings
- Migration adds `sessionId` to old entries using current session (best effort)

## Permission Modes

| Mode | SDK `permissionMode` | Tool Approval | Use Case |
|------|---------------------|---------------|----------|
| Plan | `plan` | SDK handles internally | Read-only exploration, planning |
| Default | `default` | Uses `canUseTool` callback | Manual approval for each tool |
| Bypass | `bypassPermissions` | No approval needed | Trusted automation |
| AcceptEdits | `acceptEdits` | Accept code edits only | Allow edits, prompt for others |

### canUseTool Callback (Default Mode)

In `default` mode, SDK calls `canUseTool` for tool approval:
- Must return `{ behavior: 'allow', updatedInput: {...} }` or `{ behavior: 'deny', message: '...' }`
- 7-day timeout with 4-hour reminders
- Auto-deny `mcp__ask-user__approve_action` to avoid double prompts
- Tool approval UI shows tool name and input preview

## Extended Thinking

Configurable via `/max-thinking-tokens <tokens>` command:
- `undefined`: Default (31,999 tokens)
- `0`: Disabled (no thinking blocks)
- `1024-128000`: Custom budget

Thinking content is:
- Streamed in real-time to activity log (rolling window of last 500 chars)
- Stored in full for View Log modal
- Available for download via .txt export

## MCP Server Integration

The MCP server runs as a subprocess spawned by the SDK:

```
Main Process                    MCP Subprocess
     │                               │
     │  SDK spawns subprocess        │
     │  ─────────────────────────────>
     │                               │
     │                   ask_user tool called
     │                               │
     │                   Posts to Slack
     │                               │
     │  User clicks button           │
     │  ─────────────────>           │
     │                               │
     │  Writes /tmp/ccslack-answers/ │
     │  ─────────────────────────────>
     │                               │
     │                   Polls for file
     │                   Reads answer
     │                   Returns to SDK
```

IPC mechanism:
- Answer directory: `/tmp/ccslack-answers/`
- File format: `{questionId}.json` containing `{ answer: string, timestamp: number }`
- Main process writes, MCP subprocess polls and reads
- File deleted after reading

## Development Commands

```bash
# Setup
make setup              # Install all dependencies

# Testing
make test               # Run all tests
make test-coverage      # Run with coverage
make test-watch         # Watch mode
npm test -- src/__tests__/unit/blocks.test.ts  # Run specific file

# Type checking
npx tsc --noEmit

# Build & Run
make build              # Compile TypeScript
make dev                # Run dev server (auto-reload)
make start              # Run production server
make clean              # Remove dist/ and coverage/
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-...) |
| `SLACK_APP_TOKEN` | App-Level Token for Socket Mode (xapp-...) |
| `SLACK_SIGNING_SECRET` | Request signing secret |

## Commands

| Command | Description |
|---------|-------------|
| `@claude <message>` | Send message to Claude |
| `@claude /status` | Show session status, context usage |
| `@claude /mode` | Show mode selection buttons |
| `@claude /model` | Show model selection buttons |
| `@claude /cd <dir>` | Change working directory (before lock) |
| `@claude /ls [path]` | List files in directory |
| `@claude /set-current-path` | Lock current directory (one-time) |
| `@claude /context` | Show detailed context usage |
| `@claude /continue` | Get terminal resume command |
| `@claude /fork` | Get terminal fork command |
| `@claude /fork-thread <desc>` | Fork current thread to new thread |
| `@claude /resume <id>` | Resume a terminal session in Slack |
| `@claude /clear` | Clear conversation history |
| `@claude /compact` | Compact session to reduce context |
| `@claude /max-thinking-tokens <tokens>` | Set extended thinking budget (0=disable, 1024-128000) |
| `@claude /update-rate <1-10>` | Set status update interval (default 2s) |
| `@claude /message-size <100-36000>` | Set message size limit (default 500) |
| `@claude /strip-empty-tag [true\|false]` | Strip bare ``` wrappers (default false) |
| `@claude /wait <1-300>` | Rate limit test |
| `> fork: <description>` | (In thread) Fork to new thread |

## Session Cleanup

Sessions are automatically cleaned up when a Slack channel is deleted (via `channel_deleted` event):

**What gets deleted:**
- Main channel session from `sessions.json`
- All thread sessions from `sessions.json`
- All previous sessions (from `/clear` operations)
- All corresponding SDK `.jsonl` files from `~/.claude/projects/`

**What is NOT deleted:**
- Terminal forks created via `claude --resume <id> --fork-session`
- These may be user's personal sessions and cannot be distinguished from bot-created forks
