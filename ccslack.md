# Claude Code Slack Bot

## Project Overview

Build a Slack bot that provides **100% fidelity** with local Claude Code CLI. Users can interact with Claude Code via Slack with the same capabilities as the terminal, and seamlessly switch between Slack and local terminal using the same session.

## Core Requirements

### 1. Full Claude Code Fidelity
- Same capabilities as running `claude` in terminal
- Claude can ask questions → user answers in Slack → Claude continues
- Support for all permission modes (plan, auto, ask)
- Full tool access: Read, Write, Bash, Edit, Glob, Grep, WebSearch, etc.

### 2. Bidirectional Session Handoff
- Sessions stored locally in `~/.claude/sessions/`
- User starts in Slack → continues in terminal (same session)
- User starts in terminal → continues in Slack (same session)
- No context lost when switching interfaces

### 3. Interactive Question Handling
- When Claude uses `AskUserQuestion` tool, post question to Slack
- Wait for user reply in Slack
- Return answer to Claude, conversation continues
- Support multiple-choice and free-text responses

### 4. Git-Style Thread Forking
- Channel = main conversation branch
- Thread fork = snapshot channel session, branch independently
- Multiple threads can fork from same point
- Thread changes don't affect channel session

## Technical Approach

### Use Official Claude Agent SDK
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
```

**Why Agent SDK:**
- Stable, versioned, documented API
- Built-in session management
- `canUseTool` callback for handling `AskUserQuestion`
- `forkSession` option for thread branching
- Full Claude Code feature parity (CLAUDE.md, skills, MCP, hooks)

**Not using:**
- Raw CLI spawning (brittle, undocumented behavior)
- Direct Anthropic API (loses Claude Code features)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Slack Bot (Node.js)                     │
│                                                             │
│  ┌─────────────────┐    ┌──────────────────────────────┐   │
│  │  Slack Events   │───→│  Claude Agent SDK            │   │
│  │  (Socket Mode)  │    │                              │   │
│  └─────────────────┘    │  - query() with canUseTool   │   │
│          ↑              │  - Session resume/fork       │   │
│          │              │  - Permission modes          │   │
│          │              └──────────────────────────────┘   │
│          │                         │                        │
│          └─────────────────────────┘                        │
│           Post responses, receive answers                   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Session Store (JSON file)                          │   │
│  │  - channel_id → { sessionId, workingDir, mode }     │   │
│  │  - thread_ts  → { sessionId, workingDir, mode }     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│            ↕ Same sessions ↕                                │
│                                                             │
│       ~/.claude/sessions/ (shared with CLI)                 │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Details

### Session Management

```typescript
interface ChannelSession {
  sessionId: string;
  workingDir: string;
  mode: "plan" | "auto" | "ask" | ...
}

// Storage: ./sessions.json
{
  "channels": {
    "C1234567890": { sessionId: "abc-123", workingDir: "/path/to/project", mode: "plan" }
  },
  "threads": {
    "C1234567890:1234567890.123456": { sessionId: "def-456", workingDir: "/path/to/project", mode: "plan" }
  }
}
```

### Query with Interactive Support

```typescript
async function handleMessage(channelId: string, threadTs: string | null, text: string) {
  const session = getSession(channelId, threadTs);
  
  for await (const message of query({
    prompt: text,
    options: {
      resume: session?.sessionId,
      cwd: session?.workingDir,
      permissionMode: session?.mode || "plan",
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "AskUserQuestion"],
      canUseTool: async (toolName, input) => {
        if (toolName === "AskUserQuestion") {
          return await handleAskUserQuestion(channelId, threadTs, input);
        }
        return { behavior: "allow" };
      }
    }
  })) {
    // Stream responses to Slack
    if (message.type === "assistant") {
      await postToSlack(channelId, threadTs, formatMessage(message));
    }
    
    // Capture session ID on init
    if (message.type === "system" && message.subtype === "init") {
      saveSession(channelId, threadTs, message.session_id);
    }
  }
}
```

### AskUserQuestion Handler

```typescript
async function handleAskUserQuestion(
  channelId: string, 
  threadTs: string | null, 
  input: AskUserQuestionInput
): Promise<PermissionResult> {
  // Format questions for Slack
  const blocks = formatQuestionsAsBlocks(input.questions);
  
  // Post to Slack
  const msg = await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    blocks,
    text: "Claude has a question..."
  });
  
  // Wait for user reply (store promise, resolve when message event arrives)
  const userAnswer = await waitForReply(channelId, msg.ts);
  
  // Return answer to SDK
  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: { [input.questions[0].question]: userAnswer }
    }
  };
}
```

### Thread Forking

```typescript
// When user sends message in thread that doesn't have its own session
async function handleThreadMessage(channelId: string, threadTs: string, text: string) {
  const threadSession = getThreadSession(channelId, threadTs);
  
  if (!threadSession) {
    // Fork from channel session
    const channelSession = getChannelSession(channelId);
    
    for await (const message of query({
      prompt: text,
      options: {
        resume: channelSession.sessionId,
        forkSession: true,  // Creates new session branched from channel
        cwd: channelSession.workingDir,
        // ...
      }
    })) {
      // Save new forked session ID for this thread
      if (message.type === "system" && message.subtype === "init") {
        saveThreadSession(channelId, threadTs, message.session_id);
      }
    }
  }
}
```

## Slack Commands

| Command | Action |
|---------|--------|
| `@claude <message>` | Send message to Claude |
| `@claude mode plan` | Switch to plan mode (ask before executing) |
| `@claude mode auto` | Switch to auto mode (execute without asking) |
| `@claude mode ask` | Switch to ask mode (default, ask for permissions) |
| `@claude cwd /path/to/dir` | Set working directory |
| `@claude cwd` | Show current working directory |
| `@claude fork` | Explicitly fork session into current thread |
| `@claude continue locally` | Get command to continue in terminal |
| `@claude status` | Show session ID, mode, working dir |
| `@claude clear` | Clear context (like /clear in CLI) |

## Expected Workflows

### Workflow 1: Start in Slack, Continue Locally
```
Slack #backend:
  User: @claude refactor the auth module
  Claude: I have some questions...
  Claude: Which provider - OAuth or SAML?
  User: OAuth
  Claude: Here's my plan... [shows plan]
  User: @claude continue locally

  Claude: Run this to continue:
          cd /Users/you/project && claude --resume abc123

Terminal:
  $ cd /Users/you/project && claude --resume abc123
  > (continues same conversation with full context)
```

### Workflow 2: Start Locally, Continue in Slack
```
Terminal:
  $ claude
  > refactor the auth module
  Claude: [works on it]
  > /stop

Slack #backend:
  User: @claude --resume abc123 what's the status?
  Claude: (picks up same session) I was working on...
```

### Workflow 3: Thread Forking
```
Slack #backend:
  User: @claude analyze the codebase structure
  Claude: [analysis...]
  
  [Thread 1 - forked]
    User: what if we used microservices?
    Claude: [explores microservices approach]
  
  [Thread 2 - forked from same point]
    User: what if we kept the monolith?
    Claude: [explores monolith approach]
  
  (Main channel unaffected by thread explorations)
```

### Workflow 4: Plan Mode Interactive
```
Slack #backend:
  User: @claude mode plan
  Claude: Switched to plan mode.
  
  User: @claude refactor auth with MFA support
  Claude: Before I plan, I need to know:
          1. Which MFA methods? (TOTP / SMS / Both)
          2. Backup codes required?
  
  User: TOTP only, yes backup codes
  
  Claude: Here's my plan:
          Phase 1: Add TOTP infrastructure
          Phase 2: Integrate with login flow  
          Phase 3: Add backup code generation
          
          Execute, Abort, or suggest changes?
  
  User: execute
  
  Claude: ✓ Created src/auth/mfa/totp.ts
          ✓ Updated src/auth/login.ts
          ...
```

## File Structure

```
claude-slack-bot/
├── src/
│   ├── index.ts              # Entry point, Slack app setup
│   ├── slack-events.ts       # Slack event handlers
│   ├── claude-query.ts       # Agent SDK integration
│   ├── session-store.ts      # Session persistence
│   ├── ask-user-handler.ts   # AskUserQuestion flow
│   ├── commands.ts           # Command parsing (@claude mode, etc.)
│   └── format.ts             # Markdown → Slack formatting
├── sessions.json             # Runtime session storage
├── package.json
├── tsconfig.json
├── .env.example
├── .env
└── CLAUDE.md                 # This file
```

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@slack/bolt": "^3.x",
    "@slack/web-api": "^7.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "tsx": "^4.x",
    "@types/node": "^20.x"
  }
}
```

## Environment Variables

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# Claude (one of these)
ANTHROPIC_API_KEY=sk-ant-...
# OR
CLAUDE_CODE_USE_BEDROCK=1
# OR  
CLAUDE_CODE_USE_VERTEX=1

# Optional
DEFAULT_WORKING_DIR=/Users/you/projects
DEFAULT_MODE=plan
```

## Slack App Permissions

### Bot Token Scopes
- `app_mentions:read` - Receive @mentions
- `channels:history` - Read channel messages
- `chat:write` - Post messages
- `im:history` - Read DMs
- `im:read` - Access DM metadata
- `im:write` - Send DMs
- `reactions:write` - Add reactions (for status)

### Event Subscriptions
- `app_mention` - When bot is @mentioned
- `message.im` - Direct messages
- `message.channels` - Channel messages (for thread replies)

### Socket Mode
- Enabled (for real-time events without public URL)

## Implementation Priority

1. **Phase 1: Basic Query** (~1 hour)
   - Slack Socket Mode setup
   - Simple `query()` → post response
   - Session creation and storage

2. **Phase 2: Interactive** (~1 hour)
   - `canUseTool` callback
   - `AskUserQuestion` handling
   - Wait for reply mechanism

3. **Phase 3: Commands** (~30 min)
   - Mode switching
   - Working directory
   - Status/continue locally

4. **Phase 4: Threading** (~30 min)
   - Thread detection
   - Session forking
   - Thread-specific sessions

## Success Criteria

- [ ] Can send message in Slack, Claude responds
- [ ] Claude can ask question, user answers in Slack, Claude continues
- [ ] Can switch modes (plan/auto/ask) via Slack command
- [ ] Can run `@claude continue locally` and get working CLI command
- [ ] Can resume Slack session from terminal with `claude --resume <id>`
- [ ] Thread forks create independent sessions
- [ ] Streaming responses update in Slack as Claude works

## Notes

- Agent SDK handles all Claude Code internals (tools, permissions, CLAUDE.md, MCP)
- We only handle: Slack I/O, session tracking, question routing
- ~200-250 lines of actual code
- Sessions persist in `~/.claude/sessions/` (shared with CLI)
