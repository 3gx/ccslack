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
- **File uploads** - Attach images, PDFs, and code files (up to 20 files, 30MB each)
- **Session persistence** across conversations with automatic resumption
- **Real-time activity log** showing thinking, generating, and tool usage
- **Extended thinking support** with configurable token budget (1,024-128,000)
- **Multiple permission modes** for controlling tool execution (Plan, Ask, Bypass, Accept Edits)
- **Model selection** via interactive picker with 1-hour model cache
- **Point-in-time forking** via "Fork here" button for exploring alternative approaches
- **Thread sessions** with configuration inheritance from parent channel
- **Session management** with compact and clear commands
- **DM notifications** when mentioned in bot responses or approval requests
- **Terminal integration** - Watch, sync, and resume terminal sessions
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
| `/ls [path]` | List files in directory (relative or absolute) |
| `/cd [path]` | Change directory (only before path is locked) |
| `/cwd` | Show current working directory |
| `/set-current-path` | Lock current directory (one-time only, cannot be changed) |
| `/watch` | Start watching session for terminal updates (main channel only) |
| `/stop-watching` | Stop watching terminal session |
| `/ff` | Fast-forward sync missed terminal messages (main channel only) |
| `/resume <id>` | Resume a terminal session in Slack (UUID format required) |
| `/compact` | Compact session to reduce context size |
| `/clear` | Clear session history (start fresh) |
| `/show-plan` | Display current plan file content in thread |

## Permission Modes

| Mode | SDK Name | Description |
|------|----------|-------------|
| Plan | `plan` | Read-only analysis, writes to plan file. Shows 5-button approval UI when ready. |
| Default (Ask) | `default` | Prompts for approval on each tool use via Approve/Deny buttons. |
| Bypass | `bypassPermissions` | Runs tools without asking for approval. |
| Accept Edits | `acceptEdits` | Auto-approves code edits, prompts for other tools. |

### Mode Shortcuts

- `/mode plan` → `plan`
- `/mode bypass` → `bypassPermissions`
- `/mode ask` → `default`
- `/mode edit` → `acceptEdits`

### Interactive Mode Picker

Running `/mode` without arguments opens a modal with radio buttons to select the desired mode.

## Real-Time Activity Display

During query processing, the bot shows:

1. **Status Panel** - Current mode, model, elapsed time, spinner, and Abort button
2. **Activity Log** - Live updates showing:
   - Extended thinking content (rolling window of last 500 chars)
   - Tool usage with start/complete indicators and duration
   - Text generation progress

After completion:
- Activity log displayed inline in the status message
- "Fork here" button on final message segment for point-in-time forking
- Collapsed summary with thinking block and tool counts

## File Upload Support

Upload files directly to messages when mentioning the bot:

- **Supported formats**: Images (PNG, JPG, GIF, WebP), PDFs, text files, code files
- **Limits**: Up to 20 files per message, 30MB max per file
- **Processing**: Files are downloaded, validated, and included as multi-modal content
- **Images**: Converted to base64 and sent to Claude for visual analysis
- **Text/Code**: Content extracted and included in the prompt

## DM Notifications

The bot sends direct messages to notify users when they're mentioned:

- **Trigger**: When a user is @mentioned in a bot response or tool approval request
- **Content**: Notification with permalink to the original message
- **Debounce**: 15-second window per notification type to prevent spam
- **Types**: Completion notifications, approval request notifications

## Tool Approval

In `default` (Ask) mode, the bot prompts for tool approval:

- **Approve/Deny buttons**: Each tool use shows interactive buttons
- **Timeout**: 7-day timeout for pending approvals
- **Reminders**: 4-hour interval reminders for pending approvals
- **AskUserQuestion**: Always prompts user in ALL permission modes

### Plan Mode Approval

When Claude exits plan mode, a 5-button approval UI appears:

1. **Clear context & bypass** - Clear history and run with bypass permissions
2. **Accept edits** - Accept code edits automatically, prompt for others
3. **Bypass permissions** - Run all tools without prompting
4. **Manual approve** - Approve each tool individually
5. **Change the plan** - Request modifications to the plan

## Thread Sessions

Conversations in threads have their own sessions:

- **Inheritance**: Thread sessions inherit configuration from parent channel (mode, model, thinking tokens, update rate, message size)
- **Isolation**: Each thread maintains independent conversation history
- **Tracking**: Thread sessions stored under parent channel in `sessions.json`
- **Forking**: "Fork here" button creates new channel with point-in-time forked session

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

# Run dev mode
make dev
```

See [CLAUDE.md](./CLAUDE.md) for detailed development instructions and [ARCHITECTURE.md](./ARCHITECTURE.md) for system design.

## Session Lifecycle

### Creation
- Bot creates session when user first messages in a channel
- Session stored in `./sessions.json` (bot records)
- Session stored in `~/.claude/projects/` (SDK files)

### Forking
- "Fork here" button creates a new Slack channel with a point-in-time forked session
- SDK's `resumeSessionAt` parameter limits context to that message (verified in sdk-fork-e2e-clear.test.ts)
- Thread sessions tracked under parent channel in `sessions.json`

### Cleanup
- Channel deletion triggers automatic cleanup
- Deletes bot records from `sessions.json`
- Deletes SDK files from `~/.claude/projects/`
- Terminal forks (manual `--fork-session`) are preserved

## Terminal Integration

Sync Slack with Claude Code terminal sessions:

### Commands

- **`/watch`** - Start watching a session for terminal updates (polls JSONL files)
- **`/stop-watching`** - Stop watching the terminal session
- **`/ff`** - Fast-forward sync: imports missed messages from terminal and starts watching
- **`/resume <session-id>`** - Resume an existing terminal session in Slack (UUID format)

### How It Works

1. Terminal sessions write to JSONL files in `~/.claude/projects/`
2. The bot polls these files for new messages (via `terminal-watcher.ts`)
3. New messages are posted to the Slack channel in real-time
4. Use `/ff` to catch up on messages sent while the bot wasn't watching

### To Fork a Slack Session to Terminal

Use the session ID from `/status` to fork in terminal:
```bash
claude --resume <session-id> --fork-session
```

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
