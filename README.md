# Claude Code Slack Bot

A Slack bot that integrates the Claude Code SDK for AI-powered coding assistance in Slack channels.

## Quick Start

1. **Set up Slack App** - Follow the [Slack Bot Setup Guide](./SETUP.md) to create and configure your Slack app
2. **Configure environment** - Copy `.env.example` to `.env` and add your tokens
3. **Install & run**:
   ```bash
   make setup    # Install dependencies
   make build    # Compile TypeScript
   make start    # Run the bot
   ```

See [SETUP.md](./SETUP.md) for detailed step-by-step instructions.

## Features

- **Direct messaging** with Claude Code via Slack mentions (@bot)
- **Session persistence** across conversations with automatic resumption
- **Real-time activity log** showing thinking, generating, and tool usage
- **Extended thinking support** with configurable token budget (1,024-128,000)
- **Multiple permission modes** for controlling tool execution
- **Model selection** via interactive picker
- **Point-in-time thread forking** for exploring alternative approaches
- **Session management** with compact and clear commands
- **MCP server integration** for `ask_user` and `approve_action` tools
- **Automatic cleanup** when channels are deleted

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/status` | Show session info (ID, mode, directory, context usage) |
| `/context` | Show context window usage with visual progress bar |
| `/mode [plan\|bypass\|ask\|edit]` | Show mode picker or switch directly with shortcut |
| `/model` | Show model picker |
| `/max-thinking-tokens [n]` | Set thinking budget (0=disable, 1024-128000, default=31999) |
| `/update-rate [n]` | Set status update interval (1-10 seconds, default=3) |
| `/message-size [n]` | Set message size limit before truncation (100-36000, default=500) |
| `/strip-empty-tag [true\|false]` | Strip bare ``` wrappers (default=false) |
| `/ls [path]` | List files in directory (relative or absolute) |
| `/cd [path]` | Change directory (only before path is locked) |
| `/set-current-path` | Lock current directory (one-time only, cannot be changed) |
| `/watch` | Start watching session for terminal updates (main channel only) |
| `/stop-watching` | Stop watching terminal session |
| `/fork` | Get command to fork session to terminal |
| `/resume <id>` | Resume a terminal session in Slack (UUID format required) |
| `/compact` | Compact session to reduce context size |
| `/clear` | Clear session history (start fresh) |
| `/show-plan` | Display current plan file content in thread |
| `/wait <sec>` | Rate limit stress test (1-300 seconds) |

## Permission Modes

| Mode | SDK Name | Description |
|------|----------|-------------|
| Plan | `plan` | Read-only analysis, writes to plan file. Shows Proceed buttons when ready. |
| Default (Ask) | `default` | Prompts for approval on each tool use via Approve/Deny buttons. |
| Bypass | `bypassPermissions` | Runs tools without asking for approval. |
| Accept Edits | `acceptEdits` | Auto-approves code edits, prompts for other tools. |

## Real-Time Activity Display

During query processing, the bot shows:

1. **Status Panel** - Current mode, model, elapsed time, spinner, and Abort button
2. **Activity Log** - Live updates showing:
   - Extended thinking content (rolling window of last 500 chars)
   - Tool usage with start/complete indicators and duration
   - Text generation progress

After completion:
- Collapsed summary with thinking block and tool counts
- "View Log" button opens paginated modal with full content
- "Download .txt" button exports complete log with full thinking content

## Development

```bash
# Build
make build

# Run tests
make test

# Run tests in watch mode
make test-watch

# Run with coverage
make test-coverage

# Type check
npx tsc --noEmit

# Lint
npm run lint

# Run dev mode
make dev
```

See [CLAUDE.md](./CLAUDE.md) for detailed development instructions and [ARCHITECTURE.md](./ARCHITECTURE.md) for system design.

## Session Lifecycle

### Creation
- Bot creates session when user first messages in a channel
- Session stored in `./sessions.json` (bot records)
- Session stored in `~/.claude/projects/` (SDK files)

### Forking (Point-in-Time)
- Thread replies create new forked sessions with **point-in-time history**
- When you reply to message B in a conversation A→B→C→D, the thread only knows about A and B
- This enables "what if" scenarios from any point in the conversation
- All forks tracked in `sessions.json` under parent channel
- "Fork here" button on messages creates new channel with forked session

### Cleanup
- Channel deletion triggers automatic cleanup
- Deletes bot records from `sessions.json`
- Deletes SDK files from `~/.claude/projects/`
- Terminal forks (manual `--fork-session`) are preserved

## Known Limitations

### Terminal Session Detection

The bot cannot currently detect if a session is active in your terminal. This feature is disabled because:

- macOS `ps` command truncates long arguments, hiding session IDs
- No reliable cross-platform detection method found

**Workaround:** Before using `/watch` to sync with terminal, manually check if Claude is already running:
```bash
ps aux | grep "claude --resume"
```

This limitation will be addressed in a future update.

### Concurrent Session Warning

Due to the terminal detection limitation above, the bot cannot warn you if you're about to use a session that's already active in terminal. Using the same session from multiple places simultaneously may cause unexpected behavior.

### Disabled Commands

- `/ff` (fast-forward) - Disabled, returns "Unknown command" error
