# Claude Code Slack Bot - Architecture

## Overview

The Slack bot enables interaction with Claude Code through Slack DMs, providing:
- Streaming responses to Slack
- Interactive questions via Block Kit
- Session management with terminal handoff
- Thread-based session forking with point-in-time history
- Robust error handling with no crashes

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│              Slack Bot (Node.js + TypeScript)                │
│                                                              │
│  ┌──────────────────┐     ┌──────────────────────────────┐  │
│  │  Slack Events    │────→│  Pre-Flight Checks           │  │
│  │  (Socket Mode)   │     │  - Check ps for active       │  │
│  │  message.im      │     │    claude process            │  │
│  │  app_mention     │     │  - Show warning if found     │  │
│  │  block_actions   │     └──────────────────────────────┘  │
│  └──────────────────┘                ↓                       │
│          ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Session Manager                                     │   │
│  │  - Simple DM/thread → sessionId mapping              │   │
│  │  - Fork sessions for threads                         │   │
│  │  - Persist to sessions.json                          │   │
│  └──────────────────────────────────────────────────────┘   │
│          ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Claude Agent SDK                                    │   │
│  │  - query() for agent execution                       │   │
│  │  - Session resume/fork                               │   │
│  │  - Claude Code preset                                │   │
│  └──────────────────────────────────────────────────────┘   │
│          ↓                             ↓                     │
│  ┌─────────────────┐         ┌────────────────────────┐     │
│  │ Slack Streaming │         │ MCP ask_user Tool      │     │
│  │ API             │         │ Handler                │     │
│  │ - startStream   │         │ - Block Kit UI         │     │
│  │ - appendStream  │         │ - Abort detection      │     │
│  │ - stopStream    │         │ - File-based answers   │     │
│  └─────────────────┘         └────────────────────────┘     │
│          ↓                                                   │
│       ~/.claude/projects/ (SDK session storage)              │
└──────────────────────────────────────────────────────────────┘
```

## Components

### Entry Point (`src/index.ts`)
- Initializes Slack app with Socket Mode
- Loads environment variables
- Starts the bot

### Slack Bot (`src/slack-bot.ts`)
- Handles `message.im` events for DM messages
- Handles `app_mention` events for channel mentions
- Handles `block_actions` for button clicks
- Manages active queries and abort tracking
- Posts streaming responses with header blocks
- **Thread forking**: Detects `thread_ts` and auto-forks sessions
- **Error handling**: Top-level try/catch wraps all handlers

### Claude Client (`src/claude-client.ts`)
- Wraps Claude Code SDK `query()` function
- Configures MCP server for ask_user tool
- Maps modes to permission settings
- Supports `forkSession` option for thread forking

### MCP Server (`src/mcp-server.ts`)
- Implements `ask_user` tool for Slack questions
- Implements `approve_action` tool for approvals
- Uses file-based communication with main process
- Polls for answers in `/tmp/ccslack-answers/`

### Session Manager (`src/session-manager.ts`)
- Persists sessions to `sessions.json`
- Maps users to sessions
- Supports thread-based session forking
- Handles corrupted session files gracefully
- **Message mapping**: Maps Slack timestamps to SDK message IDs for point-in-time forking

### Streaming (`src/streaming.ts`)
- Implements Slack native streaming API
- Falls back to regular `chat.update` on errors
- Handles rate limiting with throttling
- **Message splitting**: Splits long responses (>4000 chars)

### Blocks (`src/blocks.ts`)
- Block Kit builders for all message types
- Question blocks with buttons/dropdowns
- Header blocks with status/stats
- Approval and reminder blocks

### Commands (`src/commands.ts`)
- Parses @claude commands
- Implements: mode, cwd, status, continue, fork, clear

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

## Data Flow

```
User DM → Slack Socket Mode → slack-bot.ts
                                   │
                          ┌────────┴────────┐
                          │                 │
                     Main DM?          Thread reply?
                          │                 │
                          ▼                 ▼
                    Get Session      getOrCreateThreadSession()
                          │                 │
                          │            Is new fork?
                          │                 │
                          │          Yes ───┼─── No
                          │           │     │     │
                          │    Post fork    │  Use existing
                          │    message      │  thread session
                          │           │     │     │
                          └─────┬─────┴─────┴─────┘
                                │
                                ▼
                          Claude SDK Query
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
            MCP ask_user tool        Streaming Response
                    │                       │
                    ▼                       ▼
            Block Kit Question       postSplitResponse()
                    │                       │
                    ▼                       ▼
            User clicks button        User sees response
                    │
                    ▼
            Write answer to file
                    │
                    ▼
            Claude continues
```

## Session Storage

Sessions are stored in `sessions.json`:

```json
{
  "channels": {
    "D123456": {
      "sessionId": "abc-123-def",
      "workingDir": "/Users/you/project",
      "mode": "plan",
      "createdAt": 1705123456789,
      "lastActiveAt": 1705234567890,
      "messageMap": {
        "1234567890.001": { "sdkMessageId": "user_001", "type": "user" },
        "1234567890.002": { "sdkMessageId": "msg_017pagAKz", "type": "assistant", "parentSlackTs": "1234567890.001" }
      },
      "threads": {
        "1234567890.002": {
          "sessionId": "ghi-456-jkl",
          "forkedFrom": "abc-123-def",
          "resumeSessionAtMessageId": "msg_017pagAKz",
          "workingDir": "/Users/you/project",
          "mode": "plan",
          "createdAt": 1705345678901,
          "lastActiveAt": 1705456789012
        }
      }
    }
  }
}
```

The `messageMap` links Slack message timestamps to SDK message IDs, enabling point-in-time forking. When a thread is created, `resumeSessionAtMessageId` stores the fork point.

## Error Handling Philosophy

**Principle: Bot must NEVER crash on invalid input. Always report error to user gracefully.**

### Error Codes

| Code | Description | Recoverable |
|------|-------------|-------------|
| `SLACK_RATE_LIMITED` | Rate limited by Slack | Yes |
| `SLACK_API_ERROR` | Generic Slack API error | Yes |
| `CLAUDE_SDK_ERROR` | Claude SDK threw error | No |
| `SESSION_NOT_FOUND` | Session ID doesn't exist | No |
| `SESSION_FILE_MISSING` | Session file deleted | No |
| `SESSION_FILE_CORRUPTED` | Invalid JSON in file | No |
| `WORKING_DIR_NOT_FOUND` | Directory doesn't exist | No |
| `GIT_CONFLICT` | Git conflicts detected | No |
| `EMPTY_MESSAGE` | No message text provided | No |

### Recovery Actions

| Scenario | Action |
|----------|--------|
| Session file missing | Create new session |
| Invalid working directory | Show error, keep old cwd |
| Git conflicts | Warn but continue |
| SDK error | Show user-friendly message |
| Rate limited | Retry with backoff |

## Thread Forking (Point-in-Time)

Thread forking uses **point-in-time history** - the thread only knows about messages up to where it forked:

```
Main channel: A → B → C → D
User replies to B in thread
Thread context: A, B only (not C, D)
```

### How It Works

1. **Message Mapping**: As messages flow, bot captures Slack timestamps → SDK message IDs
2. **Fork Detection**: When user replies in thread, bot detects `thread_ts`
3. **Fork Point Lookup**: `findForkPointMessageId()` finds the SDK message ID for the parent message
4. **Point-in-Time Fork**: SDK `resumeSessionAt` parameter creates fork with history only up to that point
5. **Notification**: Posts link to the exact message being forked from

### Fork Flow

1. Bot detects `thread_ts` in message event
2. Checks if thread already has a session
3. If new thread:
   - Looks up `thread_ts` in `messageMap` to find SDK message ID
   - Forks from parent session using `forkSession: true` and `resumeSessionAt`
   - Posts "Forked with conversation state through: [this message]" notification
4. Creates new SDK session with limited history
5. Saves thread session with `resumeSessionAtMessageId` to `sessions.json`

### Graceful Degradation

For older channels without message mappings:
- Falls back to forking from latest state (current behavior)
- New messages after deployment will have proper mappings

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- src/__tests__/integration/graceful-failures.test.ts

# Run with coverage
npm test -- --coverage

# Type checking
npx tsc --noEmit
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-...) |
| `SLACK_APP_TOKEN` | App-Level Token for Socket Mode (xapp-...) |

## Commands

| Command | Action |
|---------|--------|
| `@claude <message>` | Send message to Claude |
| `@claude /mode [plan\|auto\|ask]` | Set permission mode |
| `@claude /cwd [path]` | Set working directory |
| `@claude /status` | Show session status |
| `@claude /continue` | Get terminal resume command |
| `@claude /fork` | Get terminal fork command |
| `@claude /clear` | Clear conversation context |
