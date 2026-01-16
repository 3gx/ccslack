# Claude Code Slack Bot

A Slack bot that integrates Claude Code SDK for AI-powered assistance in Slack channels.

## Features

- Direct messaging with Claude Code via Slack mentions
- Session persistence across conversations
- Interactive approval and question handling via MCP tools
- Slash commands for session management
- Automatic cleanup when channels are deleted (removes both bot records and SDK files)

## Slash Commands

| Command | Description |
|---------|-------------|
| `/status` | Show current session info (ID, mode, working directory) |
| `/mode` | Show mode selection buttons |
| `/mode [plan\|auto\|ask]` | Set permission mode directly |
| `/cwd` | Show current working directory |
| `/cwd [path]` | Set working directory |
| `/continue` | Show command to continue session in terminal |
| `/fork` | Show command to fork session to terminal |
| `/resume <session-id>` | Resume a terminal session in Slack |

## Permission Modes

- **Plan** - Claude creates a plan and asks for approval before executing (default)
- **Auto** - Claude executes tools without asking (bypass permissions)
- **Ask** - Claude shows Approve/Deny buttons for each tool use

## Setup

```bash
# Install dependencies
npm install

# Set environment variables
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export SLACK_SIGNING_SECRET=...

# Run the bot
npm start
```

## Development

```bash
# Run tests
npm test

# Run in development mode
npm run dev

# Type check
npx tsc --noEmit
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
- `/fork-thread` creates explicit thread forks
- All forks tracked in `sessions.json` under parent channel

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

**Workaround:** Before using `/continue` to move a session to terminal, manually check if Claude is already running:
```bash
ps aux | grep "claude --resume"
```

This limitation will be addressed in a future update.

### Concurrent Session Warning

Due to the terminal detection limitation above, the bot cannot warn you if you're about to use a session that's already active in terminal. Using the same session from multiple places simultaneously may cause unexpected behavior.
