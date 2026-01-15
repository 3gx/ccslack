# Claude Code Slack Bot - Development Guide

## Quick Reference

```bash
# Build
npm run build

# Test (all)
npm test

# Test (specific file)
npm test -- src/__tests__/unit/blocks.test.ts

# Type check
npx tsc --noEmit

# Lint
npm run lint

# Run dev mode
npm run dev
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
└── __tests__/
    ├── unit/          # Unit tests (mocked dependencies)
    └── integration/   # Integration tests (mocked Slack/SDK)
```

## Key Patterns

### Error Handling
- Bot must NEVER crash on invalid input
- All handlers wrapped in try/catch
- Use `SlackBotError` class with typed error codes
- Return user-friendly messages via `toUserMessage()`

### Session Management
- Sessions stored in `sessions.json`
- Thread replies get forked sessions automatically
- Session includes: `sessionId`, `workingDir`, `mode`, timestamps

### Slack API Calls
- Always wrap in `withSlackRetry()` for rate limit handling
- Use streaming API with fallback to `chat.update`
- Split messages over 4000 characters

### Claude SDK Integration
- Use `query()` from `@anthropic-ai/claude-code`
- Pass `permissionMode` directly to SDK
- Handle `canUseTool` callback for manual approval mode
- MCP server provides `ask_user` and `approve_action` tools

## Testing

### Unit Tests
- Mock all external dependencies (Slack, SDK)
- Test individual functions in isolation
- Located in `src/__tests__/unit/`

### Integration Tests
- Mock Slack client and SDK
- Test full flows (message → response)
- Located in `src/__tests__/integration/`

### Running Tests
```bash
# All tests
npm test

# Watch mode
npm test -- --watch

# Coverage
npm test -- --coverage

# Single file
npm test -- src/__tests__/unit/blocks.test.ts
```

## Important Implementation Details

### Permission Modes
| Mode | SDK `permissionMode` | Tool Approval |
|------|---------------------|---------------|
| Plan | `plan` | SDK handles internally |
| Auto | `bypassPermissions` | No approval needed |
| Ask | `default` | Uses `canUseTool` callback |

### canUseTool Callback
In `default` mode, SDK calls `canUseTool` for tool approval:
- Must return `{ behavior: 'allow' }` or `{ behavior: 'deny', message }`
- Has 60-second timeout (we use 55s to be safe)
- Auto-deny `mcp__ask-user__approve_action` to avoid double prompts

### MCP Server Communication
- MCP server runs as subprocess spawned by SDK
- Uses file-based IPC via `/tmp/ccslack-answers/`
- Main process writes answer files, MCP server polls for them

### Thread Forking
- Detect thread via `thread_ts` in message event
- Check `sessions.json` for existing thread session
- If new, fork from parent session using `forkSession: true`

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
