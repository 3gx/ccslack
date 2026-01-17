# Fix /clear Command Implementation

**Goal:** Fix `/clear` command detection and add session history tracking for complete cleanup

---

## Context: How /clear Works

```
Main Channel Timeline (Linear with Clear Separators):
══════════════════════════════════════════════════════════════════

Session S1:  M1 ─→ M2 ─→ M3 ─→ M4
                                 │
                            ─────┴───── /clear ─────
                                 │
Session S2:                      M5 ─→ M6 ─→ M7
                                             │
                            ─────────────────┴───── /clear ─────
                                             │
Session S3:                                  M8 ─→ M9
                                                   │
                                                (current)

══════════════════════════════════════════════════════════════════

User can fork ANY point in history:

  Fork M2 → Thread gets S1 context (M1→M2)         "Old convo"
  Fork M3 → Thread gets S1 context (M1→M2→M3)     "Old convo"
  Fork M6 → Thread gets S2 context (M5→M6)         "Middle convo"
  Fork M9 → Thread gets S3 context (M8→M9)         "Current convo"

══════════════════════════════════════════════════════════════════

Natural behavior:
- Main is always the "latest" session (S3)
- /clear creates a new segment/session
- messageMap preserves ALL history across all sessions
- Forking = "time travel" to that session's context
- User intuitively knows: fork above clear = old context, fork below = new context
```

---

## Problem Summary

1. **Detection broken**: Code looks for `clear_boundary` message which SDK doesn't emit
2. **Orphaned sessions**: Old session IDs (S1, S2) not tracked, never deleted on channel cleanup

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/session-manager.ts` | Add `previousSessionIds` to Session interface, update deleteSession |
| `src/slack-bot.ts` | Fix /clear detection (use new session ID), track previous sessions |
| `src/__tests__/unit/commands.test.ts` | Already done ✓ |
| `src/__tests__/integration/slack-bot.test.ts` | Update /clear tests for correct detection |
| `src/__tests__/sdk-live/sdk-clear.test.ts` | Fix test to use correct detection |

---

## Phase 1: Add Session History Tracking

**File:** `src/session-manager.ts`

### 1.1 Update Session interface (~line 19-31)

```typescript
export interface Session {
  sessionId: string | null;
  previousSessionIds?: string[];  // Track all sessions before /clear
  workingDir: string;
  // ... rest unchanged
}
```

### 1.2 Update deleteSession() (~line 472)

Add after main session deletion, before thread deletion:

```typescript
// Delete all previous session SDK files (from /clear operations)
if (channelSession.previousSessionIds) {
  for (const prevId of channelSession.previousSessionIds) {
    if (prevId) {
      deleteSdkSessionFile(prevId, channelSession.workingDir);
      console.log(`[DeleteSession] Deleted previous session: ${prevId}`);
    }
  }
}
```

### 1.3 Add migration in loadSessions() (~line 113-134)

```typescript
// Migration: Add previousSessionIds field to existing sessions
if (channel.previousSessionIds === undefined) {
  channel.previousSessionIds = [];
}
```

---

## Phase 2: Fix /clear Detection in slack-bot.ts

**File:** `src/slack-bot.ts`

### 2.1 Update runClearSession() success detection (~line 647)

**Current (broken):**
```typescript
} else if (clearBoundaryFound || newSessionId) {
```

**Fixed:**
```typescript
// Success = got a NEW session ID different from original
const clearSucceeded = newSessionId && newSessionId !== session.sessionId;

if (errorOccurred) {
  // ... error handling
} else if (clearSucceeded) {
```

### 2.2 Track previous session ID before updating (~line 649-652)

**Current:**
```typescript
if (newSessionId && newSessionId !== session.sessionId) {
  saveSession(channelId, { sessionId: newSessionId });
}
```

**Fixed:**
```typescript
if (newSessionId && newSessionId !== session.sessionId) {
  // Track old session ID before updating
  const previousIds = session.previousSessionIds ?? [];
  if (session.sessionId) {
    previousIds.push(session.sessionId);
  }

  saveSession(channelId, {
    sessionId: newSessionId,
    previousSessionIds: previousIds,
  });
  console.log(`[Clear] Session updated: ${session.sessionId} → ${newSessionId}`);
}
```

### 2.3 Remove broken clear_boundary detection (~line 607-611)

Remove or comment out:
```typescript
// REMOVE: SDK doesn't emit clear_boundary
// if (msg.type === 'system' && (msg as any).subtype === 'clear_boundary') {
//   clearBoundaryFound = true;
// }
```

---

## Phase 3: Update Tests

### 3.1 Unit Tests - Session Manager

**File:** `src/__tests__/unit/session-manager.test.ts`

```typescript
describe('previousSessionIds tracking', () => {
  it('should initialize previousSessionIds as empty array for new sessions', () => {
    const session = getSession('new-channel');
    expect(session.previousSessionIds).toEqual([]);
  });

  it('should preserve previousSessionIds when saving other fields', () => {
    saveSession('C123', { previousSessionIds: ['S1', 'S2'] });
    saveSession('C123', { sessionId: 'S3' });
    const session = getSession('C123');
    expect(session.previousSessionIds).toEqual(['S1', 'S2']);
  });

  it('should migrate existing sessions without previousSessionIds', () => {
    // Simulate old session format
    // Verify migration adds empty array
  });
});

describe('deleteSession with previousSessionIds', () => {
  it('should delete all previous session SDK files', () => {
    // Setup session with previousSessionIds: ["S1", "S2"], sessionId: "S3"
    // Mock fs.existsSync and fs.unlinkSync
    // Call deleteSession
    // Verify deleteSdkSessionFile called for S1, S2, S3
  });

  it('should handle empty previousSessionIds', () => {
    // Setup session with previousSessionIds: [], sessionId: "S1"
    // Call deleteSession
    // Verify only S1 deleted, no errors
  });
});
```

### 3.2 Integration Tests - /clear Command

**File:** `src/__tests__/integration/slack-bot.test.ts`

Update existing `/clear command` describe block:

```typescript
describe('/clear command', () => {
  it('should detect clear success via new session ID (not clear_boundary)', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'old-session-S1',
      previousSessionIds: [],
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      // ...
    });

    // SDK returns new session ID (no clear_boundary needed)
    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'new-session-S2', model: 'claude-sonnet' };
        yield { type: 'result', result: '' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> /clear', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should save new session ID AND track previous
    expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({
      sessionId: 'new-session-S2',
      previousSessionIds: ['old-session-S1'],
    }));

    // Should post success message
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Session history cleared'),
      })
    );
  });

  it('should accumulate previousSessionIds across multiple clears', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const mockClient = createMockSlackClient();

    // Session already has previous IDs from earlier clears
    vi.mocked(getSession).mockReturnValue({
      sessionId: 'S2',
      previousSessionIds: ['S1'],  // Already one previous
      workingDir: '/test/dir',
      mode: 'default',
      pathConfigured: true,
      // ...
    });

    vi.mocked(startClaudeQuery).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'S3', model: 'claude-sonnet' };
        yield { type: 'result', result: '' };
      },
      interrupt: vi.fn(),
    } as any);

    await handler({
      event: { user: 'U123', text: '<@BOT123> /clear', channel: 'C123', ts: 'msg123' },
      client: mockClient,
    });

    // Should append S2 to existing [S1]
    expect(saveSession).toHaveBeenCalledWith('C123', expect.objectContaining({
      sessionId: 'S3',
      previousSessionIds: ['S1', 'S2'],
    }));
  });

  it('should fail gracefully when SDK returns same session ID', async () => {
    // Edge case: SDK doesn't actually clear (returns same ID)
    // Should show "Clear processed" not success
  });
});
```

### 3.3 Integration Tests - Channel Deletion

**File:** `src/__tests__/integration/channel-lifecycle.test.ts`

```typescript
describe('channel deletion with session history', () => {
  it('should delete all previous session files on channel deletion', async () => {
    const handler = registeredHandlers['event_channel_deleted'];

    // Setup session with history
    vi.mocked(loadSessions).mockReturnValue({
      channels: {
        'C123': {
          sessionId: 'S3',
          previousSessionIds: ['S1', 'S2'],
          workingDir: '/test/dir',
          threads: {
            'thread1': { sessionId: 'T1', forkedFrom: 'S1' },
          },
        },
      },
    });

    // Mock file existence
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await handler({ event: { channel: 'C123' } });

    // Verify ALL sessions deleted
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('S1.jsonl'));
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('S2.jsonl'));
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('S3.jsonl'));
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('T1.jsonl'));
  });

  it('should handle channel with no previous sessions', async () => {
    // previousSessionIds: [] or undefined
    // Should still delete current session without error
  });
});
```

### 3.4 SDK Live Test - /clear Command

**File:** `src/__tests__/sdk-live/sdk-clear.test.ts`

Rewrite test to use correct detection:

```typescript
describe.skipIf(SKIP_LIVE)('SDK Clear Command (Isolated)', { timeout: 120000 }, () => {
  it('TEST: /clear creates new session ID', { timeout: 90000 }, async () => {
    // Step 1: Create initial session
    console.log('\n=== Step 1: Creating initial session ===');
    const q1 = query({
      prompt: 'Say "hello" and nothing else',
      options: { maxTurns: 1 },
    });

    let originalSessionId: string | null = null;
    for await (const msg of q1) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        originalSessionId = (msg as any).session_id;
        console.log(`Original session: ${originalSessionId}`);
      }
      if (msg.type === 'result') break;
    }
    expect(originalSessionId).not.toBeNull();

    // Step 2: Resume with /clear
    console.log('\n=== Step 2: Resuming with /clear ===');
    const q2 = query({
      prompt: '/clear',
      options: { maxTurns: 1, resume: originalSessionId! },
    });

    let newSessionId: string | null = null;
    try {
      for await (const msg of q2) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          newSessionId = (msg as any).session_id;
          console.log(`New session after /clear: ${newSessionId}`);
        }
        if (msg.type === 'result') break;
      }
    } finally {
      await q2.interrupt().catch(() => {});
    }

    // SUCCESS CRITERIA: New session ID is different from original
    const results = {
      originalSessionId,
      newSessionId,
      sessionChanged: newSessionId !== originalSessionId,
    };
    console.log('\n=== RESULTS ===\n', JSON.stringify(results, null, 2));

    if (newSessionId && newSessionId !== originalSessionId) {
      console.log('>>> SUCCESS: /clear created new session! <<<');
      expect(newSessionId).not.toBe(originalSessionId);
    } else {
      expect.fail(`/clear did not create new session. Results: ${JSON.stringify(results)}`);
    }
  });
});
```

### 3.5 Test Summary

| Test Type | File | Tests |
|-----------|------|-------|
| Unit | `session-manager.test.ts` | previousSessionIds tracking, migration, deletion |
| Integration | `slack-bot.test.ts` | /clear detection, session accumulation |
| Integration | `channel-lifecycle.test.ts` | Delete all sessions including previous |
| SDK Live | `sdk-clear.test.ts` | Verify SDK behavior (new session ID) |

---

## Phase 4: Session Structure After Implementation

```typescript
// sessions.json
{
  "channels": {
    "C123": {
      "sessionId": "S3",                    // Current main session
      "previousSessionIds": ["S1", "S2"],   // Sessions before /clear
      "threads": {
        "ts1": { "sessionId": "T1", "forkedFrom": "S1" },
        "ts2": { "sessionId": "T2", "forkedFrom": "S3" }
      },
      "messageMap": { ... }                 // Preserved across clears
    }
  }
}
```

**On channel deletion, ALL deleted:**
- S1, S2 (from previousSessionIds)
- S3 (from sessionId)
- T1, T2 (from threads)
- **Result: ZERO ORPHANS**

---

## Verification

### Run tests
```bash
npx tsc --noEmit        # Type check
npm test                # All unit/integration tests pass
npm run test:sdk        # SDK live tests pass (including /clear)
```

### Manual test
1. Start bot: `make dev`
2. Send messages in channel
3. Type `/clear` - should show success message
4. Send more messages
5. Type `/clear` again
6. Verify `sessions.json` has `previousSessionIds: ["S1", "S2"]`
7. Delete channel in Slack
8. Verify all `.jsonl` files deleted from `~/.claude/projects/`

---

## User Experience

**Before:**
- `/clear` detection unreliable
- Old sessions orphaned on disk

**After:**
- `/clear` reliably detected via new session ID
- All sessions tracked and cleaned up
- User can still fork old messages to "time travel" to previous context
