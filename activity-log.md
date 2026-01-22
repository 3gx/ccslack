# Consolidate Status Message: Remove Beginning/Completed Headers

## Objective

Remove "Beginning" and "Completed" headers. Consolidate all info into a single message format that saves vertical space.

---

## BEFORE (Current)

### In-Progress Message
```
┌─────────────────────────────────────────────────────┐
│ *Beginning*                          ← REMOVE THIS  │
│ _plan | claude-opus-4_                              │
│                                                     │
│ :brain: *Thinking...* (2.1s) 450 chars             │
│ :mag: *Read* [in progress]                         │
│                                                     │
│ ⠋ [12s]                              ← KEEP THIS!  │
│ [View Log] [Abort]                                  │
└─────────────────────────────────────────────────────┘
```

### Completed Message
```
┌─────────────────────────────────────────────────────┐
│ *Beginning*                          ← REMOVE THIS  │
│ _plan | claude-opus-4_                              │
│                                                     │
│ :brain: *Thinking...* (2.1s)                       │
│ :white_check_mark: *Read* (0.8s)                   │
│                                                     │
│ *Complete*                           ← REMOVE THIS  │
│ _plan | opus | 1.2k/850 | 45% ctx | $0.12 | 15s_   │
└─────────────────────────────────────────────────────┘
```

---

## AFTER (New)

**ALL OF THIS IS ONE SINGLE MESSAGE** that updates in-place during processing.

### In-Progress - Initial (SINGLE MESSAGE)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ _plan | n/a | n/a_                                                       │ ← TOP: simple (no ctx%)
│                                                                          │
│ :brain: *Analyzing request...*                                          │ ← ACTIVITY LOG
│                                                                          │
│ [View Log] [Abort]                                                       │ ← BUTTONS
│ ⠋ [1.0s]                                                                 │ ← SPINNER (separate block below)
└──────────────────────────────────────────────────────────────────────────┘
```

### In-Progress - After SDK Reports (SINGLE MESSAGE)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ _plan | claude-sonnet-4 | [new] abc123_                                  │ ← TOP: mode | model | session-id
│                                                                          │
│ :brain: *Thinking...* (2.1s) 450 chars                                  │ ← ACTIVITY LOG
│ :mag: *Read* [in progress]                                              │   (all entries
│ :white_check_mark: *Edit* (0.5s)                                        │    in ONE block)
│ :pencil: *Generating...* 120 chars                                      │
│                                                                          │
│ [View Log] [Abort]                                                       │ ← BUTTONS (no BOTTOM stats yet)
│ ⠋ [12.3s]                                                                │ ← SPINNER (separate block below)
└──────────────────────────────────────────────────────────────────────────┘
                        ↑ THIS IS ONE SLACK MESSAGE ↑
```

### In-Progress - With Rate Limit Hit (SINGLE MESSAGE)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ _plan | claude-sonnet-4 | [new] abc123_                                  │ ← TOP: mode | model | session-id
│                                                                          │
│ :brain: *Thinking...* (2.1s) 450 chars                                  │ ← ACTIVITY LOG
│ :mag: *Read* [in progress]                                              │
│                                                                          │
│ _:warning: 2 rate limits hit_                                            │ ← RATE LIMIT WARNING (shown immediately!)
│ [View Log] [Abort]                                                       │ ← BUTTONS
│ ⠋ [12.3s]                                                                │ ← SPINNER
└──────────────────────────────────────────────────────────────────────────┘
```

### Completed Segment - Non-Final (SINGLE MESSAGE)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ _plan | claude-sonnet-4 | abc123_                                        │ ← TOP: mode | model | session-id
│                                                                          │
│ :brain: *Thinking...* (2.1s)                                            │ ← ACTIVITY LOG
│ :white_check_mark: *Read* (0.8s)                                        │   (all entries
│ :white_check_mark: *Edit* (0.5s)                                        │    in ONE block)
│ :pencil: *Generated* (1.2s) 850 chars                                   │
│                                                                          │
│ _plan | claude-sonnet-4 | abc123 | 55% ctx (22% to ⚡) | 1.2k/850 | $0.12 | 15s_ │ ← BOTTOM: mode|model|session + stats
│ [View Log]                                                               │ ← NO ABORT, NO SPINNER
└──────────────────────────────────────────────────────────────────────────┘
                        ↑ THIS IS ONE SLACK MESSAGE ↑
```

### Completed Segment - FINAL (SINGLE MESSAGE)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ _plan | claude-sonnet-4 | abc123_                                        │ ← TOP: mode | model | session-id
│                                                                          │
│ :brain: *Thinking...* (2.1s)                                            │ ← ACTIVITY LOG
│ :white_check_mark: *Read* (0.8s)                                        │   (all entries
│ :white_check_mark: *Edit* (1.2s)                                        │    in ONE block)
│                                                                          │
│ _plan | claude-sonnet-4 | abc123 | 55% ctx (22% to ⚡) | 1.2k/850 | $0.12 | 15s_ │ ← BOTTOM: mode|model|session + stats
│ [View Log] [Fork here]                                                   │ ← FORK BUTTON, NO SPINNER
└──────────────────────────────────────────────────────────────────────────┘
                        ↑ THIS IS ONE SLACK MESSAGE ↑
```

### Completed Segment - With Rate Limits (SINGLE MESSAGE)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ _plan | claude-sonnet-4 | abc123_                                        │ ← TOP: mode | model | session-id
│                                                                          │
│ :brain: *Thinking...* (2.1s)                                            │ ← ACTIVITY LOG
│ :white_check_mark: *Read* (0.8s)                                        │
│                                                                          │
│ _plan | claude-sonnet-4 | abc123 | 55% ctx (22% to ⚡) | 1.2k/850 | $0.12 | 15s | :warning: 2 limits_ │ ← BOTTOM + rate limits
│ [View Log] [Fork here]                                                   │ ← NO SPINNER
└──────────────────────────────────────────────────────────────────────────┘
```

### Aborted - With Data Available (SINGLE MESSAGE)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ _plan | claude-sonnet-4 | abc123_                                        │ ← TOP: mode | model | session-id
│                                                                          │
│ :brain: *Thinking...* (2.1s)                                            │ ← ACTIVITY LOG
│ :x: *Aborted by user*                                                   │
│                                                                          │
│ _plan | claude-sonnet-4 | abc123 | 45% ctx (30% to ⚡) | 800/200 | $0.05 | 8s_ │ ← BOTTOM: mode|model|session + stats
│ [View Log]                                                               │ ← NO FORK (aborted), NO SPINNER
└──────────────────────────────────────────────────────────────────────────┘
```

### Aborted - Early (No Stats Yet) (SINGLE MESSAGE)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ _plan | claude-sonnet-4 | abc123_                                        │ ← TOP: mode | model | session-id
│                                                                          │
│ :brain: *Analyzing request...*                                          │ ← ACTIVITY LOG
│ :x: *Aborted by user*                                                   │
│                                                                          │
│ _plan | claude-sonnet-4 | abc123_                                        │ ← BOTTOM: just mode|model|session (no stats)
│ [View Log]                                                               │ ← NO SPINNER
└──────────────────────────────────────────────────────────────────────────┘
```

**Key points:**
- **TOP line**: Simple format `mode | model | [new] session-id` - NO context %
- **BOTTOM line**: ONLY at completion (not during in-progress)
- **Context %**: Only in BOTTOM line at completion
- **Session ID**: Only in TOP line
- **Spinner**: BELOW buttons in separate context block `⠋ [x.ys]`
- **Cost**: Only in BOTTOM line at completion
- **Rate limits**:
  - Shown IMMEDIATELY above buttons when hit during in-progress: `_:warning: 2 rate limits hit_`
  - ALSO reported in BOTTOM stats line at completion as suffix

**CRITICAL - Same behavior for BOTH thread AND main channel:**
- Fork button appears on final segment for BOTH threads AND main channel
- All status formats identical regardless of thread vs channel
- No special cases - unified UI

**Abort behavior:**
- View Log button ALWAYS stays after abort
- BOTTOM stats line shown ONLY if SDK reported data (contextPercent, tokens, etc.)
- If no data available (early abort), skip BOTTOM line entirely

---

## Status Line Format

### TOP line (simple - updates when SDK reports)
```
_{mode} | {model} | [new] {sessionId}_
```
- Initially shows `n/a` for model and sessionId until SDK reports
- Updates when init message arrives with model and sessionId
- `[new]` prefix only if session was just created (no prior sessionId)
- Model uses full name as-is (e.g., "claude-sonnet-4") - same as current code
- **NO context % in TOP line** - simplified!

### BOTTOM line (ONLY at segment completion)
```
_{mode} | {model} | {sessionId} | {ctx}% ctx ({compact}% to ⚡) | {tokensIn}/{tokensOut} | ${cost} | {duration}s_
```
- **NOT present during in-progress** - only appears at completion
- Mode, model, session-id: SAME as TOP line (repeated for completeness)
- Context % at END of segment
- Tokens: final input/output counts
- Cost: total cost
- Duration: total time
- Optional suffix: `| :warning: {rateLimitHits} limits` if rate limits hit

### Rate limit warning (shown immediately when hit)
```
_:warning: {rateLimitHits} rate limits hit_
```
- Shown ABOVE buttons during in-progress when `rateLimitHits > 0`
- Also reported in BOTTOM stats line at completion

### Button row + Spinner
```
_:warning: 2 rate limits hit_    ← RATE LIMIT (if any, above buttons)
[View Log] [Abort]               ← IN-PROGRESS: buttons
⠋ [x.ys]                         ← SPINNER below buttons (separate block)

[View Log]                       ← COMPLETED non-final: no abort, no spinner
[View Log] [Fork here]           ← COMPLETED final: fork button, no spinner
```

---

## Implementation

### File: `src/blocks.ts`

#### 1. Modify `buildCombinedStatusBlocks()`

**Remove:**
- Block 1: "Beginning" section
- Block 4: "Complete"/"Aborted"/"Error" headers

**Keep:**
- Spinner + elapsed time footer (critical for showing bot is alive)

**New structure:**
```typescript
// Block 1: TOP status line (context) - simple: mode | model | session-id
{
  type: 'context',
  elements: [{
    type: 'mrkdwn',
    text: buildTopStatusLine(mode, model, sessionId, isNewSession)
    // Returns: "_plan | claude-sonnet-4 | [new] abc123_"
    // Or initially: "_plan | n/a | n/a_"
  }]
}

// Block 2: Activity log (section) - ALWAYS
{
  type: 'section',
  text: { type: 'mrkdwn', text: activityLogText }
}

// Block 3: BOTTOM stats line (context) - ONLY AT COMPLETION/ABORT
// NOT present during in-progress!
// Always shows mode|model|session, stats appended only if available
...(!inProgress ? [{
  type: 'context',
  elements: [{
    type: 'mrkdwn',
    text: buildBottomStatsLine(mode, model, sessionId, contextPercent, compactPercent, inputTokens, outputTokens, cost, durationMs, rateLimitHits)
    // With stats: "_plan | claude-sonnet-4 | abc123 | 55% ctx (22% to ⚡) | 1.2k/850 | $0.12 | 15s_"
    // No stats (early abort): "_plan | claude-sonnet-4 | abc123_"
    // With rate limits: "_plan | claude-sonnet-4 | abc123 | 55% ctx (22% to ⚡) | 1.2k/850 | $0.12 | 15s | :warning: 2 limits_"
  }]
}])

// Block 4: Rate limit warning (context) - ABOVE buttons when rate limits hit
// Shows immediately during in-progress, AND in BOTTOM stats at completion
...(rateLimitHits > 0 && inProgress ? [{
  type: 'context',
  elements: [{ type: 'mrkdwn', text: `_:warning: ${rateLimitHits} rate limits hit_` }]
}] : [])

// Block 5: Actions (actions) - ALWAYS
{
  type: 'actions',
  elements: [
    viewLogButton,
    ...(inProgress ? [abortButton] : []),
    // Fork button on final segment for BOTH thread AND main channel
    ...(!inProgress && isFinalSegment && forkInfo ? [forkButton] : []),
  ]
}

// Block 6: Spinner (context) - ONLY during in-progress, BELOW buttons
...(inProgress ? [{
  type: 'context',
  elements: [{ type: 'mrkdwn', text: `${spinner} [${elapsedSec}s]` }]
}] : [])
```

#### 2. Add helper functions

```typescript
// TOP line - simple: mode | model | session-id
function buildTopStatusLine(
  mode: string,
  model?: string,
  sessionId?: string,
  isNewSession?: boolean
): string
// Returns: "_plan | claude-sonnet-4 | [new] abc123_"
// Or: "_plan | n/a | n/a_" if values not yet available

// BOTTOM line - only at completion/abort (mode|model|session always, stats if available)
function buildBottomStatsLine(
  mode: string,
  model?: string,
  sessionId?: string,
  contextPercent?: number,
  compactPercent?: number,
  inputTokens?: number,
  outputTokens?: number,
  cost?: number,
  durationMs?: number,
  rateLimitHits?: number
): string
// With stats: "_plan | claude-sonnet-4 | abc123 | 55% ctx (22% to ⚡) | 1.2k/850 | $0.12 | 15s_"
// No stats (early abort): "_plan | claude-sonnet-4 | abc123_"
// With rate limits: "_plan | claude-sonnet-4 | abc123 | 55% ctx (22% to ⚡) | 1.2k/850 | $0.12 | 15s | :warning: 2 limits_"
```

#### 3. Update interface `CombinedStatusBlocksOptions`

Add new fields:
- `sessionId?: string` - current session ID (n/a initially)
- `isNewSession?: boolean` - show [new] prefix in TOP line
- `isFinalSegment?: boolean` - show Fork button
- `forkInfo?: { threadTs?: string; conversationKey: string }` - for Fork button
- `cost?: number` - only on completion (for BOTTOM line)

Keep existing:
- `spinner?: string` (for spinner block below buttons)
- `elapsedMs?: number` (for spinner display)
- `contextPercent?: number` - for BOTTOM line at completion
- `compactPercent?: number` - for BOTTOM line at completion
- `rateLimitHits?: number` - for warning above buttons AND in BOTTOM line

### File: `src/slack-bot.ts`

#### Update all callers of `buildCombinedStatusBlocks()`

Pass new fields:
- `sessionId` from `newSessionId` variable
- `isNewSession` from session state comparison
- `isFinalSegment` for completion blocks
- `forkInfo` for Fork button

Locations to update:
- Initial status post (~line 2230)
- Periodic update timer
- `moveStatusToBottom()` helper
- Completion update (~line 3128)

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/blocks.ts` | Rewrite `buildCombinedStatusBlocks()`, add helper functions |
| `src/slack-bot.ts` | Update all callers with new parameters |

---

## Automated Testing

### File: `src/__tests__/unit/blocks.test.ts`

Add tests for `buildCombinedStatusBlocks()`:

1. **TOP line format tests**:
   - Initial state: `_plan | n/a | n/a_`
   - After SDK report: `_plan | claude-sonnet-4 | abc123_`
   - New session: `_plan | claude-sonnet-4 | [new] abc123_`

2. **BOTTOM line presence tests**:
   - In-progress: NO bottom line
   - Completed: HAS bottom line with mode|model|session + stats
   - Aborted with data: HAS bottom line with mode|model|session + stats
   - Aborted early (no stats): HAS bottom line with mode|model|session ONLY

3. **Rate limit warning tests**:
   - In-progress + rateLimitHits=0: NO warning block
   - In-progress + rateLimitHits>0: HAS warning block ABOVE actions
   - Completed + rateLimitHits>0: warning in BOTTOM line suffix only

4. **Button tests**:
   - In-progress: `[View Log] [Abort]`
   - Completed non-final: `[View Log]`
   - Completed final (main channel): `[View Log] [Fork here]`
   - Completed final (thread): `[View Log] [Fork here]` ← SAME AS MAIN CHANNEL
   - Aborted: `[View Log]` only

5. **Spinner tests**:
   - In-progress: spinner block BELOW actions
   - Completed: NO spinner block
   - Aborted: NO spinner block

6. **Helper function tests**:
   - `buildTopStatusLine()`: various combinations of mode/model/sessionId/isNewSession
   - `buildBottomStatsLine()`: includes mode/model/sessionId + stats + rate limits suffix

### File: `src/__tests__/integration/slack-bot-mention.test.ts`

Add integration tests:

1. **Full flow test**: @bot query → initial status → SDK report → completion
   - Verify TOP line updates when SDK reports model/sessionId
   - Verify BOTTOM line appears only at completion
   - Verify Fork button on final segment

2. **Abort flow test**: @bot query → abort button clicked
   - Verify View Log stays
   - Verify BOTTOM line conditional on data availability

3. **Rate limit flow test**: @bot query with simulated rate limits
   - Verify warning appears immediately above buttons
   - Verify warning in BOTTOM line at completion

4. **Thread parity test**: Same status format in thread as main channel
   - Both get Fork button on final segment
   - No behavioral differences

---

## Manual Verification

1. **Start @bot query**:
   - TOP line: `_plan | n/a | n/a_`
   - Activity log: `:brain: *Analyzing request...*`
   - NO BOTTOM line (only at completion)
   - Buttons + spinner: `[View Log] [Abort]` then `⠋ [0.0s]`

2. **After first SDK report**:
   - TOP line updates: `_plan | claude-sonnet-4 | [new] abc123_`
   - Activity log updates with tools/thinking
   - Still NO BOTTOM line

3. **During processing**:
   - TOP line stays fixed (mode | model | session-id)
   - Activity log updates with each SDK event
   - Spinner animates: `⠋ → ⠙ → ⠹ → ...`
   - NO BOTTOM line until completion

4. **Rate limit hit during processing**:
   - Rate limit warning appears ABOVE buttons: `_:warning: 2 rate limits hit_`

5. **On completion**:
   - BOTTOM line appears: `_plan | claude-sonnet-4 | abc123 | 55% ctx (22% to ⚡) | 1.2k/850 | $0.12 | 15s_`
   - Spinner REMOVED
   - No "Beginning" or "Complete" headers

6. **Final segment**: `[View Log] [Fork here]` - no spinner, no abort
7. **Non-final segment**: `[View Log]` only - no spinner, no abort
8. **Abort**: BOTTOM line shows values at abort time, `[View Log]` only
9. **Rate limits at completion**: BOTTOM line suffix `:warning: 2 limits` if occurred
