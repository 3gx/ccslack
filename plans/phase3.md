# Phase 3: Terminal Handoff & Commands - Implementation Plan

## Overview

Phase 3 adds bidirectional session switching between Slack and terminal, plus slash commands for bot control.

**Scope:** Slash commands, terminal handoff, session resume

---

## Current State (Phase 2 Complete)

| Component | Status | Location |
|-----------|--------|----------|
| Session storage (sessionId, mode, cwd) | ✅ | `src/session-manager.ts` |
| SDK session resume | ✅ | `src/claude-client.ts:43` |
| SDK cwd passing | ✅ | `src/claude-client.ts:39` |
| Concurrent check infrastructure | ⚠️ Disabled | `src/concurrent-check.ts:50` |
| `getContinueCommand()` helper | ✅ | `src/concurrent-check.ts:60` |
| Permission mode in session | ✅ | `Session.mode` field exists |

**Gap:** Permission mode hardcoded to `'bypassPermissions'` in claude-client.ts:33

---

## Phase 3 Components

### 1. Command Parser (`src/commands.ts`) - NEW FILE

**Purpose:** Parse and route slash commands prefixed with `/`.

**Command Format:** `@claude /<command> [args]`

**Commands to Implement:**

| Command | Action |
|---------|--------|
| `/status` | Show session ID, mode, cwd |
| `/mode` | Show mode options as buttons |
| `/mode [plan\|auto\|ask]` | Switch permission mode directly |
| `/cwd [path]` | Set working directory (with validation) |
| `/continue` | Show `claude --resume <id>` to continue session in terminal |
| `/fork` | Show `claude --resume <id> --fork` to fork session in terminal |
| `/resume <id>` | Resume a terminal session in Slack |

**Examples:**
```
@claude /status           → Shows session info
@claude /mode             → Shows button options: Plan | Auto | Ask
@claude /mode auto        → Sets mode to auto
@claude /cwd ~/projects   → Sets working directory
@claude /continue         → Shows: claude --resume abc-123
@claude /fork             → Shows: claude --resume abc-123 --fork
@claude /resume abc-123   → Resumes terminal session abc-123 in Slack
@claude hello             → Normal message to Claude (no slash)
```

**Implementation:**
```typescript
// src/commands.ts
export interface CommandResult {
  handled: boolean;           // True if command was processed
  response?: string;          // Text response to post
  blocks?: Block[];           // Block Kit response
  sessionUpdate?: Partial<Session>;  // Session fields to update
}

export async function parseCommand(
  text: string,
  session: Session,
  channelId: string
): Promise<CommandResult> {
  // Only handle slash commands
  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const [command, ...args] = text.slice(1).split(/\s+/);
  const argString = args.join(' ').trim();

  switch (command.toLowerCase()) {
    case 'status':
      return handleStatus(session);
    case 'mode':
      return handleMode(argString, session);
    case 'cwd':
      return handleCwd(argString, session);
    case 'continue':
      return handleContinue(session);
    case 'fork':
      return handleFork(session);
    case 'resume':
      return handleResume(argString);
    default:
      return { handled: false };  // Unknown command, pass to Claude
  }
}
```

**Files to create:**
- `src/commands.ts`

**Files to modify:**
- `src/slack-bot.ts` - Add command check before Claude call

---

### 2. `/continue` Command (Continue Session in Terminal)

**Purpose:** Show command to continue the current Slack session in terminal.

**Existing:** `getContinueCommand(sessionId)` in concurrent-check.ts

**Implementation in `src/commands.ts`:**
```typescript
import { getContinueCommand } from './concurrent-check.js';

function handleContinue(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: "No active session. Start a conversation first."
    };
  }

  const command = `claude --resume ${session.sessionId}`;

  return {
    handled: true,
    blocks: buildTerminalCommandBlocks({
      title: "Continue in Terminal",
      description: "Run this command to continue your session locally:",
      command,
      workingDir: session.workingDir,
      sessionId: session.sessionId
    })
  };
}
```

---

### 3. `/fork` Command (Fork Session to Terminal)

**Purpose:** Show command to fork (branch) the current session in terminal.

**Implementation in `src/commands.ts`:**
```typescript
function handleFork(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: "No active session. Start a conversation first."
    };
  }

  // Fork creates a new session branching from current
  const command = `claude --resume ${session.sessionId} --fork`;

  return {
    handled: true,
    blocks: buildTerminalCommandBlocks({
      title: "Fork to Terminal",
      description: "Run this command to create a new branch from your session:",
      command,
      workingDir: session.workingDir,
      sessionId: session.sessionId,
      note: "This creates a new session. The original Slack session remains unchanged."
    })
  };
}
```

**Shared block builder in `src/blocks.ts`:**
```typescript
export interface TerminalCommandParams {
  title: string;
  description: string;
  command: string;
  workingDir: string;
  sessionId: string;
  note?: string;
}

export function buildTerminalCommandBlocks(params: TerminalCommandParams): Block[] {
  const { title, description, command, workingDir, sessionId, note } = params;

  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: title }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: description }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "```" + command + "```" }
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `📁 Working directory: \`${workingDir}\`\n🔑 Session: \`${sessionId}\``
      }]
    }
  ];

  if (note) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `💡 ${note}` }]
    });
  }

  return blocks;
}
```

---

### 4. `/status` Command

**Implementation in `src/commands.ts`:**
```typescript
function handleStatus(session: Session): CommandResult {
  return {
    handled: true,
    blocks: buildStatusDisplayBlocks({
      sessionId: session.sessionId,
      mode: session.mode,
      workingDir: session.workingDir,
      lastActiveAt: session.lastActiveAt
    })
  };
}
```

**Block builder in `src/blocks.ts`:**
```typescript
export interface StatusDisplayParams {
  sessionId: string | null;
  mode: 'plan' | 'auto' | 'ask';
  workingDir: string;
  lastActiveAt: number;
}

export function buildStatusDisplayBlocks(params: StatusDisplayParams): Block[] {
  const { sessionId, mode, workingDir, lastActiveAt } = params;

  const modeEmoji = { plan: '📋', auto: '🚀', ask: '❓' }[mode];
  const lastActive = new Date(lastActiveAt).toLocaleString();

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Session Status" }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Session ID:*\n\`${sessionId || 'None'}\`` },
        { type: "mrkdwn", text: `*Mode:*\n${modeEmoji} ${mode}` },
        { type: "mrkdwn", text: `*Working Directory:*\n\`${workingDir}\`` },
        { type: "mrkdwn", text: `*Last Active:*\n${lastActive}` }
      ]
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        // NOTE: Terminal detection disabled - see README.md for details
        text: "⚠️ *Terminal detection:* _disabled (coming soon)_"
      }]
    }
  ];
}
```

**Note:** Terminal PID detection is intentionally disabled. See "Known Limitations" section below.

---

### 5. `/mode` Command (with Button Options)

**Behavior:**
- `/mode` (no arg) → Show buttons: Plan | Auto | Ask
- `/mode plan` → Set mode directly

**Implementation in `src/commands.ts`:**
```typescript
function handleMode(modeArg: string, session: Session): CommandResult {
  const validModes = ['plan', 'auto', 'ask'] as const;

  // No arg → show button options
  if (!modeArg) {
    return {
      handled: true,
      blocks: buildModeSelectionBlocks(session.mode)
    };
  }

  // Validate mode arg
  if (!validModes.includes(modeArg as any)) {
    return {
      handled: true,
      response: `Invalid mode: \`${modeArg}\`. Valid modes: plan, auto, ask`
    };
  }

  return {
    handled: true,
    response: `Mode set to \`${modeArg}\``,
    sessionUpdate: { mode: modeArg as 'plan' | 'auto' | 'ask' }
  };
}
```

**Block builder in `src/blocks.ts`:**
```typescript
export function buildModeSelectionBlocks(currentMode: string): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Select Permission Mode*\nCurrent: \`${currentMode}\``
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📋 Plan" },
          action_id: "mode_plan",
          value: "plan",
          style: currentMode === 'plan' ? 'primary' : undefined
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🚀 Auto" },
          action_id: "mode_auto",
          value: "auto",
          style: currentMode === 'auto' ? 'primary' : undefined
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❓ Ask" },
          action_id: "mode_ask",
          value: "ask",
          style: currentMode === 'ask' ? 'primary' : undefined
        }
      ]
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "• *Plan* - Ask before executing tools\n• *Auto* - Execute without asking\n• *Ask* - Always ask for approval"
      }]
    }
  ];
}
```

**Button handler in `src/slack-bot.ts`:**
```typescript
// Handle mode button clicks
app.action(/^mode_(plan|auto|ask)$/, async ({ action, ack, body, client }) => {
  await ack();
  const mode = action.action_id.replace('mode_', '') as 'plan' | 'auto' | 'ask';
  const channelId = body.channel?.id;

  if (channelId) {
    await saveSession(channelId, { mode });
    await client.chat.update({
      channel: channelId,
      ts: body.message?.ts,
      text: `Mode set to \`${mode}\``,
      blocks: []
    });
  }
});
```

**SDK Integration - Update `src/claude-client.ts`:**
```typescript
// Add mode to StreamOptions interface
export interface StreamOptions {
  sessionId?: string;
  workingDir?: string;
  mode?: 'plan' | 'auto' | 'ask';  // ADD THIS
  slackContext?: { ... };
}

// Update startClaudeQuery to use mode
export function startClaudeQuery(prompt: string, options: StreamOptions): ClaudeQuery {
  const queryOptions: Record<string, unknown> = {
    outputFormat: 'stream-json',
    permissionMode: options.mode || 'bypassPermissions',  // USE FROM OPTIONS
    systemPrompt: 'claude_code',
  };
  // ...
}
```

---

### 6. `/cwd` Command (Set Working Directory)

**Implementation in `src/commands.ts`:**
```typescript
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

function handleCwd(pathArg: string, session: Session): CommandResult {
  // No arg → show current
  if (!pathArg) {
    return {
      handled: true,
      response: `Current working directory: \`${session.workingDir}\``
    };
  }

  // Expand ~ to home directory
  const expanded = pathArg.startsWith('~')
    ? pathArg.replace('~', homedir())
    : pathArg;

  const resolved = resolve(expanded);

  // Validate path exists and is directory
  if (!existsSync(resolved)) {
    return {
      handled: true,
      response: `Path does not exist: \`${resolved}\``
    };
  }

  if (!statSync(resolved).isDirectory()) {
    return {
      handled: true,
      response: `Path is not a directory: \`${resolved}\``
    };
  }

  return {
    handled: true,
    response: `Working directory set to \`${resolved}\``,
    sessionUpdate: { workingDir: resolved }
  };
}
```

---

### 7. `/resume` Command (Resume Terminal Session in Slack)

**Purpose:** Allow user to start a session in terminal, then continue in Slack.

**Implementation in `src/commands.ts`:**
```typescript
function handleResume(sessionId: string): CommandResult {
  if (!sessionId) {
    return {
      handled: true,
      response: "Usage: `/resume <session-id>`\n\nGet the session ID from your terminal with `claude --print-session-id`"
    };
  }

  // Validate session ID format (UUID-like)
  const uuidPattern = /^[a-f0-9-]{36}$/i;
  if (!uuidPattern.test(sessionId)) {
    return {
      handled: true,
      response: `Invalid session ID format: \`${sessionId}\``
    };
  }

  return {
    handled: true,
    response: `Resuming session \`${sessionId}\`\n\nYour next message will continue this session.`,
    sessionUpdate: { sessionId }
  };
}
```

---

### 8. Integration in slack-bot.ts

**Add command check in `handleMessage()`:**

```typescript
// At the top of handleMessage(), after getting session:
import { parseCommand } from './commands.js';

// In handleMessage(), before busy check:
const commandResult = await parseCommand(userText, session, channelId);

if (commandResult.handled) {
  // Apply any session updates
  if (commandResult.sessionUpdate) {
    await saveSession(channelId, commandResult.sessionUpdate);
  }

  // Post response
  if (commandResult.blocks) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: commandResult.blocks,
      text: 'Command response'  // Fallback
    });
  } else if (commandResult.response) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: commandResult.response
    });
  }

  return;  // Don't send to Claude
}

// Continue with normal Claude flow...
```

**Pass mode to Claude client:**
```typescript
// When calling startClaudeQuery:
const claudeQuery = startClaudeQuery(userText, {
  sessionId: session.sessionId || undefined,
  workingDir: session.workingDir,
  mode: session.mode,  // ADD THIS
  slackContext: { ... }
});
```

---

## File Structure (After Phase 3)

```
src/
├── index.ts              # Entry point (unchanged)
├── slack-bot.ts          # Add command integration + mode button handler
├── mcp-server.ts         # MCP tools (unchanged)
├── claude-client.ts      # Add mode option to SDK call
├── session-manager.ts    # Unchanged (already has mode, workingDir)
├── streaming.ts          # Unchanged
├── concurrent-check.ts   # Unchanged (kept disabled)
├── blocks.ts             # Add: buildTerminalCommandBlocks, buildStatusDisplayBlocks, buildModeSelectionBlocks
├── commands.ts           # NEW: Command parser and handlers
├── abort-tracker.ts      # Unchanged
├── utils.ts              # Unchanged
└── __tests__/
    ├── unit/
    │   ├── commands.test.ts      # NEW
    │   └── ... (existing)
    └── integration/
        └── ... (existing)
```

---

## Implementation Order

| Day | Task | Files |
|-----|------|-------|
| 1 | Create command parser + `/status` | `src/commands.ts`, `src/blocks.ts` |
| 2 | Implement `/continue` + `/fork` | `src/commands.ts`, `src/blocks.ts` |
| 3 | Implement `/mode` with buttons | `src/commands.ts`, `src/blocks.ts`, `src/slack-bot.ts` |
| 4 | Implement `/cwd` + `/resume` | `src/commands.ts` |
| 5 | SDK mode integration | `src/claude-client.ts`, `src/slack-bot.ts` |
| 6 | Unit tests | `src/__tests__/unit/commands.test.ts` |
| 7 | Manual testing, bug fixes | All files |

**Total: ~7 days**

---

## Testing Strategy

### Unit Tests (`src/__tests__/unit/commands.test.ts`)

| Test | Verification |
|------|--------------|
| `parseCommand('/status', ...)` | Returns handled: true, status blocks |
| `parseCommand('/mode', ...)` | Returns mode selection blocks with buttons |
| `parseCommand('/mode plan', ...)` | Returns sessionUpdate with mode: 'plan' |
| `parseCommand('/mode invalid', ...)` | Returns error message |
| `parseCommand('/cwd', ...)` | Returns current working directory |
| `parseCommand('/cwd /valid/path', ...)` | Returns sessionUpdate with workingDir |
| `parseCommand('/cwd /invalid', ...)` | Returns error about non-existent path |
| `parseCommand('/continue', ...)` | Returns blocks with resume command |
| `parseCommand('/fork', ...)` | Returns blocks with fork command |
| `parseCommand('/resume abc-123...', ...)` | Returns sessionUpdate with sessionId |
| `parseCommand('hello', ...)` | Returns handled: false (not a command) |

### Integration Tests

| Scenario | Verification |
|----------|--------------|
| `/status` | Shows session info (ID, mode, cwd) |
| `/mode` | Shows button options, clicking updates session |
| `/mode auto` → send message | Claude runs with auto mode |
| `/cwd ~/projects` | Confirms directory change |
| `/continue` | Shows `claude --resume <id>` |
| `/fork` | Shows `claude --resume <id> --fork` |
| `/resume <id>` → send message | Continues terminal session |

### Manual Testing

1. `/continue` → copy command → run in terminal → verify context preserved
2. Start in terminal → get ID → `/resume <id>` in Slack → verify context
3. `/mode` → click Auto button → send message → verify no approval prompt
4. `/fork` → copy command → run in terminal → verify new session created

---

## Success Criteria

- [ ] `/status` shows session ID, mode, cwd, last active
- [ ] `/mode` shows button options (Plan/Auto/Ask)
- [ ] `/mode [plan|auto|ask]` sets mode directly
- [ ] `/cwd` shows current directory
- [ ] `/cwd [path]` validates and sets working directory
- [ ] `/continue` shows `claude --resume <id>`
- [ ] `/fork` shows `claude --resume <id> --fork`
- [ ] `/resume <id>` resumes terminal session in Slack
- [ ] Non-slash messages pass to Claude normally
- [ ] Mode button clicks update session
- [ ] `make test` passes with new tests

---

## Verification Commands

```bash
# Run all tests
make test

# Run only Phase 3 tests
npx vitest run --filter "commands"

# Manual test status
# In Slack: @claude /status
# Verify: Shows session ID, mode, cwd
# Verify: Shows "Terminal detection: disabled (coming soon)"

# Manual test mode buttons
# In Slack: @claude /mode
# Verify: Shows Plan/Auto/Ask buttons
# Click Auto → verify "Mode set to auto"

# Manual test mode direct
# In Slack: @claude /mode plan
# Verify: "Mode set to plan"

# Manual test continue
# In Slack: @claude /continue
# Verify: Shows claude --resume <session-id>

# Manual test fork
# In Slack: @claude /fork
# Verify: Shows claude --resume <session-id> --fork

# Manual test cwd
# In Slack: @claude /cwd ~/projects/myapp
# Verify: "Working directory set to /Users/you/projects/myapp"

# Manual test resume
# In terminal: claude (start session)
# In terminal: claude --print-session-id → note ID
# In Slack: @claude /resume <session-id>
# In Slack: @claude what were we discussing?
# Verify: Has context from terminal
```

---

## Known Limitations

### Terminal Detection (Disabled)

**Status:** Intentionally disabled in Phase 3. Will be re-enabled in a future phase.

**Why it's disabled:**
- `ps aux` truncates command-line arguments on macOS (limited to ~80 chars)
- Session IDs are UUIDs (36 chars), often get truncated
- Working directory matching is unreliable (too broad)
- No reliable cross-platform method found yet

**Current behavior:**
- `/status` shows "Terminal detection: disabled (coming soon)"
- No PID check when processing messages
- User must manually check with `ps aux | grep claude` if needed

**Future investigation areas:**
1. macOS `libproc` APIs (proc_pidinfo) for full command args
2. Direct `sysctl` calls
3. `/proc/<pid>/cmdline` on Linux
4. DTrace probes (macOS)

**Code reference:** See `src/concurrent-check.ts` for disabled infrastructure.

---

## README.md Updates

Add the following section to README.md:

```markdown
## Known Limitations

### Terminal Session Detection

The bot cannot currently detect if a session is active in your terminal. This feature is disabled because:

- macOS `ps` command truncates long arguments, hiding session IDs
- No reliable cross-platform detection method found

**Workaround:** Before using `/continue` to move a session to terminal, manually check if Claude is already running:
\`\`\`bash
ps aux | grep "claude --resume"
\`\`\`

This limitation will be addressed in a future update.
```
