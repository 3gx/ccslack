# Claude Code Slack Bot - Development Guide

## Quick Reference

```bash
# Setup
make setup              # Install all dependencies

# Build & Run
make build              # Compile TypeScript
make dev                # Run dev server (auto-reload)
make start              # Run production server
make clean              # Remove dist/ and coverage/

# Testing
make test               # Unit + integration tests (mocked, JOBS=4 for parallel)
make sdk-test           # Live SDK tests (may require ANTHROPIC_API_KEY, SDKJOBS=4)
make all-test           # All tests (unit + integration + SDK live)
make test-watch         # Watch mode
make test-coverage      # With coverage report

# Single file test
npm test -- src/__tests__/unit/blocks.test.ts

# Type check only
npx tsc --noEmit
```

## Project Structure

```
src/
├── index.ts              # Entry point, initializes Slack app
├── slack-bot.ts          # Main bot logic, event handlers, button handlers (~6400 lines)
├── claude-client.ts      # Claude Code SDK wrapper
├── session-manager.ts    # Session persistence to sessions.json with mutex locking
├── session-reader.ts     # Parses Claude SDK JSONL session files from ~/.claude/projects/
├── session-event-stream.ts # Reads session JSONL files as async generator
├── streaming.ts          # Slack streaming API with fallback to chat.update
├── blocks.ts             # Block Kit builders for all UI (~83KB)
├── commands.ts           # Slash command parsing and execution
├── errors.ts             # SlackBotError class and error factories
├── retry.ts              # Retry utilities with exponential backoff
├── abort-tracker.ts      # Tracks aborted queries by conversation key
├── ff-abort-tracker.ts   # Tracks aborted fast-forward syncs
├── concurrent-check.ts   # Terminal session detection (currently disabled)
├── model-cache.ts        # Caches available models from SDK (1-hour TTL)
├── markdown-png.ts       # Markdown to PNG image conversion via Puppeteer
├── utils.ts              # Utility functions (markdown conversion, etc.)
├── message-sync.ts       # Syncs terminal session messages to Slack
├── terminal-watcher.ts   # Polls terminal session files and posts updates
├── activity-thread.ts    # Posts activity entries as thread replies
├── file-handler.ts       # Downloads and processes Slack file uploads
├── content-builder.ts    # Builds Claude-compatible multi-modal content blocks
├── types.d.ts            # Module declarations for markdown-it plugins
└── __tests__/
    ├── unit/             # Unit tests (27 files, mocked dependencies)
    ├── integration/      # Integration tests (19 files, mocked Slack/SDK)
    └── sdk-live/         # Live SDK tests (50 files, requires real API key)
```

## Key Patterns

### Error Handling
- Bot must NEVER crash on invalid input
- All handlers wrapped in try/catch
- Use `SlackBotError` class with typed error codes
- Return user-friendly messages via `toUserMessage()`

### Session Management
- Sessions stored in `sessions.json`
- "Fork here" button creates new channel with point-in-time forked session
- Session includes: `sessionId`, `workingDir`, `mode`, `model`, timestamps
- Channel sessions include `messageMap` for Slack ts → SDK message ID mapping
- Session configuration: `maxThinkingTokens`, `updateRateSeconds`, `threadCharLimit`, `stripEmptyTag`, `lastUsage`, `planFilePath`
- `lastUsage` cleared on `/clear` to show fresh state in `/status` and `/context`

### Session Cleanup

Sessions are automatically cleaned up when:
- A Slack channel is deleted (via `channel_deleted` event)
- The bot receives the deletion event and removes:
  1. Bot's session records from `sessions.json`
  2. Main session SDK file from `~/.claude/projects/`
  3. All thread session SDK files

**What gets deleted:**
- ✅ Main channel session
- ✅ Forked channel sessions (from "Fork here" button)
- ❌ Terminal forks (created via `claude --resume <id> --fork-session`)

**Why terminal forks are NOT deleted:**
- They may be user's personal sessions
- Bot cannot distinguish bot-created vs. user-created forks
- User has full control over terminal session lifecycle

### Slack API Calls
- Always wrap in `withSlackRetry()` for rate limit handling
- Use streaming API with fallback to `chat.update`
- Split messages over 4000 characters

### Claude SDK Integration
- Use `query()` from `@anthropic-ai/claude-agent-sdk`
- Pass `permissionMode` directly to SDK
- Handle `canUseTool` callback for manual approval mode
- `includePartialMessages: true` enables real-time activity tracking (stream_event messages)

## Testing

### Unit Tests
- Mock all external dependencies (Slack, SDK)
- Test individual functions in isolation
- Located in `src/__tests__/unit/`

### Integration Tests
- Mock Slack client and SDK
- Test full flows (message → response)
- Located in `src/__tests__/integration/`

### SDK Live Tests
- Require real API key (`ANTHROPIC_API_KEY`)
- Test actual SDK behavior (forking, clearing, compacting)
- Located in `src/__tests__/sdk-live/`
- Run with `make sdk-test` (see Quick Reference above)

## Important Implementation Details

### Permission Modes
| Mode | SDK `permissionMode` | Tool Approval |
|------|---------------------|---------------|
| Plan | `plan` | SDK handles via ExitPlanMode tool, shows 5-button approval UI |
| Bypass | `bypassPermissions` | No approval needed, all tools auto-allowed |
| Ask (Default) | `default` | Uses `canUseTool` callback with Approve/Deny buttons |
| AcceptEdits | `acceptEdits` | Accept code edits without prompting, prompt for others |

### Mode Shortcuts
- `/mode plan` → `plan`
- `/mode bypass` → `bypassPermissions`
- `/mode ask` → `default`
- `/mode edit` → `acceptEdits`

### canUseTool Callback
In `default` mode, SDK calls `canUseTool` for tool approval:
- Must return `{ behavior: 'allow', updatedInput: {...} }` or `{ behavior: 'deny', message }`
- Has 7-day timeout with 4-hour reminder intervals
- `AskUserQuestion` tool always prompts user in ALL modes

### Fork Here Button
- "Fork here" button on messages creates new Slack channel with point-in-time forked session
- Uses `forkSession: true` and `resumeSessionAt` to limit context to that message
- Fork gets context up to that message only (verified in sdk-fork-e2e-clear.test.ts)
- New channel has independent session from fork point

### Extended Thinking Configuration
- `maxThinkingTokens` in session controls Claude's extended thinking budget
- Values: `undefined` = default (31,999), `0` = disabled, positive = custom budget
- Set via `/max-thinking-tokens <tokens>` command
- Inherited by thread sessions from parent channel
- Shown in `/status` output

### Update Rate Configuration
- `updateRateSeconds` controls how often Slack status updates during processing
- Values: `undefined` = 3 seconds (default), range 1-10 seconds
- Higher values reduce Slack API rate limit pressure
- Set via `/update-rate <seconds>` command
- Shown in `/status` output
- Can be updated mid-query (takes effect immediately)

### Message Size Configuration
- `threadCharLimit` controls max chars before response truncation
- Values: `undefined` = 500 (default), range 100-36000
- Set via `/message-size <chars>` command
- Shown in `/status` output

### Strip Empty Tag Configuration
- `stripEmptyTag` controls stripping of bare ``` wrappers
- Values: `undefined` or `false` = preserve (default), `true` = strip
- Set via `/strip-empty-tag [true|false]` command
- Shown in `/status` output

### Activity Log and Generating Entries
- Real-time activity tracking via `ActivityEntry` type
- Entry types: `starting`, `thinking`, `tool_start`, `tool_complete`, `error`, `generating`, `aborted`, `mode_changed`
- `generating` entries track text streaming progress (chunks, chars, duration)
- Activity logs stored in memory during processing (not persisted to sessions.json)
- View Log modal shows paginated activity history
- Download .txt exports full activity log

### Plan Mode
- Claude writes to a plan file via `ExitPlanMode` tool
- Session stores `planFilePath` for the current plan
- `/show-plan` command displays plan file content in thread
- Plan approval shows 5 buttons: 1. Clear context & bypass, 2. Accept edits, 3. Bypass permissions, 4. Manual approve, 5. Change the plan

### Terminal Integration
- `/watch` starts watching a session for terminal updates
- `/stop-watching` stops watching the terminal session
- `/fork` provides terminal command to fork session
- `/ff` (fast-forward) command and then `/watch`
- Terminal watcher polls session JSONL files and posts new messages to Slack

## Common Issues

### Rate Limiting
- Slack API has rate limits
- `withSlackRetry()` handles `Retry-After` headers
- Streaming updates throttled to prevent rate limits

### Session Not Found
- Sessions stored in `sessions.json`
- If corrupted, delete file to reset
- SDK sessions in `~/.claude/projects/`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth Token (xoxb-...) |
| `SLACK_APP_TOKEN` | Yes | Socket Mode Token (xapp-...) |
| `ANTHROPIC_API_KEY` | No | API key for SDK live tests |
| `SKIP_SDK_TESTS` | No | Set to 'true' to skip live SDK tests |

## All Slash Commands

| Command | Parameters | Description |
|---------|------------|-------------|
| `/help` | - | Show all available commands |
| `/status` | - | Show session info (ID, mode, directory, context usage) |
| `/context` | - | Show context window usage with visual progress bar |
| `/mode` | `[plan\|bypass\|ask\|edit]` | Show mode picker or switch directly with shortcut |
| `/model` | `[name]` | Show model picker (name arg redirects to picker) |
| `/max-thinking-tokens` | `[n]` | Set thinking budget (0=disable, 1024-128000, default=31999) |
| `/update-rate` | `[n]` | Set status update interval (1-10 seconds, default=3) |
| `/message-size` | `[n]` | Set message size limit (100-36000, default=500) |
| `/strip-empty-tag` | `[true\|false]` | Strip bare ``` wrappers (default=false) |
| `/ls` | `[path]` | List files in directory |
| `/cd` | `[path]` | Change directory (disabled after path locked) |
| `/set-current-path` | - | Lock current directory (one-time, cannot be changed) |
| `/watch` | - | Start watching session for terminal updates (main channel only) |
| `/stop-watching` | - | Stop watching terminal session |
| `/fork` | - | Get terminal command to fork session |
| `/ff` | - | Fast-forward sync missed terminal messages (main channel only) |
| `/resume` | `<session-id>` | Resume a terminal session in Slack (UUID format required) |
| `/compact` | - | Compact session to reduce context size |
| `/clear` | - | Clear session history and start fresh |
| `/show-plan` | - | Display current plan file content in thread |
| `/wait` | `<seconds>` | Rate limit stress test (1-300 seconds) |

