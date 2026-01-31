import { describe, it, expect } from 'vitest';
import {
  buildSdkQuestionBlocks,
  buildStatusBlocks,
  buildHeaderBlocks,
  buildAnsweredBlocks,
  buildStatusDisplayBlocks,
  buildContextDisplayBlocks,
  computeAutoCompactThreshold,
  DEFAULT_CONTEXT_WINDOW,
  buildModeSelectionBlocks,
  buildModelSelectionBlocks,
  buildModelDeprecatedBlocks,
  buildPlanApprovalBlocks,
  buildToolApprovalBlocks,
  formatToolInput,
  buildForkAnchorBlocks,
  buildStatusPanelBlocks,
  buildActivityLogText,
  buildCombinedStatusBlocks,
  buildLiveActivityBlocks,
  getToolEmoji,
  formatToolName,
  formatToolInputSummary,
  formatToolResultSummary,
  formatToolDetails,
  formatOutputPreview,
  ActivityEntry,
  ACTIVITY_LOG_MAX_CHARS,
  TODO_LIST_MAX_CHARS,
  TodoItem,
  isTodoItem,
  extractLatestTodos,
  formatTodoListDisplay,
  buildStopWatchingButton,
  buildWatchingStatusSection,
  buildUnifiedStatusLine,
  formatTokensK,
  buildForkToChannelModalView,
  buildAbortConfirmationModalView,
  formatThreadActivityBatch,
  formatThreadThinkingMessage,
  formatThreadResponseMessage,
  formatThreadStartingMessage,
  formatThreadErrorMessage,
  buildAttachThinkingFileButton,
  linkifyActivityLabel,
} from '../../blocks.js';
import type { ModelInfo } from '../../model-cache.js';
import type { LastUsage } from '../../session-manager.js';

describe('blocks', () => {
  describe('buildSdkQuestionBlocks', () => {
    it('should build SDK question with header and options', () => {
      const blocks = buildSdkQuestionBlocks({
        question: 'Which auth method should we use?',
        header: 'Auth method',
        options: [
          { label: 'OAuth', description: 'Use OAuth 2.0 for third-party auth' },
          { label: 'JWT', description: 'Use JSON Web Tokens for stateless auth' },
        ],
        questionId: 'askuserq_123',
        multiSelect: false,
      });

      // Header + 2 option sections + divider + actions (Other/Abort)
      expect(blocks.length).toBeGreaterThanOrEqual(5);
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text?.text).toContain('[Auth method]');
      expect(blocks[0].text?.text).toContain('Which auth method should we use?');

      // First option section
      expect(blocks[1].type).toBe('section');
      expect(blocks[1].text?.text).toContain('OAuth');
      expect(blocks[1].text?.text).toContain('Use OAuth 2.0');
      expect(blocks[1].accessory?.action_id).toBe('sdkq_askuserq_123_0');
      expect(blocks[1].accessory?.value).toBe('OAuth');

      // Second option section
      expect(blocks[2].type).toBe('section');
      expect(blocks[2].text?.text).toContain('JWT');
      expect(blocks[2].accessory?.action_id).toBe('sdkq_askuserq_123_1');
    });

    it('should use multi-select dropdown when multiSelect is true', () => {
      const blocks = buildSdkQuestionBlocks({
        question: 'Select features:',
        header: 'Features',
        options: [
          { label: 'Auth', description: 'Authentication' },
          { label: 'DB', description: 'Database' },
          { label: 'Cache', description: 'Caching layer' },
        ],
        questionId: 'askuserq_456',
        multiSelect: true,
      });

      // Should have multi-select dropdown
      const multiSelectBlock = blocks.find(b => b.accessory?.type === 'multi_static_select');
      expect(multiSelectBlock).toBeDefined();
      expect(multiSelectBlock?.accessory?.action_id).toBe('sdkq_multi_askuserq_456');

      // Should have submit button
      const actionsBlock = blocks.find(b =>
        b.elements?.some((e: any) => e.action_id === 'sdkq_submit_askuserq_456')
      );
      expect(actionsBlock).toBeDefined();
    });

    it('should use multi-select when more than 5 options', () => {
      const blocks = buildSdkQuestionBlocks({
        question: 'Choose language:',
        header: 'Language',
        options: [
          { label: 'JS', description: 'JavaScript' },
          { label: 'TS', description: 'TypeScript' },
          { label: 'PY', description: 'Python' },
          { label: 'GO', description: 'Go' },
          { label: 'RS', description: 'Rust' },
          { label: 'RB', description: 'Ruby' },
        ],
        questionId: 'askuserq_789',
        multiSelect: false,  // Should still use multi-select due to count
      });

      // Should have multi-select dropdown due to >5 options
      const multiSelectBlock = blocks.find(b => b.accessory?.type === 'multi_static_select');
      expect(multiSelectBlock).toBeDefined();
    });

    it('should include Other and Abort buttons for regular options', () => {
      const blocks = buildSdkQuestionBlocks({
        question: 'Pick one:',
        header: 'Choice',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' },
        ],
        questionId: 'askuserq_abc',
        multiSelect: false,
      });

      // Find actions block with Other and Abort
      const actionsBlock = blocks.find(b =>
        b.elements?.some((e: any) => e.action_id === 'sdkq_other_askuserq_abc')
      );
      expect(actionsBlock).toBeDefined();

      const abortButton = actionsBlock?.elements?.find((e: any) =>
        e.action_id === 'sdkq_abort_askuserq_abc'
      );
      expect(abortButton).toBeDefined();
      expect(abortButton?.style).toBe('danger');
    });

    it('should handle empty options with abort only', () => {
      const blocks = buildSdkQuestionBlocks({
        question: 'What should we do?',
        header: 'Action',
        options: [],
        questionId: 'askuserq_empty',
        multiSelect: false,
      });

      // Should have header, context hint, and abort button
      expect(blocks[0].text?.text).toContain('What should we do?');

      // Should have abort button
      const actionsBlock = blocks.find(b =>
        b.elements?.some((e: any) => e.action_id === 'sdkq_abort_askuserq_empty')
      );
      expect(actionsBlock).toBeDefined();
    });

    it('should include user mention in header when userId and channelId provided', () => {
      const blocks = buildSdkQuestionBlocks({
        question: 'Which auth method should we use?',
        header: 'Auth method',
        options: [
          { label: 'OAuth', description: 'Use OAuth 2.0' },
          { label: 'JWT', description: 'Use JSON Web Tokens' },
        ],
        questionId: 'askuserq_123',
        multiSelect: false,
        userId: 'U12345',
        channelId: 'C67890',
      });

      expect(blocks[0].text?.text).toContain('<@U12345>');
      expect(blocks[0].text?.text).toContain('[Auth method]');
    });

    it('should NOT include user mention for DM channels', () => {
      const blocks = buildSdkQuestionBlocks({
        question: 'Which auth method should we use?',
        header: 'Auth method',
        options: [
          { label: 'OAuth', description: 'Use OAuth 2.0' },
        ],
        questionId: 'askuserq_123',
        multiSelect: false,
        userId: 'U12345',
        channelId: 'D67890', // DM channel
      });

      expect(blocks[0].text?.text).not.toContain('<@U12345>');
    });

    it('should NOT include user mention when userId is not provided', () => {
      const blocks = buildSdkQuestionBlocks({
        question: 'Which auth method should we use?',
        header: 'Auth method',
        options: [
          { label: 'OAuth', description: 'Use OAuth 2.0' },
        ],
        questionId: 'askuserq_123',
        multiSelect: false,
        channelId: 'C67890',
      });

      expect(blocks[0].text?.text).not.toContain('<@');
    });
  });

  describe('buildStatusBlocks', () => {
    it('should build processing status with abort button', () => {
      const blocks = buildStatusBlocks({
        status: 'processing',
        messageTs: 'msg_123',
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0].text?.text).toContain('Processing');
      expect(blocks[1].type).toBe('actions');
      expect(blocks[1].elements?.[0].action_id).toBe('abort_query_msg_123');
    });

    it('should build aborted status', () => {
      const blocks = buildStatusBlocks({
        status: 'aborted',
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Aborted');
    });

    it('should build error status with message', () => {
      const blocks = buildStatusBlocks({
        status: 'error',
        errorMessage: 'Connection failed',
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Error');
      expect(blocks[0].text?.text).toContain('Connection failed');
    });
  });

  describe('buildAnsweredBlocks', () => {
    it('should build answered question display', () => {
      const blocks = buildAnsweredBlocks('What color?', 'Blue');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text?.text).toContain('What color?');
      expect(blocks[0].text?.text).toContain('Blue');
    });
  });

  describe('buildStatusDisplayBlocks', () => {
    it('should show session ID', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123-def',
        mode: 'plan',
        workingDir: '/test/path',
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      expect(blocks.length).toBeGreaterThanOrEqual(2);
      expect(blocks[0].type).toBe('header');
      expect(blocks[1].text?.text).toContain('abc-123-def');
    });

    it('should show "None" when no session', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: null,
        mode: 'plan',
        workingDir: '/test/path',
        lastActiveAt: Date.now(),
        pathConfigured: false,
        configuredBy: null,
        configuredAt: null,
      });

      expect(blocks[1].text?.text).toContain('None');
    });

    it('should show current mode', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'bypassPermissions',
        workingDir: '/test/path',
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      expect(blocks[1].text?.text).toContain('bypassPermissions');
    });

    it('should show working directory', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'plan',
        workingDir: '/my/project/dir',
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      expect(blocks[1].text?.text).toContain('/my/project/dir');
    });

    it('should show model and context info when lastUsage provided', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'plan',
        workingDir: '/test',
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredBy: 'U123',
        configuredAt: Date.now(),
        lastUsage: {
          inputTokens: 5000,
          outputTokens: 2000,
          cacheReadInputTokens: 95000,
          contextWindow: 200000,
          model: 'claude-opus-4-5',
        },
      });

      expect(blocks[1].text?.text).toContain('claude-opus-4-5');
      expect(blocks[1].text?.text).toContain('Context:');
      expect(blocks[1].text?.text).toContain('50%'); // (5000 + 95000) / 200000 = 50%
    });

    it('should not show model/context when no lastUsage', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'plan',
        workingDir: '/test',
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredBy: 'U123',
        configuredAt: Date.now(),
      });

      expect(blocks[1].text?.text).not.toContain('Model:');
      expect(blocks[1].text?.text).not.toContain('Context:');
    });

    it('should show default thinking tokens when not set', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'plan',
        workingDir: '/test',
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredBy: 'U123',
        configuredAt: Date.now(),
        maxThinkingTokens: undefined,
      });

      expect(blocks[1].text?.text).toContain('*Thinking Tokens:* 31,999 (default)');
    });

    it('should show custom thinking tokens value', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'plan',
        workingDir: '/test',
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredBy: 'U123',
        configuredAt: Date.now(),
        maxThinkingTokens: 16000,
      });

      expect(blocks[1].text?.text).toContain('*Thinking Tokens:* 16,000');
      // Should not show "(default)" on the thinking tokens line specifically
      expect(blocks[1].text?.text).not.toContain('*Thinking Tokens:* 16,000 (default)');
    });

    it('should show disabled when thinking tokens is 0', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'plan',
        workingDir: '/test',
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredBy: 'U123',
        configuredAt: Date.now(),
        maxThinkingTokens: 0,
      });

      expect(blocks[1].text?.text).toContain('*Thinking Tokens:* disabled');
    });

    it('should show default update rate when not set', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'plan',
        workingDir: '/test',
        lastActiveAt: Date.now(),
        pathConfigured: false,
        configuredBy: null,
        configuredAt: null,
      });

      expect(blocks[1].text?.text).toContain('*Update Rate:* 3s (default)');
    });

    it('should show custom update rate value', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'plan',
        workingDir: '/test',
        lastActiveAt: Date.now(),
        pathConfigured: false,
        configuredBy: null,
        configuredAt: null,
        updateRateSeconds: 2.5,
      });

      expect(blocks[1].text?.text).toContain('*Update Rate:* 2.5s');
      // Should not show "(default)" on the update rate line specifically
      expect(blocks[1].text?.text).not.toContain('*Update Rate:* 2.5s (default)');
    });

    it('should show integer update rate without decimal', () => {
      const blocks = buildStatusDisplayBlocks({
        sessionId: 'abc-123',
        mode: 'plan',
        workingDir: '/test',
        lastActiveAt: Date.now(),
        pathConfigured: false,
        configuredBy: null,
        configuredAt: null,
        updateRateSeconds: 5,
      });

      expect(blocks[1].text?.text).toContain('*Update Rate:* 5s');
    });
  });

  describe('buildContextDisplayBlocks', () => {
    const baseUsage: LastUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 49000,
      cacheCreationInputTokens: 0,
      contextWindow: 200000,
      model: 'claude-sonnet-4-5',
      maxOutputTokens: 64000,  // sonnet uses 64k output tokens
    };

    it('should show header with Context Usage title', () => {
      const blocks = buildContextDisplayBlocks(baseUsage);

      expect(blocks[0].type).toBe('header');
      expect(blocks[0].text?.text).toBe('Context Usage');
    });

    it('should show model name', () => {
      const blocks = buildContextDisplayBlocks(baseUsage);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      expect(sectionBlock?.text?.text).toContain('claude-sonnet-4-5');
    });

    it('should show progress bar', () => {
      const blocks = buildContextDisplayBlocks(baseUsage);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      // Progress bar uses block characters
      expect(sectionBlock?.text?.text).toMatch(/[\u2588\u2591]+/);
    });

    it('should calculate percentage correctly', () => {
      const blocks = buildContextDisplayBlocks(baseUsage);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      // (1000 + 49000) / 200000 = 25%
      expect(sectionBlock?.text?.text).toContain('25%');
    });

    it('should show token breakdown', () => {
      const blocks = buildContextDisplayBlocks(baseUsage);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      expect(sectionBlock?.text?.text).toContain('Input: 1,000');
      expect(sectionBlock?.text?.text).toContain('Output: 500');
      expect(sectionBlock?.text?.text).toContain('Cache creation: 0');
      expect(sectionBlock?.text?.text).toContain('Cache read: 49,000');
    });

    it('should show tokens used and remaining', () => {
      const blocks = buildContextDisplayBlocks(baseUsage);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      expect(sectionBlock?.text?.text).toContain('*Tokens used:* 50,000 / 200,000');
      expect(sectionBlock?.text?.text).toContain('*Remaining:* 150,000');
    });

    it('should show healthy status when under 80%', () => {
      const blocks = buildContextDisplayBlocks(baseUsage);
      const contextBlock = blocks.find((b: any) => b.type === 'context');

      expect(contextBlock?.elements?.[0]?.text).toContain(':white_check_mark:');
      expect(contextBlock?.elements?.[0]?.text).toContain('Healthy');
    });

    it('should show warning when compact percent <= 20%', () => {
      // threshold = 200k - 32k(capped) - 13k = 155k. Want ~15% compact left
      // (155k - 132k) / 155k * 100 = 14.8%
      const highUsage: LastUsage = {
        ...baseUsage,
        inputTokens: 64000,
        cacheReadInputTokens: 68000, // 132k total, compact% = (155k-132k)/155k = 14.8%
      };
      const blocks = buildContextDisplayBlocks(highUsage);
      const contextBlock = blocks.find((b: any) => b.type === 'context');

      expect(contextBlock?.elements?.[0]?.text).toContain(':warning:');
      expect(contextBlock?.elements?.[0]?.text).toContain('Consider `/compact`');
    });

    it('should show error when compact percent <= 10%', () => {
      // threshold = 200k - 32k(capped) - 13k = 155k. Want ~5% compact left
      // (155k - 148k) / 155k * 100 = 4.5%
      const veryHighUsage: LastUsage = {
        ...baseUsage,
        inputTokens: 80000,
        cacheReadInputTokens: 68000, // 148k total, compact% = (155k-148k)/155k = 4.5%
      };
      const blocks = buildContextDisplayBlocks(veryHighUsage);
      const contextBlock = blocks.find((b: any) => b.type === 'context');

      expect(contextBlock?.elements?.[0]?.text).toContain(':x:');
      expect(contextBlock?.elements?.[0]?.text).toContain('nearly full');
    });

    it('should show imminent when past threshold', () => {
      // threshold = 200k - 32k(capped) - 13k = 155k. Using 160k is past threshold
      const pastThreshold: LastUsage = {
        ...baseUsage,
        inputTokens: 60000,
        cacheReadInputTokens: 100000, // 160k total, past 155k threshold
      };
      const blocks = buildContextDisplayBlocks(pastThreshold);
      const contextBlock = blocks.find((b: any) => b.type === 'context');

      expect(contextBlock?.elements?.[0]?.text).toContain(':x:');
      expect(contextBlock?.elements?.[0]?.text).toContain('imminent');
    });

    it('should show auto-compact remaining percentage with tokens', () => {
      // threshold = 200k - 32k(capped) - 13k = 155k. 50k used
      // CLI formula: (155k - 50k) / 155k * 100 = 67.7%
      // tokensToCompact = 105k
      const blocks = buildContextDisplayBlocks(baseUsage);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      expect(sectionBlock?.text?.text).toContain('Auto-compact:');
      expect(sectionBlock?.text?.text).toContain('67.7% remaining (105.0k tok)');
    });

    it('should show auto-compact imminent when past threshold', () => {
      const pastThreshold: LastUsage = {
        ...baseUsage,
        inputTokens: 60000,
        cacheReadInputTokens: 100000, // 160k used, past 155k threshold
      };
      const blocks = buildContextDisplayBlocks(pastThreshold);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      expect(sectionBlock?.text?.text).toContain('Auto-compact:');
      expect(sectionBlock?.text?.text).toContain('imminent');
    });

    it('should handle zero context window gracefully', () => {
      const zeroWindow: LastUsage = {
        ...baseUsage,
        contextWindow: 0,
      };
      const blocks = buildContextDisplayBlocks(zeroWindow);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      expect(sectionBlock?.text?.text).toContain('0%');
    });

    it('should not cap maxOutputTokens below 32k (e.g. Claude 3.5 with 8192)', () => {
      // Claude 3.5 has maxOutputTokens=8192, which is below 32k cap → use 8192 as-is
      // threshold = 200k - 8192 - 13k = 178808
      // CLI formula: (178808 - 50000) / 178808 * 100 = 72.0%
      // tokensToCompact = 128808 → "128.8k tok"
      const claude35Usage: LastUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 49000,
        cacheCreationInputTokens: 0,
        contextWindow: 200000,
        model: 'claude-3-5-sonnet-20241022',
        maxOutputTokens: 8192,
      };
      const blocks = buildContextDisplayBlocks(claude35Usage);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      expect(sectionBlock?.text?.text).toContain('72.0% remaining (128.8k tok)');
    });

    it('should handle context exceeding 100% without crashing', () => {
      const overflowUsage: LastUsage = {
        ...baseUsage,
        inputTokens: 150000,
        cacheReadInputTokens: 200000, // 350k total = 175% of 200k window
        contextWindow: 200000,
      };
      const blocks = buildContextDisplayBlocks(overflowUsage);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock?.text?.text).toContain('175%');
      expect(sectionBlock?.text?.text).toContain('\u2588'.repeat(20));
    });

    it('should include cache creation tokens in context percentage', () => {
      const withCacheCreation: LastUsage = {
        ...baseUsage,
        inputTokens: 1000,
        cacheReadInputTokens: 39000,
        cacheCreationInputTokens: 10000, // 1000 + 10000 + 39000 = 50000 = 25%
      };
      const blocks = buildContextDisplayBlocks(withCacheCreation);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock?.text?.text).toContain('25%');
      expect(sectionBlock?.text?.text).toContain('Cache creation: 10,000');
    });
  });

  describe('computeAutoCompactThreshold', () => {
    it('should cap maxOutputTokens at 32k (CLI HV6 behavior)', () => {
      // Opus 4.5 native max is 64k, but CLI caps at 32k
      // 200000 - 32000 (capped) - 13000 = 155000
      expect(computeAutoCompactThreshold(200000, 64000)).toBe(155000);
    });

    it('should compute threshold with default maxOutputTokens (32k)', () => {
      // 200000 - 32000 - 13000 = 155000
      expect(computeAutoCompactThreshold(200000)).toBe(155000);
    });

    it('should compute threshold with opus-4 maxOutputTokens (32k)', () => {
      // 200000 - 32000 - 13000 = 155000
      expect(computeAutoCompactThreshold(200000, 32000)).toBe(155000);
    });

    it('should not cap maxOutputTokens below 32k (e.g. Claude 3.5 with 8192)', () => {
      // 200000 - 8192 - 13000 = 178808
      expect(computeAutoCompactThreshold(200000, 8192)).toBe(178808);
    });
  });

  describe('DEFAULT_CONTEXT_WINDOW', () => {
    it('should be 200000 (all current Claude models)', () => {
      expect(DEFAULT_CONTEXT_WINDOW).toBe(200000);
    });
  });

  describe('buildModeSelectionBlocks', () => {
    it('should show all four SDK mode buttons', () => {
      const blocks = buildModeSelectionBlocks('plan');

      const actions = blocks.find((b: any) => b.type === 'actions');
      expect(actions).toBeDefined();
      expect(actions.elements).toHaveLength(4);

      // Verify all SDK mode buttons exist
      const values = actions.elements.map((e: any) => e.value);
      expect(values).toContain('plan');
      expect(values).toContain('default');
      expect(values).toContain('bypassPermissions');
      expect(values).toContain('acceptEdits');
    });

    it('should highlight current mode as primary', () => {
      const blocks = buildModeSelectionBlocks('bypassPermissions');

      const actions = blocks.find((b: any) => b.type === 'actions');
      const bypassBtn = actions.elements.find((e: any) => e.value === 'bypassPermissions');
      const planBtn = actions.elements.find((e: any) => e.value === 'plan');

      expect(bypassBtn.style).toBe('primary');
      expect(planBtn.style).toBeUndefined();
    });

    it('should include mode descriptions with SDK names', () => {
      const blocks = buildModeSelectionBlocks('default');

      const context = blocks.find((b: any) => b.type === 'context');
      expect(context).toBeDefined();
      expect(context.elements[0].text).toContain('plan');
      expect(context.elements[0].text).toContain('default');
      expect(context.elements[0].text).toContain('bypassPermissions');
      expect(context.elements[0].text).toContain('acceptEdits');
    });

    it('should show current mode in header', () => {
      const blocks = buildModeSelectionBlocks('plan');

      const section = blocks.find((b: any) => b.type === 'section');
      expect(section.text.text).toContain('plan');
    });
  });

  describe('buildModelSelectionBlocks', () => {
    const mockModels: ModelInfo[] = [
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', description: 'Best balance' },
      { value: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', description: 'Fastest' },
      { value: 'claude-opus-4-5-20251101', displayName: 'Claude Opus 4.5', description: 'Most capable' },
    ];

    it('should create buttons for each model', () => {
      const blocks = buildModelSelectionBlocks(mockModels);
      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock.elements).toHaveLength(3);
    });

    it('should highlight current model as primary', () => {
      const blocks = buildModelSelectionBlocks(mockModels, 'claude-sonnet-4-5-20250929');
      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const sonnetBtn = actionsBlock.elements.find((e: any) => e.value === 'claude-sonnet-4-5-20250929');
      const haikuBtn = actionsBlock.elements.find((e: any) => e.value === 'claude-haiku-4-5-20251001');

      expect(sonnetBtn.style).toBe('primary');
      expect(haikuBtn.style).toBeUndefined();
    });

    it('should show current model in header', () => {
      const blocks = buildModelSelectionBlocks(mockModels, 'claude-opus-4-5-20251101');
      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).toContain('claude-opus-4-5-20251101');
    });

    it('should show "default (SDK chooses)" when no current model', () => {
      const blocks = buildModelSelectionBlocks(mockModels, undefined);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).toContain('default (SDK chooses)');
    });

    it('should include model descriptions in context block', () => {
      const blocks = buildModelSelectionBlocks(mockModels);
      const contextBlock = blocks.find((b: any) => b.type === 'context');
      expect(contextBlock).toBeDefined();
      expect(contextBlock.elements[0].text).toContain('Claude Sonnet 4.5');
      expect(contextBlock.elements[0].text).toContain('Best balance');
      expect(contextBlock.elements[0].text).toContain('Claude Haiku 4.5');
      expect(contextBlock.elements[0].text).toContain('Fastest');
    });

    it('should have correct action_id format for model buttons', () => {
      const blocks = buildModelSelectionBlocks(mockModels);
      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const actionIds = actionsBlock.elements.map((e: any) => e.action_id);

      expect(actionIds).toContain('model_select_claude-sonnet-4-5-20250929');
      expect(actionIds).toContain('model_select_claude-haiku-4-5-20251001');
      expect(actionIds).toContain('model_select_claude-opus-4-5-20251101');
    });

    it('should limit to 5 models for Slack actions block', () => {
      const manyModels: ModelInfo[] = Array.from({ length: 10 }, (_, i) => ({
        value: `model-${i}`,
        displayName: `Model ${i}`,
        description: `Description ${i}`,
      }));

      const blocks = buildModelSelectionBlocks(manyModels);
      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock.elements).toHaveLength(5);
    });
  });

  describe('buildModelDeprecatedBlocks', () => {
    const mockModels: ModelInfo[] = [
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', description: 'Best balance' },
    ];

    it('should show warning for deprecated model', () => {
      const blocks = buildModelDeprecatedBlocks('old-deprecated-model', mockModels);
      const text = JSON.stringify(blocks);
      expect(text).toContain('No Longer Available');
      expect(text).toContain('old-deprecated-model');
    });

    it('should include warning emoji', () => {
      const blocks = buildModelDeprecatedBlocks('old-model', mockModels);
      const sectionBlock = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('warning'));
      expect(sectionBlock).toBeDefined();
      expect(sectionBlock.text.text).toContain(':warning:');
    });

    it('should include model selection blocks after divider', () => {
      const blocks = buildModelDeprecatedBlocks('old-model', mockModels);
      const dividerIndex = blocks.findIndex((b: any) => b.type === 'divider');
      expect(dividerIndex).toBeGreaterThan(0);
      // After divider should be the model selection blocks
      expect(blocks.length).toBeGreaterThan(dividerIndex + 1);
    });

    it('should show the deprecated model name in warning', () => {
      const blocks = buildModelDeprecatedBlocks('claude-old-version', mockModels);
      const warningBlock = blocks.find((b: any) => b.text?.text?.includes('No Longer Available'));
      expect(warningBlock.text.text).toContain('claude-old-version');
    });
  });

  describe('buildHeaderBlocks', () => {
    it('should show mode with Abort button on starting status', () => {
      const blocks = buildHeaderBlocks({
        status: 'starting',
        mode: 'plan',
        conversationKey: 'conv_123',
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('context');
      expect(blocks[0].elements[0].text).toBe('_Plan_');
      expect(blocks[1].type).toBe('actions');
      expect(blocks[1].elements[0].action_id).toBe('abort_query_conv_123');
    });

    it('should show mode | model with Abort button on processing status', () => {
      const blocks = buildHeaderBlocks({
        status: 'processing',
        mode: 'bypassPermissions',
        conversationKey: 'conv_456',
        model: 'claude-sonnet',
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('context');
      expect(blocks[0].elements[0].text).toBe('_Bypass | claude-sonnet_');
      expect(blocks[1].type).toBe('actions');
      expect(blocks[1].elements[0].action_id).toBe('abort_query_conv_456');
    });

    it('should show mode | model | tokens | time on complete status (no Abort)', () => {
      const blocks = buildHeaderBlocks({
        status: 'complete',
        mode: 'plan',
        model: 'claude-sonnet',
        inputTokens: 100,
        outputTokens: 200,
        durationMs: 5000,
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('context');
      expect(blocks[0].elements[0].text).toContain('claude-sonnet');
      expect(blocks[0].elements[0].text).toContain('Plan');
      expect(blocks[0].elements[0].text).toContain('300 tokens');
      expect(blocks[0].elements[0].text).toContain('5.0s');
    });

    it('should omit tokens and time if not provided on complete', () => {
      const blocks = buildHeaderBlocks({
        status: 'complete',
        mode: 'default',
        model: 'claude-opus',
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].elements[0].text).toBe('_Default | claude-opus_');
    });

    it('should show mode | model | aborted when model is known', () => {
      const blocks = buildHeaderBlocks({
        status: 'aborted',
        mode: 'plan',
        model: 'claude-sonnet',
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('context');
      expect(blocks[0].elements[0].text).toBe('_Plan | claude-sonnet | aborted_');
    });

    it('should show mode | aborted when model is not known', () => {
      const blocks = buildHeaderBlocks({
        status: 'aborted',
        mode: 'bypassPermissions',
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('context');
      expect(blocks[0].elements[0].text).toBe('_Bypass | aborted_');
    });

    it('should show error status with message', () => {
      const blocks = buildHeaderBlocks({
        status: 'error',
        mode: 'bypassPermissions',
        errorMessage: 'Connection failed',
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('context');
      expect(blocks[0].elements[0].text).toBe('_Error: Connection failed_');
    });

    it('should use default model name when not provided', () => {
      const blocks = buildHeaderBlocks({
        status: 'processing',
        mode: 'plan',
        conversationKey: 'conv_789',
      });

      expect(blocks[0].elements[0].text).toBe('_Plan | Claude_');
    });
  });

  describe('buildPlanApprovalBlocks (CLI fidelity)', () => {
    it('should show 5 action buttons across 3 actions blocks', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });
      const actionsBlocks = blocks.filter((b: any) => b.type === 'actions');
      const allButtons = actionsBlocks.flatMap((b: any) => b.elements || []);

      expect(actionsBlocks).toHaveLength(3);
      expect(allButtons).toHaveLength(5);
    });

    it('should have correct action IDs matching CLI options', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123_T456' });
      const actionsBlocks = blocks.filter((b: any) => b.type === 'actions');
      const actionIds = actionsBlocks.flatMap((b: any) =>
        (b.elements || []).map((e: any) => e.action_id)
      );

      // 5 CLI options
      expect(actionIds).toContain('plan_clear_bypass_C123_T456');  // Option 1
      expect(actionIds).toContain('plan_accept_edits_C123_T456'); // Option 2
      expect(actionIds).toContain('plan_bypass_C123_T456');       // Option 3
      expect(actionIds).toContain('plan_manual_C123_T456');       // Option 4
      expect(actionIds).toContain('plan_reject_C123_T456');       // Option 5
    });

    it('should display requested permissions when provided', () => {
      const blocks = buildPlanApprovalBlocks({
        conversationKey: 'C123',
        allowedPrompts: [
          { tool: 'Bash', prompt: 'run tests' },
          { tool: 'Bash', prompt: 'build the project' },
        ],
      });

      const text = JSON.stringify(blocks);
      expect(text).toContain('Requested permissions');
      expect(text).toContain('Bash(prompt: run tests)');
      expect(text).toContain('Bash(prompt: build the project)');
    });

    it('should omit permissions section when allowedPrompts is empty', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });
      const text = JSON.stringify(blocks);
      expect(text).not.toContain('Requested permissions');
    });

    it('should omit permissions section when allowedPrompts is undefined', () => {
      const blocks = buildPlanApprovalBlocks({
        conversationKey: 'C123',
        allowedPrompts: undefined,
      });
      const text = JSON.stringify(blocks);
      expect(text).not.toContain('Requested permissions');
    });

    it('should have primary style for options 1 and 2, danger for option 5', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });
      const actionsBlocks = blocks.filter((b: any) => b.type === 'actions');
      const allButtons = actionsBlocks.flatMap((b: any) => b.elements || []);

      const clearBypassBtn = allButtons.find((e: any) => e.action_id.includes('plan_clear_bypass'));
      const acceptEditsBtn = allButtons.find((e: any) => e.action_id.includes('plan_accept_edits'));
      const rejectBtn = allButtons.find((e: any) => e.action_id.includes('plan_reject'));

      expect(clearBypassBtn.style).toBe('primary');
      expect(acceptEditsBtn.style).toBe('primary');
      expect(rejectBtn.style).toBe('danger');
    });

    it('should have no style (default) for options 3 and 4', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });
      const actionsBlocks = blocks.filter((b: any) => b.type === 'actions');
      const allButtons = actionsBlocks.flatMap((b: any) => b.elements || []);

      const bypassBtn = allButtons.find((e: any) => e.action_id.includes('plan_bypass_'));
      const manualBtn = allButtons.find((e: any) => e.action_id.includes('plan_manual_'));

      expect(bypassBtn.style).toBeUndefined();
      expect(manualBtn.style).toBeUndefined();
    });

    it('should include a divider at the start', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });
      expect(blocks[0].type).toBe('divider');
    });

    it('should include context hint explaining all 5 options', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });
      const contextBlock = blocks.find((b: any) => b.type === 'context');

      expect(contextBlock).toBeDefined();
      const contextText = contextBlock.elements[0].text;
      expect(contextText).toContain('Fresh start');
      expect(contextText).toContain('Auto-accept edits');
      expect(contextText).toContain('Auto-accept all');
      expect(contextText).toContain('Ask for each');
      expect(contextText).toContain('Revise plan');
    });

    it('should include header section asking to proceed', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });
      const sectionBlocks = blocks.filter((b: any) => b.type === 'section');

      // First section (after divider) asks if user wants to proceed
      const promptSection = sectionBlocks.find((b: any) =>
        b.text?.text?.includes('Would you like to proceed')
      );
      expect(promptSection).toBeDefined();
    });

    it('should include user mention in blocks when userId and channelId provided', () => {
      const blocks = buildPlanApprovalBlocks({
        conversationKey: 'C123',
        userId: 'U12345',
        channelId: 'C67890',
      });

      const mentionSection = blocks.find((b: any) =>
        b.type === 'section' && b.text?.text?.includes('<@U12345>')
      );
      expect(mentionSection).toBeDefined();
      expect(mentionSection.text.text).toContain('Plan ready for approval');
    });

    it('should NOT include user mention for DM channels (channelId starts with D)', () => {
      const blocks = buildPlanApprovalBlocks({
        conversationKey: 'C123',
        userId: 'U12345',
        channelId: 'D67890', // DM channel
      });

      const text = JSON.stringify(blocks);
      expect(text).not.toContain('<@U12345>');
    });

    it('should NOT include user mention when userId is not provided', () => {
      const blocks = buildPlanApprovalBlocks({
        conversationKey: 'C123',
        channelId: 'C67890',
      });

      const text = JSON.stringify(blocks);
      expect(text).not.toContain('<@');
    });
  });

  describe('formatToolInput', () => {
    it('should format simple tool input as JSON', () => {
      const input = { file_path: '/test.txt', content: 'hello' };
      const result = formatToolInput(input);

      expect(result).toContain('file_path');
      expect(result).toContain('/test.txt');
      expect(result).toContain('content');
      expect(result).toContain('hello');
    });

    it('should truncate long input to 500 chars', () => {
      const longContent = 'x'.repeat(1000);
      const input = { content: longContent };
      const result = formatToolInput(input);

      expect(result.length).toBeLessThanOrEqual(503); // 500 + "..."
      expect(result).toContain('...');
    });

    it('should not truncate short input', () => {
      const input = { name: 'test' };
      const result = formatToolInput(input);

      expect(result).not.toContain('...');
    });

    it('should handle nested objects', () => {
      const input = { outer: { inner: 'value' } };
      const result = formatToolInput(input);

      expect(result).toContain('outer');
      expect(result).toContain('inner');
      expect(result).toContain('value');
    });
  });

  describe('buildToolApprovalBlocks', () => {
    it('should include divider, section, and actions blocks', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'test-123',
        toolName: 'Write',
        toolInput: { file_path: '/test.txt' },
      });

      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe('divider');
      expect(blocks[1].type).toBe('section');
      expect(blocks[2].type).toBe('actions');
    });

    it('should show tool name in section', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'test-123',
        toolName: 'Edit',
        toolInput: { file_path: '/src/app.ts' },
      });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).toContain('Edit');
      expect(sectionBlock.text.text).toContain('Claude wants to use');
    });

    it('should show tool input in code block', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'test-123',
        toolName: 'Write',
        toolInput: { file_path: '/test.txt', content: 'hello world' },
      });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).toContain('```');
      expect(sectionBlock.text.text).toContain('file_path');
      expect(sectionBlock.text.text).toContain('/test.txt');
    });

    it('should have approve and deny buttons', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'test-456',
        toolName: 'Bash',
        toolInput: { command: 'npm install' },
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock.elements).toHaveLength(2);

      const approveBtn = actionsBlock.elements.find((e: any) => e.text.text === 'Approve');
      const denyBtn = actionsBlock.elements.find((e: any) => e.text.text === 'Deny');

      expect(approveBtn).toBeDefined();
      expect(denyBtn).toBeDefined();
    });

    it('should have correct action IDs with approval ID', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'abc-789',
        toolName: 'Write',
        toolInput: { file_path: '/test' },
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const actionIds = actionsBlock.elements.map((e: any) => e.action_id);

      expect(actionIds).toContain('tool_approve_abc-789');
      expect(actionIds).toContain('tool_deny_abc-789');
    });

    it('should have primary style for approve and danger for deny', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'test-123',
        toolName: 'Write',
        toolInput: { file_path: '/test' },
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const approveBtn = actionsBlock.elements.find((e: any) => e.action_id.includes('approve'));
      const denyBtn = actionsBlock.elements.find((e: any) => e.action_id.includes('deny'));

      expect(approveBtn.style).toBe('primary');
      expect(denyBtn.style).toBe('danger');
    });

    it('should truncate long tool input', () => {
      const longInput = { content: 'x'.repeat(1000) };
      const blocks = buildToolApprovalBlocks({
        approvalId: 'test-123',
        toolName: 'Write',
        toolInput: longInput,
      });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).toContain('...');
    });

    it('should set correct block_id', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'my-approval-id',
        toolName: 'Write',
        toolInput: {},
      });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock.block_id).toBe('tool_approval_my-approval-id');
    });

    it('should include user mention in section when userId and channelId provided', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'test-123',
        toolName: 'Write',
        toolInput: { file_path: '/test.txt' },
        userId: 'U12345',
        channelId: 'C67890',
      });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).toContain('<@U12345>');
      expect(sectionBlock.text.text).toContain('Claude wants to use');
    });

    it('should NOT include user mention for DM channels', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'test-123',
        toolName: 'Write',
        toolInput: { file_path: '/test.txt' },
        userId: 'U12345',
        channelId: 'D67890', // DM channel
      });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).not.toContain('<@U12345>');
    });

    it('should NOT include user mention when userId is not provided', () => {
      const blocks = buildToolApprovalBlocks({
        approvalId: 'test-123',
        toolName: 'Write',
        toolInput: { file_path: '/test.txt' },
        channelId: 'C67890',
      });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).not.toContain('<@');
    });
  });

  describe('buildForkAnchorBlocks', () => {
    it('should build fork anchor with single section block', () => {
      const blocks = buildForkAnchorBlocks({
        forkPointLink: 'https://slack.com/archives/C123/p1234567890123456?thread_ts=1234567890.123456&cid=C123',
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('section');
    });

    it('should include fork emoji and link in section', () => {
      const forkPointLink = 'https://slack.com/archives/C123/p1234567890123456?thread_ts=1234567890.123456&cid=C123';
      const blocks = buildForkAnchorBlocks({ forkPointLink });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock?.text?.text).toContain('🔀');
      expect(sectionBlock?.text?.text).toContain('Point-in-time fork from');
      expect(sectionBlock?.text?.text).toContain('this message');
      expect(sectionBlock?.text?.text).toContain(forkPointLink);
    });

    it('should format link as Slack mrkdwn', () => {
      const forkPointLink = 'https://slack.com/archives/C456/p9876543210987654?thread_ts=9876543210.987654&cid=C456';
      const blocks = buildForkAnchorBlocks({ forkPointLink });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock?.text?.text).toBe(`🔀 Point-in-time fork from <${forkPointLink}|this message>`);
    });
  });

  // ============================================================================
  // Real-Time Processing Feedback Block Tests
  // ============================================================================

  describe('getToolEmoji', () => {
    it('should return magnifying glass for read operations', () => {
      expect(getToolEmoji('Read')).toBe(':mag:');
      expect(getToolEmoji('Glob')).toBe(':mag:');
      expect(getToolEmoji('Grep')).toBe(':mag:');
    });

    it('should return memo for write operations', () => {
      expect(getToolEmoji('Edit')).toBe(':memo:');
      expect(getToolEmoji('Write')).toBe(':memo:');
    });

    it('should return computer for bash operations', () => {
      expect(getToolEmoji('Bash')).toBe(':computer:');
      expect(getToolEmoji('Shell')).toBe(':computer:');
    });

    it('should return globe for web operations', () => {
      expect(getToolEmoji('WebFetch')).toBe(':globe_with_meridians:');
      expect(getToolEmoji('WebSearch')).toBe(':globe_with_meridians:');
    });

    it('should return robot for task operations', () => {
      expect(getToolEmoji('Task')).toBe(':robot_face:');
    });

    it('should return clipboard for todo operations', () => {
      expect(getToolEmoji('Todo')).toBe(':clipboard:');
      // Note: TodoWrite matches 'write' first, so it returns :memo:
      expect(getToolEmoji('TodoWrite')).toBe(':memo:');
    });

    it('should return gear for unknown tools', () => {
      expect(getToolEmoji('UnknownTool')).toBe(':gear:');
      expect(getToolEmoji(undefined)).toBe(':gear:');
    });

    it('should be case insensitive', () => {
      expect(getToolEmoji('READ')).toBe(':mag:');
      expect(getToolEmoji('edit')).toBe(':memo:');
      expect(getToolEmoji('BASH')).toBe(':computer:');
    });
  });

  describe('formatToolName', () => {
    it('should return simple tool names unchanged', () => {
      expect(formatToolName('Read')).toBe('Read');
      expect(formatToolName('Edit')).toBe('Edit');
      expect(formatToolName('Bash')).toBe('Bash');
    });

    it('should strip MCP-style prefixes', () => {
      expect(formatToolName('mcp__claude-code__Read')).toBe('Read');
      expect(formatToolName('mcp__ask-user__ask_user')).toBe('ask_user');
      expect(formatToolName('mcp__ask-user__approve_action')).toBe('approve_action');
    });

    it('should handle double underscore in tool name', () => {
      expect(formatToolName('prefix__middle__ToolName')).toBe('ToolName');
    });
  });

  describe('buildStatusPanelBlocks', () => {
    const baseParams = {
      mode: 'plan' as const,
      toolsCompleted: 0,
      elapsedMs: 0,
      conversationKey: 'C123',
    };

    describe('starting status', () => {
      it('should show working header and starting text', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'starting',
        });

        expect(blocks).toHaveLength(3);
        expect(blocks[0].type).toBe('section');
        expect((blocks[0] as any).text.text).toContain('Claude is working');
        expect(blocks[1].type).toBe('context');
        expect((blocks[1] as any).elements[0].text).toContain('Plan');
        expect((blocks[1] as any).elements[0].text).toContain('Starting');
      });

      it('should include Abort button only (no View Log)', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'starting',
        });

        expect(blocks[2].type).toBe('actions');
        // Only Abort button (no View Log)
        expect((blocks[2] as any).elements.length).toBe(1);
        const abortButton = (blocks[2] as any).elements[0];
        expect(abortButton.text.text).toBe('Abort');
        expect(abortButton.style).toBe('danger');
        expect(abortButton.action_id).toContain('abort_query_');
      });
    });

    describe('thinking status', () => {
      it('should show Thinking in status line', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'thinking',
          model: 'claude-sonnet',
          elapsedMs: 5000,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('Thinking');
        expect(contextText).toContain('claude-sonnet');
        expect(contextText).toContain('5.0s');
      });

      it('should show tools completed count when > 0', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'thinking',
          toolsCompleted: 3,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('Tools: 3');
      });

      it('should include Abort button', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'thinking',
        });

        expect(blocks[2].type).toBe('actions');
      });
    });

    describe('tool status', () => {
      it('should show current tool name', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'tool',
          currentTool: 'Read',
          model: 'claude-sonnet',
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('Running: Read');
      });

      it('should include Abort button', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'tool',
          currentTool: 'Edit',
        });

        expect(blocks[2].type).toBe('actions');
      });
    });

    describe('complete status', () => {
      it('should show Complete header', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          model: 'claude-sonnet',
          elapsedMs: 10000,
        });

        expect(blocks).toHaveLength(2); // No Abort button
        expect((blocks[0] as any).text.text).toContain('Complete');
      });

      it('should show token counts', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          inputTokens: 1234,
          outputTokens: 567,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('1,234');
        expect(contextText).toContain('567');
      });

      it('should show context percentage', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          contextPercent: 45,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('45% ctx');
      });

      it('should show context with compact percent when both provided', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          contextPercent: 45,
          compactPercent: 32,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('45% ctx (32% to compact)');
      });

      it('should show compact soon when compactPercent <= 0', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          contextPercent: 80,
          compactPercent: -2,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('80% ctx (compact soon)');
      });

      it('should show just ctx when no compactPercent', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          contextPercent: 50,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('50% ctx');
        expect(contextText).not.toContain('to compact');
        expect(contextText).not.toContain('compact soon');
      });

      it('should show cost', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          costUsd: 0.0123,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('$0.0123');
      });

      it('should show duration', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          elapsedMs: 12345,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('12.3s');
      });

      it('should NOT include Abort button', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
        });

        const actionsBlock = blocks.find((b: any) => b.type === 'actions');
        expect(actionsBlock).toBeUndefined();
      });
    });

    describe('error status', () => {
      it('should show Error header', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'error',
          errorMessage: 'Something went wrong',
        });

        expect(blocks).toHaveLength(2);
        expect((blocks[0] as any).text.text).toContain('Error');
      });

      it('should show error message', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'error',
          errorMessage: 'Connection timeout',
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('Connection timeout');
      });

      it('should show Unknown error when no message provided', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'error',
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('Unknown error');
      });
    });

    describe('aborted status', () => {
      it('should show Aborted header', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'aborted',
          model: 'claude-sonnet',
        });

        expect(blocks).toHaveLength(2);
        expect((blocks[0] as any).text.text).toContain('Aborted');
      });

      it('should show mode and aborted in status', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'aborted',
          model: 'claude-opus',
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('Plan');
        expect(contextText).toContain('claude-opus');
        expect(contextText).toContain('aborted');
      });
    });

    describe('spinner display', () => {
      it('should include spinner in starting status header', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'starting',
          spinner: '◐',
        });

        const headerText = (blocks[0] as any).text.text;
        expect(headerText).toContain('Claude is working');
        expect(headerText).toContain('◐');
      });

      it('should include spinner in thinking status header', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'thinking',
          spinner: '◓',
        });

        const headerText = (blocks[0] as any).text.text;
        expect(headerText).toContain('Claude is working');
        expect(headerText).toContain('◓');
      });

      it('should include spinner in tool status header', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'tool',
          currentTool: 'Read',
          spinner: '◑',
        });

        const headerText = (blocks[0] as any).text.text;
        expect(headerText).toContain('Claude is working');
        expect(headerText).toContain('◑');
      });

      it('should handle missing spinner gracefully', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'thinking',
        });

        const headerText = (blocks[0] as any).text.text;
        expect(headerText).toContain('Claude is working');
        // Should not crash without spinner
      });
    });

    describe('mode labels', () => {
      it('should display Plan for plan mode', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'starting',
          mode: 'plan',
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('Plan');
      });

      it('should display Default for default mode', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'starting',
          mode: 'default',
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('Default');
      });

      it('should display Bypass for bypassPermissions mode', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'starting',
          mode: 'bypassPermissions',
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('Bypass');
      });

      it('should display AcceptEdits for acceptEdits mode', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'starting',
          mode: 'acceptEdits',
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('AcceptEdits');
      });
    });

    describe('rate limit display', () => {
      it('should show rate limit count in thinking status when > 0', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'thinking',
          rateLimitHits: 3,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain(':warning:');
        expect(contextText).toContain('3 rate limits');
      });

      it('should show singular "rate limit" when count is 1', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'thinking',
          rateLimitHits: 1,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('1 rate limit');
        expect(contextText).not.toContain('1 rate limits');
      });

      it('should NOT show rate limit when count is 0', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'thinking',
          rateLimitHits: 0,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).not.toContain('rate limit');
      });

      it('should NOT show rate limit when undefined', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'thinking',
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).not.toContain('rate limit');
      });

      it('should show rate limit count in tool status', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'tool',
          currentTool: 'Read',
          rateLimitHits: 2,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain('2 rate limits');
      });

      it('should show rate limit count in complete status', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          rateLimitHits: 5,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).toContain(':warning:');
        expect(contextText).toContain('5 rate limits');
      });

      it('should NOT show rate limit in complete status when count is 0', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'complete',
          rateLimitHits: 0,
        });

        const contextText = (blocks[1] as any).elements[0].text;
        expect(contextText).not.toContain('rate limit');
      });
    });
  });

  describe('buildActivityLogText', () => {
    it('should show analyzing message when empty (fallback)', () => {
      const text = buildActivityLogText([], true);
      expect(text).toContain('Analyzing request');
    });

    it('should show fallback analyzing message when empty even if not in progress', () => {
      // With empty array, fallback shows regardless of inProgress
      const text = buildActivityLogText([], false);
      expect(text).toContain('Analyzing request');
    });

    it('should format starting entry with brain emoji', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':brain:');
      expect(text).toContain('Analyzing request');
    });

    it('should preserve starting entry when other entries are added', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read' },
      ];
      const text = buildActivityLogText(entries, true);
      // Starting entry should still be present
      expect(text).toContain(':brain: *Analyzing request...*');
      // In-progress tool should show with [in progress]
      expect(text).toContain(':mag: *Read* [in progress]');
    });

    it('should show simplified format: completed tools with checkmark, in-progress with emoji', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read' },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 200 },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Edit' },
      ];
      const text = buildActivityLogText(entries, true);
      // Starting entry
      expect(text).toContain(':brain: *Analyzing request...*');
      // Completed tool: checkmark + name + duration (no duplicate tool_start)
      expect(text).toContain(':white_check_mark: *Read* [0.2s]');
      expect(text).not.toContain(':mag: *Read*'); // tool_start for Read should NOT show
      // In-progress tool: emoji + name + [in progress]
      expect(text).toContain(':memo: *Edit* [in progress]');
    });

    it('should not show tool_start for completed tools', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'tool_start', tool: 'Bash' },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Bash', durationMs: 500 },
      ];
      const text = buildActivityLogText(entries, true);
      // Should only show completed entry, not tool_start
      expect(text).toContain(':white_check_mark: *Bash* [0.5s]');
      expect(text).not.toContain(':computer: *Bash*');
    });

    it('should format thinking entries with brain emoji', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: 'Let me analyze this problem...',
          thinkingTruncated: 'Let me analyze this problem...',
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':brain:');
      expect(text).toContain('Thinking');
    });

    it('should show elapsed time for thinking entries', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          durationMs: 500,
          thinkingTruncated: 'test',
        },
      ];
      const text = buildActivityLogText(entries, true);
      // Completed thinking (no thinkingInProgress flag) shows "Thinking" without ellipsis
      expect(text).toContain(':brain: *Thinking* [0.5s]');
    });

    it('should show [in progress] for in-progress tool_start entries', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read', durationMs: 1200 },
      ];
      const text = buildActivityLogText(entries, true);
      // In simplified format, tool_start always shows [in progress]
      expect(text).toContain(':mag: *Read* [in progress]');
    });

    it('should show [in progress] for tool_start without duration', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'tool_start', tool: 'Edit' },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':memo: *Edit* [in progress]');
    });

    it('should show character count for long thinking blocks', () => {
      const longContent = 'A'.repeat(600);
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: longContent,
          thinkingTruncated: '...' + longContent.substring(longContent.length - 500),
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain('[600 chars]');
    });

    it('should show "Thinking..." for in-progress thinking entries', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: 'Let me analyze...',
          thinkingTruncated: 'Let me analyze...',
          thinkingInProgress: true,
          durationMs: 1500,
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':brain: *Thinking...*');
      expect(text).toContain('[1.5s]');
      expect(text).toContain('[17 chars]');
    });

    it('should show rolling window preview for in-progress thinking', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: 'A'.repeat(600),
          thinkingTruncated: '...' + 'B'.repeat(500), // Rolling window with ... prefix
          thinkingInProgress: true,
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':brain: *Thinking...*');
      expect(text).toContain('[600 chars]');
      // Should show preview with "..." prefix since it's a rolling window
      expect(text).toContain('> ...');
      expect(text).toContain('BBBB');
    });

    it('should show "Thinking" (not "Thinking...") for completed thinking entries', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: 'Full thinking content here',
          thinkingTruncated: 'Full thinking content here',
          thinkingInProgress: false,
          durationMs: 2000,
        },
      ];

      const text = buildActivityLogText(entries, true);
      // Completed: should show "Thinking" without ellipsis
      expect(text).toContain(':brain: *Thinking*');
      expect(text).not.toContain(':brain: *Thinking...*');
      expect(text).toContain('[2.0s]');
    });

    it('should show full content for short completed thinking (under 500 chars)', () => {
      const shortContent = 'A'.repeat(300);
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: shortContent,
          thinkingTruncated: shortContent,
          thinkingInProgress: false,
        },
      ];

      const text = buildActivityLogText(entries, true);
      // Completed: shows full content when under 500 chars (no truncation needed)
      expect(text).toContain('> ' + 'A'.repeat(300));
    });

    it('should show last 500 chars for completed long thinking (conclusion)', () => {
      // Simulate long thinking where thinkingTruncated already has "..." + last 500 chars
      // Full content: BEGINNING (10) + X's (600) + CONCLUSION (10) = 620 chars
      // thinkingTruncated: "..." + last 500 = "..." + X's (490) + CONCLUSION (10)
      // Display should show the CONCLUSION at the end, not the beginning
      const fullContent = 'BEGINNING_' + 'X'.repeat(600) + 'CONCLUSION';
      const truncated = '...' + fullContent.substring(fullContent.length - 500);
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: fullContent,
          thinkingTruncated: truncated,
          thinkingInProgress: false,
        },
      ];

      const text = buildActivityLogText(entries, true);
      // Should show "..." prefix (indicates truncation from beginning)
      expect(text).toContain('> ...');
      // Should NOT contain beginning of thinking
      expect(text).not.toContain('BEGINNING_');
      // Should contain the CONCLUSION at the end
      expect(text).toContain('CONCLUSION');
    });

    it('should show END of thinking, not middle, for very long content', () => {
      // This is the key regression test: ensure we show the CONCLUSION, not the MIDDLE
      // Full thinking: "I need to analyze..." (beginning) + lots of reasoning + "Therefore the answer is X" (end)
      const beginning = 'I_NEED_TO_ANALYZE_THIS_PROBLEM_FIRST_';
      const middle = 'M'.repeat(800);
      const conclusion = '_THEREFORE_THE_ANSWER_IS_42';
      const fullContent = beginning + middle + conclusion;
      // thinkingTruncated stores last 500 chars (from slack-bot.ts)
      const truncated = '...' + fullContent.substring(fullContent.length - 500);

      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: fullContent,
          thinkingTruncated: truncated,
          thinkingInProgress: false,
        },
      ];

      const text = buildActivityLogText(entries, true);
      // Must NOT show beginning (would indicate wrong truncation)
      expect(text).not.toContain('I_NEED_TO_ANALYZE');
      // Must show the conclusion (the actual answer)
      expect(text).toContain('THEREFORE_THE_ANSWER_IS_42');
      // Should have "..." prefix indicating truncation
      expect(text).toContain('> ...');
    });

    it('should format tool_start entries with appropriate emoji', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read' },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Edit' },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Bash' },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':mag:');
      expect(text).toContain(':memo:');
      expect(text).toContain(':computer:');
    });

    it('should format tool_complete entries with checkmark and duration', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 1500 },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':white_check_mark:');
      expect(text).toContain('*Read*');
      expect(text).toContain('[1.5s]');
    });

    it('should format error entries with x emoji', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'error', message: 'Connection failed' },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':x:');
      expect(text).toContain('Connection failed');
    });

    it('should format in-progress generating entries with pencil emoji and char count', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'generating',
          generatingChunks: 25,
          generatingChars: 1500,
          generatingInProgress: true,
          durationMs: 2500,
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':pencil:');
      expect(text).toContain('*Generating...*');
      expect(text).toContain('[1,500 chars]');
      expect(text).toContain('[2.5s]');
    });

    it('should format completed generating entries without chunk count', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'generating',
          generatingChunks: 50,
          generatingChars: 3200,
          generatingInProgress: false,
          durationMs: 4000,
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':pencil:');
      expect(text).toContain('*Response*');
      expect(text).toContain('[4.0s]');
      expect(text).toContain('[3,200 chars]');
      // Completed should NOT show chunk count (cleaner)
      expect(text).not.toContain('chunks');
    });

    it('should show generating activity alongside other entries', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'thinking', thinkingTruncated: 'Analyzing...', thinkingInProgress: false, durationMs: 1000 },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 500 },
        { timestamp: Date.now(), type: 'generating', generatingChunks: 30, generatingChars: 2000, generatingInProgress: true, durationMs: 1500 },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':brain:'); // Thinking
      expect(text).toContain(':white_check_mark:'); // Tool complete
      expect(text).toContain(':pencil:'); // Generating
      expect(text).toContain('*Generating...*');
    });

    it('should show multiple generating entries when tools run between them', () => {
      // Simulates: text → tool → text (should show 2 generating entries)
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        // First generating block (before tool)
        { timestamp: Date.now(), type: 'generating', generatingChunks: 10, generatingChars: 500, generatingInProgress: false, durationMs: 1000 },
        // Tool runs
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Task', durationMs: 3000 },
        // Second generating block (after tool) - should be a NEW entry
        { timestamp: Date.now(), type: 'generating', generatingChunks: 25, generatingChars: 1500, generatingInProgress: true, durationMs: 2000 },
      ];

      const text = buildActivityLogText(entries, true);
      // Should have two pencil entries
      const pencilMatches = text.match(/:pencil:/g) || [];
      expect(pencilMatches.length).toBe(2);
      // First one should be completed (Response), second in-progress (Generating...)
      expect(text).toContain('*Response*');
      expect(text).toContain('*Generating...*');
      // Tool should be between them
      expect(text).toContain(':white_check_mark:');
    });

    it('should show Response (not Generating) for completed generating entries', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'generating', generatingChunks: 50, generatingChars: 3000, generatingInProgress: false, durationMs: 5000 },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':pencil:');
      expect(text).toContain('*Response*');
      expect(text).not.toContain('*Generating...*');
      expect(text).toContain('[5.0s]');
      expect(text).toContain('[3,000 chars]');
    });

    it('should show finalized generating entry created during tool execution', () => {
      // Simulates: tool starts → generating during execution → tool completes
      // The generating entry should be finalized (Response) and appear before tool_complete
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Task' },
        // Generating created DURING tool execution (e.g., from assistant messages)
        { timestamp: Date.now(), type: 'generating', generatingChunks: 30, generatingChars: 2000, generatingInProgress: false, durationMs: 8900 },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Task', durationMs: 3400 },
      ];

      const text = buildActivityLogText(entries, true);
      // Generating should show as Response (finalized), not Generating...
      expect(text).toContain(':pencil:');
      expect(text).toContain('*Response*');
      expect(text).not.toContain('*Generating...*');
      // Tool should show as complete
      expect(text).toContain(':white_check_mark:');
      expect(text).toContain('*Task*');
      expect(text).toContain('[3.4s]');
      // Response should appear (tool_start is hidden since tool_complete exists)
      expect(text).toContain('[8.9s]');
      expect(text).toContain('[2,000 chars]');
    });

    it('should apply rolling window when entries exceed MAX_LIVE_ENTRIES', () => {
      // Create 310 entries (> 300 MAX_LIVE_ENTRIES)
      const entries: ActivityEntry[] = [];
      for (let i = 0; i < 310; i++) {
        entries.push({ timestamp: Date.now(), type: 'tool_start', tool: `Tool${i}` });
      }

      const text = buildActivityLogText(entries, true);
      // Should show truncation notice
      expect(text).toContain('earlier entries');
      expect(text).toContain('see full log');
      // Should only show last ROLLING_WINDOW_SIZE (20) entries
      expect(text).toContain('Tool309');
      expect(text).toContain('Tool290');
      expect(text).not.toContain('Tool0');
    });

    it('should show preview of thinking content', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: 'This is my analysis of the problem at hand.',
          thinkingTruncated: 'This is my analysis of the problem at hand.',
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain('This is my analysis');
    });

    it('should show preview of response content for completed generating entries', () => {
      const responseContent = 'Here is the response text from Claude.';
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'generating',
          generatingChunks: 10,
          generatingChars: responseContent.length,
          generatingInProgress: false,
          generatingContent: responseContent,
          generatingTruncated: responseContent,
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':pencil:');
      expect(text).toContain('*Response*');
      expect(text).toContain(`[${responseContent.length} chars]`);
      // Should show preview of response content in quote
      expect(text).toContain('> Here is the response text from Claude.');
    });

    it('should show preview of response content for in-progress generating entries', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'generating',
          generatingChunks: 5,
          generatingChars: 100,
          generatingInProgress: true,
          generatingContent: 'Generating this response...',
          generatingTruncated: 'Generating this response...',
          durationMs: 1500,
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':pencil:');
      expect(text).toContain('*Generating...*');
      expect(text).toContain('[1.5s]');
      // Should show preview of response content in quote
      expect(text).toContain('> Generating this response...');
    });

    it('should truncate long response content preview to 300 chars', () => {
      const longContent = 'A'.repeat(400);
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'generating',
          generatingChunks: 20,
          generatingChars: 400,
          generatingInProgress: false,
          generatingContent: longContent,
          generatingTruncated: longContent,
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain('[400 chars]');
      // Should truncate to 300 chars with ...
      expect(text).toContain('A'.repeat(300) + '...');
      expect(text).not.toContain('A'.repeat(301));
    });

    it('should use generatingTruncated when generatingContent is not available', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'generating',
          generatingChunks: 8,
          generatingChars: 200,
          generatingInProgress: false,
          generatingTruncated: 'This is truncated content...',
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain('> This is truncated content...');
    });

    it('should show aborted message for aborted entry', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'test', thinkingInProgress: false },
        { timestamp: Date.now(), type: 'aborted' },
      ];
      const text = buildActivityLogText(entries, false);
      expect(text).toContain(':octagonal_sign:');
      expect(text).toContain('Aborted by user');
    });

    it('should show aborted as last entry in activity log', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Bash', durationMs: 1000 },
        { timestamp: Date.now(), type: 'aborted' },
      ];
      const text = buildActivityLogText(entries, false);
      const lines = text.split('\n');
      const lastNonEmptyLine = lines.filter(l => l.trim()).pop();
      expect(lastNonEmptyLine).toContain('Aborted by user');
    });

    it('should format mode_changed entry with gear emoji', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'mode_changed', mode: 'plan' },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':gear:');
      expect(text).toContain('Mode changed to *plan*');
    });

    it('should show mode_changed after starting entry', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'mode_changed', mode: 'bypassPermissions' },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read' },
      ];
      const text = buildActivityLogText(entries, true);
      const lines = text.split('\n').filter(l => l.trim());
      // Order: starting, mode_changed, tool
      expect(lines[0]).toContain('Analyzing request');
      expect(lines[1]).toContain('Mode changed to *bypassPermissions*');
      expect(lines[2]).toContain('Read');
    });

    it('should format context_cleared entry as separator line', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'context_cleared' },
        { timestamp: Date.now(), type: 'mode_changed', mode: 'bypassPermissions' },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain('────── Context Cleared ──────');
    });

    it('should show context_cleared before mode_changed in plan approval flow', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'ExitPlanMode' },
        { timestamp: Date.now(), type: 'context_cleared' },
        { timestamp: Date.now(), type: 'mode_changed', mode: 'bypassPermissions' },
      ];
      const text = buildActivityLogText(entries, true);
      const lines = text.split('\n').filter(l => l.trim());
      // Find context_cleared and mode_changed indices
      const contextClearedIndex = lines.findIndex(l => l.includes('Context Cleared'));
      const modeChangedIndex = lines.findIndex(l => l.includes('Mode changed'));
      expect(contextClearedIndex).toBeGreaterThan(-1);
      expect(modeChangedIndex).toBeGreaterThan(-1);
      expect(contextClearedIndex).toBeLessThan(modeChangedIndex);
    });

    it('should format session_changed entry with bookmark emoji and session ID', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'session_changed', previousSessionId: '550e8400-e29b-41d4-a716-446655440000' },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain(':bookmark:');
      expect(text).toContain('Previous session:');
      expect(text).toContain('`550e8400-e29b-41d4-a716-446655440000`');
    });

    it('should show session_changed before context_cleared and mode_changed in plan approval flow', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'session_changed', previousSessionId: 'old-session-uuid' },
        { timestamp: Date.now(), type: 'context_cleared' },
        { timestamp: Date.now(), type: 'mode_changed', mode: 'bypassPermissions' },
      ];
      const text = buildActivityLogText(entries, true);
      const lines = text.split('\n').filter(l => l.trim());
      // Find indices
      const sessionChangedIndex = lines.findIndex(l => l.includes('Previous session'));
      const contextClearedIndex = lines.findIndex(l => l.includes('Context Cleared'));
      const modeChangedIndex = lines.findIndex(l => l.includes('Mode changed'));
      expect(sessionChangedIndex).toBeGreaterThan(-1);
      expect(contextClearedIndex).toBeGreaterThan(-1);
      expect(modeChangedIndex).toBeGreaterThan(-1);
      expect(sessionChangedIndex).toBeLessThan(contextClearedIndex);
      expect(contextClearedIndex).toBeLessThan(modeChangedIndex);
    });

    it('should not show session_changed entry when previousSessionId is missing', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'session_changed' }, // No previousSessionId
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).not.toContain(':bookmark:');
      expect(text).not.toContain('Previous session');
    });

    // Clickable activity links tests
    it('should make activity labels clickable when threadMessageLink is set', () => {
      const permalink = 'https://slack.com/archives/C123/p1234567890123456';
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting', threadMessageLink: permalink },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain(`<${permalink}|Analyzing request...>`);
    });

    it('should make thinking label clickable when threadMessageLink is set', () => {
      const permalink = 'https://slack.com/archives/C123/p1234567890123456';
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: 'Analyzing...',
          thinkingTruncated: 'Analyzing...',
          threadMessageLink: permalink,
        },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain(`<${permalink}|Thinking>`);
    });

    it('should make tool_complete label clickable when threadMessageLink is set', () => {
      const permalink = 'https://slack.com/archives/C123/p1234567890123456';
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'tool_complete',
          tool: 'Read',
          durationMs: 500,
          threadMessageLink: permalink,
        },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain(`<${permalink}|Read>`);
    });

    it('should make generating/Response label clickable when threadMessageLink is set', () => {
      const permalink = 'https://slack.com/archives/C123/p1234567890123456';
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'generating',
          generatingChars: 500,
          generatingInProgress: false,
          threadMessageLink: permalink,
        },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain(`<${permalink}|Response>`);
    });

    it('should make error label clickable when threadMessageLink is set', () => {
      const permalink = 'https://slack.com/archives/C123/p1234567890123456';
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'error',
          message: 'Something went wrong',
          threadMessageLink: permalink,
        },
      ];
      const text = buildActivityLogText(entries, true);
      expect(text).toContain(`<${permalink}|Error>`);
    });

    it('should make aborted label clickable when threadMessageLink is set', () => {
      const permalink = 'https://slack.com/archives/C123/p1234567890123456';
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'aborted', threadMessageLink: permalink },
      ];
      const text = buildActivityLogText(entries, false);
      expect(text).toContain(`<${permalink}|Aborted by user>`);
    });

    it('should render plain labels when threadMessageLink is not set', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 500 },
      ];
      const text = buildActivityLogText(entries, true);
      // Should NOT have link syntax
      expect(text).not.toContain('<https://');
      expect(text).toContain('Analyzing request...');
      expect(text).toContain('*Read*');
    });

    it('should escape pipe characters in labels to prevent link parsing issues', () => {
      // Pipe characters in Slack mrkdwn links need escaping
      const result = linkifyActivityLabel('Test|Label', 'https://example.com');
      expect(result).toContain('Test¦Label');
      expect(result).not.toContain('Test|Label');
    });
  });

  describe('linkifyActivityLabel', () => {
    it('should wrap label with Slack mrkdwn link when link is provided', () => {
      const result = linkifyActivityLabel('Thinking', 'https://slack.com/archives/C123/p123');
      expect(result).toBe('<https://slack.com/archives/C123/p123|Thinking>');
    });

    it('should return plain label when no link is provided', () => {
      const result = linkifyActivityLabel('Thinking');
      expect(result).toBe('Thinking');
    });

    it('should return plain label when link is undefined', () => {
      const result = linkifyActivityLabel('Thinking', undefined);
      expect(result).toBe('Thinking');
    });

    it('should escape pipe characters in label', () => {
      const result = linkifyActivityLabel('Label|With|Pipes', 'https://example.com');
      expect(result).toBe('<https://example.com|Label¦With¦Pipes>');
    });
  });

  describe('buildLiveActivityBlocks', () => {
    it('should show activity text in section', () => {
      const entries: ActivityEntry[] = [{
        timestamp: Date.now(),
        type: 'tool_complete',
        tool: 'Read',
        durationMs: 1500,
      }];
      const blocks = buildLiveActivityBlocks(entries);

      expect(blocks[0].type).toBe('section');
      const sectionText = (blocks[0] as any).text.text;
      expect(sectionText).toContain('Read');
    });
  });

  describe('activity log accumulation', () => {
    it('should show completed tools and in-progress tools correctly', () => {
      const activityLog: ActivityEntry[] = [];

      // Simulate multiple tool starts and completions
      activityLog.push({ timestamp: 1000, type: 'tool_start', tool: 'Read' });
      activityLog.push({ timestamp: 2000, type: 'tool_complete', tool: 'Read', durationMs: 700 });
      activityLog.push({ timestamp: 3000, type: 'tool_start', tool: 'Edit' });

      const text = buildActivityLogText(activityLog, true);

      // Completed tool shows with checkmark and duration
      expect(text).toContain(':white_check_mark: *Read* [0.7s]');
      // In-progress tool shows with emoji and [in progress]
      expect(text).toContain(':memo: *Edit* [in progress]');
      // tool_start for completed Read should NOT show
      expect(text).not.toContain(':mag: *Read*');
      expect(activityLog.length).toBe(3);
    });

    it('should show all thinking blocks', () => {
      const entries: ActivityEntry[] = [
        { timestamp: 1000, type: 'thinking', durationMs: 200, thinkingTruncated: 'First thought' },
        { timestamp: 2000, type: 'tool_start', tool: 'Read' },
        { timestamp: 3000, type: 'thinking', durationMs: 800, thinkingTruncated: 'Second thought' },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain('First thought');
      expect(text).toContain('Second thought');
      expect(text).toContain('[0.2s]');
      expect(text).toContain('[0.8s]');
    });
  });

  describe('spinner cycling', () => {
    it('should cycle through spinner frames correctly', () => {
      const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
      let spinnerIndex = 0;

      const results: string[] = [];
      for (let i = 0; i < 6; i++) {
        results.push(SPINNER_FRAMES[spinnerIndex]);
        spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      }

      expect(results).toEqual(['◐', '◓', '◑', '◒', '◐', '◓']);
    });

    it('should show spinner in status panel for starting status', () => {
      const blocks = buildStatusPanelBlocks({
        status: 'starting',
        mode: 'plan',
        toolsCompleted: 0,
        elapsedMs: 0,
        conversationKey: 'test',
        spinner: '◐',
      });
      const text = JSON.stringify(blocks);
      expect(text).toContain('Claude is working');
      expect(text).toContain('◐');
    });

    it('should show spinner in status panel for thinking status', () => {
      const blocks = buildStatusPanelBlocks({
        status: 'thinking',
        mode: 'plan',
        toolsCompleted: 0,
        elapsedMs: 5000,
        conversationKey: 'test',
        spinner: '◓',
      });
      const text = JSON.stringify(blocks);
      expect(text).toContain('Claude is working');
      expect(text).toContain('◓');
    });

    it('should show spinner in status panel for tool status', () => {
      const blocks = buildStatusPanelBlocks({
        status: 'tool',
        mode: 'plan',
        currentTool: 'Read',
        toolsCompleted: 1,
        elapsedMs: 3000,
        conversationKey: 'test',
        spinner: '◑',
      });
      const text = JSON.stringify(blocks);
      expect(text).toContain('Claude is working');
      expect(text).toContain('◑');
    });

    it('should show spinner and Generating status in status panel', () => {
      const blocks = buildStatusPanelBlocks({
        status: 'generating',
        mode: 'plan',
        toolsCompleted: 2,
        elapsedMs: 8000,
        conversationKey: 'test',
        spinner: '◒',
      });
      const text = JSON.stringify(blocks);
      expect(text).toContain('Claude is working');
      expect(text).toContain('◒');
      expect(text).toContain('Generating...');
    });

    it('should show spinner immediately on initial status panel (spinner provided)', () => {
      // This tests that initial status panel gets spinner from SPINNER_FRAMES[0]
      const blocks = buildStatusPanelBlocks({
        status: 'starting',
        mode: 'plan',
        toolsCompleted: 0,
        elapsedMs: 0,
        conversationKey: 'test',
        spinner: '◐',  // First spinner frame
      });
      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock?.text?.text).toContain('◐');
    });
  });

  describe('modelUsage dictionary access', () => {
    it('should correctly access contextWindow from modelUsage dictionary', () => {
      // Simulate SDK result message structure
      const resultMsg = {
        type: 'result',
        modelUsage: {
          'claude-sonnet-4-20250514': {
            inputTokens: 1234,
            outputTokens: 567,
            contextWindow: 200000,
            costUSD: 0.0123,
          },
        },
        total_cost_usd: 0.0123,
      };

      const model = 'claude-sonnet-4-20250514';
      const modelData = resultMsg.modelUsage[model];

      expect(modelData).toBeDefined();
      expect(modelData.contextWindow).toBe(200000);
      expect(modelData.inputTokens).toBe(1234);
      expect(modelData.outputTokens).toBe(567);
      expect(modelData.costUSD).toBe(0.0123);
    });

    it('should return undefined for unknown model', () => {
      const resultMsg = {
        modelUsage: {
          'claude-sonnet-4-20250514': {
            contextWindow: 200000,
          },
        },
      };

      const unknownModelData = resultMsg.modelUsage['unknown-model'];
      expect(unknownModelData).toBeUndefined();
    });
  });

  describe('context percentage calculation with cache tokens', () => {
    // Helper function that mirrors the actual calculation in slack-bot.ts
    const calculateContextPercent = (
      inputTokens: number,
      cacheReadInputTokens: number,
      contextWindow: number
    ): number | undefined => {
      const totalContextTokens = inputTokens + cacheReadInputTokens;
      return contextWindow && totalContextTokens > 0
        ? Math.round((totalContextTokens / contextWindow) * 100)
        : undefined;
    };

    it('should calculate context % including cache read tokens', () => {
      // Simulates: 8 input tokens + 45726 cache read tokens = 45734 total
      const inputTokens = 8;
      const cacheReadInputTokens = 45726;
      const contextWindow = 200000;

      const contextPercent = calculateContextPercent(inputTokens, cacheReadInputTokens, contextWindow);

      // 45734 / 200000 * 100 = 22.867 -> rounds to 23
      expect(contextPercent).toBe(23);
    });

    it('should return 0% for very small token counts without cache', () => {
      const inputTokens = 8;
      const cacheReadInputTokens = 0;
      const contextWindow = 200000;

      const contextPercent = calculateContextPercent(inputTokens, cacheReadInputTokens, contextWindow);

      // 8 / 200000 * 100 = 0.004 -> rounds to 0
      expect(contextPercent).toBe(0);
    });

    it('should calculate 50% correctly', () => {
      const inputTokens = 1000;
      const cacheReadInputTokens = 99000;
      const contextWindow = 200000;

      const contextPercent = calculateContextPercent(inputTokens, cacheReadInputTokens, contextWindow);

      // 100000 / 200000 * 100 = 50
      expect(contextPercent).toBe(50);
    });

    it('should return undefined when contextWindow is 0', () => {
      const inputTokens = 1000;
      const cacheReadInputTokens = 1000;
      const contextWindow = 0;

      const contextPercent = calculateContextPercent(inputTokens, cacheReadInputTokens, contextWindow);

      expect(contextPercent).toBeUndefined();
    });

    it('should return undefined when no tokens used', () => {
      const inputTokens = 0;
      const cacheReadInputTokens = 0;
      const contextWindow = 200000;

      const contextPercent = calculateContextPercent(inputTokens, cacheReadInputTokens, contextWindow);

      expect(contextPercent).toBeUndefined();
    });

    it('should handle high context utilization', () => {
      const inputTokens = 10000;
      const cacheReadInputTokens = 170000;
      const contextWindow = 200000;

      const contextPercent = calculateContextPercent(inputTokens, cacheReadInputTokens, contextWindow);

      // 180000 / 200000 * 100 = 90
      expect(contextPercent).toBe(90);
    });
  });

  describe('buildActivityLogText with maxChars', () => {
    it('should return full text when under maxChars limit', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 500 },
      ];
      const text = buildActivityLogText(entries, true, 5000);
      expect(text).toContain(':brain:');
      expect(text).toContain(':white_check_mark: *Read*');
      // Should NOT start with "..." (truncation indicator), but may contain "..." in content like "Analyzing request..."
      expect(text.startsWith('...')).toBe(false);
    });

    it('should truncate from start when exceeds maxChars', () => {
      const entries: ActivityEntry[] = [];
      // Create enough entries to exceed 200 chars
      for (let i = 0; i < 20; i++) {
        entries.push({ timestamp: Date.now(), type: 'tool_complete', tool: `Tool${i}`, durationMs: 100 });
      }
      const text = buildActivityLogText(entries, true, 200);
      // Should start with truncation indicator
      expect(text.startsWith('...')).toBe(true);
      // Should show most recent entries
      expect(text).toContain('Tool19');
    });

    it('should truncate at newline boundary', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'FirstTool', durationMs: 100 },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'SecondTool', durationMs: 100 },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'ThirdTool', durationMs: 100 },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'FourthTool', durationMs: 100 },
      ];
      const text = buildActivityLogText(entries, true, 100);
      // Should have "..." followed by newline when truncating at line boundary
      expect(text.startsWith('...')).toBe(true);
    });

    it('should default to unlimited when maxChars not provided', () => {
      const entries: ActivityEntry[] = [];
      for (let i = 0; i < 50; i++) {
        entries.push({ timestamp: Date.now(), type: 'tool_complete', tool: `Tool${i}`, durationMs: 100 });
      }
      const text = buildActivityLogText(entries, true);
      // Should contain all entries without truncation
      expect(text).toContain('Tool0');
      expect(text).toContain('Tool49');
      expect(text.startsWith('...')).toBe(false);
    });

    it('should respect ACTIVITY_LOG_MAX_CHARS constant', () => {
      // Verify the constant is exported and has expected value
      expect(ACTIVITY_LOG_MAX_CHARS).toBe(1000);
    });
  });

  describe('buildCombinedStatusBlocks', () => {
    const baseParams = {
      status: 'starting' as const,
      mode: 'bypassPermissions' as const,
      toolsCompleted: 0,
      elapsedMs: 0,
      conversationKey: 'C123_thread456',
      spinner: '◐',
    };

    describe('in-progress state', () => {
      it('should return activity + spinner + status + buttons', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          activityLog: entries,
          inProgress: true,
          sessionId: 'abc123',
        });

        // Should have 4 blocks: activity, spinner, status line, buttons
        expect(blocks.length).toBe(4);
        // First block should be activity log section
        expect(blocks[0].type).toBe('section');
        expect((blocks[0] as any).text.text).toContain(':brain:');
        // Second should be spinner + elapsed
        expect(blocks[1].type).toBe('context');
        expect((blocks[1] as any).elements[0].text).toContain('◐');
        // Third should be unified status line
        expect(blocks[2].type).toBe('context');
        expect((blocks[2] as any).elements[0].text).toContain('bypass');
        expect((blocks[2] as any).elements[0].text).toContain('abc123');
        // Fourth should be Abort button
        expect(blocks[3].type).toBe('actions');
        expect((blocks[3] as any).elements.length).toBe(1);
        expect((blocks[3] as any).elements[0].text.text).toBe('Abort');
      });

      it('should show n/a for model and sessionId when not yet available', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          activityLog: entries,
          inProgress: true,
          // no model, no sessionId
        });

        // Status line is blocks[2] (after activity and spinner)
        const statusLine = (blocks[2] as any).elements[0].text;
        expect(statusLine).toContain('n/a');
      });

      it('should show [new] prefix for new sessions', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          activityLog: entries,
          inProgress: true,
          sessionId: 'new-session-id',
          isNewSession: true,
        });

        // Status line is blocks[2] (after activity and spinner)
        const statusLine = (blocks[2] as any).elements[0].text;
        expect(statusLine).toContain('[new]');
        expect(statusLine).toContain('new-session-id');
      });

      it('should show rate limits in unified status line (no separate block)', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          activityLog: entries,
          inProgress: true,
          rateLimitHits: 3,
        });

        // Still 4 blocks: activity, spinner, status line (with rate limits), buttons
        expect(blocks.length).toBe(4);
        // Status line should contain rate limits
        const statusLine = (blocks[2] as any).elements[0].text;
        expect(statusLine).toContain(':warning:');
        expect(statusLine).toContain('3 limits');
        // Buttons should be last
        expect(blocks[3].type).toBe('actions');
      });

      it('should include abort button during processing', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          activityLog: entries,
          inProgress: true,
        });

        const actionsBlock = blocks.find(b => b.type === 'actions');
        expect(actionsBlock).toBeDefined();
        const abortButton = (actionsBlock as any).elements.find(
          (e: any) => e.action_id.startsWith('abort_query_')
        );
        expect(abortButton).toBeDefined();
        expect(abortButton.style).toBe('danger');
      });

      it('should show context% and tokens-to-compact in in-progress status line when provided', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          activityLog: entries,
          inProgress: true,
          sessionId: 'test-session',
          contextPercent: 11.0,
          compactPercent: 84.8,
          tokensToCompact: 131500,
        });

        // Status line is blocks[2] (after activity and spinner)
        const statusLine = (blocks[2] as any).elements[0].text;
        expect(statusLine).toContain('% ctx');
        expect(statusLine).toContain('11');
        expect(statusLine).toMatch(/tok to ⚡/);
      });

      it('should omit context% in in-progress status line when not provided', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          activityLog: entries,
          inProgress: true,
          sessionId: 'test-session',
          // no contextPercent, compactPercent, tokensToCompact
        });

        const statusLine = (blocks[2] as any).elements[0].text;
        expect(statusLine).not.toContain('% ctx');
        expect(statusLine).not.toMatch(/tok to ⚡/);
      });
    });

    describe('completed state', () => {
      it('should show unified stats line on completion', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
          { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 500 },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'complete',
          activityLog: entries,
          inProgress: false,
          model: 'claude-sonnet-4',
          sessionId: 'session-xyz',
          inputTokens: 1500,
          outputTokens: 800,
          contextPercent: 45,
          compactPercent: 30,
          costUsd: 0.05,
          elapsedMs: 5000,
        });

        // Should have 2 blocks: activity, unified stats (no buttons without Fork)
        expect(blocks.length).toBe(2);
        // First is activity log
        expect(blocks[0].type).toBe('section');
        // Second is unified stats line
        expect(blocks[1].type).toBe('context');
        const statsLine = (blocks[1] as any).elements[0].text;
        expect(statsLine).toContain('bypass');
        expect(statsLine).toContain('claude-sonnet-4');
        expect(statsLine).toContain('session-xyz');
        expect(statsLine).toContain('45.0% ctx');
        expect(statsLine).toContain('30.0% to ⚡');
        expect(statsLine).toContain('1.5k/800');
        expect(statsLine).toContain('$0.05');
        expect(statsLine).toContain('5.0s');
        // No actions block when not final segment and no Fork
      });

      it('should show Fork button on final segment', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'complete',
          activityLog: entries,
          inProgress: false,
          isFinalSegment: true,
          forkInfo: { threadTs: 'thread-123', conversationKey: 'C123_thread456' },
        });

        const actionsBlock = blocks.find(b => b.type === 'actions');
        expect(actionsBlock).toBeDefined();
        const forkButton = (actionsBlock as any).elements.find(
          (e: any) => e.action_id.startsWith('fork_here_')
        );
        expect(forkButton).toBeDefined();
        expect(forkButton.text.text).toContain('Fork here');
      });

      it('should NOT show Fork button on non-final segment', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'complete',
          activityLog: entries,
          inProgress: false,
          isFinalSegment: false,
          forkInfo: { threadTs: 'thread-123', conversationKey: 'C123_thread456' },
        });

        // No actions block when not final segment (no Fork, no View Log)
        const actionsBlock = blocks.find(b => b.type === 'actions');
        expect(actionsBlock).toBeUndefined();
      });

      it('should include rate limits in unified stats line at completion', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'complete',
          activityLog: entries,
          inProgress: false,
          rateLimitHits: 2,
          inputTokens: 100,
          elapsedMs: 1000,
        });

        // Find unified stats line (should be context block after activity)
        const contextBlocks = blocks.filter(b => b.type === 'context');
        const statsLine = contextBlocks[contextBlocks.length - 1];
        expect((statsLine as any).elements[0].text).toContain(':warning:');
        expect((statsLine as any).elements[0].text).toContain('2 limits');
      });

      it('should NOT have spinner after completion', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'complete',
          activityLog: entries,
          inProgress: false,
        });

        // Last block should be context (unified stats line), no spinner
        expect(blocks[blocks.length - 1].type).toBe('context');
      });
    });

    describe('aborted state', () => {
      it('should show unified stats line with available data on abort', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'aborted',
          activityLog: entries,
          inProgress: false,
          sessionId: 'session-abc',
          inputTokens: 500,
          outputTokens: 100,
          contextPercent: 20,
          costUsd: 0.02,
          elapsedMs: 3000,
        });

        // Should have unified stats line
        const contextBlocks = blocks.filter(b => b.type === 'context');
        expect(contextBlocks.length).toBe(1); // Just unified stats line
        const statsLine = contextBlocks[0];
        expect((statsLine as any).elements[0].text).toContain('session-abc');
        expect((statsLine as any).elements[0].text).toContain('20.0% ctx');
      });

      it('should NOT show Abort or Fork after abort (no buttons)', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'aborted',
          activityLog: entries,
          inProgress: false,
          isFinalSegment: true,
          forkInfo: { threadTs: 'thread-123', conversationKey: 'C123_thread456' },
        });

        // No actions block after abort (no View Log, no Abort, no Fork)
        const actionsBlock = blocks.find(b => b.type === 'actions');
        expect(actionsBlock).toBeUndefined();
      });

      it('should show aborted entry in activity section above status line', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
          { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 500 },
          { timestamp: Date.now(), type: 'aborted' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'aborted',
          activityLog: entries,
          inProgress: false,
          sessionId: 'session-xyz',
          inputTokens: 200,
          outputTokens: 50,
          elapsedMs: 2000,
        });

        // Activity section is the first block (section type)
        const sectionBlocks = blocks.filter(b => b.type === 'section');
        expect(sectionBlocks.length).toBeGreaterThan(0);
        const activitySection = sectionBlocks[0];
        const activityText = (activitySection as any).text.text;

        // Should contain aborted message in activity section
        expect(activityText).toContain(':octagonal_sign:');
        expect(activityText).toContain('Aborted by user');

        // Verify order: activity section comes before unified stats (context)
        const activityIndex = blocks.indexOf(activitySection);
        const contextBlocks = blocks.filter(b => b.type === 'context');
        const statsBlock = contextBlocks[contextBlocks.length - 1];
        const statsIndex = blocks.indexOf(statsBlock);
        expect(activityIndex).toBeLessThan(statsIndex);
      });
    });

    describe('error state', () => {
      it('should show error message in context when no stats available', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
          { timestamp: Date.now(), type: 'error', message: 'Connection timeout' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'error',
          activityLog: entries,
          inProgress: false,
          errorMessage: 'Connection timeout',
        });

        const contextBlocks = blocks.filter(b => b.type === 'context');
        // Should have error message in a context block
        const errorContext = contextBlocks.find(b =>
          (b as any).elements[0].text.includes(':x:')
        );
        expect(errorContext).toBeDefined();
      });

      it('should show unified stats line when error has stats available', () => {
        const entries: ActivityEntry[] = [
          { timestamp: Date.now(), type: 'starting' },
          { timestamp: Date.now(), type: 'error', message: 'API error' },
        ];
        const blocks = buildCombinedStatusBlocks({
          ...baseParams,
          status: 'error',
          activityLog: entries,
          inProgress: false,
          errorMessage: 'API error',
          model: 'claude-sonnet-4',
          sessionId: 'session-abc',
          inputTokens: 500,
          outputTokens: 100,
          contextPercent: 25,
          costUsd: 0.01,
          elapsedMs: 2000,
        });

        const contextBlocks = blocks.filter(b => b.type === 'context');
        // Should have unified stats line (not error message)
        const statsLine = contextBlocks[0];
        expect((statsLine as any).elements[0].text).toContain('session-abc');
        expect((statsLine as any).elements[0].text).toContain('25.0% ctx');
        expect((statsLine as any).elements[0].text).toContain('$0.01');
        // Should NOT contain error icon in the stats line
        expect((statsLine as any).elements[0].text).not.toContain(':x:');
      });
    });

    it('should truncate activity log to maxChars', () => {
      // Create entries that would exceed ACTIVITY_LOG_MAX_CHARS
      const entries: ActivityEntry[] = [];
      for (let i = 0; i < 100; i++) {
        entries.push({
          timestamp: Date.now(),
          type: 'tool_complete',
          tool: `VeryLongToolNameThatTakesUpSpace${i}`,
          durationMs: 100,
        });
      }
      const blocks = buildCombinedStatusBlocks({
        ...baseParams,
        activityLog: entries,
        inProgress: true,
      });

      // Activity log section is blocks[0] (first block)
      const activitySection = blocks[0];
      expect((activitySection as any).text.text.length).toBeLessThanOrEqual(ACTIVITY_LOG_MAX_CHARS + 100); // Allow some margin
    });

    it('should show correct status during thinking', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'thinking', thinkingContent: 'Analyzing...', thinkingInProgress: true },
      ];
      const blocks = buildCombinedStatusBlocks({
        ...baseParams,
        status: 'thinking',
        activityLog: entries,
        inProgress: true,
      });

      // Activity section is blocks[0] (first block)
      expect((blocks[0] as any).text.text).toContain(':brain:');
      expect((blocks[0] as any).text.text).toContain('Thinking');
    });

    describe('Generate Output button (failed upload retry)', () => {
      const completeBaseParams = {
        activityLog: [{ timestamp: Date.now(), type: 'starting' as const }],
        inProgress: false,
        status: 'complete' as const,
        mode: 'bypassPermissions' as const,
        conversationKey: 'C123_thread456',
        toolsCompleted: 0,
        elapsedMs: 1000,
      };

      it('should show Generate Output button when hasFailedUpload is true', () => {
        const blocks = buildCombinedStatusBlocks({
          ...completeBaseParams,
          hasFailedUpload: true,
          retryUploadInfo: {
            activityLogKey: 'C123_thread456',
            channelId: 'C123',
            threadTs: 'thread456',
            statusMsgTs: '1234567890.123456',
          },
        });

        const actionsBlock = blocks.find(b => b.type === 'actions');
        expect(actionsBlock).toBeDefined();
        const retryButton = (actionsBlock as any).elements.find(
          (e: any) => e.action_id.startsWith('retry_upload_')
        );
        expect(retryButton).toBeDefined();
        expect(retryButton.text.text).toContain('Generate Output');
        expect(retryButton.action_id).toBe('retry_upload_1234567890.123456');
        // Verify value contains JSON with activityLogKey for file lookup
        const value = JSON.parse(retryButton.value);
        expect(value.activityLogKey).toBe('C123_thread456');
        expect(value.channelId).toBe('C123');
        expect(value.threadTs).toBe('thread456');
      });

      it('should NOT show Generate Output button when hasFailedUpload is false', () => {
        const blocks = buildCombinedStatusBlocks({
          ...completeBaseParams,
          hasFailedUpload: false,
          retryUploadInfo: {
            activityLogKey: 'C123_thread456',
            channelId: 'C123',
            statusMsgTs: '1234567890.123456',
          },
        });

        const actionsBlock = blocks.find(b => b.type === 'actions');
        const retryButton = (actionsBlock as any)?.elements?.find(
          (e: any) => e.action_id?.startsWith('retry_upload_')
        );
        expect(retryButton).toBeUndefined();
      });

      it('should NOT show Generate Output button when retryUploadInfo is missing', () => {
        const blocks = buildCombinedStatusBlocks({
          ...completeBaseParams,
          hasFailedUpload: true,
          // retryUploadInfo omitted
        });

        const actionsBlock = blocks.find(b => b.type === 'actions');
        const retryButton = (actionsBlock as any)?.elements?.find(
          (e: any) => e.action_id?.startsWith('retry_upload_')
        );
        expect(retryButton).toBeUndefined();
      });

      it('should NOT show Generate Output button during inProgress', () => {
        const blocks = buildCombinedStatusBlocks({
          ...completeBaseParams,
          inProgress: true,
          status: 'thinking',
          hasFailedUpload: true,
          retryUploadInfo: {
            activityLogKey: 'C123_thread456',
            channelId: 'C123',
            statusMsgTs: '1234567890.123456',
          },
        });

        const actionsBlock = blocks.find(b => b.type === 'actions');
        const retryButton = (actionsBlock as any)?.elements?.find(
          (e: any) => e.action_id?.startsWith('retry_upload_')
        );
        expect(retryButton).toBeUndefined();
      });

      it('should show both Fork and Generate Output buttons together', () => {
        const blocks = buildCombinedStatusBlocks({
          ...completeBaseParams,
          isFinalSegment: true,
          forkInfo: { threadTs: 'thread-123', conversationKey: 'C123_thread456' },
          hasFailedUpload: true,
          retryUploadInfo: {
            activityLogKey: 'C123_thread456',
            channelId: 'C123',
            threadTs: 'thread456',
            statusMsgTs: '1234567890.123456',
          },
        });

        const actionsBlock = blocks.find(b => b.type === 'actions');
        const elements = (actionsBlock as any).elements;

        const forkButton = elements.find((e: any) => e.action_id.startsWith('fork_here_'));
        const retryButton = elements.find((e: any) => e.action_id.startsWith('retry_upload_'));

        expect(forkButton).toBeDefined();
        expect(retryButton).toBeDefined();
      });

      // THREAD vs MAIN CHANNEL PARITY TESTS
      it('should work for main channel (no threadTs)', () => {
        const blocks = buildCombinedStatusBlocks({
          ...completeBaseParams,
          conversationKey: 'C123',  // Main channel - no thread
          hasFailedUpload: true,
          retryUploadInfo: {
            activityLogKey: 'C123_1234567890.000000',  // Main channel uses originalTs
            channelId: 'C123',
            // threadTs: undefined - main channel
            statusMsgTs: '1234567890.123456',
          },
        });

        const actionsBlock = blocks.find(b => b.type === 'actions');
        const retryButton = (actionsBlock as any).elements.find(
          (e: any) => e.action_id.startsWith('retry_upload_')
        );
        expect(retryButton).toBeDefined();
        const value = JSON.parse(retryButton.value);
        expect(value.threadTs).toBeUndefined();
      });

      it('should work for thread (with threadTs)', () => {
        const blocks = buildCombinedStatusBlocks({
          ...completeBaseParams,
          conversationKey: 'C123_thread789',
          hasFailedUpload: true,
          retryUploadInfo: {
            activityLogKey: 'C123_thread789',
            channelId: 'C123',
            threadTs: 'thread789',
            statusMsgTs: '1234567890.123456',
          },
        });

        const actionsBlock = blocks.find(b => b.type === 'actions');
        const retryButton = (actionsBlock as any).elements.find(
          (e: any) => e.action_id.startsWith('retry_upload_')
        );
        expect(retryButton).toBeDefined();
        const value = JSON.parse(retryButton.value);
        expect(value.threadTs).toBe('thread789');
      });
    });
  });

  describe('buildUnifiedStatusLine', () => {
    it('should format mode | model | sessionId', () => {
      const line = buildUnifiedStatusLine('plan', 'claude-sonnet-4', 'abc123');
      expect(line).toBe('_plan | claude-sonnet-4 | abc123_');
    });

    it('should show n/a for missing values', () => {
      const line = buildUnifiedStatusLine('plan');
      expect(line).toBe('_plan | n/a | n/a_');
    });

    it('should show [new] prefix for new sessions', () => {
      const line = buildUnifiedStatusLine('bypassPermissions', 'claude-opus-4', 'new-session', true);
      expect(line).toBe('_bypass | claude-opus-4 | [new] new-session_');
    });

    it('should not show [new] when isNewSession is false', () => {
      const line = buildUnifiedStatusLine('default', 'claude-sonnet-4', 'existing', false);
      expect(line).toBe('_default | claude-sonnet-4 | existing_');
    });

    it('should format percentages with one decimal place', () => {
      const line = buildUnifiedStatusLine(
        'plan',
        'claude-sonnet-4',
        'session123',
        false,
        3,    // contextPercent - should become 3.0%
        30,   // compactPercent - should become 30.0%
      );
      expect(line).toContain('3.0% ctx');
      expect(line).toContain('30.0% to ⚡');
    });

    it('should format all stats when available', () => {
      const line = buildUnifiedStatusLine(
        'plan',
        'claude-sonnet-4',
        'session123',
        false,  // isNewSession
        55,     // contextPercent
        22,     // compactPercent
        34100,  // tokensToCompact (34.1k)
        1200,   // inputTokens
        850,    // outputTokens
        0.12,   // cost
        15000,  // durationMs
      );
      expect(line).toContain('plan');
      expect(line).toContain('claude-sonnet-4');
      expect(line).toContain('session123');
      expect(line).toContain('55.0% ctx (22.0% 34.1k tok to ⚡)');
      expect(line).toContain('1.2k/850');
      expect(line).toContain('$0.12');
      expect(line).toContain('15.0s');
    });

    it('should show just mode/model/session when no stats', () => {
      const line = buildUnifiedStatusLine('acceptEdits', 'claude-opus-4', 'sess-abc');
      expect(line).toBe('_acceptEdits | claude-opus-4 | sess-abc_');
    });

    it('should include rate limit warning as suffix', () => {
      const line = buildUnifiedStatusLine(
        'plan', 'claude-sonnet-4', 'session', false, 45, 30, 46500, 1000, 500, 0.05, 5000, 3
      );
      expect(line).toContain(':warning: 3 limits');
    });

    it('should show rate limits in-progress (no stats, just limits)', () => {
      const line = buildUnifiedStatusLine(
        'plan', 'claude-sonnet-4', 'session', false,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        2
      );
      // Rate limits go on second line since they're part of stats
      expect(line).toBe('_plan | claude-sonnet-4 | session_\n_:warning: 2 limits_');
    });

    it('should show completion stats with rate limits', () => {
      const line = buildUnifiedStatusLine(
        'plan', 'claude-sonnet-4', 'session', false,
        45, 30, 46500, 1500, 800, 0.05, 5000, 3
      );
      expect(line).toContain('45.0% ctx (30.0% 46.5k tok to ⚡)');
      expect(line).toContain('1.5k/800');
      expect(line).toContain('$0.05');
      expect(line).toContain('5.0s');
      expect(line).toContain(':warning: 3 limits');
    });

    it('should display compactPercent as-is for positive, zero, or negative values', () => {
      // Positive compactPercent
      const linePos = buildUnifiedStatusLine('plan', 'claude-sonnet-4', 'session', false, 45, 30);
      expect(linePos).toContain('45.0% ctx (30.0% to ⚡)');

      // Zero compactPercent
      const lineZero = buildUnifiedStatusLine('plan', 'claude-sonnet-4', 'session', false, 80, 0);
      expect(lineZero).toContain('80.0% ctx (0.0% to ⚡)');

      // Negative compactPercent
      const lineNeg = buildUnifiedStatusLine('plan', 'claude-sonnet-4', 'session', false, 80, -5);
      expect(lineNeg).toContain('80.0% ctx (-5.0% to ⚡)');
    });
  });

  describe('formatTokensK', () => {
    it('should format tokens with one decimal in k', () => {
      expect(formatTokensK(67516)).toBe('67.5k');
      expect(formatTokensK(13000)).toBe('13.0k');
      expect(formatTokensK(500)).toBe('0.5k');
      expect(formatTokensK(0)).toBe('0.0k');
      expect(formatTokensK(128808)).toBe('128.8k');
      expect(formatTokensK(105000)).toBe('105.0k');
      expect(formatTokensK(1500)).toBe('1.5k');
    });
  });

  describe('buildStopWatchingButton', () => {
    it('should have danger style and emoji', () => {
      const button = buildStopWatchingButton('session-123');

      expect(button.type).toBe('actions');
      expect(button.block_id).toBe('terminal_watch_session-123');
      expect(button.elements).toHaveLength(1);

      const buttonElement = button.elements[0];
      expect(buttonElement.type).toBe('button');
      expect(buttonElement.style).toBe('danger');
      expect(buttonElement.text.text).toContain('🛑');
      expect(buttonElement.text.text).toContain('Stop Watching');
      expect(buttonElement.text.emoji).toBe(true);
      expect(buttonElement.action_id).toBe('stop_terminal_watch');
    });

    it('should include session ID in value', () => {
      const button = buildStopWatchingButton('my-test-session');
      const value = JSON.parse(button.elements[0].value);
      expect(value.sessionId).toBe('my-test-session');
    });

    it('should generate unique block_id for each session', () => {
      const button1 = buildStopWatchingButton('session-aaa');
      const button2 = buildStopWatchingButton('session-bbb');

      expect(button1.block_id).toBe('terminal_watch_session-aaa');
      expect(button2.block_id).toBe('terminal_watch_session-bbb');
      expect(button1.block_id).not.toBe(button2.block_id);
    });
  });

  describe('buildWatchingStatusSection', () => {
    it('should return actions block with button', () => {
      const block = buildWatchingStatusSection('session-123', 2);

      expect(block.type).toBe('actions');
      expect(block.block_id).toBe('terminal_watch_session-123');
      expect(block.elements).toHaveLength(1);
    });

    it('should have button with update rate in text', () => {
      const block = buildWatchingStatusSection('session-456', 5);
      const button = block.elements![0];

      expect(button.type).toBe('button');
      expect(button.text.text).toContain('🛑');
      expect(button.text.text).toContain('Stop Watching');
      expect(button.text.text).toContain('(5s)');
      expect(button.text.emoji).toBe(true);
      expect(button.action_id).toBe('stop_terminal_watch');
      expect(button.style).toBe('danger');
    });

    it('should include session ID in button value', () => {
      const block = buildWatchingStatusSection('my-session', 3);
      const value = JSON.parse(block.elements![0].value);
      expect(value.sessionId).toBe('my-session');
    });

    it('should include threadTs in button value when provided (for stop button to find watcher)', () => {
      const block = buildWatchingStatusSection('my-session', 3, 'anchor-ts-123');
      const value = JSON.parse(block.elements![0].value);
      expect(value.sessionId).toBe('my-session');
      expect(value.threadTs).toBe('anchor-ts-123');
    });

    it('should have undefined threadTs in button value when not provided', () => {
      const block = buildWatchingStatusSection('my-session', 3);
      const value = JSON.parse(block.elements![0].value);
      expect(value.sessionId).toBe('my-session');
      expect(value.threadTs).toBeUndefined();
    });

    it('should use dynamic update rate in button text', () => {
      const block1 = buildWatchingStatusSection('sess', 2);
      const block2 = buildWatchingStatusSection('sess', 10);

      expect(block1.elements![0].text.text).toContain('(2s)');
      expect(block2.elements![0].text.text).toContain('(10s)');
    });
  });

  describe('buildForkToChannelModalView', () => {
    it('should have callback_id fork_to_channel_modal', () => {
      const view = buildForkToChannelModalView({
        sourceChannelId: 'C123',
        sourceMessageTs: '1234567890.123456',
        conversationKey: 'C123',
      });

      expect(view.callback_id).toBe('fork_to_channel_modal');
    });

    it('should store source info in private_metadata', () => {
      const view = buildForkToChannelModalView({
        sourceChannelId: 'C123',
        sourceMessageTs: '1234567890.123456',
        conversationKey: 'C123_thread',
        threadTs: '1234567890.111111',
      });

      const metadata = JSON.parse(view.private_metadata);
      expect(metadata.sourceChannelId).toBe('C123');
      expect(metadata.sourceMessageTs).toBe('1234567890.123456');
      expect(metadata.conversationKey).toBe('C123_thread');
      expect(metadata.threadTs).toBe('1234567890.111111');
    });

    it('should have channel name input with 80 char max', () => {
      const view = buildForkToChannelModalView({
        sourceChannelId: 'C123',
        sourceMessageTs: '1234567890.123456',
        conversationKey: 'C123',
      });

      const inputBlock = view.blocks.find((b: any) => b.block_id === 'channel_name_block');
      expect(inputBlock).toBeDefined();
      expect(inputBlock.element.type).toBe('plain_text_input');
      expect(inputBlock.element.action_id).toBe('channel_name_input');
      expect(inputBlock.element.max_length).toBe(80);
    });

    it('should have submit and close buttons', () => {
      const view = buildForkToChannelModalView({
        sourceChannelId: 'C123',
        sourceMessageTs: '1234567890.123456',
        conversationKey: 'C123',
      });

      expect(view.submit.text).toBe('Create Channel');
      expect(view.close.text).toBe('Cancel');
    });

    it('should have modal type and title', () => {
      const view = buildForkToChannelModalView({
        sourceChannelId: 'C123',
        sourceMessageTs: '1234567890.123456',
        conversationKey: 'C123',
      });

      expect(view.type).toBe('modal');
      expect(view.title.text).toBe('Fork to New Channel');
    });
  });

  describe('buildAbortConfirmationModalView', () => {
    it('should have callback_id abort_confirmation_modal', () => {
      const view = buildAbortConfirmationModalView({
        abortType: 'query',
        key: 'C123',
        channelId: 'C123',
        messageTs: '1234567890.123456',
      });

      expect(view.callback_id).toBe('abort_confirmation_modal');
    });

    it('should store params in private_metadata', () => {
      const view = buildAbortConfirmationModalView({
        abortType: 'query',
        key: 'C123',
        channelId: 'C123',
        messageTs: '1234567890.123456',
      });

      const metadata = JSON.parse(view.private_metadata!);
      expect(metadata.abortType).toBe('query');
      expect(metadata.key).toBe('C123');
      expect(metadata.channelId).toBe('C123');
      expect(metadata.messageTs).toBe('1234567890.123456');
    });

    it('should have submit Abort and close Cancel buttons', () => {
      const view = buildAbortConfirmationModalView({
        abortType: 'query',
        key: 'C123',
        channelId: 'C123',
        messageTs: '1234567890.123456',
      });

      expect(view.submit!.text).toBe('Abort');
      expect(view.close!.text).toBe('Cancel');
    });

    it('should have modal type and Confirm Abort title', () => {
      const view = buildAbortConfirmationModalView({
        abortType: 'query',
        key: 'C123',
        channelId: 'C123',
        messageTs: '1234567890.123456',
      });

      expect(view.type).toBe('modal');
      expect(view.title.text).toBe('Confirm Abort');
    });

    it('should show query-specific message for query abort type', () => {
      const view = buildAbortConfirmationModalView({
        abortType: 'query',
        key: 'C123',
        channelId: 'C123',
        messageTs: '1234567890.123456',
      });

      const section = view.blocks[0] as any;
      expect(section.text.text).toContain('interrupt Claude\'s current processing');
    });

    it('should show question-specific message for question abort type', () => {
      const view = buildAbortConfirmationModalView({
        abortType: 'question',
        key: 'q123',
        channelId: 'C123',
        messageTs: '1234567890.123456',
      });

      const section = view.blocks[0] as any;
      expect(section.text.text).toContain('abort the current question');
    });

    it('should show SDK question-specific message for sdk_question abort type', () => {
      const view = buildAbortConfirmationModalView({
        abortType: 'sdk_question',
        key: 'sdkq123',
        channelId: 'C123',
        messageTs: '1234567890.123456',
      });

      const section = view.blocks[0] as any;
      expect(section.text.text).toContain('abort Claude\'s question');
    });
  });

  // ============================================================================
  // Thread Activity Formatting Tests
  // ============================================================================

  describe('formatThreadActivityBatch', () => {
    it('should format completed tools with emoji and bullet point details', () => {
      const entries: ActivityEntry[] = [
        { timestamp: 1000, type: 'tool_complete', tool: 'Read', durationMs: 500 },
        { timestamp: 2000, type: 'tool_complete', tool: 'Edit', durationMs: 1200 },
      ];

      const result = formatThreadActivityBatch(entries);

      // Thread format uses tool emoji (not checkmark) and bullet point details
      expect(result).toContain(':mag: *Read*');
      expect(result).toContain('• Duration: 0.5s');
      expect(result).toContain(':memo: *Edit*');
      expect(result).toContain('• Duration: 1.2s');
    });

    it('should show in-progress tools with emoji', () => {
      const entries: ActivityEntry[] = [
        { timestamp: 1000, type: 'tool_start', tool: 'Bash' },
      ];

      const result = formatThreadActivityBatch(entries);

      expect(result).toContain('*Bash* [in progress]');
    });

    it('should hide tool_start when tool_complete exists for same tool', () => {
      const entries: ActivityEntry[] = [
        { timestamp: 1000, type: 'tool_start', tool: 'Read' },
        { timestamp: 2000, type: 'tool_complete', tool: 'Read', durationMs: 500 },
      ];

      const result = formatThreadActivityBatch(entries);

      // Should show completed version with emoji and duration in bullet
      expect(result).toContain(':mag: *Read*');
      expect(result).toContain('• Duration: 0.5s');
      // Should NOT show the in-progress version
      expect(result).not.toContain('[in progress]');
    });

    it('should format starting entry', () => {
      const entries: ActivityEntry[] = [
        { timestamp: 1000, type: 'starting' },
      ];

      const result = formatThreadActivityBatch(entries);

      expect(result).toContain(':brain: *Analyzing request...*');
    });

    it('should format error entry', () => {
      const entries: ActivityEntry[] = [
        { timestamp: 1000, type: 'error', message: 'Connection timeout' },
      ];

      const result = formatThreadActivityBatch(entries);

      expect(result).toContain(':x: *Error:* Connection timeout');
    });

    it('should return empty string for empty entries', () => {
      const result = formatThreadActivityBatch([]);
      expect(result).toBe('');
    });

    it('should strip MCP prefixes from tool names', () => {
      const entries: ActivityEntry[] = [
        { timestamp: 1000, type: 'tool_complete', tool: 'mcp__my-server__custom_tool', durationMs: 300 },
      ];

      const result = formatThreadActivityBatch(entries);

      expect(result).toContain('*custom_tool*');
      expect(result).not.toContain('mcp__');
    });

    it('should format aborted entry for thread posting', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'aborted' },
      ];
      const text = formatThreadActivityBatch(entries);
      expect(text).toContain(':octagonal_sign:');
      expect(text).toContain('Aborted by user');
    });

    it('should format mode_changed entry for thread posting', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'mode_changed', mode: 'plan' },
      ];
      const text = formatThreadActivityBatch(entries);
      expect(text).toContain(':gear:');
      expect(text).toContain('*Mode changed*');
      expect(text).toContain('`plan`');
    });

    it('should show mode_changed in correct order for thread batch', () => {
      const entries: ActivityEntry[] = [
        { timestamp: 1000, type: 'starting' },
        { timestamp: 2000, type: 'mode_changed', mode: 'default' },
        { timestamp: 3000, type: 'tool_complete', tool: 'Read', durationMs: 500 },
      ];
      const text = formatThreadActivityBatch(entries);
      // All three entries should be present
      expect(text).toContain('Analyzing request');
      expect(text).toContain('Mode changed');
      expect(text).toContain('Read');
    });

    it('should format session_changed entry with bookmark emoji and resume hint', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'session_changed', previousSessionId: '550e8400-e29b-41d4-a716-446655440000' },
      ];
      const text = formatThreadActivityBatch(entries);
      expect(text).toContain(':bookmark:');
      expect(text).toContain('*Previous session:*');
      expect(text).toContain('`550e8400-e29b-41d4-a716-446655440000`');
      expect(text).toContain('/resume');
    });

    it('should show session_changed before context_cleared and mode_changed in thread batch', () => {
      const entries: ActivityEntry[] = [
        { timestamp: 1000, type: 'session_changed', previousSessionId: 'old-session-uuid' },
        { timestamp: 2000, type: 'context_cleared' },
        { timestamp: 3000, type: 'mode_changed', mode: 'bypassPermissions' },
      ];
      const text = formatThreadActivityBatch(entries);
      const lines = text.split('\n').filter(l => l.trim());
      // Find indices
      const sessionChangedIndex = lines.findIndex(l => l.includes('Previous session'));
      const contextClearedIndex = lines.findIndex(l => l.includes('Context Cleared'));
      const modeChangedIndex = lines.findIndex(l => l.includes('Mode changed'));
      expect(sessionChangedIndex).toBeGreaterThan(-1);
      expect(contextClearedIndex).toBeGreaterThan(-1);
      expect(modeChangedIndex).toBeGreaterThan(-1);
      expect(sessionChangedIndex).toBeLessThan(contextClearedIndex);
      expect(contextClearedIndex).toBeLessThan(modeChangedIndex);
    });

    it('should not show session_changed entry when previousSessionId is missing', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'session_changed' }, // No previousSessionId
      ];
      const text = formatThreadActivityBatch(entries);
      expect(text).not.toContain(':bookmark:');
      expect(text).not.toContain('Previous session');
    });
  });

  describe('formatThreadThinkingMessage', () => {
    it('should format in-progress thinking with rolling tail', () => {
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: 'I am analyzing the code...',
        thinkingInProgress: true,
        durationMs: 2000,
      };

      const result = formatThreadThinkingMessage(entry, false, 500);

      expect(result).toContain(':brain: *Thinking...*');
      expect(result).toContain('[2.0s]');
      expect(result).toContain('_26 chars_');
      // In-progress shows content directly (rolling tail)
      expect(result).toContain('I am analyzing the code...');
    });

    it('should format completed thinking with markdownToSlack conversion', () => {
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: '**Analysis** complete.',
        thinkingInProgress: false,
        durationMs: 5000,
      };

      const result = formatThreadThinkingMessage(entry, false, 500);

      expect(result).toContain(':bulb: *Thinking*');
      // Duration and char count now included in completed header
      expect(result).toContain('[5.0s]');
      expect(result).toContain('_22 chars_');
      // markdownToSlack converts **Analysis** to *Analysis*
      expect(result).toContain('*Analysis*');
      expect(result).not.toContain('> ');  // No blockquote
    });

    it('should preserve newlines in completed thinking', () => {
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: 'Line 1\nLine 2\nLine 3',
        thinkingInProgress: false,
      };

      const result = formatThreadThinkingMessage(entry, false, 500);

      expect(result).toContain('\n');
      expect(result).not.toContain('Line 1 Line 2');  // Not collapsed
    });

    it('should show truncation notice when truncated (completed)', () => {
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: 'Very long content...',
        thinkingInProgress: false,
      };

      const result = formatThreadThinkingMessage(entry, true, 500);

      expect(result).toContain('_Full content attached._');
    });

    it('should not show truncation notice for in-progress thinking', () => {
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: 'Very long content...',
        thinkingInProgress: true,
      };

      const result = formatThreadThinkingMessage(entry, true, 500);

      expect(result).not.toContain('attached');
    });

    it('should show rolling tail (last N chars) for in-progress thinking', () => {
      const longContent = 'A'.repeat(300) + 'B'.repeat(300);
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: longContent,
        thinkingInProgress: true,
      };

      const result = formatThreadThinkingMessage(entry, false, 500);

      // Should show last 500 chars (rolling tail)
      expect(result).toContain('B'.repeat(300));
      // Should NOT start with A (first 100 chars are cut off)
      expect(result).not.toContain('A'.repeat(300));
    });

    it('should truncate completed thinking at charLimit (from start)', () => {
      const longContent = 'A'.repeat(600);
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: longContent,
        thinkingInProgress: false,
      };

      const result = formatThreadThinkingMessage(entry, false, 500);

      // Should truncate with ... at charLimit (from start)
      expect(result).toContain('A'.repeat(500) + '...');
      expect(result).not.toContain('A'.repeat(501));
    });

    it('should show full content when under charLimit', () => {
      const content = 'A'.repeat(400);
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: content,
        thinkingInProgress: false,
      };

      const result = formatThreadThinkingMessage(entry, false, 500);

      // Should show full content without truncation
      expect(result).toContain('A'.repeat(400));
      expect(result).not.toContain('...');
    });

    it('should respect custom charLimit for completed thinking', () => {
      const content = 'A'.repeat(200);
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: content,
        thinkingInProgress: false,
      };

      // With charLimit 100, content of 200 chars should be truncated
      const result = formatThreadThinkingMessage(entry, false, 100);

      expect(result).toContain('A'.repeat(100) + '...');
      expect(result).not.toContain('A'.repeat(101));
    });

    it('should preserve tail with preserveTail option for completed thinking', () => {
      const content = 'A'.repeat(200) + 'B'.repeat(200);
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: content,
        thinkingInProgress: false,
        durationMs: 3000,
      };

      const result = formatThreadThinkingMessage(entry, true, 200, { preserveTail: true });

      // Should show tail (last 200 chars) with ... prefix
      expect(result).toContain('...' + 'B'.repeat(200));
      // Should NOT start with A (first 200 chars are cut off)
      expect(result).not.toContain('A'.repeat(200));
    });

    it('should include attachment link when provided', () => {
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: 'Long thinking content',
        thinkingInProgress: false,
        durationMs: 5000,
      };

      const result = formatThreadThinkingMessage(entry, true, 500, {
        attachmentLink: 'https://slack.com/archives/C123/p1234567890',
      });

      expect(result).toContain('_Full response <https://slack.com/archives/C123/p1234567890|attached>._');
    });

    it('should not include attachment suffix when truncated but no link provided', () => {
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: 'Long thinking content',
        thinkingInProgress: false,
      };

      const result = formatThreadThinkingMessage(entry, true, 500, { preserveTail: true });

      // No suffix - waiting for upload or showing retry button
      expect(result).not.toContain('attached');
      expect(result).not.toContain('Full response');
    });

    it('should include duration and char count in header for completed thinking', () => {
      const entry: ActivityEntry = {
        timestamp: 1000,
        type: 'thinking',
        thinkingContent: 'Short content',
        thinkingInProgress: false,
        durationMs: 4500,
      };

      const result = formatThreadThinkingMessage(entry, false, 500);

      expect(result).toContain(':bulb: *Thinking*');
      expect(result).toContain('[4.5s]');
      expect(result).toContain('_13 chars_');
    });
  });

  describe('buildAttachThinkingFileButton', () => {
    it('should create actions block with retry button', () => {
      const block = buildAttachThinkingFileButton(
        'activity-ts-123',
        'thread-parent-ts',
        'C123',
        'session-id-abc',
        1700000000000,  // timestamp
        5000            // charCount
      );

      expect(block.type).toBe('actions');
      expect((block as any).block_id).toBe('attach_thinking_activity-ts-123');
      expect((block as any).elements).toHaveLength(1);
      expect((block as any).elements[0].action_id).toBe('attach_thinking_file_activity-ts-123');
      expect((block as any).elements[0].text.text).toBe(':page_facing_up: Attach Response');
    });

    it('should store metadata in button value', () => {
      const block = buildAttachThinkingFileButton(
        'activity-ts-123',
        'thread-parent-ts',
        'C123',
        'session-id-abc',
        1700000000000,
        5000
      );

      const value = JSON.parse((block as any).elements[0].value);
      expect(value.threadParentTs).toBe('thread-parent-ts');
      expect(value.channelId).toBe('C123');
      expect(value.sessionId).toBe('session-id-abc');
      expect(value.thinkingTimestamp).toBe(1700000000000);
      expect(value.thinkingCharCount).toBe(5000);
      expect(value.activityMsgTs).toBe('activity-ts-123');
    });
  });

  describe('formatThreadResponseMessage', () => {
    it('should format response with speech_balloon emoji (same as main channel)', () => {
      const result = formatThreadResponseMessage(1500, 3000, 'Here is my response...', false, 500);

      expect(result).toContain(':speech_balloon: *Response*');
      // No duration/chars in header (simplified format)
      expect(result).not.toContain('[3.0s]');
      expect(result).not.toContain('_1,500 chars_');
      // Content preserved without blockquote
      expect(result).toContain('Here is my response...');
      expect(result).not.toContain('> ');  // No blockquote wrapping
    });

    it('should show truncation notice when truncated', () => {
      const result = formatThreadResponseMessage(5000, 2000, 'Preview text', true, 500);

      expect(result).toContain('_Full content attached._');
    });

    it('should apply markdownToSlack conversion', () => {
      const content = '**bold** and *italic* text';
      const result = formatThreadResponseMessage(100, undefined, content, false, 500);

      expect(result).toContain(':speech_balloon: *Response*');
      // markdownToSlack converts **bold** to *bold* and *italic* to _italic_
      expect(result).toContain('*bold*');
      expect(result).toContain('_italic_');
    });

    it('should preserve newlines (not collapse to spaces)', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const result = formatThreadResponseMessage(100, 1000, content, false, 500);

      // Newlines should be preserved
      expect(result).toContain('\n');
      expect(result).not.toContain('Line 1 Line 2');  // Not collapsed
    });

    it('should truncate at charLimit (after markdown conversion)', () => {
      const longContent = 'B'.repeat(600);
      const result = formatThreadResponseMessage(600, 1000, longContent, false, 500);

      // Should truncate with ... at charLimit
      expect(result).toContain('B'.repeat(500) + '...');
      expect(result).not.toContain('B'.repeat(501));
    });

    it('should show full content when under charLimit', () => {
      const content = 'B'.repeat(400);
      const result = formatThreadResponseMessage(400, 1000, content, false, 500);

      // Should show full content without truncation
      expect(result).toContain('B'.repeat(400));
      expect(result).not.toContain('...');
    });

    it('should respect custom charLimit', () => {
      const content = 'B'.repeat(200);

      // With charLimit 100, content of 200 chars should be truncated
      const result = formatThreadResponseMessage(200, 1000, content, false, 100);

      expect(result).toContain('B'.repeat(100) + '...');
      expect(result).not.toContain('B'.repeat(101));
    });
  });

  describe('formatThreadStartingMessage', () => {
    it('should return starting message', () => {
      const result = formatThreadStartingMessage();
      expect(result).toBe(':brain: *Analyzing request...*');
    });
  });

  describe('formatThreadErrorMessage', () => {
    it('should format error message', () => {
      const result = formatThreadErrorMessage('Connection refused');
      expect(result).toBe(':x: *Error:* Connection refused');
    });
  });

  describe('formatToolInputSummary', () => {
    it('should format Read tool with file path', () => {
      expect(formatToolInputSummary('Read', { file_path: 'src/slack-bot.ts' }))
        .toBe(' `src/slack-bot.ts`');
    });

    it('should format Edit tool with file path', () => {
      expect(formatToolInputSummary('Edit', { file_path: 'src/blocks.ts' }))
        .toBe(' `src/blocks.ts`');
    });

    it('should format Grep tool with pattern', () => {
      expect(formatToolInputSummary('Grep', { pattern: 'ActivityEntry' }))
        .toBe(' `"ActivityEntry"`');
    });

    it('should format Glob tool with pattern', () => {
      expect(formatToolInputSummary('Glob', { pattern: '**/*.test.ts' }))
        .toBe(' `**/*.test.ts`');
    });

    it('should format Bash tool with command', () => {
      expect(formatToolInputSummary('Bash', { command: 'npm test' }))
        .toBe(' `npm test`');
    });

    it('should truncate long commands', () => {
      const result = formatToolInputSummary('Bash', { command: 'npm test -- src/__tests__/unit/blocks.test.ts --reporter=verbose' });
      expect(result.length).toBeLessThanOrEqual(40);
      expect(result).toContain('...');
    });

    it('should format Task tool with subagent and description', () => {
      expect(formatToolInputSummary('Task', { subagent_type: 'Explore', description: 'Find auth code' }))
        .toBe(':Explore "Find auth code"');
    });

    it('should format WebSearch with query', () => {
      expect(formatToolInputSummary('WebSearch', { query: 'Claude API docs' }))
        .toBe(' "Claude API docs"');
    });

    it('should format TodoWrite with status breakdown', () => {
      const todos = [
        { content: 'Task A', status: 'completed' },
        { content: 'Task B', status: 'completed' },
        { content: 'Task C', status: 'in_progress', activeForm: 'Working on C' },
        { content: 'Task D', status: 'pending' },
        { content: 'Task E', status: 'pending' },
      ];
      expect(formatToolInputSummary('TodoWrite', { todos }))
        .toBe(' 2✓ 1→ 2☐');
    });

    it('should format TodoWrite just started (0 done, 1 working, 8 waiting)', () => {
      const todos = [
        { content: 'Task 1', status: 'in_progress', activeForm: 'Setting up' },
        ...Array(8).fill(null).map((_, i) => ({ content: `Task ${i + 2}`, status: 'pending' })),
      ];
      expect(formatToolInputSummary('TodoWrite', { todos }))
        .toBe(' 1→ 8☐');  // Omit 0✓
    });

    it('should format TodoWrite all done', () => {
      const todos = [
        { content: 'Task A', status: 'completed' },
        { content: 'Task B', status: 'completed' },
        { content: 'Task C', status: 'completed' },
      ];
      expect(formatToolInputSummary('TodoWrite', { todos }))
        .toBe(' 3✓');  // Omit zeros
    });

    it('should format TodoWrite no in_progress', () => {
      const todos = [
        { content: 'Task A', status: 'completed' },
        { content: 'Task B', status: 'completed' },
        { content: 'Task C', status: 'pending' },
        { content: 'Task D', status: 'pending' },
      ];
      expect(formatToolInputSummary('TodoWrite', { todos }))
        .toBe(' 2✓ 2☐');  // Omit 0→
    });

    it('should filter invalid todo items', () => {
      const todos = [
        { content: 'Valid', status: 'completed' },
        { invalid: 'data' },  // Missing required fields
        { content: 'Also valid', status: 'pending' },
      ];
      expect(formatToolInputSummary('TodoWrite', { todos }))
        .toBe(' 1✓ 1☐');  // Only 2 valid items
    });

    it('should return empty for AskUserQuestion', () => {
      expect(formatToolInputSummary('AskUserQuestion', { questions: [] }))
        .toBe('');
    });

    it('should return empty when no input', () => {
      expect(formatToolInputSummary('Read', undefined))
        .toBe('');
    });

    it('should handle MCP-style tool names', () => {
      expect(formatToolInputSummary('mcp__server__Read', { file_path: 'test.ts' }))
        .toBe(' `test.ts`');
    });

    it('should truncate long paths keeping last segments', () => {
      const result = formatToolInputSummary('Read', {
        file_path: '/very/long/path/to/some/deeply/nested/directory/file.ts'
      });
      expect(result).toContain('file.ts');
      expect(result.length).toBeLessThanOrEqual(45);
    });
  });

  describe('formatToolResultSummary', () => {
    it('should format lineCount', () => {
      expect(formatToolResultSummary({ lineCount: 141 } as ActivityEntry))
        .toBe(' (141 lines)');
    });

    it('should format matchCount singular', () => {
      expect(formatToolResultSummary({ matchCount: 1 } as ActivityEntry))
        .toBe(' → 1 match');
    });

    it('should format matchCount plural', () => {
      expect(formatToolResultSummary({ matchCount: 12 } as ActivityEntry))
        .toBe(' → 12 matches');
    });

    it('should format linesAdded and linesRemoved', () => {
      expect(formatToolResultSummary({ linesAdded: 5, linesRemoved: 2 } as ActivityEntry))
        .toBe(' (+5/-2)');
    });

    it('should handle only linesAdded', () => {
      expect(formatToolResultSummary({ linesAdded: 10 } as ActivityEntry))
        .toBe(' (+10/-0)');
    });

    it('should return empty when no metrics', () => {
      expect(formatToolResultSummary({} as ActivityEntry))
        .toBe('');
    });
  });

  describe('formatToolDetails', () => {
    it('should format Read tool with lineCount', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Read',
        lineCount: 100,
        durationMs: 500,
      });
      expect(details).toContain('Read: 100 lines');
      expect(details).toContain('Duration: 0.5s');
    });

    it('should format Edit tool with changes', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Edit',
        linesAdded: 5,
        linesRemoved: 3,
        durationMs: 1200,
      });
      expect(details).toContain('Changed: +5/-3 lines');
      expect(details).toContain('Duration: 1.2s');
    });

    it('should format Grep tool with path and matches', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Grep',
        toolInput: { path: 'src/', pattern: 'test' },
        matchCount: 25,
        durationMs: 300,
      });
      expect(details).toContain('Path: `src/`');
      expect(details).toContain('Found: 25 matches');
    });

    it('should format Bash tool with command', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Bash',
        toolInput: { command: 'npm test -- blocks.test.ts' },
        durationMs: 8200,
      });
      expect(details).toContain('Command: `npm test -- blocks.test.ts`');
      expect(details).toContain('Duration: 8.2s');
    });

    it('should format Task tool with subagent details', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Task',
        toolInput: { subagent_type: 'Explore', description: 'Find error handlers' },
        durationMs: 35200,
      });
      expect(details).toContain('Type: Explore');
      expect(details).toContain('Task: Find error handlers');
    });

    it('should only show duration for AskUserQuestion', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'AskUserQuestion',
        toolInput: { questions: [] },
        durationMs: 5000,
      });
      expect(details).toHaveLength(1);
      expect(details[0]).toBe('Duration: 5.0s');
    });

    it('should use generic fallback for unknown tools', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'CustomTool',
        toolInput: { option1: 'value1', option2: 'value2' },
        durationMs: 1000,
      });
      expect(details.length).toBeGreaterThanOrEqual(2);
      expect(details).toContain('Duration: 1.0s');
    });

    it('should include output preview', () => {
      const details = formatToolDetails({
        timestamp: Date.now(),
        type: 'tool_complete',
        tool: 'Bash',
        toolOutputPreview: 'test output',
        durationMs: 1000,
      });
      expect(details.some(d => d.includes('Output:'))).toBe(true);
    });

    it('should show error for failed tools', () => {
      const details = formatToolDetails({
        timestamp: Date.now(),
        type: 'tool_complete',
        tool: 'Bash',
        toolIsError: true,
        toolErrorMessage: 'Command failed',
        durationMs: 100,
      });
      expect(details.some(d => d.includes('Error:'))).toBe(true);
      expect(details.some(d => d.includes('Command failed'))).toBe(true);
    });

    it('should not show output when tool has error', () => {
      const details = formatToolDetails({
        timestamp: Date.now(),
        type: 'tool_complete',
        tool: 'Bash',
        toolIsError: true,
        toolErrorMessage: 'Command failed',
        toolOutputPreview: 'some output',  // Should not appear
        durationMs: 100,
      });
      expect(details.some(d => d.includes('Error:'))).toBe(true);
      expect(details.some(d => d.includes('Output:'))).toBe(false);
    });
  });

  describe('formatOutputPreview', () => {
    it('should format bash output', () => {
      const result = formatOutputPreview('bash', 'test output');
      expect(result).toBe('`test output`');
    });

    it('should truncate long bash output', () => {
      const long = 'x'.repeat(200);
      const result = formatOutputPreview('bash', long);
      expect(result).toContain('...');
      expect(result.length).toBeLessThan(200);
    });

    it('should format grep matches', () => {
      const result = formatOutputPreview('grep', 'file1.ts\nfile2.ts');
      expect(result).toContain('file1.ts');
      expect(result).toContain('file2.ts');
    });

    it('should format glob matches', () => {
      const result = formatOutputPreview('glob', 'src/a.ts\nsrc/b.ts\nsrc/c.ts');
      expect(result).toContain('src/a.ts');
      expect(result).toContain('src/b.ts');
      expect(result).toContain('src/c.ts');
    });

    it('should format read output', () => {
      const result = formatOutputPreview('read', 'file content here');
      expect(result).toBe('`file content here`');
    });

    it('should truncate long read output', () => {
      const long = 'x'.repeat(150);
      const result = formatOutputPreview('read', long);
      expect(result).toContain('...');
      expect(result.length).toBeLessThan(150);
    });

    it('should handle unknown tools with default formatting', () => {
      const result = formatOutputPreview('unknown', 'some output');
      expect(result).toBe('some output');
    });

    it('should return empty string for empty preview', () => {
      const result = formatOutputPreview('bash', '');
      expect(result).toBe('');
    });

    it('should return empty string for whitespace only', () => {
      const result = formatOutputPreview('bash', '   \n\t  ');
      expect(result).toBe('');
    });

    it('should clean control characters', () => {
      const result = formatOutputPreview('bash', 'hello\x00world');
      expect(result).not.toContain('\x00');
    });
  });

  describe('isTodoItem', () => {
    it('should return true for valid todo item', () => {
      expect(isTodoItem({ content: 'Task A', status: 'completed' })).toBe(true);
      expect(isTodoItem({ content: 'Task B', status: 'in_progress', activeForm: 'Working on B' })).toBe(true);
      expect(isTodoItem({ content: 'Task C', status: 'pending' })).toBe(true);
    });

    it('should return false for missing content', () => {
      expect(isTodoItem({ status: 'pending' })).toBe(false);
    });

    it('should return false for missing status', () => {
      expect(isTodoItem({ content: 'Task A' })).toBe(false);
    });

    it('should return false for invalid status', () => {
      expect(isTodoItem({ content: 'Task A', status: 'invalid' })).toBe(false);
    });

    it('should return false for null', () => {
      expect(isTodoItem(null)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(isTodoItem('string')).toBe(false);
      expect(isTodoItem(123)).toBe(false);
    });
  });

  describe('extractLatestTodos', () => {
    it('should return empty array when no TodoWrite entries', () => {
      const log: ActivityEntry[] = [
        { type: 'tool_complete', timestamp: Date.now(), tool: 'Read' },
        { type: 'thinking', timestamp: Date.now() },
      ];
      expect(extractLatestTodos(log)).toEqual([]);
    });

    it('should return todos from most recent tool_complete', () => {
      const log: ActivityEntry[] = [
        {
          type: 'tool_complete',
          timestamp: Date.now() - 1000,
          tool: 'TodoWrite',
          toolInput: { todos: [{ content: 'Old task', status: 'pending' }] },
        },
        {
          type: 'tool_complete',
          timestamp: Date.now(),
          tool: 'TodoWrite',
          toolInput: { todos: [{ content: 'New task', status: 'completed' }] },
        },
      ];
      const result = extractLatestTodos(log);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('New task');
    });

    it('should handle case-insensitive tool name matching', () => {
      const log: ActivityEntry[] = [
        {
          type: 'tool_complete',
          timestamp: Date.now(),
          tool: 'todowrite',  // lowercase
          toolInput: { todos: [{ content: 'Task', status: 'pending' }] },
        },
      ];
      expect(extractLatestTodos(log)).toHaveLength(1);
    });

    it('should prefer tool_complete over tool_start', () => {
      const log: ActivityEntry[] = [
        {
          type: 'tool_start',
          timestamp: Date.now(),
          tool: 'TodoWrite',
          toolInput: { todos: [{ content: 'Start task', status: 'pending' }] },
        },
        {
          type: 'tool_complete',
          timestamp: Date.now() - 500,
          tool: 'TodoWrite',
          toolInput: { todos: [{ content: 'Complete task', status: 'completed' }] },
        },
      ];
      const result = extractLatestTodos(log);
      expect(result[0].content).toBe('Complete task');
    });

    it('should fallback to tool_start if no complete entry', () => {
      const log: ActivityEntry[] = [
        {
          type: 'tool_start',
          timestamp: Date.now(),
          tool: 'TodoWrite',
          toolInput: { todos: [{ content: 'Started task', status: 'in_progress' }] },
        },
      ];
      const result = extractLatestTodos(log);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Started task');
    });

    it('should filter out malformed todo items', () => {
      const log: ActivityEntry[] = [
        {
          type: 'tool_complete',
          timestamp: Date.now(),
          tool: 'TodoWrite',
          toolInput: {
            todos: [
              { content: 'Valid', status: 'pending' },
              { invalid: 'data' },  // Missing required fields
              { content: 'Also valid', status: 'completed' },
            ],
          },
        },
      ];
      const result = extractLatestTodos(log);
      expect(result).toHaveLength(2);
    });
  });

  describe('formatTodoListDisplay', () => {
    it('should return empty string for empty array', () => {
      expect(formatTodoListDisplay([])).toBe('');
    });

    it('should show all items when they fit within limit', () => {
      const todos: TodoItem[] = [
        { content: 'Task A', status: 'completed' },
        { content: 'Task B', status: 'in_progress', activeForm: 'Working on B' },
        { content: 'Task C', status: 'pending' },
      ];
      const result = formatTodoListDisplay(todos);
      expect(result).toContain(':clipboard: *Tasks (1/3)*');
      expect(result).toContain(':ballot_box_with_check: ~Task A~');
      expect(result).toContain(':arrow_right: *Working on B*');
      expect(result).toContain(':white_large_square: Task C');
    });

    it('should show checkmark when all completed', () => {
      const todos: TodoItem[] = [
        { content: 'Task A', status: 'completed' },
        { content: 'Task B', status: 'completed' },
      ];
      const result = formatTodoListDisplay(todos);
      expect(result).toContain(':clipboard: *Tasks (2/2)* :white_check_mark:');
    });

    it('should fallback to content when activeForm is missing', () => {
      const todos: TodoItem[] = [
        { content: 'Task without activeForm', status: 'in_progress' },
      ];
      const result = formatTodoListDisplay(todos);
      expect(result).toContain(':arrow_right: *Task without activeForm*');
    });

    it('should truncate long task text to 50 chars', () => {
      const todos: TodoItem[] = [
        { content: 'This is a very long task description that exceeds fifty characters easily', status: 'pending' },
      ];
      const result = formatTodoListDisplay(todos);
      expect(result).toContain('...');
      // The truncated text should be within 50 chars
      const lines = result.split('\n');
      const taskLine = lines.find(l => l.includes(':white_large_square:'));
      expect(taskLine).toBeDefined();
      expect(taskLine!.length).toBeLessThan(80);
    });

    it('should show truncation summaries when list is large', () => {
      // Create a large list that will be truncated
      const todos: TodoItem[] = [
        ...Array(10).fill(null).map((_, i) => ({ content: `Completed task ${i + 1}`, status: 'completed' as const })),
        { content: 'In progress', status: 'in_progress' as const, activeForm: 'Working...' },
        ...Array(10).fill(null).map((_, i) => ({ content: `Pending task ${i + 1}`, status: 'pending' as const })),
      ];
      const result = formatTodoListDisplay(todos, 300);  // Smaller limit to force truncation
      expect(result).toContain('more completed');
      expect(result).toContain('more pending');
    });

    it('should show divider when no in_progress items', () => {
      const todos: TodoItem[] = [
        { content: 'Completed A', status: 'completed' },
        { content: 'Completed B', status: 'completed' },
        { content: 'Pending A', status: 'pending' },
        { content: 'Pending B', status: 'pending' },
      ];
      const result = formatTodoListDisplay(todos);
      // When no in_progress, should show divider between completed and pending
      expect(result).toContain('────');
    });

    it('should not show divider when in_progress items exist', () => {
      const todos: TodoItem[] = [
        { content: 'Completed A', status: 'completed' },
        { content: 'In progress', status: 'in_progress', activeForm: 'Working' },
        { content: 'Pending A', status: 'pending' },
      ];
      const result = formatTodoListDisplay(todos);
      expect(result).not.toContain('────');
    });
  });

  describe('formatToolDetails for TodoWrite', () => {
    it('should show breakdown for mixed status todos', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'TodoWrite',
        toolInput: {
          todos: [
            { content: 'Task A', status: 'completed' },
            { content: 'Task B', status: 'completed' },
            { content: 'Task C', status: 'in_progress', activeForm: 'Working on C' },
            { content: 'Task D', status: 'pending' },
          ],
        },
        durationMs: 100,
      });
      expect(details).toContain('✓ 2 completed');
      expect(details).toContain('→ Working on C');
      expect(details).toContain('☐ 1 pending');
    });

    it('should show "All tasks completed" when all done', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'TodoWrite',
        toolInput: {
          todos: [
            { content: 'Task A', status: 'completed' },
            { content: 'Task B', status: 'completed' },
          ],
        },
        durationMs: 100,
      });
      expect(details).toContain('All tasks completed');
    });

    it('should show all in_progress items individually', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'TodoWrite',
        toolInput: {
          todos: [
            { content: 'Task A', status: 'in_progress', activeForm: 'Working A' },
            { content: 'Task B', status: 'in_progress', activeForm: 'Working B' },
            { content: 'Task C', status: 'pending' },
          ],
        },
        durationMs: 100,
      });
      expect(details).toContain('→ Working A');
      expect(details).toContain('→ Working B');
    });

    it('should fallback to content when activeForm missing', () => {
      const details = formatToolDetails({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'TodoWrite',
        toolInput: {
          todos: [
            { content: 'Task without activeForm', status: 'in_progress' },
          ],
        },
        durationMs: 100,
      });
      expect(details).toContain('→ Task without activeForm');
    });
  });

  describe('buildCombinedStatusBlocks with todos', () => {
    it('should not add todo section when no TodoWrite entries', () => {
      const blocks = buildCombinedStatusBlocks({
        activityLog: [{ type: 'thinking', timestamp: Date.now() }],
        inProgress: null,
        status: 'complete',
        mode: 'default',
        elapsedMs: 1000,
        conversationKey: 'test',
      });
      // Should not have a divider block (which would indicate todo section)
      const hasDivider = blocks.some(b => b.type === 'divider');
      expect(hasDivider).toBe(false);
    });

    it('should add todo section and divider when TodoWrite entries exist', () => {
      const blocks = buildCombinedStatusBlocks({
        activityLog: [
          {
            type: 'tool_complete',
            timestamp: Date.now(),
            tool: 'TodoWrite',
            toolInput: {
              todos: [
                { content: 'Task A', status: 'completed' },
                { content: 'Task B', status: 'in_progress', activeForm: 'Working on B' },
              ],
            },
          },
        ],
        inProgress: null,
        status: 'complete',
        mode: 'default',
        elapsedMs: 1000,
        conversationKey: 'test',
      });
      // First block should be the todo section
      expect(blocks[0].type).toBe('section');
      expect((blocks[0] as any).text.text).toContain(':clipboard: *Tasks');
      // Second block should be divider
      expect(blocks[1].type).toBe('divider');
    });
  });

});
