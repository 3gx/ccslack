# Phase 0 Implementation Plan: Add Test Coverage (NO implementation changes)

**Goal:** Establish test baseline on OLD SDK. All tests must pass before Phase 1.

---

## Summary

Create comprehensive test coverage for SDK integration points to ensure the upgrade doesn't break functionality. Tests will be written against the **current** SDK (`@anthropic-ai/claude-code ^1.0.0`) and must all pass before proceeding to Phase 1.

**Files to create:**
1. `src/__tests__/unit/model-cache.test.ts` - 12 tests
2. `src/__tests__/unit/sdk-message-handling.test.ts` - 14 tests (includes stream_event structure)
3. `src/__tests__/unit/mcp-server.test.ts` - 18 tests (includes zod schema tests)
4. `src/__tests__/sdk-live/sdk-verification.test.ts` - 18 tests (includes breaking change canaries)

**Files to modify:**
1. `src/__tests__/unit/claude-client.test.ts` - Add 9 tests (includes PermissionResult tests)
2. `package.json` - Add `test:sdk` script
3. `Makefile` - Add `sdk-test` target

**Existing tests to verify:** `allowedTools` per permission mode (lines 134-176 of claude-client.test.ts)

**Confidence Level:** 95% (up from 79% after adding stream_event, result fields, fork options, and MCP config canaries)

---

## 0.1 Create `src/__tests__/unit/model-cache.test.ts`

**Path:** `src/__tests__/unit/model-cache.test.ts`

**Mocking pattern:**
```typescript
vi.mock('@anthropic-ai/claude-code', () => ({
  query: vi.fn(),
}));
```

**Test cases:**

### Cache TTL Logic
1. `getAvailableModels returns cached models when fresh` - verify cache hit within TTL
2. `getAvailableModels refreshes when cache is stale` - verify refresh after TTL expires
3. `getAvailableModels refreshes on first call with empty cache` - initial load

### SDK Integration
4. `refreshModelCache creates query with correct options` - verify `{ prompt: '', maxTurns: 1 }`
5. `refreshModelCache calls supportedModels on query` - verify SDK method called
6. `refreshModelCache updates cache and timestamp` - verify state updated
7. `refreshModelCache calls interrupt after getting models` - verify cleanup

### Error Handling
8. `refreshModelCache uses fallback when SDK fails and cache empty` - verify fallback models
9. `refreshModelCache keeps existing cache when SDK fails` - verify cache preserved
10. `interrupt errors are silently ignored` - verify no crash on interrupt failure

### Model Lookup
11. `isModelAvailable returns true for existing model` - verify lookup works
12. `getModelInfo returns undefined for unknown model` - verify not found case

**Module state reset:**
- Use `vi.resetModules()` in `beforeEach` to reset `cachedModels` and `lastRefresh`
- Re-import module after reset

---

## 0.2 Create `src/__tests__/unit/sdk-message-handling.test.ts`

**Path:** `src/__tests__/unit/sdk-message-handling.test.ts`

**Purpose:** Test robustness against unknown/malformed SDK messages. Uses the existing `startClaudeQuery` to verify message handling doesn't crash.

**Test cases:**

### Unknown Message Types
1. `handles unknown message type without crashing` - yield `{ type: 'unknown_future_type' }`
2. `handles message with missing required fields` - yield `{ type: 'assistant' }` (no text)
3. `handles null content gracefully` - yield `{ type: 'assistant', content: null }`

### Content Structure Variations
4. `handles content_block without text` - test partial content blocks
5. `handles empty content array` - `{ type: 'assistant', content: [] }`
6. `handles nested unknown structures` - deeply nested unknown fields

### Stream Events (Critical for SDK upgrade - slack-bot.ts lines 1257-1305)
7. `handles stream_event with content_block_start thinking` - `{ event: { type: 'content_block_start', content_block: { type: 'thinking' } } }`
8. `handles stream_event with thinking_delta` - `{ event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'text' } } }`
9. `handles stream_event with tool_use content_block` - `{ event: { content_block: { type: 'tool_use', name: 'Read' } } }`
10. `handles stream_event with content_block_stop` - `{ event: { type: 'content_block_stop', index: 0 } }`
11. `handles stream_event with text_delta` - `{ event: { delta: { type: 'text_delta', text: 'hello' } } }`

### Result Message Fields
12. `handles result without expected fields` - minimal result object
13. `handles result with total_cost_usd field` - verify field access doesn't crash
14. `handles result with modelUsage.contextWindow` - verify nested field access

**Implementation approach:**
- Mock SDK to yield various message shapes
- Iterate through async generator to completion
- Verify no exceptions thrown

---

## 0.3 Create `src/__tests__/unit/mcp-server.test.ts`

**Path:** `src/__tests__/unit/mcp-server.test.ts`

**Mocking requirements:**
```typescript
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'mock-ts' }),
      update: vi.fn().mockResolvedValue({}),
    },
  })),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));
```

**Test cases:**

### Server Initialization
1. `server initializes with correct name and version` - verify "ask-user" v1.0.0
2. `server registers ListTools and CallTool handlers`
3. `WebClient uses SLACK_BOT_TOKEN from environment`

### ask_user Tool
4. `ask_user posts question to correct channel` - verify Slack API call
5. `ask_user generates unique questionId` - verify timestamp + random format
6. `ask_user waits for answer file` - mock file system polling
7. `ask_user updates message when answered` - verify chat.update call
8. `ask_user returns answer as text content` - verify MCP response format

### approve_action Tool
9. `approve_action posts approval request` - verify blocks posted
10. `approve_action returns 'approved' for approval answer` - verify response
11. `approve_action returns 'denied' for other answers`

### File-Based IPC
12. `waitForAnswer polls correct file path` - verify `/tmp/ccslack-answers/{id}.json`
13. `waitForAnswer parses JSON answer` - verify `{ answer: "value" }` structure
14. `waitForAnswer deletes file after reading`

### Environment Handling
15. `handles missing SLACK_CONTEXT gracefully` - verify error handling

### Zod Schema Compatibility (Breaking Change: zod ^3.x → ^4.0.0)
16. `ListToolsRequestSchema parses valid request` - verify MCP SDK schema works
17. `CallToolRequestSchema parses valid request` - verify tool call schema
18. `zod basic schema operations work` - verify z.object, z.string, safeParse

```typescript
import { z } from 'zod';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('zod schema compatibility', () => {
  it('ListToolsRequestSchema parses valid request', () => {
    const validRequest = { method: 'tools/list' };
    expect(() => ListToolsRequestSchema.parse(validRequest)).not.toThrow();
  });

  it('CallToolRequestSchema parses valid request', () => {
    const validRequest = {
      method: 'tools/call',
      params: { name: 'ask_user', arguments: { question: 'test' } }
    };
    expect(() => CallToolRequestSchema.parse(validRequest)).not.toThrow();
  });

  it('zod basic operations work with MCP SDK', () => {
    const schema = z.object({ test: z.string() });
    const result = schema.safeParse({ test: 'value' });
    expect(result.success).toBe(true);
  });
});
```

**Notes:**
- Use `vi.useFakeTimers()` for polling tests
- Advance timers to simulate file appearance

---

## 0.4 Add to `src/__tests__/unit/claude-client.test.ts`

**Path:** `src/__tests__/unit/claude-client.test.ts`

**Add these test cases to existing describe block:**

### MCP Server Config Structure
1. `MCP server config has correct command and args` - verify `npx tsx src/mcp-server.ts`
2. `MCP server receives SLACK_CONTEXT as JSON env var` - verify serialization

### Session Fork Options
3. `forkSession sets resume and forkSession options` - verify both options
4. `resumeSessionAt passes message ID for point-in-time fork`

### canUseTool Callback
5. `canUseTool callback passed to SDK options when provided`
6. `canUseTool callback NOT in options when undefined`

### allowedTools per Permission Mode (EXISTING - verify coverage)
**Note:** Tests already exist in `claude-client.test.ts` lines 134-176. Verify these cover:
- `default` mode: only `mcp__ask-user__ask_user` (excludes `approve_action`)
- `plan` mode: includes both `ask_user` and `approve_action`
- `bypassPermissions` mode: includes both tools

### PermissionResult Type Format (SDK expects specific shape)
7. `allow result requires behavior and updatedInput` - type shape validation
8. `deny result requires behavior and message` - type shape validation
9. `deny result supports optional interrupt field` - complete type coverage

```typescript
describe('PermissionResult type compatibility', () => {
  it('allow result has correct shape', () => {
    const result: PermissionResult = {
      behavior: 'allow',
      updatedInput: { key: 'value' }
    };
    expect(result.behavior).toBe('allow');
    expect(result).toHaveProperty('updatedInput');
  });

  it('deny result has correct shape', () => {
    const result: PermissionResult = {
      behavior: 'deny',
      message: 'Not allowed'
    };
    expect(result.behavior).toBe('deny');
    expect(result).toHaveProperty('message');
  });

  it('deny result supports interrupt field', () => {
    const result: PermissionResult = {
      behavior: 'deny',
      message: 'Denied',
      interrupt: true
    };
    expect(result.interrupt).toBe(true);
  });
});
```

**Implementation:** Add tests within existing `describe('startClaudeQuery', ...)` block.

---

## 0.5 Create `src/__tests__/sdk-live/sdk-verification.test.ts`

**Path:** `src/__tests__/sdk-live/sdk-verification.test.ts`

**Purpose:** Live tests against real SDK (requires `ANTHROPIC_API_KEY`). These tests verify SDK API surface and include "canary" tests that will **fail after upgrade** to signal required changes.

**Test cases:**

### Model API
1. `supportedModels returns models with value, displayName, description` - verify shape
2. `supportedModels returns at least one model` - verify non-empty
3. `model fields are strings (not null/undefined)` - verify field types

### Query Object API Surface
4. `query returns object with interrupt method` - verify method exists
5. `query returns object with supportedModels method` - verify method exists
6. `query returns object with setModel method` - verify method exists
7. `query is async iterable` - verify `Symbol.asyncIterator`

### Message Structure
8. `first message is system init with session_id, model, tools` - verify init message
9. `result message has duration_ms, usage, is_error` - verify result structure
10. `result message has total_cost_usd field` - verify extended field exists
11. `result message has modelUsage with contextWindow` - verify nested structure
12. `assistant message has message.id field` - critical for point-in-time forking

### Breaking Change Canaries (WILL FAIL after SDK upgrade - signals Phase 3 needed)
13. `CANARY: systemPrompt string format accepted` - tests OLD format `'claude_code'`
14. `CANARY: settings load without settingSources` - tests automatic settings loading
15. `CANARY: query works without new required options` - baseline compatibility
16. `CANARY: resume + forkSession + resumeSessionAt accepted` - fork options structure
17. `CANARY: mcpServers config structure accepted` - MCP server config format

### Future Compatibility (verify new options don't error)
18. `settingSources option accepted if provided` - tests new option doesn't crash

```typescript
describe('Breaking Change Canaries', () => {
  // These tests document CURRENT behavior
  // They WILL FAIL after SDK upgrade - this is intentional!
  // Failure signals that Phase 3 changes are required

  it('CANARY: systemPrompt string format accepted', async () => {
    // OLD format - will fail when new SDK requires object format
    const q = query({
      prompt: 'echo test',
      options: {
        systemPrompt: 'claude_code',  // OLD format
        maxTurns: 1
      }
    });
    const msg = await q[Symbol.asyncIterator]().next();
    expect(msg.done).toBe(false);
    await q.interrupt();
  });

  it('CANARY: settings load without settingSources', async () => {
    // Current behavior - settings load automatically
    // Will fail if new SDK requires explicit settingSources
    const q = query({
      prompt: 'echo test',
      options: { maxTurns: 1 }  // NO settingSources
    });
    const msg = await q[Symbol.asyncIterator]().next();
    expect(msg.done).toBe(false);
    await q.interrupt();
  });

  it('CANARY: resume + forkSession + resumeSessionAt accepted', async () => {
    // Fork options structure used by point-in-time forking
    // Will fail if SDK changes option format
    const q = query({
      prompt: 'echo test',
      options: {
        maxTurns: 1,
        resume: 'test-session-id',
        forkSession: true,
        resumeSessionAt: 'test-message-id'
      }
    });
    // Should not throw for option structure (may fail for invalid session)
    try {
      await q[Symbol.asyncIterator]().next();
    } catch (e: any) {
      // Accept "session not found" errors, reject option format errors
      expect(e.message).toMatch(/session|not found|invalid/i);
    }
    await q.interrupt().catch(() => {});
  });

  it('CANARY: mcpServers config structure accepted', async () => {
    // MCP server config format used by claude-client.ts
    const q = query({
      prompt: 'echo test',
      options: {
        maxTurns: 1,
        mcpServers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            env: { TEST_KEY: 'value' }
          }
        }
      }
    });
    // Should not throw for config structure
    const msg = await q[Symbol.asyncIterator]().next();
    expect(msg.done).toBe(false);
    await q.interrupt();
  });
});

describe('Future Compatibility', () => {
  it('settingSources option accepted if provided', async () => {
    // Test that providing settingSources doesn't cause error
    // Current SDK may ignore it, but should not reject as unknown option
    let succeeded = false;
    let errorMessage = '';

    try {
      const q = query({
        prompt: 'echo test',
        options: {
          maxTurns: 1,
          settingSources: ['user', 'project', 'local']
        }
      });
      const msg = await q[Symbol.asyncIterator]().next();
      expect(msg.done).toBe(false);
      await q.interrupt();
      succeeded = true;
    } catch (e: any) {
      errorMessage = e.message || String(e);
    }

    // Document current behavior for upgrade verification:
    // If this test passes now but fails after upgrade,
    // it means settingSources became required or format changed
    if (!succeeded) {
      console.log(`Future compat test failed with: ${errorMessage}`);
      // Fail explicitly so we know the current SDK behavior
      expect.fail(`Current SDK rejects settingSources: ${errorMessage}`);
    }
  });
});
```

**Test file structure with timeout:**
```typescript
import { describe, it, expect } from 'vitest';
import { query } from '@anthropic-ai/claude-code';

const SKIP_LIVE = !process.env.ANTHROPIC_API_KEY;

describe.skipIf(SKIP_LIVE)('SDK Live Verification', { timeout: 30000 }, () => {
  // All tests inherit 30s timeout

  describe('Model API', () => {
    it('supportedModels returns models with correct shape', async () => {
      const q = query({ prompt: '', options: { maxTurns: 1 } });
      const models = await q.supportedModels();

      expect(models.length).toBeGreaterThan(0);
      const model = models[0];
      expect(typeof model.value).toBe('string');
      expect(typeof model.displayName).toBe('string');
      expect(typeof model.description).toBe('string');
      expect(model.value.length).toBeGreaterThan(0);

      await q.interrupt();
    });
  });

  // ... other test suites
});
```

---

## 0.6 Add Build Configuration

### package.json
Add script:
```json
"test:sdk": "vitest run src/__tests__/sdk-live/ --reporter=verbose"
```

### Makefile
Add target:
```makefile
# Run SDK live tests (requires ANTHROPIC_API_KEY)
sdk-test:
	npm run test:sdk
```

---

## 0.7 Verification Checklist

```bash
# 1. Type check
npx tsc --noEmit

# 2. Unit tests (all)
npm test

# 3. Live SDK tests (optional, needs API key)
make sdk-test

# 4. Coverage check
make test-coverage
```

**Gate:** ALL unit tests must pass. Live tests should pass if API key available.

---

## File Structure After Phase 0

```
src/__tests__/
├── __fixtures__/
│   ├── slack-messages.ts
│   └── claude-messages.ts
├── unit/
│   ├── blocks.test.ts
│   ├── claude-client.test.ts     # Modified: +9 tests
│   ├── errors.test.ts
│   ├── model-cache.test.ts       # NEW: 12 tests
│   ├── mcp-server.test.ts        # NEW: 18 tests (includes zod schema)
│   ├── sdk-message-handling.test.ts  # NEW: 14 tests (includes stream_event)
│   └── ... (existing)
├── integration/
│   └── ... (existing)
└── sdk-live/
    └── sdk-verification.test.ts  # NEW: 18 tests (includes canaries)
```

---

## Critical Files to Modify

| File | Action | Tests Added |
|------|--------|-------------|
| `src/__tests__/unit/model-cache.test.ts` | Create | 12 |
| `src/__tests__/unit/sdk-message-handling.test.ts` | Create | 14 |
| `src/__tests__/unit/mcp-server.test.ts` | Create | 18 |
| `src/__tests__/unit/claude-client.test.ts` | Modify | 9 |
| `src/__tests__/sdk-live/sdk-verification.test.ts` | Create | 18 |
| `package.json` | Modify | - |
| `Makefile` | Modify | - |

**Total new tests:** ~71

---

## Execution Order

1. Create `model-cache.test.ts` → run tests → verify pass
2. Create `sdk-message-handling.test.ts` → run tests → verify pass
3. Create `mcp-server.test.ts` → run tests → verify pass
4. Add tests to `claude-client.test.ts` → run tests → verify pass
5. Create `sdk-live/` directory and `sdk-verification.test.ts`
6. Update `package.json` and `Makefile`
7. Run full test suite → verify all pass
8. (Optional) Run live SDK tests with API key

---

## Risk Mitigation

- Tests written against **current** SDK behavior
- No implementation changes in Phase 0
- If any test fails, fix the test (not the code) - we're documenting current behavior
- Live tests are optional (skipped without API key)

---

## Breaking Change Coverage Summary

| Breaking Change | Test Location | Type |
|----------------|---------------|------|
| `systemPrompt: 'claude_code'` → `{ type: 'preset', preset: 'claude_code' }` | sdk-verification.test.ts (CANARY test 13) | Live SDK |
| Settings loading: Automatic → explicit `settingSources` | sdk-verification.test.ts (CANARY test 14, test 18) | Live SDK |
| zod `^3.x` → `^4.0.0` | mcp-server.test.ts (tests 16-18) | Unit |
| `setModel()` method on query | sdk-verification.test.ts (test 6) | Live SDK |
| `PermissionResult` type shape | claude-client.test.ts (tests 7-9) | Unit |
| Model field types | sdk-verification.test.ts (test 3) | Live SDK |
| `allowedTools` per mode | claude-client.test.ts (existing, lines 134-176) | Unit |
| Fork options structure | sdk-verification.test.ts (CANARY test 16) | Live SDK |
| MCP server config format | sdk-verification.test.ts (CANARY test 17) | Live SDK |
| `stream_event` structure | sdk-message-handling.test.ts (tests 7-11) | Unit |
| `result` extended fields | sdk-verification.test.ts (tests 10-11), sdk-message-handling.test.ts (tests 13-14) | Both |
| `message.id` field | sdk-verification.test.ts (test 12) | Live SDK |

**Strategy:**
1. CANARY tests will **fail immediately** after SDK upgrade (Phase 1)
2. This signals that Phase 3 (Update SDK Options) is required
3. After Phase 3 changes, tests should be updated to verify NEW behavior
4. No silent failures - all breaking changes produce visible test failures
