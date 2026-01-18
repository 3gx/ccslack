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
make test               # Unit + integration tests (mocked)
make sdk-test           # Live SDK tests (requires ANTHROPIC_API_KEY)
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
├── index.ts           # Entry point, initializes Slack app
├── slack-bot.ts       # Main bot logic, event handlers, button handlers
├── claude-client.ts   # Claude Code SDK wrapper
├── mcp-server.ts      # MCP ask_user/approve_action tools
├── session-manager.ts # Session persistence to sessions.json
├── streaming.ts       # Slack streaming API with fallback
├── blocks.ts          # Block Kit builders for all UI
├── commands.ts        # Slash command parsing
├── errors.ts          # SlackBotError class and error factories
├── retry.ts           # Retry utilities with backoff
├── abort-tracker.ts   # Tracks aborted queries by conversation key
├── concurrent-check.ts # Detects if session is active in terminal
├── model-cache.ts     # Caches available models from SDK
├── utils.ts           # Utility functions (markdown conversion, etc.)
└── __tests__/
    ├── unit/          # Unit tests (mocked dependencies)
    ├── integration/   # Integration tests (mocked Slack/SDK)
    └── sdk-live/      # Live SDK tests (requires real API key)
```

## Key Patterns

### Error Handling
- Bot must NEVER crash on invalid input
- All handlers wrapped in try/catch
- Use `SlackBotError` class with typed error codes
- Return user-friendly messages via `toUserMessage()`

### Session Management
- Sessions stored in `sessions.json`
- Thread replies get forked sessions automatically (point-in-time)
- Session includes: `sessionId`, `workingDir`, `mode`, `model`, timestamps
- Channel sessions include `messageMap` for Slack ts → SDK message ID mapping
- Session configuration: `maxThinkingTokens`, `updateRateSeconds`, `lastUsage`
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
- ✅ Thread sessions (auto-forks and `/fork-thread` forks)
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
- MCP server provides `ask_user` and `approve_action` tools
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
| Plan | `plan` | SDK handles internally |
| Auto | `bypassPermissions` | No approval needed |
| Ask | `default` | Uses `canUseTool` callback |
| AcceptEdits | `acceptEdits` | Accept code edits without prompting |

### canUseTool Callback
In `default` mode, SDK calls `canUseTool` for tool approval:
- Must return `{ behavior: 'allow' }` or `{ behavior: 'deny', message }`
- Has 60-second timeout (we use 55s to be safe)
- Auto-deny `mcp__ask-user__approve_action` to avoid double prompts

### MCP Server Communication
- MCP server runs as subprocess spawned by SDK
- Uses file-based IPC via `/tmp/ccslack-answers/`
- Main process writes answer files, MCP server polls for them

### Thread Forking (Point-in-Time)
- Detect thread via `thread_ts` in message event
- Check `sessions.json` for existing thread session
- If new:
  - Look up `thread_ts` in `messageMap` to find SDK message ID
  - Fork from parent using `forkSession: true` and `resumeSessionAt`
  - Thread gets history only up to the fork point (not future messages)
- Older channels without `messageMap` fall back to latest-state forking
- After `/clear`, forks use session ID stored in `messageMap` (not current null session)

### Extended Thinking Configuration
- `maxThinkingTokens` in session controls Claude's extended thinking budget
- Values: `undefined` = default (31,999), `0` = disabled, positive = custom budget
- Set via `/thinking <tokens>` command
- Inherited by thread sessions from parent channel
- Shown in `/status` output

### Update Rate Configuration
- `updateRateSeconds` controls how often Slack status updates during processing
- Values: `undefined` = 1 second (default), range 1-10 seconds
- Higher values reduce Slack API rate limit pressure
- Set via `/rate <seconds>` command
- Shown in `/status` output

### Activity Log and Generating Entries
- Real-time activity tracking via `ActivityEntry` type
- Entry types: `starting`, `thinking`, `tool_start`, `tool_complete`, `error`, `generating`
- `generating` entries track text streaming progress (chunks, chars, duration)
- Activity logs stored in `activityLogs` by conversation key
- View Log modal shows paginated activity history
- Download .txt exports full activity log

## Common Issues

### Double Approval Prompts
If both `canUseTool` and MCP `approve_action` show prompts:
- Ensure `approve_action` is auto-denied in `canUseTool`
- Check `allowedTools` doesn't include `approve_action` in default mode

### Rate Limiting
- Slack API has rate limits
- `withSlackRetry()` handles `Retry-After` headers
- Streaming updates throttled to prevent rate limits

### Session Not Found
- Sessions stored in `sessions.json`
- If corrupted, delete file to reset
- SDK sessions in `~/.claude/projects/`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot OAuth Token (xoxb-...) |
| `SLACK_APP_TOKEN` | Socket Mode Token (xapp-...) |
| `SLACK_SIGNING_SECRET` | Request signing secret |
| `ANTHROPIC_API_KEY` | API key for SDK live tests (optional) |
