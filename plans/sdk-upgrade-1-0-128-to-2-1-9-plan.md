# SDK Upgrade Plan: @anthropic-ai/claude-code → @anthropic-ai/claude-agent-sdk

## Overview

Phased upgrade with incremental testing at each step.

**Current:** `@anthropic-ai/claude-code: ^1.0.0`, zod `^3.24.0`, 560 tests
**Target:** `@anthropic-ai/claude-agent-sdk` (latest), zod `^4.0.0`, all tests pass

**Confidence Level:** 98%+

---

## Breaking Changes

| Change | Old | New |
|--------|-----|-----|
| Package name | `@anthropic-ai/claude-code` | `@anthropic-ai/claude-agent-sdk` |
| systemPrompt | `'claude_code'` | `{ type: 'preset', preset: 'claude_code' }` |
| Settings loading | Automatic | `settingSources: ['user', 'project', 'local']` |
| zod | `^3.x` | `^4.0.0` |

---

# Phase 0: Add Tests (NO implementation changes)

**Goal:** Establish test baseline on OLD SDK. All tests must pass before proceeding.

## 0.1 Create `src/__tests__/unit/model-cache.test.ts`

Tests for model caching:
- `getAvailableModels()` caching behavior
- `refreshModelCache()` SDK interaction
- `isModelAvailable()` and `getModelInfo()`
- Fallback models when SDK fails
- `interrupt()` called after getting models

## 0.2 Create `src/__tests__/unit/sdk-message-handling.test.ts`

Tests for message robustness:
- Unknown message types don't crash
- Messages with missing fields handled gracefully
- Content structure changes handled
- stream_event handling

## 0.3 Create `src/__tests__/unit/mcp-server.test.ts`

Tests for MCP server:
- Server initialization without crash
- Schema validation (ListToolsRequest, CallToolRequest)
- File-based IPC mechanism
- zod schema compatibility

## 0.4 Add to `src/__tests__/unit/claude-client.test.ts`

Additional tests:
- MCP server config structure
- MCP env vars passed correctly
- allowedTools per permission mode
- `canUseTool` callback handling
- `PermissionResult` type format

## 0.5 Create `src/__tests__/sdk-live/sdk-verification.test.ts`

Live SDK tests (requires `ANTHROPIC_API_KEY`):
- `supportedModels()` returns `value`, `displayName`, `description`
- Query has `interrupt()`, `supportedModels()`, `setModel()` methods
- Query is async iterable
- System init has `session_id`, `model`, `tools`
- Result has `duration_ms`, `usage`, `is_error`

## 0.6 Add build configuration

**package.json:**
```json
"test:sdk": "vitest run src/__tests__/sdk-live/ --reporter=verbose"
```

**Makefile:**
```makefile
sdk-test:
	npm run test:sdk
```

## 0.7 Verify Phase 0

```bash
npm test                    # All unit tests pass
make sdk-test               # All live tests pass (needs API key)
```

**Gate:** ALL tests must pass before Phase 1.

---

# Phase 1: Update Dependencies

**Goal:** Change package references, reinstall dependencies.

## 1.1 Update package.json

```diff
- "@anthropic-ai/claude-code": "^1.0.0",
+ "@anthropic-ai/claude-agent-sdk": "latest",
  ...
- "zod": "^3.24.0"
+ "zod": "^4.0.0"
```

## 1.2 Reinstall

```bash
rm -rf node_modules package-lock.json
npm install
```

## 1.3 Verify Phase 1

```bash
npx tsc --noEmit            # WILL FAIL (import paths wrong) - expected
npm test                    # WILL FAIL (import paths wrong) - expected
```

**Expected:** TypeScript errors about missing module `@anthropic-ai/claude-code`.

---

# Phase 2: Update Imports

**Goal:** Fix all import paths. No behavior changes yet.

## 2.1 Update `src/claude-client.ts` (line 1)

```diff
- import { query, type SDKMessage } from '@anthropic-ai/claude-code';
+ import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
```

## 2.2 Update `src/model-cache.ts` (line 6)

```diff
- import { query } from '@anthropic-ai/claude-code';
+ import { query } from '@anthropic-ai/claude-agent-sdk';
```

## 2.3 Update test mocks

**`src/__tests__/unit/claude-client.test.ts`:**
```diff
- vi.mock('@anthropic-ai/claude-code', ...
+ vi.mock('@anthropic-ai/claude-agent-sdk', ...

- import { query } from '@anthropic-ai/claude-code';
+ import { query } from '@anthropic-ai/claude-agent-sdk';
```

**`src/__tests__/unit/model-cache.test.ts`:**
```diff
- vi.mock('@anthropic-ai/claude-code', ...
+ vi.mock('@anthropic-ai/claude-agent-sdk', ...
```

## 2.4 Verify Phase 2

```bash
npx tsc --noEmit            # Should pass (imports resolved)
npm test                    # May have failures (SDK options changed)
```

**Expected:** TypeScript passes. Some tests may fail due to systemPrompt format.

---

# Phase 3: Update SDK Options

**Goal:** Apply breaking changes to SDK options.

## 3.1 Update `src/claude-client.ts` (lines 52-59)

```diff
  const queryOptions: Record<string, unknown> = {
    outputFormat: 'stream-json',
    permissionMode,
-   systemPrompt: 'claude_code',
+   systemPrompt: { type: 'preset', preset: 'claude_code' },
+   settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
  };
```

## 3.2 Verify Phase 3

```bash
npx tsc --noEmit            # Should pass
npm test                    # Some tests fail (assertions need update)
```

**Expected:** TypeScript passes. Tests checking `systemPrompt: 'claude_code'` will fail.

---

# Phase 4: Update Test Assertions

**Goal:** Update tests to match new SDK options format.

## 4.1 Update `src/__tests__/unit/claude-client.test.ts`

```diff
- it('should set systemPrompt to claude_code', () => {
+ it('should set systemPrompt to claude_code preset', () => {
    startClaudeQuery('test prompt', {});
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
-         systemPrompt: 'claude_code',
+         systemPrompt: { type: 'preset', preset: 'claude_code' },
+         settingSources: ['user', 'project', 'local'],
        }),
      })
    );
  });
```

## 4.2 Verify Phase 4

```bash
npm test                    # ALL tests should pass
make sdk-test               # Live tests should pass
```

**Gate:** ALL tests must pass before Phase 5.

---

# Phase 5: Update Documentation

**Goal:** Update references in docs and comments.

## 5.1 Update `CLAUDE.md` (line 92)

```diff
- - Use `query()` from `@anthropic-ai/claude-code`
+ - Use `query()` from `@anthropic-ai/claude-agent-sdk`
```

## 5.2 Update `src/session-manager.ts` (line 6)

```diff
- * SDK Permission Mode type - matches @anthropic-ai/claude-code SDK.
+ * SDK Permission Mode type - matches @anthropic-ai/claude-agent-sdk SDK.
```

## 5.3 Verify Phase 5

```bash
npm test                    # All pass (no code changes)
```

---

# Phase 6: Final Verification

**Goal:** Complete verification of entire upgrade.

## 6.1 Run all checks

```bash
# Type checking
npx tsc --noEmit

# Unit tests (mocked)
npm test

# Live SDK tests (real API)
make sdk-test

# Build
make build
```

## 6.2 Manual smoke test (recommended)

```bash
make dev
```

Test in Slack:
1. Send message → verify response
2. `/model` → verify model list
3. `/mode ask` → verify tool approval
4. Reply in thread → verify forking

## 6.3 Commit

```bash
git add -A
git commit -m "Upgrade SDK from @anthropic-ai/claude-code to @anthropic-ai/claude-agent-sdk

Phase 0: Added comprehensive test coverage
Phase 1-2: Updated dependencies and imports
Phase 3-4: Applied breaking changes (systemPrompt, settingSources)
Phase 5: Updated documentation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Rollback Strategy

At any phase, if issues discovered:

```bash
git checkout HEAD -- .
rm -rf node_modules package-lock.json && npm install
```

---

## Risk Summary

| Risk Level | Before | After All Phases |
|------------|--------|------------------|
| HIGH | 4 | 0 |
| MEDIUM | 2 | 0 |
| LOW | 2 | ~0.5 |

### Accepted Risks (Untestable)
| Risk | Impact if Fails |
|------|-----------------|
| MCP subprocess spawning | Bot continues, no MCP tools |
| SDK internal timeouts | UX degradation, user retries |

---

## Sources

- [npm package](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- [GitHub CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Migration Guide](https://platform.claude.com/docs/en/agent-sdk/migration-guide)
