# Channel-Specific Working Directory Configuration

## Summary

Implement channel-only bot operation with one-time, immutable working directory setup per channel. Users must configure the working directory using `/path` command before the bot processes any Claude Code commands.

**Key Features:**
- Bot only works in Slack channels (not DMs)
- One-time `/path` setup per channel (immutable)
- Before path set: `/ls` and `/cwd` work
- After path set: `/ls` and `/cwd` disabled, all Claude Code commands work
- Threads inherit channel's configured path

---

## User Flow

### First Use in New Channel

```
User: @Claude Code help me with this code

Bot: ⚠️ Working directory not configured

     Before I can help, you need to set the working directory
     for this channel. This is a one-time setup and cannot be
     changed later.

     Usage:
     /path /absolute/path/to/your/project

     💡 Tip: Use /ls to explore the current directory first.
```

### Path Configuration

```
User: /ls

Bot: Files in `/Users/egx/ai`:
     ccslack/
     other-project/
     ...

     To set this as working directory: /path /Users/egx/ai

User: /path /Users/egx/ai/ccslack

Bot: ✅ Working directory set to `/Users/egx/ai/ccslack`

     ⚠️ This cannot be changed. All Claude Code operations
     will use this directory.

User: @Claude Code help me with this code

Bot: [Processes command normally using /Users/egx/ai/ccslack]
```

### After Configuration

```
User: /ls

Bot: ❌ `/ls` is disabled after path configuration.

     Use Claude Code commands to explore:
     "@Claude Code show me the files"

User: /path /different/path

Bot: ❌ Working directory already configured:
     `/Users/egx/ai/ccslack`

     This cannot be changed. If you need a different
     directory, use a different channel.
```

---

## Implementation Plan

### Phase 1: Session Schema Updates

**File:** `src/session-manager.ts`

**Changes:**

1. Update `Session` interface (lines 17-23):
```typescript
export interface Session {
  sessionId: string | null;
  workingDir: string;
  mode: PermissionMode;
  createdAt: number;
  lastActiveAt: number;
  // NEW FIELDS:
  pathConfigured: boolean;      // Whether /path has been run
  configuredPath: string | null; // The immutable path
  configuredBy: string | null;   // User ID who set it
  configuredAt: number | null;   // When it was set
}
```

2. Update `ThreadSession` interface (lines 28-36):
```typescript
export interface ThreadSession {
  sessionId: string | null;
  forkedFrom: string | null;
  forkedFromThreadTs?: string;
  workingDir: string;
  mode: PermissionMode;
  createdAt: number;
  lastActiveAt: number;
  // NEW FIELDS (inherited from parent):
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy: string | null;
  configuredAt: number | null;
}
```

3. Add migration logic in `loadSessions()` (line 58):
```typescript
// After parsing JSON, add defaults for new fields
for (const channelId in parsed.channels) {
  const channel = parsed.channels[channelId];
  if (channel.pathConfigured === undefined) {
    channel.pathConfigured = false;
    channel.configuredPath = null;
    channel.configuredBy = null;
    channel.configuredAt = null;
  }
  // Migrate threads too
  if (channel.threads) {
    for (const threadTs in channel.threads) {
      const thread = channel.threads[threadTs];
      if (thread.pathConfigured === undefined) {
        thread.pathConfigured = channel.pathConfigured;
        thread.configuredPath = channel.configuredPath;
        thread.configuredBy = channel.configuredBy;
        thread.configuredAt = channel.configuredAt;
      }
    }
  }
}
```

4. Update `saveThreadSession()` to inherit path config (line 150):
```typescript
store.channels[channelId].threads![threadTs] = {
  sessionId: existingThread?.sessionId ?? null,
  forkedFrom: existingThread?.forkedFrom ?? null,
  workingDir: existingThread?.workingDir ?? store.channels[channelId].workingDir,
  mode: existingThread?.mode ?? store.channels[channelId].mode,
  createdAt: existingThread?.createdAt ?? Date.now(),
  lastActiveAt: Date.now(),
  // INHERIT path configuration from channel:
  pathConfigured: existingThread?.pathConfigured ?? store.channels[channelId].pathConfigured,
  configuredPath: existingThread?.configuredPath ?? store.channels[channelId].configuredPath,
  configuredBy: existingThread?.configuredBy ?? store.channels[channelId].configuredBy,
  configuredAt: existingThread?.configuredAt ?? store.channels[channelId].configuredAt,
  ...session,
};
```

---

### Phase 2: Channel-Only Filtering

**File:** `src/slack-bot.ts`

**Change:** Update `app_mention` handler (line 266):
```typescript
app.event('app_mention', async ({ event, client }) => {
  try {
    // ONLY respond in channels (IDs start with 'C')
    // Reject DMs ('D'), group DMs ('G')
    if (!event.channel.startsWith('C')) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: '❌ This bot only works in channels, not in direct messages.',
      });
      return;
    }

    console.log(`Received mention from ${event.user}: ${event.text}`);
    // ... rest of handler
  } catch (error) {
    // ... error handling
  }
});
```

**Note:** Keep `app.message` handler (line 297) unchanged - it only processes DMs, which we're now excluding.

---

### Phase 3: `/path` Command Implementation

**File:** `src/commands.ts`

**Change 1:** Add case to `parseCommand()` (line 41):
```typescript
case 'path':
  return handlePath(argString, session);
```

**Change 2:** Implement `handlePath()`:
```typescript
import fs from 'fs';

function handlePath(pathArg: string, session: Session): CommandResult {
  // Check if path already configured
  if (session.pathConfigured) {
    return {
      handled: true,
      response: `❌ Working directory already configured: \`${session.configuredPath}\`\n\nThis cannot be changed. If you need a different directory, use a different channel.`,
    };
  }

  // Require path argument
  if (!pathArg) {
    return {
      handled: true,
      response: 'Usage: `/path /absolute/path/to/project`\n\nSet the working directory for this channel (one-time only).',
    };
  }

  // Validate: must be absolute path
  if (!pathArg.startsWith('/')) {
    return {
      handled: true,
      response: '❌ Path must be absolute (start with `/`). Example: `/path /Users/myuser/myproject`',
    };
  }

  // Validate: path exists
  if (!fs.existsSync(pathArg)) {
    return {
      handled: true,
      response: `❌ Directory does not exist: \`${pathArg}\`\n\nPlease provide a valid directory path.`,
    };
  }

  // Check if it's a directory (not a file)
  const stats = fs.statSync(pathArg);
  if (!stats.isDirectory()) {
    return {
      handled: true,
      response: `❌ Path is not a directory: \`${pathArg}\`\n\nPlease provide a directory, not a file.`,
    };
  }

  // Check read/execute permissions
  try {
    fs.accessSync(pathArg, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot access directory: \`${pathArg}\`\n\nPermission denied or directory not readable.`,
    };
  }

  // Normalize path (resolve symlinks, remove trailing slash)
  const normalizedPath = fs.realpathSync(pathArg);

  return {
    handled: true,
    response: `✅ Working directory set to \`${normalizedPath}\`\n\n⚠️ This cannot be changed. All Claude Code operations will use this directory.`,
    sessionUpdate: {
      pathConfigured: true,
      configuredPath: normalizedPath,
      workingDir: normalizedPath,
      configuredAt: Date.now(),
    },
  };
}
```

**Change 3:** Update `/help` command (line 70):
```typescript
const helpText = `*Available Commands*
\`/help\` - Show this help message
\`/path <directory>\` - Set working directory (one-time only)
\`/ls\` - List files (only before path configured)
\`/cwd\` - Show current directory (only before path configured)
\`/status\` - Show session info
...
`;
```

---

### Phase 4: Command Restrictions

**File:** `src/commands.ts`

**Change 1:** Update `/cwd` command (line 127):
```typescript
function handleCwd(pathArg: string, session: Session): CommandResult {
  // Disabled after path configured
  if (session.pathConfigured) {
    return {
      handled: true,
      response: `❌ \`/cwd\` is disabled. Working directory is locked to: \`${session.configuredPath}\``,
    };
  }

  // Before path configured: show current directory
  if (pathArg) {
    return {
      handled: true,
      response: `Changing directory via /cwd is not supported.\n\nUse \`/path <directory>\` to set the working directory.\n\nCurrent: \`${session.workingDir}\``,
    };
  }

  return {
    handled: true,
    response: `Current directory: \`${session.workingDir}\`\n\nTo set working directory, use: \`/path /your/project/path\``,
  };
}
```

**Change 2:** Add `/ls` command:
```typescript
case 'ls':
  return handleLs(session);

function handleLs(session: Session): CommandResult {
  if (session.pathConfigured) {
    return {
      handled: true,
      response: `❌ \`/ls\` is disabled after path configuration.\n\nUse Claude Code commands to explore: "@Claude Code show me the files"`,
    };
  }

  try {
    const files = fs.readdirSync(session.workingDir);
    const fileList = files.slice(0, 20).join('\n');
    const more = files.length > 20 ? `\n\n... and ${files.length - 20} more` : '';

    return {
      handled: true,
      response: `Files in \`${session.workingDir}\`:\n\`\`\`\n${fileList}${more}\n\`\`\`\n\nTo set this as working directory: \`/path ${session.workingDir}\``,
    };
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot read directory: ${error.message}`,
    };
  }
}
```

---

### Phase 5: Message Processing Guard

**File:** `src/slack-bot.ts`

**Change:** Add guard after command handling (line 546):
```typescript
// After handling commands that returned a response
if (commandResult.handled) {
  // ... handle command response ...
  return;
}

// GUARD: Path must be configured before processing messages
if (!session.pathConfigured) {
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    blocks: buildPathSetupBlocks(),
    text: 'Please set working directory first: /path /your/project/path',
  });

  // Remove eyes reaction
  if (originalTs) {
    try {
      await client.reactions.remove({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      });
    } catch (error) {
      // Ignore
    }
  }

  return; // Don't process the message
}

// Continue with Claude query...
```

---

### Phase 6: UI Blocks

**File:** `src/blocks.ts`

**Add:**
```typescript
export function buildPathSetupBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':warning: *Working directory not configured*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Before I can help, you need to set the working directory for this channel.\n\nThis is a *one-time setup* and cannot be changed later.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Usage:*\n```/path /absolute/path/to/your/project```',
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: ':bulb: Tip: Use `/ls` to explore the current directory first.',
      }],
    },
  ];
}
```

---

### Phase 7: Session Initialization

**File:** `src/slack-bot.ts`

**Change:** Update session creation (line 409):
```typescript
if (!mainSession) {
  mainSession = {
    sessionId: null,
    workingDir: process.cwd(),
    mode: 'plan',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: false,
    configuredPath: null,
    configuredBy: null,
    configuredAt: null,
  };
  saveSession(channelId, mainSession);
}
```

**Change:** Save `configuredBy` when handling `/path` (line 499):
```typescript
if (commandResult.sessionUpdate) {
  // Add userId for /path command
  if (commandResult.sessionUpdate.pathConfigured) {
    commandResult.sessionUpdate.configuredBy = userId ?? null;
  }
  saveSession(channelId, commandResult.sessionUpdate);
}
```

---

### Phase 8: Status Display

**File:** `src/blocks.ts`

**Update:** `buildStatusDisplayBlocks()` (line 492):
```typescript
export interface StatusDisplayParams {
  sessionId: string | null;
  mode: PermissionMode;
  workingDir: string;
  lastActiveAt: number;
  pathConfigured: boolean;
  configuredBy: string | null;
  configuredAt: number | null;
}

export function buildStatusDisplayBlocks(params: StatusDisplayParams): Block[] {
  const statusLines = [
    `*Session ID:* \`${params.sessionId || 'None'}\``,
    `*Mode:* ${modeEmoji[params.mode]} ${params.mode}`,
    `*Working Directory:* \`${params.workingDir}\``,
    `*Last Active:* ${formatRelativeTime(params.lastActiveAt)}`,
  ];

  if (params.pathConfigured) {
    const configuredDate = new Date(params.configuredAt!).toLocaleString();
    statusLines.push(`*Path Configured:* ✅ Yes (by <@${params.configuredBy}> on ${configuredDate})`);
    statusLines.push(`*Path Locked:* Yes (cannot be changed)`);
  } else {
    statusLines.push(`*Path Configured:* ❌ No - use \`/path <directory>\` to set`);
  }

  // ... rest of implementation
}
```

**File:** `src/commands.ts`

**Update:** `/status` command caller (line 93):
```typescript
return {
  handled: true,
  blocks: buildStatusDisplayBlocks({
    sessionId: session.sessionId,
    mode: session.mode,
    workingDir: session.workingDir,
    lastActiveAt: session.lastActiveAt,
    pathConfigured: session.pathConfigured,
    configuredBy: session.configuredBy,
    configuredAt: session.configuredAt,
  }),
};
```

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Path deleted after config | SDK will error, user must use different channel |
| Symlinks | Resolved with `fs.realpathSync()` |
| Permission denied | Checked with `fs.accessSync()` before accepting |
| Relative paths | Rejected, must be absolute |
| User sets path in thread | Not allowed - threads inherit channel's path |
| Migration from old sessions | Auto-add defaults in `loadSessions()` |

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/session-manager.ts` | Add path config fields, migration logic, thread inheritance |
| `src/slack-bot.ts` | Channel-only filtering, message guard, session init |
| `src/commands.ts` | `/path` command, `/ls` command, restrict `/cwd` |
| `src/blocks.ts` | Path setup blocks, status display updates |
| `src/__tests__/unit/session-manager.test.ts` | Migration, inheritance tests |
| `src/__tests__/unit/commands.test.ts` | `/path`, `/ls`, `/cwd` tests |
| `src/__tests__/unit/blocks.test.ts` | Block builder tests |
| `src/__tests__/integration/slack-bot.test.ts` | Channel filter, path guard tests |
| `src/__tests__/integration/path-configuration.test.ts` | End-to-end flow tests |

---

## Tests

### Unit Tests

**session-manager.test.ts:**
- Migration adds default path fields
- New sessions initialize with defaults
- Thread sessions inherit path config

**commands.test.ts:**
- `/path` validates absolute paths
- `/path` rejects non-existent paths
- `/path` rejects files (not directories)
- `/path` rejects when already configured
- `/cwd` disabled after path set
- `/ls` disabled after path set

**blocks.test.ts:**
- `buildPathSetupBlocks()` structure
- `buildStatusDisplayBlocks()` includes path info

### Integration Tests

**slack-bot.test.ts:**
- DM mention → error message
- Channel mention → processes normally
- Message before path configured → shows setup prompt
- Message after path configured → processes normally

**path-configuration.test.ts:**
1. New channel → no path → shows prompt
2. User runs `/path /tmp` → success
3. User runs `/path /other` → error (locked)
4. User sends message → processes with path
5. Thread inherits channel path
6. `/ls` and `/cwd` disabled after config

---

## Verification

### Manual Testing

```bash
# 1. Start bot
npm run dev

# 2. Create new Slack channel
# 3. Mention bot without configuring path
@Claude Code help me

# Expected: Setup prompt with /path instructions

# 4. Try /ls command
/ls

# Expected: Shows files in current directory

# 5. Configure path
/path /Users/egx/ai/ccslack

# Expected: Success message, path locked

# 6. Try /ls again
/ls

# Expected: Error - disabled after configuration

# 7. Send normal message
@Claude Code show me the files

# Expected: Processes normally using configured path

# 8. Try to change path
/path /different/path

# Expected: Error - already configured

# 9. Create thread and verify inheritance
# Reply in thread: @Claude Code /status

# Expected: Shows same working directory as channel
```

### Automated Tests

```bash
npm test
```

---

## Implementation Checklist

- [ ] Phase 1: Update session schema
- [ ] Phase 2: Add channel-only filtering
- [ ] Phase 3: Implement `/path` command
- [ ] Phase 4: Restrict `/ls` and `/cwd`
- [ ] Phase 5: Add message processing guard
- [ ] Phase 6: Add path setup blocks
- [ ] Phase 7: Update session initialization
- [ ] Phase 8: Update status display
- [ ] Unit tests for all changes
- [ ] Integration tests for flows
- [ ] Manual testing in Slack
- [ ] Update README.md
- [ ] Update CLAUDE.md
