# SDK Upgrade: Phases 2-6 Implementation

**Goal:** Complete upgrade from `@anthropic-ai/claude-code` to `@anthropic-ai/claude-agent-sdk`

**Current State:** Phase 1 complete (dependencies updated, build broken - expected)

**Verification:** ✅ Plan verified against meta plan - no gaps, fully atomic

---

## Phase 2: Update Imports

Update all import paths from `@anthropic-ai/claude-code` to `@anthropic-ai/claude-agent-sdk`.

### Source Files (2 files)

| File | Line | Change |
|------|------|--------|
| `src/claude-client.ts` | 1 | `import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';` |
| `src/model-cache.ts` | 6 | `import { query } from '@anthropic-ai/claude-agent-sdk';` |

### Test Files (4 files)

| File | Lines | Changes |
|------|-------|---------|
| `src/__tests__/unit/claude-client.test.ts` | 4, 13 | Mock + import |
| `src/__tests__/unit/model-cache.test.ts` | 4, 8 | Mock + import |
| `src/__tests__/unit/sdk-message-handling.test.ts` | 11, 15 | Mock + import |
| `src/__tests__/sdk-live/sdk-verification.test.ts` | 2 | Import only |

### Verification
```bash
npx tsc --noEmit    # Should PASS (imports resolved)
npm test            # May fail (SDK options format - expected)
```

---

## Phase 3: Update SDK Options

Apply breaking changes to SDK query options.

### File: `src/claude-client.ts` (lines ~52-59)

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

### Verification
```bash
npx tsc --noEmit    # Should PASS
npm test            # Some tests fail (assertions need update - expected)
```

---

## Phase 4: Update Test Assertions

Update test expectations to match new SDK options format.

### File: `src/__tests__/unit/claude-client.test.ts`

Find test `'should set systemPrompt to claude_code'` and update:

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

### Verification
```bash
npm test            # ALL tests should PASS
```

---

## Phase 5: Update Documentation

Update references in docs and comments.

| File | Line | Change |
|------|------|--------|
| `CLAUDE.md` | ~92 | `@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk` |
| `src/session-manager.ts` | 6 | Comment: `@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk` |

---

## Phase 6: Final Verification

### Run all checks
```bash
npx tsc --noEmit        # Type check
npm test                # All unit tests
npm run test:sdk        # Live SDK tests (needs API key)
make build              # Build passes
```

### Manual smoke test (optional)
```bash
make dev
```
- Send message → verify response
- `/model` → verify model list
- `/mode ask` → verify tool approval

---

## Summary: 8 Files to Modify

1. `src/claude-client.ts` - import + SDK options
2. `src/model-cache.ts` - import
3. `src/__tests__/unit/claude-client.test.ts` - mock, import, assertion
4. `src/__tests__/unit/model-cache.test.ts` - mock, import
5. `src/__tests__/unit/sdk-message-handling.test.ts` - mock, import
6. `src/__tests__/sdk-live/sdk-verification.test.ts` - import
7. `CLAUDE.md` - doc reference
8. `src/session-manager.ts` - comment
