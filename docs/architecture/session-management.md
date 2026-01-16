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

## Implementation Files

| File | Purpose |
|------|---------|
| `src/session-manager.ts` | Session CRUD operations, cleanup logic |
| `src/slack-bot.ts` | Event handlers, including `channel_deleted` |
| `src/__tests__/unit/session-manager.test.ts` | Unit tests for session operations |
| `src/__tests__/integration/channel-lifecycle.test.ts` | Integration tests for cleanup |
| `sessions.json` | Bot session metadata (git-ignored) |
| `~/.claude/projects/` | SDK session files (managed by SDK) |

## Testing Strategy

### Unit Tests
- Mock `fs` module for file operations
- Test `deleteSession()` with various scenarios:
  - Main session only
  - Main + multiple threads
  - Non-existent channel
  - Null sessionId
  - Persistence to disk

### Integration Tests
- Mock Slack App and event handlers
- Test `channel_deleted` event flow:
  - Single session cleanup
  - Multiple threads cleanup
  - No session (safe handling)
  - Other channels unaffected

### Manual Testing
1. Create test channel in Slack
2. Configure path and create conversations
3. Create thread forks
4. Verify sessions in `sessions.json` and SDK files
5. Delete channel
6. Verify cleanup logs
7. Verify sessions removed
8. Verify SDK files deleted

## Future Enhancements

**Out of scope for current implementation:**

1. **Time-based cleanup** - Delete sessions inactive for 90+ days
2. **Bot removal cleanup** - Delete sessions when bot is removed from channel
3. **Archive handling** - Decide whether to keep/delete sessions when channel archived
4. **Metrics** - Track cleanup statistics (sessions deleted, disk space freed)
5. **Admin command** - Manual cleanup trigger via `/cleanup` command
6. **Dry-run mode** - Preview what would be deleted without actually deleting
