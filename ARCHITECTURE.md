# Claude Code Slack Bot - Architecture

## Overview

The Slack bot enables interaction with Claude Code through Slack channels (via @mentions), providing:
- Real-time status panel with activity log during processing
- Interactive questions and tool approvals via Block Kit
- Session management with terminal handoff
- "Fork here" button for point-in-time forking to new channels
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
│  │  - app_mention    │     │  - message: DM text messages               │   │
│  │  - block_actions  │     │  - channel_deleted: Session cleanup        │   │
│  │  - channel_deleted│     │  - block_actions: Button clicks            │   │
│  └───────────────────┘     └────────────────────────────────────────────┘   │
│                                          ↓                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  Command Parser (commands.ts)                                        │   │
│  │  /status, /mode, /model, /cd, /cwd, /ls, /set-current-path, /context,│   │
│  │  /watch, /stop-watching, /ff, /resume, /clear, /compact,             │   │
│  │  /max-thinking-tokens, /update-rate, /message-size, /show-plan, /help│   │
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
│  │  - canUseTool callback for approvals                                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│            │                                       │                         │
│            ▼                                       ▼                         │
│  ┌────────────────────────┐          ┌───────────────────────────────────┐  │
│  │  Real-Time UI          │          │  Tool Approval System             │  │
│  │  (blocks.ts)           │          │  - canUseTool callback            │  │
│  │                        │          │  - AskUserQuestion prompts        │  │
│  │  Message 1: Status     │          │  - Approve/Deny buttons           │  │
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
- Starts the bot via `startBot()`
- Sets up graceful shutdown handlers (SIGTERM, SIGINT)
- Calls `stopAllWatchers()` to stop terminal watchers on shutdown

### Slack Bot (`src/slack-bot.ts`)
- Handles `app_mention` events for channel @mentions
- Handles `message.im` events for DM text messages
- Handles `block_actions` for button clicks (abort, tool approval, mode selection)
- Handles `channel_deleted` for session cleanup
- Manages active queries with abort capability via `ClaudeQuery.interrupt()`
- Posts real-time status panel and activity log during processing
- Coordinates tool approval flow in `default` permission mode
- **Fork here button**: Creates new channel with point-in-time forked session
- **DM notifications**: Sends DMs when users are mentioned (15-sec debounce per type)
- **Emoji reactions**: Tracks message state (:eyes:, :question:, :x:, etc.)
- **Error handling**: Top-level try/catch wraps all handlers
- **Mutex locking**: Prevents race conditions during abort and emoji operations

### Claude Client (`src/claude-client.ts`)
- Wraps Claude Code SDK `query()` function
- Implements `canUseTool` callback for tool approval in `default` mode
- Maps permission modes directly to SDK (`plan`, `default`, `bypassPermissions`, `acceptEdits`)
- Supports `forkSession` and `resumeSessionAt` for "Fork here" button
- Configures `maxThinkingTokens` for extended thinking budget
- Enables `includePartialMessages` for real-time activity tracking

### Tool Approval System
- SDK's `canUseTool` callback handles tool approval in `default` mode
- `AskUserQuestion` tool always prompts user in ALL permission modes
- Tool approval UI shows tool name and input preview with Approve/Deny buttons
- 7-day expiry with 4-hour reminder intervals (42 reminders max)
- Auto-deny after max reminders reached
- Pending approvals tracked in memory with cleanup on answer/abort

### Session Manager (`src/session-manager.ts`)
- Persists sessions to `sessions.json`
- **Session interface**: `sessionId`, `previousSessionIds`, `workingDir`, `mode`, `model`, `createdAt`, `lastActiveAt`, `pathConfigured`, `configuredPath`, `configuredBy`, `configuredAt`, `lastUsage`, `maxThinkingTokens`, `updateRateSeconds`, `threadCharLimit`, `planFilePath`, `planPresentationCount`, `syncedMessageUuids`, `slackOriginatedUserUuids`, `forkedFromChannelId`, `forkedFromMessageTs`, `forkedFromThreadTs`, `forkedFromSdkMessageId`, `forkedFromSessionId`, `forkedFromConversationKey`
- **LastUsage interface**: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `contextWindow`, `model`, `maxOutputTokens`
- **ThreadSession interface**: Inherits from Session, adds `forkedFrom`, `forkedFromThreadTs`, `resumeSessionAtMessageId`
- **Message mapping**: `SlackMessageMapping` links Slack timestamps to SDK message IDs and session IDs
- **Activity log storage**: Activity entries stored in memory during processing (not persisted to sessions.json)
- `previousSessionIds[]`: Tracks sessions before `/clear` for time-travel forking
- Handles corrupted session files gracefully with migration support

### Streaming (`src/streaming.ts`)
- Implements Slack native streaming API (chat.startStream/appendStream/stopStream)
- Falls back to throttled `chat.update` on errors (2-second interval)
- `truncateWithClosedFormatting()`: Truncates text at configurable limit with proper formatting closure
- `uploadMarkdownAndPngWithResponse()`: Posts response with attached .md and .png files when truncated
- `uploadFilesToThread()`: Uploads thinking content as files to thread

### Blocks (`src/blocks.ts`)
- Block Kit builders for all message types
- **Status panel**: `buildStatusPanelBlocks()` - mode, model, current activity, spinner, abort button
- **Activity log**: `buildActivityLogText()` - thinking, tool executions, generating status
- **Live activity**: `buildLiveActivityBlocks()` - real-time activity with Fork button on completion
- **Combined status**: `buildCombinedStatusBlocks()` - unified status and activity display
- Question blocks with buttons/multi-select dropdowns
- Tool approval blocks for manual approval mode
- Plan approval blocks (5 options: clear+bypass, accept edits, bypass, manual, change plan)
- Mode and model selection blocks
- Context usage display with visual progress bar
- Cost display in status footer

### Commands (`src/commands.ts`)
- Parses slash commands from user messages
- Implements: `/help`, `/status`, `/context`, `/mode`, `/model`, `/cd`, `/cwd`, `/ls`, `/set-current-path`, `/watch`, `/stop-watching`, `/ff`, `/resume`, `/clear`, `/compact`, `/max-thinking-tokens`, `/update-rate`, `/message-size`, `/show-plan`

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
- `getAvailableModels()`, `isModelAvailable()`, `refreshModelCache()`, `getModelInfo()`, `getDefaultModel()`
- Used for `/model` command and model selection UI

### Markdown PNG (`src/markdown-png.ts`)
- Converts markdown to PNG images using Puppeteer
- Includes syntax highlighting for code blocks via highlight.js
- Returns null on failure for graceful fallback

### Abort Tracker (`src/abort-tracker.ts`)
- Tracks aborted conversations to prevent race conditions
- `markAborted()`, `isAborted()`, `clearAborted()`, `reset()` (testing only)
- Used during query interrupt flow

### FF Abort Tracker (`src/ff-abort-tracker.ts`)
- Tracks aborted fast-forward sync operations
- Similar API to abort-tracker but for `/ff` command
- Enables "Stop FF" button to halt mid-sync

### File Handler (`src/file-handler.ts`)
- Downloads and processes Slack file uploads
- **Limits**: Up to 20 files per message, 30MB max per file
- **Image handling**: Resizes to max 3.75MB for Claude API
- **Text detection**: JSON, JS, TS, XML, YAML, Python, shell scripts, etc.
- **Binary rejection**: PDFs, ZIPs, audio/video, Office docs skipped with warning
- Returns file metadata with content or base64 data

### Content Builder (`src/content-builder.ts`)
- Builds Claude-compatible multi-modal content blocks
- Combines text prompts with image/file content
- Handles base64 encoding for images
- Supports multiple files per message
- Adds file index numbering for user reference

### Session Reader (`src/session-reader.ts`)
- Parses Claude SDK JSONL session files from `~/.claude/projects/`
- `readNewMessages()`: Read messages from byte offset
- `extractTextContent()`: Convert content blocks to text
- `groupMessagesByTurn()`: Group messages into user turns for `/ff`
- `hasExitPlanMode()`: Detect plan mode completion
- `extractPlanFilePathFromMessage()`: Extract plan file paths

### Session Event Stream (`src/session-event-stream.ts`)
- Reads session JSONL files as async generator
- Streams events for real-time terminal watching
- Supports resuming from byte offset

### Terminal Watcher (`src/terminal-watcher.ts`)
- Polls terminal session files for new messages
- Posts updates to Slack channel in real-time
- Tracks watch state per channel
- Prevents concurrent polls with `pollInProgress` flag
- `startWatching()`, `stopWatching()`, `stopAllWatchers()`

### Message Sync (`src/message-sync.ts`)
- Syncs terminal session messages to Slack for `/ff` command
- **Turn-based posting**: Groups messages by user turn for fidelity
- **TurnSegment structure**: Activity messages + text output pairs
- **Interleaved content**: Handles think → text → think → tools → text patterns
- Tracks synced message UUIDs to prevent duplicates
- Supports resumable sync (can run `/ff` multiple times)

### Activity Thread (`src/activity-thread.ts`)
- Posts activity entries as thread replies
- `formatThreadActivityBatch()`: Batches activity entries
- `formatThreadThinkingMessage()`: Formats thinking content
- `formatThreadResponseMessage()`: Formats response content
- Truncates long content with .md attachment fallback
- Rate-limited to prevent Slack API limits

### Concurrent Check (`src/concurrent-check.ts`)
- **DISABLED**: Attempts to detect if session is active in terminal
- Returns `false` always (no reliable detection method found)
- macOS `ps` truncates command arguments
- Documented for potential future implementation

### Utils (`src/utils.ts`)
- Utility functions for markdown conversion and text processing
- Markdown-to-Slack mrkdwn conversion
- Text truncation helpers

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
            SDK stream_event       AskUserQuestion tool    canUseTool callback
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
      "updateRateSeconds": 3,
      "threadCharLimit": 500,
      "planFilePath": null,
      "lastUsage": {
        "inputTokens": 5000,
        "outputTokens": 1200,
        "cacheReadInputTokens": 3000,
        "cacheCreationInputTokens": 500,
        "contextWindow": 200000,
        "model": "claude-sonnet-4-5-20250929",
        "maxOutputTokens": 16384
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
          "updateRateSeconds": 3,
          "threadCharLimit": 500,
          "planFilePath": null
        }
      },
      "syncedMessageUuids": [],
      "slackOriginatedUserUuids": []
    }
  }
}

Note: Activity logs are stored in memory during processing only and are NOT persisted to sessions.json.
```

### Key Storage Concepts

- **messageMap**: Links Slack message timestamps to SDK message IDs AND session IDs, enabling forking after `/clear`
- **previousSessionIds**: Tracks old session IDs after `/clear` for time-travel forking
- **resumeSessionAtMessageId**: SDK message ID to fork from (passed to `resumeSessionAt` in SDK query)
- **activityLogs**: In-memory only during processing (not persisted to sessions.json)
- **pathConfigured**: Immutable after first set - prevents accidental working directory changes
- **threadCharLimit**: Message size limit before response truncation (default 500)
- **planFilePath**: Persistent plan file path for plan mode (detected from tool usage)

## Real-Time Updates Architecture

During query processing, the bot maintains two Slack messages that are updated in real-time:

### Message 1: Status Panel
Updated every `updateRateSeconds` (configurable 1-10s, default 3s):
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
- Activity log displayed inline in status message
- Shows collapsed summary: "X thinking + Y tools in Zs"
- "Fork here" button on final message segment
- Cost displayed in status footer ($X.XXXX)

### Activity Entry Types
```typescript
interface ActivityEntry {
  timestamp: number;
  type: 'starting' | 'thinking' | 'tool_start' | 'tool_complete' | 'error' | 'generating' | 'aborted' | 'mode_changed' | 'context_cleared' | 'session_changed';
  tool?: string;
  durationMs?: number;
  message?: string;
  thinkingContent?: string;     // Full content stored in activity log
  thinkingTruncated?: string;   // First 500 chars for live display
  thinkingInProgress?: boolean;
  generatingChunks?: number;
  generatingChars?: number;
  generatingInProgress?: boolean;
  generatingContent?: string;   // Full response text
  generatingTruncated?: string; // First 500 chars for live display
  mode?: string;                // For mode_changed entries
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
| `FILE_DOWNLOAD_ERROR` | Could not download file | No |
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

## Fork Here Button

The "Fork here" button on messages creates a new Slack channel with a point-in-time forked session.

### How It Works

1. **Message Mapping**: As messages flow, bot captures Slack timestamps → SDK message IDs (with session ID)
2. **Button Click**: User clicks "Fork here" on any bot response message
3. **Fork Point**: Button includes SDK message ID and session ID for the fork point
4. **Channel Creation**: Creates new Slack channel with user-specified name
5. **SDK Fork**: Uses `forkSession: true` with `resumeSessionAt` to limit context to that message (verified in sdk-fork-e2e-clear.test.ts)
6. **Session Setup**: New channel gets independent session from fork point

### Fork Flow

1. User clicks "Fork here" button on a message
2. Modal prompts for new channel name
3. Bot creates new Slack channel
4. Bot forks SDK session using:
   - `forkSession: true`
   - `resumeSessionAt: <sdk_message_id>`
5. Creates session record with `forkedFromChannelId`, `forkedFromMessageTs`, `forkedFromSdkMessageId`
6. Posts welcome message in new channel with link to fork point

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
- `AskUserQuestion` tool always prompts user regardless of mode
- Tool approval UI shows tool name and input preview

## Extended Thinking

Configurable via `/max-thinking-tokens <tokens>` command:
- `undefined`: Default (31,999 tokens)
- `0`: Disabled (no thinking blocks)
- `1024-128000`: Custom budget

Thinking content is:
- Streamed in real-time to activity log (rolling window of last 500 chars)
- Full content stored in activity entries during processing
- Displayed inline in status message on completion

## Tool Approval Integration

The SDK uses callbacks for tool approval and questions:

```
Claude SDK                       Slack Bot
     │                               │
     │  canUseTool callback          │
     │  ─────────────────────────────>
     │                               │
     │                   Posts Approve/Deny UI
     │                               │
     │  User clicks button           │
     │  <─────────────────           │
     │                               │
     │  Promise resolved             │
     │  <─────────────────────────────
     │                               │
     │  SDK continues execution      │
```

Approval mechanism:
- `canUseTool` callback receives tool name and input
- Bot posts Block Kit message with Approve/Deny buttons
- User response resolves a Promise stored in `pendingToolApprovals` map
- `AskUserQuestion` tool always prompts via button/dropdown UI
- 7-day timeout with 4-hour reminders (max 42 reminders)
- Auto-deny after timeout expires

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
| `ANTHROPIC_API_KEY` | API key for SDK live tests (optional) |
| `SKIP_SDK_TESTS` | Set to 'true' to skip live SDK tests |

## Commands

| Command | Description |
|---------|-------------|
| `@claude <message>` | Send message to Claude |
| `@claude /help` | Show all available commands |
| `@claude /status` | Show session status, context usage |
| `@claude /context` | Show detailed context usage with progress bar |
| `@claude /mode [plan\|bypass\|ask\|edit]` | Show mode picker or switch directly |
| `@claude /model` | Show model selection buttons |
| `@claude /cd <dir>` | Change working directory (before lock) |
| `@claude /cwd` | Show current working directory |
| `@claude /ls [path]` | List files in directory |
| `@claude /set-current-path` | Lock current directory (one-time) |
| `@claude /watch` | Start watching session for terminal updates |
| `@claude /stop-watching` | Stop watching terminal session |
| `@claude /ff` | Fast-forward sync missed terminal messages (main channel only) |
| `@claude /resume <id>` | Resume a terminal session in Slack (UUID format) |
| `@claude /clear` | Clear conversation history |
| `@claude /compact` | Compact session to reduce context |
| `@claude /max-thinking-tokens [tokens]` | Set extended thinking budget (0=disable, 1024-128000, default=31999) |
| `@claude /update-rate [1-10]` | Set status update interval (default 3s) |
| `@claude /message-size [100-36000]` | Set message size limit (default 500) |
| `@claude /show-plan` | Display current plan file content in thread |

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

## File Upload Support

The bot supports file uploads attached to messages:

### Processing Flow
1. User attaches files to message mentioning @bot
2. Bot downloads files from Slack (max 30MB per file, 20 files per message)
3. Images resized if needed (max 3.75MB for Claude API)
4. Text files have content extracted
5. Binary files (PDF, ZIP, etc.) are skipped with warning
6. Content blocks built for Claude multi-modal API

### Supported Formats
- **Images**: PNG, JPG, GIF, WebP (converted to base64)
- **Text/Code**: JSON, JS, TS, XML, YAML, Python, shell scripts, markdown
- **Skipped**: PDFs, ZIPs, audio/video, Office documents (with warning)

## DM Notifications

The bot sends direct messages to notify users of important events:

### Notification Types
- **Questions**: When `AskUserQuestion` tool is invoked
- **Plan approvals**: When plan mode exits and approval is needed
- **Tool approvals**: When manual tool approval is required
- **Completions**: When a query completes with user mentions

### Behavior
- 15-second debounce per user+type combination
- Skips DM channels (no need to notify about DMs)
- Skips bot users (can't DM bots)
- Includes permalink button to original message
- Silently fails if DM fails (non-critical feature)

## Emoji Reaction System

The bot uses emoji reactions to indicate message state:

| Emoji | Meaning |
|-------|---------|
| :eyes: | Processing in progress |
| :question: | Waiting for user input (questions, approvals) |
| :page_with_curl: | Plan file being presented |
| :x: | Error occurred |
| :octagonal_sign: | Processing stopped/aborted |
| :twisted_rightwards_arrows: | Fork available |

- Reactions added to original user message
- Mutex-based serialization prevents race conditions
- Automatically cleaned up on completion/error

## Auto-Compaction

Sessions are automatically compacted when context usage is high:

### Trigger
- Auto-compact threshold = 80% of remaining output capacity
- Checked after each query completion

### Behavior
- Automatic (no user prompt required)
- Shows completion message with stats
- Different from manual `/compact` command
- `compactIsManual` flag distinguishes auto vs manual

### Status Display
- `compactPercent`: Percentage of context remaining before trigger
- `tokensToCompact`: Tokens until auto-compact triggers

## Terminal Integration Details

### Turn-Based Message Posting

The `/ff` command posts messages grouped by user turn for fidelity:

```
Turn = User input + All associated responses
     = Activity messages + Text output pairs
```

### TurnSegment Structure
- Each turn can have multiple segments
- Segment = Activity entries + Text output
- Handles interleaved patterns: think → text → think → tools → text

### Fast-Forward Flow
1. `/ff` reads session JSONL from `~/.claude/projects/`
2. Groups messages by turn using `groupMessagesByTurn()`
3. Posts each turn's segments to Slack with activity
4. Tracks synced UUIDs to prevent duplicates
5. Starts watching for new messages

### Watch State
- `pollInProgress` flag prevents concurrent polls
- Watch anchor messages show sync progress
- "Stop FF" button can abort mid-sync
- Resumable: `/ff` can run multiple times

## Plan Mode Details

### Plan Approval UI (5 Buttons)

When Claude exits plan mode via `ExitPlanMode` tool:

1. **Clear context & bypass** - Clears session AND enables bypass mode
2. **Accept edits** - Enables `acceptEdits` mode
3. **Bypass permissions** - Enables `bypassPermissions` mode
4. **Manual approve** - Each tool needs individual approval
5. **Change the plan** - User provides feedback on plan rejection

### Plan Tracking
- `planFilePath`: Path to current plan file (persistent)
- `planPresentationCount`: Times plan has been presented (reset on `/clear`)
- `/show-plan` command displays plan file content
