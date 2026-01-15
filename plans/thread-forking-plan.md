# Thread-to-Thread Forking Feature

## Summary

Add ability to fork from an existing thread to a new thread. When user is in thread T1 and wants to explore a different approach, they can use `/fork-thread` to create a new thread T2 that forks from T1's session.

**User Flow:**
```
Thread T1:
  You: @claude /fork-thread "try puppeteer instead"

Main DM:
  Bot: "🔀 Forked: try puppeteer instead"  ← auto-created
    └── Thread T2                           ← auto-created
        └── Bot: "Forked from previous thread. Ready to explore."
```

---

## Implementation Plan

### 1. Add `forkedFromThreadTs` to ThreadSession Interface

**File:** `src/session-manager.ts`

```typescript
export interface ThreadSession {
  sessionId: string | null;
  forkedFrom: string | null;
  forkedFromThreadTs?: string;  // NEW: source thread's timestamp
  workingDir: string;
  mode: PermissionMode;
  createdAt: number;
  lastActiveAt: number;
}
```

### 2. Add `/fork-thread` Command Parser

**File:** `src/commands.ts`

```typescript
case 'fork-thread': {
  const description = args.join(' ').replace(/^["']|["']$/g, '').trim();
  return {
    type: 'fork-thread',
    description: description || 'Exploring alternative approach',
  };
}
```

### 3. Add Fork Anchor Blocks

**File:** `src/blocks.ts`

```typescript
export interface ForkAnchorBlockParams {
  description: string;
}

export function buildForkAnchorBlocks(params: ForkAnchorBlockParams): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔀 *Forked:* ${params.description}`,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '_Forked from thread_',
      }],
    },
  ];
}
```

### 4. Implement `handleForkThread` Function

**File:** `src/slack-bot.ts`

```typescript
async function handleForkThread({
  channelId,
  sourceThreadTs,
  description,
  client,
}: {
  channelId: string;
  sourceThreadTs: string;
  description: string;
  client: WebClient;
}): Promise<void> {
  // 1. Get source thread's session
  const sourceSession = getThreadSession(channelId, sourceThreadTs);
  if (!sourceSession?.sessionId) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: sourceThreadTs,
      text: '❌ Cannot fork: no active session in this thread.',
    });
    return;
  }

  // 2. Create new top-level message in main DM
  const anchorMessage = await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      text: `🔀 Forked: ${description}`,
      blocks: buildForkAnchorBlocks({ description }),
    })
  );
  const newThreadTs = anchorMessage.ts!;

  // 3. Create forked thread session
  saveThreadSession(channelId, newThreadTs, {
    sessionId: null,
    forkedFrom: sourceSession.sessionId,
    forkedFromThreadTs: sourceThreadTs,
    workingDir: sourceSession.workingDir,
    mode: sourceSession.mode,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });

  // 4. Post first message in new thread
  await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: newThreadTs,
      text: `_Forked from previous thread. Ready to explore: ${description}_\n\nSend a message to continue.`,
    })
  );

  // 5. Notify in source thread
  await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: sourceThreadTs,
      text: '_Session forked to new thread above._',
    })
  );
}
```

### 5. Add `> fork:` Prefix Detection & Command Handling

**File:** `src/slack-bot.ts`

In message handler, before normal processing:

```typescript
// Detect > fork: prefix in threads
const forkMatch = userText?.match(/^>\s*fork:\s*(.+)/i);
if (forkMatch && threadTs) {
  await handleForkThread({
    channelId,
    sourceThreadTs: threadTs,
    description: forkMatch[1].trim(),
    client,
  });
  return;
}

// Handle /fork-thread command
if (command?.type === 'fork-thread') {
  if (!threadTs) {
    await client.chat.postMessage({
      channel: channelId,
      text: '❌ `/fork-thread` can only be used inside a thread.',
    });
    return;
  }
  await handleForkThread({
    channelId,
    sourceThreadTs: threadTs,
    description: command.description,
    client,
  });
  return;
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/session-manager.ts` | Add `forkedFromThreadTs` to `ThreadSession` interface |
| `src/commands.ts` | Add `/fork-thread` command parser |
| `src/blocks.ts` | Add `buildForkAnchorBlocks` function |
| `src/slack-bot.ts` | Add `handleForkThread`, prefix detection, command handling |
| `src/__tests__/unit/commands.test.ts` | Tests for `/fork-thread` parsing |
| `src/__tests__/unit/blocks.test.ts` | Tests for `buildForkAnchorBlocks` |
| `src/__tests__/integration/thread-forking.test.ts` | Tests for thread-to-thread forking flow |

---

## Tests

### Unit Tests: Commands

```typescript
describe('fork-thread command', () => {
  it('should parse /fork-thread with description');
  it('should parse /fork-thread without quotes');
  it('should use default description when none provided');
});
```

### Unit Tests: Blocks

```typescript
describe('buildForkAnchorBlocks', () => {
  it('should build fork anchor with description');
});
```

### Integration Tests: Thread-to-Thread Forking

```typescript
describe('thread-to-thread forking', () => {
  it('should create new thread when /fork-thread used in thread');
  it('should detect > fork: prefix and create new thread');
  it('should error when /fork-thread used outside thread');
  it('should error when source thread has no session');
  it('should inherit workingDir and mode from source thread');
  it('should set forkedFrom to source session ID');
  it('should set forkedFromThreadTs to source thread timestamp');
  it('should notify in source thread after fork');
});
```

---

## Implementation Order

| # | Task |
|---|------|
| 1 | Add `forkedFromThreadTs` to ThreadSession interface |
| 2 | Add `/fork-thread` command parser |
| 3 | Add `buildForkAnchorBlocks` function |
| 4 | Add `handleForkThread` function |
| 5 | Add `> fork:` prefix detection |
| 6 | Add `/fork-thread` command handling |
| 7 | Add unit tests for commands |
| 8 | Add unit tests for blocks |
| 9 | Add integration tests for forking flow |
| 10 | Run all tests |

---

## Verification

### Manual Testing

```
1. Start conversation in main DM with @claude
2. Reply in thread to create T1, have a conversation
3. In T1, type: @claude /fork-thread "try async approach"
4. Verify:
   - New message appears in main DM: "🔀 Forked: try async approach"
   - New thread T2 exists under that message
   - T2 has message: "Forked from previous thread..."
   - T1 has notification: "Session forked to new thread above."
5. In T2, type: @claude /status
6. Verify session shows forked state with inherited workingDir/mode
7. Test > fork: prefix syntax similarly
```

### Automated Tests

```bash
npm test
```
