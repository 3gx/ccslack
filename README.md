# Claude Code Slack Bot

A Slack bot that integrates [Claude Code](https://claude.ai/claude-code) into your Slack workspace, enabling AI team collaboration.

## Features

### Core Capabilities
- **Claude Code Integration** - Full access to Claude Code's coding capabilities directly in Slack
- **Multi-modal Support** - Send images and files for Claude to analyze
- **Session Management** - Persistent conversations with context preservation
- **Real-time Streaming** - Live updates as Claude processes your requests

### Collaboration Features
- **Channel & Thread Support** - Works in channels, threads, and direct messages
- **Fork Here Button** - Create new channels with conversation context at any point
- **Terminal Sync** - Watch and fast-forward sync with terminal Claude sessions
- **Plan Mode** - Collaborative planning with approval workflows

### Permission Modes
| Mode | Description |
|------|-------------|
| **Plan** | Claude writes plans for approval before execution |
| **Ask** (Default) | Approve each tool use with interactive buttons |
| **Accept Edits** | Auto-approve code edits, prompt for other tools |
| **Bypass** | Auto-approve all tool usage |

### Interactive Features
- Real-time activity logging with tool execution tracking
- Extended thinking visualization
- File uploads with markdown + PNG rendering
- Emoji status indicators for processing states
- DM notifications for @mentions and approvals

## Quick Start

### Prerequisites
- Node.js 18+
- A Slack workspace with admin permissions
- Claude Code SDK access

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd ccslack

# Install dependencies
make setup

# Install native dependencies (for image processing)
make setup-tools
```

### Configuration

1. Create a Slack app following the [Setup Guide](./SETUP.md)
2. Configure environment variables:

```bash
cp .env.example .env
```

Edit `.env`:
```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

### Running the Bot

```bash
# Development (with auto-reload)
make dev

# Production
make build
make start
```

See [SETUP.md](./SETUP.md) for complete setup instructions including Slack app configuration.

## Usage

### Basic Commands

Mention the bot in any channel where it's present:

```
@Claude Code Bot /help                    # Show all commands
@Claude Code Bot /status                  # Show session info
@Claude Code Bot /context                 # Show context window usage
@Claude Code Bot explain this code        # Ask Claude anything
```

### All Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/status` | Show session info (ID, mode, context usage) |
| `/context` | Show context window with visual progress bar |
| `/mode [plan\|bypass\|ask\|edit]` | Switch permission mode |
| `/model` | Show model picker |
| `/max-thinking-tokens [n]` | Set thinking budget (0-128000) |
| `/update-rate [n]` | Set status update interval (1-10 seconds) |
| `/message-size [n]` | Set message size limit (100-36000 chars) |
| `/ls [path]` | List files in directory |
| `/cd [path]` | Change working directory |
| `/cwd` | Show current working directory |
| `/set-current-path` | Lock current directory (one-time) |
| `/watch` | Start watching terminal session |
| `/stop-watching` | Stop watching terminal session |
| `/ff` | Fast-forward sync missed terminal messages |
| `/resume <session-id>` | Resume a terminal session |
| `/compact` | Compact session to reduce context size |
| `/clear` | Clear session history |
| `/show-plan` | Display current plan file |

### Interactive Buttons

- **Fork here** - Create a new channel with context up to that message
- **Approve/Deny** - Tool approval in ask mode
- **Plan approval** - 5-button UI for plan mode completion
- **Stop watching** - Stop terminal session watching
- **Attach thinking** - Upload extended thinking content as files

### File Uploads

Upload files directly in your message - the bot supports:
- Images (JPEG, PNG, GIF, WebP) - analyzed by Claude's vision
- Text files (JSON, JS, TS, XML, YAML, Python, Shell)
- Max 30MB per file, 20 files per message

## Project Structure

```
src/
├── index.ts              # Entry point
├── slack-bot.ts          # Main bot logic and event handlers
├── claude-client.ts      # Claude Code SDK wrapper
├── session-manager.ts    # Session persistence
├── session-reader.ts     # Parses SDK session files
├── streaming.ts          # Slack streaming with fallback
├── blocks.ts             # Block Kit UI builders
├── commands.ts           # Slash command parsing
├── errors.ts             # Error handling
├── retry.ts              # Retry with exponential backoff
├── terminal-watcher.ts   # Terminal session polling
├── message-sync.ts       # Terminal message sync engine
├── file-handler.ts       # File download and processing
├── markdown-png.ts       # Markdown to PNG conversion
└── __tests__/            # Test suites
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed technical documentation.

## Development

### Build & Run

```bash
make build              # Compile TypeScript
make dev                # Run with auto-reload
make start              # Run production server
make clean              # Remove build artifacts
```

### Testing

```bash
make test               # Unit + integration tests
make test-watch         # Watch mode
make test-coverage      # With coverage report
make sdk-test           # Live SDK tests (requires API key)
make all-test           # All tests
```

Single file test:
```bash
npm test -- src/__tests__/unit/blocks.test.ts
```

### Type Checking

```bash
npx tsc --noEmit
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth Token (xoxb-...) |
| `SLACK_APP_TOKEN` | Yes | Socket Mode Token (xapp-...) |

The bot uses the `@anthropic-ai/claude-agent-sdk` which requires Claude Code CLI (`claude`) to be installed and configured on the host machine.

## Documentation

- [SETUP.md](./SETUP.md) - Complete Slack app setup guide
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical architecture documentation
- [CLAUDE.md](./CLAUDE.md) - Development guide and coding patterns
- [docs/architecture/session-management.md](./docs/architecture/session-management.md) - Session management details

## Troubleshooting

### Bot Doesn't Respond
1. Check bot is running (verify terminal output)
2. Ensure bot is invited to the channel (`/invite @BotName`)
3. Verify tokens in `.env` are correct
4. Check all Slack scopes are configured

### Rate Limiting
The bot handles Slack rate limits automatically with exponential backoff. If you see frequent rate limits, try:
- Increasing `/update-rate` (1-10 seconds)
- Using longer `/message-size` limits

### Session Issues
- If sessions seem corrupted, delete `sessions.json` to reset
- SDK session files are stored in `~/.claude/projects/`

### Image Processing Errors
Run `make verify-tools` to check native dependencies. On Linux, run `make setup-tools` to install required libraries.

## License

This project is licensed under the [BSD-3-Clause License](./LICENSE).
