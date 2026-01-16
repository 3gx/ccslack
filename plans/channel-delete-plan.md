# Automatic Session Cleanup on Channel Deletion

## Summary

**Goal:** When a Slack channel is deleted, automatically clean up:
1. Bot's session records in `sessions.json` (main channel + all thread sessions)
2. Claude Code SDK session files in `~/.claude/projects/` (JSONL files)

**Scope:** Delete only bot-created sessions (main + thread forks). Terminal forks created by users via `--fork-session` are left alone (user's responsibility).

**Current State:**
- ❌ No cleanup mechanism
- ❌ No `channel_deleted` event handler
- ❌ Sessions accumulate indefinitely

**After Implementation:**
- ✅ Automatic cleanup when channels are deleted
- ✅ Both bot records AND SDK files removed
- ✅ Comprehensive test coverage
- ✅ Updated documentation

---

## Architecture Overview

### Session Storage Locations

**1. Bot Session Records** (`./sessions.json`):
```typescript
{
  channels: {
    "C123": {
      sessionId: "abc-123",
      workingDir: "/Users/egx/ai/ccslack",
      threads: {
        "1234.5678": { sessionId: "def-456", forkedFrom: "abc-123" },
        "1234.9999": { sessionId: "ghi-789", forkedFrom: "abc-123" }
      }
    }
  }
}
```

**2. SDK Session Files** (`~/.claude/projects/`):
```
~/.claude/projects/
  └── -Users-egx-ai-ccslack/
      ├── abc-123.jsonl         # Main session
      ├── def-456.jsonl         # Thread fork 1
      └── ghi-789.jsonl         # Thread fork 2
```

### Cleanup Flow

```
Channel C123 deleted
    ↓
Bot receives channel_deleted event
    ↓
Load session from sessions.json
    ↓
Collect all session IDs:
  - Main: abc-123
  - Thread 1: def-456
  - Thread 2: ghi-789
    ↓
Delete SDK files:
  ✓ ~/.claude/projects/-Users-egx-ai-ccslack/abc-123.jsonl
  ✓ ~/.claude/projects/-Users-egx-ai-ccslack/def-456.jsonl
  ✓ ~/.claude/projects/-Users-egx-ai-ccslack/ghi-789.jsonl
    ↓
Delete from sessions.json:
  ✓ delete channels["C123"]
    ↓
Done - all cleaned up
```

---

## Implementation Plan

### Phase 1: Add Session Deletion Functions

**File:** `src/session-manager.ts`

**Location:** After `saveThreadSession()` (around line 180)

**Add these functions:**

```typescript
import path from 'path';
import os from 'os';

/**
 * Delete a single SDK session file
 */
function deleteSdkSessionFile(sessionId: string, workingDir: string): void {
  try {
    // Convert working directory to project path format
    // Example: /Users/egx/ai/ccslack -> -Users-egx-ai-ccslack
    const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');

    // Build session file path
    const sessionFile = path.join(
      os.homedir(),
      '.claude/projects',
      projectPath,
      `${sessionId}.jsonl`
    );

    // Delete if exists
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
      console.log(`  ✓ Deleted SDK session file: ${sessionId}.jsonl`);
    } else {
      console.log(`  ℹ SDK session file not found (may have been deleted): ${sessionId}.jsonl`);
    }
  } catch (error) {
    console.error(`  ✗ Error deleting SDK session file ${sessionId}:`, error);
    // Don't throw - continue with other cleanups
  }
}

/**
 * Delete session for a channel (including all SDK files)
 *
 * Deletes:
 * 1. Main channel session from sessions.json
 * 2. All thread sessions from sessions.json
 * 3. All corresponding SDK .jsonl files
 *
 * @param channelId - Slack channel ID (e.g., "C0123456789")
 */
export function deleteSession(channelId: string): void {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    console.log(`No session found for channel ${channelId}`);
    return;
  }

  console.log(`Deleting sessions for channel ${channelId}...`);

  // Count sessions for logging
  const threadCount = channelSession.threads
    ? Object.keys(channelSession.threads).length
    : 0;
  const totalSessions = 1 + threadCount; // main + threads

  console.log(`  Found ${totalSessions} session(s) to delete:`);
  console.log(`    - 1 main session`);
  if (threadCount > 0) {
    console.log(`    - ${threadCount} thread session(s)`);
  }

  // Delete main session SDK file
  if (channelSession.sessionId) {
    console.log(`  Deleting main session: ${channelSession.sessionId}`);
    deleteSdkSessionFile(channelSession.sessionId, channelSession.workingDir);
  }

  // Delete all thread session SDK files
  if (channelSession.threads) {
    const threadEntries = Object.entries(channelSession.threads);
    console.log(`  Deleting ${threadEntries.length} thread session(s)...`);

    threadEntries.forEach(([threadTs, threadSession]) => {
      if (threadSession.sessionId) {
        console.log(`    Thread ${threadTs}: ${threadSession.sessionId}`);
        deleteSdkSessionFile(threadSession.sessionId, channelSession.workingDir);
      }
    });
  }

  // Delete from sessions.json
  delete store.channels[channelId];
  saveSessions(store);
  console.log(`  ✓ Removed channel ${channelId} from sessions.json`);

  console.log(`✅ Cleanup complete for channel ${channelId}`);
}
```

**Add imports at top of file:**
```typescript
import path from 'path';
import os from 'os';
```

---

### Phase 2: Add Event Handler for Channel Deletion

**File:** `src/slack-bot.ts`

**Location:** After existing event handlers (around line 350, after `app.message`)

**Add event handler:**

```typescript
/**
 * Handle channel deletion - clean up all sessions and SDK files
 *
 * When a channel is deleted:
 * 1. Delete main session + all thread sessions from sessions.json
 * 2. Delete all corresponding SDK .jsonl files
 *
 * Terminal forks (created via --fork-session) are NOT deleted
 * as they may be user's personal sessions.
 */
app.event('channel_deleted', async ({ event }) => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Channel deleted: ${event.channel}`);
    console.log(`${'='.repeat(60)}`);

    // Delete session (handles both bot records and SDK files)
    deleteSession(event.channel);

    console.log(`${'='.repeat(60)}\n`);
  } catch (error) {
    console.error('Error handling channel deletion:', error);
    // Don't throw - cleanup failure shouldn't crash the bot
    // Log the error and continue running
  }
});
```

**Add import at top of file:**

Look for existing imports from `session-manager.js` (around line 10-20) and add `deleteSession`:

```typescript
import {
  getSession,
  saveSession,
  saveThreadSession,
  getOrCreateThreadSession,
  deleteSession,  // ADD THIS
} from './session-manager.js';
```

---

### Phase 3: Update Slack App Configuration

**Action Required:** Update Slack App Event Subscriptions

**Steps:**
1. Go to Slack App Dashboard → https://api.slack.com/apps
2. Select your app
3. Navigate to "Event Subscriptions"
4. Under "Subscribe to bot events", add:
   - `channel_deleted` ← **Add this**
5. Save changes
6. Reinstall app to workspace (OAuth & Permissions → Reinstall App)

**Required Scopes:**
- `channels:read` ✓ (already have)
- `channels:history` ✓ (already have)

**No new scopes needed** - existing permissions cover the `channel_deleted` event.

---

### Phase 4: Testing

#### Unit Tests

**File:** `src/__tests__/unit/session-manager.test.ts`

**Location:** Add at end of file (after existing tests)

**Add test suite:**

```typescript
describe('deleteSession', () => {
  const mockWorkingDir = '/Users/testuser/projects/myapp';

  beforeEach(() => {
    // Clear sessions before each test
    const store = loadSessions();
    store.channels = {};
    saveSessions(store);
  });

  it('should delete channel with main session only', () => {
    // Setup: Create channel with main session
    const session: Session = {
      sessionId: 'main-session-123',
      workingDir: mockWorkingDir,
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: mockWorkingDir,
      configuredBy: 'U123',
      configuredAt: Date.now(),
    };
    saveSession('C123', session);

    // Verify session exists
    let loadedSession = getSession('C123', null);
    expect(loadedSession).not.toBeNull();
    expect(loadedSession?.sessionId).toBe('main-session-123');

    // Delete channel
    deleteSession('C123');

    // Verify session is gone
    loadedSession = getSession('C123', null);
    expect(loadedSession).toBeNull();
  });

  it('should delete channel with main session and multiple threads', () => {
    // Setup: Create channel with main + 2 threads
    const mainSession: Session = {
      sessionId: 'main-session-123',
      workingDir: mockWorkingDir,
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: mockWorkingDir,
      configuredBy: 'U123',
      configuredAt: Date.now(),
    };
    saveSession('C123', mainSession);

    const thread1: ThreadSession = {
      ...mainSession,
      sessionId: 'thread-session-456',
      forkedFrom: 'main-session-123',
    };
    saveThreadSession('C123', '1234.5678', thread1);

    const thread2: ThreadSession = {
      ...mainSession,
      sessionId: 'thread-session-789',
      forkedFrom: 'main-session-123',
    };
    saveThreadSession('C123', '1234.9999', thread2);

    // Verify all sessions exist
    expect(getSession('C123', null)?.sessionId).toBe('main-session-123');
    expect(getSession('C123', '1234.5678')?.sessionId).toBe('thread-session-456');
    expect(getSession('C123', '1234.9999')?.sessionId).toBe('thread-session-789');

    // Delete channel
    deleteSession('C123');

    // Verify all sessions are gone
    expect(getSession('C123', null)).toBeNull();
    expect(getSession('C123', '1234.5678')).toBeNull();
    expect(getSession('C123', '1234.9999')).toBeNull();
  });

  it('should handle deleting non-existent channel safely', () => {
    // Delete channel that doesn't exist
    expect(() => deleteSession('C999')).not.toThrow();
  });

  it('should persist deletion to sessions.json', () => {
    // Setup
    const session: Session = {
      sessionId: 'test-session',
      workingDir: mockWorkingDir,
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: mockWorkingDir,
      configuredBy: 'U123',
      configuredAt: Date.now(),
    };
    saveSession('C123', session);

    // Delete
    deleteSession('C123');

    // Reload from disk and verify
    const store = loadSessions();
    expect(store.channels['C123']).toBeUndefined();
  });

  it('should handle channel with no sessionId (edge case)', () => {
    // Setup: Channel with null sessionId
    const session: Session = {
      sessionId: null,
      workingDir: mockWorkingDir,
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
      configuredBy: null,
      configuredAt: null,
    };
    saveSession('C123', session);

    // Should not throw when deleting
    expect(() => deleteSession('C123')).not.toThrow();

    // Should still delete from sessions.json
    expect(getSession('C123', null)).toBeNull();
  });
});
```

#### Integration Tests

**File:** `src/__tests__/integration/channel-lifecycle.test.ts` (NEW FILE)

**Create new file with:**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from '@slack/bolt';
import {
  saveSession,
  saveThreadSession,
  getSession,
  deleteSession,
} from '../../session-manager.js';
import type { Session, ThreadSession } from '../../session-manager.js';

describe('channel lifecycle - deletion', () => {
  const mockSession: Session = {
    sessionId: 'main-session-123',
    workingDir: '/Users/testuser/projects/myapp',
    mode: 'plan',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: true,
    configuredPath: '/Users/testuser/projects/myapp',
    configuredBy: 'U123',
    configuredAt: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should clean up session when channel is deleted', async () => {
    // Setup: Create channel session
    saveSession('C123', mockSession);
    expect(getSession('C123', null)).not.toBeNull();

    // Simulate channel deletion
    deleteSession('C123');

    // Verify session is deleted
    const session = getSession('C123', null);
    expect(session).toBeNull();
  });

  it('should clean up channel with multiple threads', async () => {
    // Setup: Channel with main + 2 threads
    saveSession('C123', mockSession);

    const thread1: ThreadSession = {
      ...mockSession,
      sessionId: 'thread-456',
      forkedFrom: 'main-session-123',
    };
    saveThreadSession('C123', '1234.5678', thread1);

    const thread2: ThreadSession = {
      ...mockSession,
      sessionId: 'thread-789',
      forkedFrom: 'thread-456',
    };
    saveThreadSession('C123', '1234.9999', thread2);

    // Verify setup
    expect(getSession('C123', null)).not.toBeNull();
    expect(getSession('C123', '1234.5678')).not.toBeNull();
    expect(getSession('C123', '1234.9999')).not.toBeNull();

    // Delete channel
    deleteSession('C123');

    // Verify all sessions deleted
    expect(getSession('C123', null)).toBeNull();
    expect(getSession('C123', '1234.5678')).toBeNull();
    expect(getSession('C123', '1234.9999')).toBeNull();
  });

  it('should handle deleting channel with no session', async () => {
    // Should not throw when deleting non-existent channel
    expect(() => deleteSession('C999')).not.toThrow();
  });

  it('should not affect other channels when one is deleted', async () => {
    // Setup: Two channels
    saveSession('C123', mockSession);
    saveSession('C456', { ...mockSession, sessionId: 'other-session' });

    // Delete one channel
    deleteSession('C123');

    // Verify C123 deleted, C456 remains
    expect(getSession('C123', null)).toBeNull();
    expect(getSession('C456', null)).not.toBeNull();
    expect(getSession('C456', null)?.sessionId).toBe('other-session');
  });
});
```

---

### Phase 5: Update Documentation

#### Update CLAUDE.md

**File:** `CLAUDE.md`

**Add new section after "Session Management":**

```markdown
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
```

#### Update README.md

**File:** `README.md`

**Add to Features section:**

```markdown
- **Automatic Cleanup**: When channels are deleted, all associated sessions are automatically cleaned up (both bot records and SDK files)
```

**Add new section under "How It Works":**

```markdown
### Session Lifecycle

**Creation:**
- Bot creates session when user first messages in a channel
- Session stored in `./sessions.json` (bot records)
- Session stored in `~/.claude/projects/` (SDK files)

**Forking:**
- Thread replies create new forked sessions
- `/fork-thread` creates explicit thread forks
- All forks tracked in `sessions.json` under parent channel

**Cleanup:**
- Channel deletion triggers automatic cleanup
- Deletes bot records from `sessions.json`
- Deletes SDK files from `~/.claude/projects/`
- Terminal forks (manual `--fork-session`) are preserved
```

#### Create Architecture Document

**File:** `docs/architecture/session-management.md` (NEW FILE)

**Create file with:**

```markdown
# Session Management Architecture

## Overview

The bot manages two types of session storage:
1. **Bot session records** - Lightweight metadata in `sessions.json`
2. **SDK session files** - Full conversation history in `~/.claude/projects/`

## Storage Locations

### Bot Session Records
**Location:** `./sessions.json`
**Format:** JSON
**Purpose:** Track session metadata, working directories, and fork relationships

**Structure:**
```json
{
  "channels": {
    "C0123456789": {
      "sessionId": "abc-123-def-456",
      "workingDir": "/Users/egx/ai/ccslack",
      "mode": "plan",
      "createdAt": 1234567890,
      "lastActiveAt": 1234567891,
      "pathConfigured": true,
      "configuredPath": "/Users/egx/ai/ccslack",
      "configuredBy": "U123456",
      "configuredAt": 1234567890,
      "threads": {
        "1234567890.123456": {
          "sessionId": "def-456-ghi-789",
          "forkedFrom": "abc-123-def-456",
          "workingDir": "/Users/egx/ai/ccslack",
          "mode": "plan",
          ...
        }
      }
    }
  }
}
```

### SDK Session Files
**Location:** `~/.claude/projects/${projectPath}/`
**Format:** JSONL (JSON Lines)
**Purpose:** Store full conversation transcript for resumption

**Path Derivation:**
```typescript
workingDir = "/Users/egx/ai/ccslack"
projectPath = "-Users-egx-ai-ccslack"  // Replace / with -, prefix with -
sessionFile = "~/.claude/projects/-Users-egx-ai-ccslack/abc-123-def-456.jsonl"
```

**File Contents:** One JSON object per line, representing messages, tool calls, and responses.

## Session Lifecycle

### Creation
1. User sends first message in channel
2. Bot calls Claude Code SDK with no `sessionId`
3. SDK creates new session, returns `session_id` in init message
4. Bot captures `session_id` from stream
5. Bot saves to `sessions.json` (metadata only)
6. SDK automatically saves full transcript to `.jsonl` file

### Resumption
1. User sends subsequent message in same channel
2. Bot loads `sessionId` from `sessions.json`
3. Bot calls SDK with `resume: sessionId`
4. SDK loads transcript from `.jsonl` file
5. Conversation continues with full context

### Forking
**Thread Replies (Auto-fork):**
1. User replies in thread
2. Bot detects `thread_ts` in event
3. Bot calls SDK with `resume: parentSessionId, forkSession: true`
4. SDK creates new session with parent's history
5. Bot saves thread session to `sessions.json` with `forkedFrom` link

**Explicit Thread Forking (`/fork-thread`):**
1. User runs `/fork-thread "description"` in thread
2. Bot creates new thread with link to source thread
3. Bot calls SDK with `resume: sourceSessionId, forkSession: true`
4. New forked session created with source's history
5. Both threads continue independently

### Deletion (Channel Deleted)
1. Slack fires `channel_deleted` event
2. Bot receives event with `channel: "C0123456789"`
3. Bot loads channel session from `sessions.json`
4. Bot collects all session IDs (main + all threads)
5. Bot deletes SDK files:
   - `~/.claude/projects/${projectPath}/${mainSessionId}.jsonl`
   - `~/.claude/projects/${projectPath}/${thread1SessionId}.jsonl`
   - `~/.claude/projects/${projectPath}/${thread2SessionId}.jsonl`
   - ...
6. Bot deletes channel entry from `sessions.json`
7. Cleanup complete

**What is NOT deleted:**
- Terminal forks created by `claude --resume <id> --fork-session`
- Sessions in other channels
- Sessions in same directory but different channels

## Session ID Relationship

**Bot's `sessionId` == SDK's `session_id`**

Both use the same UUID:
- Bot stores in `sessions.json`
- SDK uses as filename: `${sessionId}.jsonl`
- Can be used interchangeably

## Error Handling

### Channel Not Found
- If bot tries to post to deleted channel → Slack returns `channel_not_found`
- Bot catches error and shows user message
- Session cleanup happens via `channel_deleted` event (asynchronous)

### Missing SDK File
- If SDK file is deleted manually → SDK treats as new session
- Bot's `sessions.json` may reference non-existent SDK file
- Attempting to resume → SDK starts fresh (graceful degradation)

### Concurrent Access
- Multiple processes can read SDK files simultaneously
- Writing is not locked - last write wins
- Deletion during active use → undefined behavior (user's terminal may error)

## Design Decisions

### Why Two Storage Locations?
- `sessions.json` - Fast lookups for bot logic (which session belongs to which channel)
- SDK files - Full transcript for conversation resumption (managed by SDK)

### Why Not Delete Terminal Forks?
- Cannot distinguish bot-created from user-created forks
- Terminal forks may be user's personal work unrelated to Slack
- Safer to leave them (user can clean up manually)

### Why Delete on Channel Deletion?
- Channel gone = sessions no longer accessible
- Prevents indefinite accumulation of orphaned data
- Users expect cleanup when deleting channels

### Why Not Time-Based Cleanup?
- Channels may be inactive but still valuable
- User might return after long absence
- Deletion is explicit user action = clear intent
- Can be added later if needed
```

---

## Edge Cases

| Scenario | Behavior | Handled By |
|----------|----------|------------|
| Channel deleted with active threads | All thread sessions deleted | `deleteSession()` iterates threads |
| Channel deleted while bot offline | Event queued, processed on restart | Slack event delivery system |
| SDK file already deleted manually | Logs "file not found", continues | `deleteSdkSessionFile()` checks existence |
| Session with null sessionId | Skips SDK deletion, removes from sessions.json | `if (sessionId)` check |
| Deleting same channel twice | Safe - second call finds no session | `if (!channelSession) return` |
| Deleting channel from different project | Only deletes sessions for that channel | Channel ID uniqueness |
| Terminal fork in same directory | NOT deleted (user's responsibility) | Only deletes known session IDs |
| Permission error deleting SDK file | Logs error, continues with other deletions | try/catch in `deleteSdkSessionFile()` |

---

## Files Modified

| File | Changes | Purpose |
|------|---------|---------|
| `src/session-manager.ts` | Add `deleteSession()`, `deleteSdkSessionFile()` | Session cleanup logic |
| `src/session-manager.ts` | Add `import path, os` | Path utilities for SDK files |
| `src/slack-bot.ts` | Add `channel_deleted` event handler | Trigger cleanup on deletion |
| `src/slack-bot.ts` | Import `deleteSession` | Use cleanup function |
| `src/__tests__/unit/session-manager.test.ts` | Add `deleteSession()` tests | Unit test coverage |
| `src/__tests__/integration/channel-lifecycle.test.ts` | Create new test file | Integration test coverage |
| `CLAUDE.md` | Add Session Cleanup section | Developer documentation |
| `README.md` | Update Features and add Session Lifecycle | User documentation |
| `docs/architecture/session-management.md` | Create new file | Architecture documentation |

---

## Verification Checklist

### Code Implementation
- [ ] Add `deleteSdkSessionFile()` function to session-manager.ts
- [ ] Add `deleteSession()` function to session-manager.ts
- [ ] Add `path` and `os` imports to session-manager.ts
- [ ] Export `deleteSession()` from session-manager.ts
- [ ] Add `channel_deleted` event handler to slack-bot.ts
- [ ] Import `deleteSession` in slack-bot.ts

### Testing
- [ ] Add unit tests for `deleteSession()` (5 test cases)
- [ ] Create integration test file for channel lifecycle
- [ ] Run `npm test` - all tests pass
- [ ] Verify test coverage includes deletion logic

### Slack Configuration
- [ ] Update Slack app event subscriptions
- [ ] Add `channel_deleted` event
- [ ] Reinstall app to workspace
- [ ] Verify bot receives `channel_deleted` events

### Manual Testing
- [ ] Create test channel in Slack
- [ ] Configure path with `/set-current-path`
- [ ] Create 2-3 thread conversations
- [ ] Verify sessions in `sessions.json`
- [ ] Verify SDK files in `~/.claude/projects/`
- [ ] Delete the test channel
- [ ] Verify console shows cleanup logs
- [ ] Verify sessions removed from `sessions.json`
- [ ] Verify SDK files deleted from `~/.claude/projects/`
- [ ] Verify other channels unaffected

### Documentation
- [ ] Update CLAUDE.md with Session Cleanup section
- [ ] Update README.md Features list
- [ ] Update README.md with Session Lifecycle section
- [ ] Create `docs/architecture/session-management.md`
- [ ] Review all documentation for accuracy

### Code Quality
- [ ] TypeScript compiles without errors (`npm run build`)
- [ ] Linter passes (`npm run lint`)
- [ ] No console.error in normal operation
- [ ] Error handling for missing files/permissions
- [ ] Clear logging for debugging

---

## Testing Instructions

### Unit Tests
```bash
# Run all tests
npm test

# Run only session manager tests
npm test -- session-manager.test.ts

# Run with coverage
npm test -- --coverage
```

### Manual Test Scenario

**Setup:**
1. Start bot: `npm run dev`
2. Create test channel: `#bot-cleanup-test`
3. Invite bot to channel

**Test Steps:**
```
# 1. Configure channel
/cd /Users/egx/ai/ccslack
/set-current-path

# 2. Create sessions
@Claude Code help me understand this codebase
  → Creates main session

# 3. Create thread forks
- Reply in thread: @Claude Code what does this do?
  → Creates thread session 1
- Reply in different thread: @Claude Code analyze this
  → Creates thread session 2

# 4. Verify sessions exist
Check sessions.json:
  channels["C123"].sessionId = "main-abc-123"
  channels["C123"].threads["1234.5678"].sessionId = "thread-def-456"
  channels["C123"].threads["1234.9999"].sessionId = "thread-ghi-789"

Check SDK files:
  ~/.claude/projects/-Users-egx-ai-ccslack/main-abc-123.jsonl
  ~/.claude/projects/-Users-egx-ai-ccslack/thread-def-456.jsonl
  ~/.claude/projects/-Users-egx-ai-ccslack/thread-ghi-789.jsonl

# 5. Delete channel
Delete #bot-cleanup-test in Slack

# 6. Verify cleanup
Console should show:
  ============================================================
  Channel deleted: C123456789
  ============================================================
  Deleting sessions for channel C123456789...
    Found 3 session(s) to delete:
      - 1 main session
      - 2 thread session(s)
    Deleting main session: main-abc-123
      ✓ Deleted SDK session file: main-abc-123.jsonl
    Deleting 2 thread session(s)...
      Thread 1234.5678: thread-def-456
      ✓ Deleted SDK session file: thread-def-456.jsonl
      Thread 1234.9999: thread-ghi-789
      ✓ Deleted SDK session file: thread-ghi-789.jsonl
    ✓ Removed channel C123456789 from sessions.json
  ✅ Cleanup complete for channel C123456789
  ============================================================

Check sessions.json:
  channels["C123"] should not exist

Check SDK files:
  All three .jsonl files should be deleted
```

**Expected Results:**
- ✅ Console shows detailed cleanup logs
- ✅ Channel removed from `sessions.json`
- ✅ All SDK `.jsonl` files deleted
- ✅ Other channels unaffected
- ✅ Bot continues running normally

---

## Implementation Priority

**Required (do first):**
1. Phase 1 - Add deletion functions
2. Phase 2 - Add event handler
3. Phase 4 - Add tests
4. Phase 3 - Update Slack app config (after code is tested)

**Important (do before shipping):**
5. Phase 5 - Update documentation
6. Manual testing verification

---

## Future Enhancements (Out of Scope)

These are NOT part of this implementation but could be added later:

1. **Time-based cleanup:** Delete sessions inactive for 90+ days
2. **Bot removal cleanup:** Delete sessions when bot is removed from channel
3. **Archive handling:** Decide whether to keep/delete sessions when channel archived
4. **Metrics:** Track cleanup statistics (sessions deleted, disk space freed)
5. **Admin command:** Manual cleanup trigger via `/cleanup` command
6. **Dry-run mode:** Preview what would be deleted without actually deleting
