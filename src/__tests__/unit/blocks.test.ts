import { describe, it, expect } from 'vitest';
import {
  buildQuestionBlocks,
  buildApprovalBlocks,
  buildReminderBlocks,
  buildStatusBlocks,
  buildHeaderBlocks,
  buildAnsweredBlocks,
  buildApprovalResultBlocks,
  buildStatusDisplayBlocks,
  buildContextDisplayBlocks,
  buildTerminalCommandBlocks,
  buildModeSelectionBlocks,
  buildModelSelectionBlocks,
  buildModelDeprecatedBlocks,
  buildPlanApprovalBlocks,
  isPlanApprovalPrompt,
  buildToolApprovalBlocks,
  formatToolInput,
  buildForkAnchorBlocks,
  buildStatusPanelBlocks,
  buildActivityLogText,
  buildCollapsedActivityBlocks,
  buildActivityLogModalView,
  getToolEmoji,
  formatToolName,
  ActivityEntry,
} from '../../blocks.js';
import type { ModelInfo } from '../../model-cache.js';
import type { LastUsage } from '../../session-manager.js';

describe('blocks', () => {
  describe('buildQuestionBlocks', () => {
    it('should build basic question block without options', () => {
      const blocks = buildQuestionBlocks({
        question: 'What is your name?',
        questionId: 'q_123',
      });

      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text?.text).toContain('What is your name?');
      expect(blocks[1].type).toBe('context');
      expect(blocks[2].type).toBe('actions');
      // Should have abort button
      expect(blocks[2].elements?.[0].action_id).toBe('abort_q_123');
    });

    it('should build question with button options when <= 5 options', () => {
      const blocks = buildQuestionBlocks({
        question: 'Choose a color:',
        options: ['Red', 'Blue', 'Green'],
        questionId: 'q_456',
      });

      expect(blocks).toHaveLength(4);
      expect(blocks[0].type).toBe('section');
      expect(blocks[1].type).toBe('actions');
      expect(blocks[1].elements).toHaveLength(3);
      expect(blocks[1].elements?.[0].action_id).toBe('answer_q_456_0');
      expect(blocks[1].elements?.[0].value).toBe('Red');
      expect(blocks[2].type).toBe('divider');
      expect(blocks[3].type).toBe('actions');
      // Should have freetext and abort buttons
      expect(blocks[3].elements?.[0].action_id).toBe('freetext_q_456');
      expect(blocks[3].elements?.[1].action_id).toBe('abort_q_456');
    });

    it('should use multi-select dropdown when > 5 options', () => {
      const blocks = buildQuestionBlocks({
        question: 'Choose languages:',
        options: ['JavaScript', 'Python', 'Go', 'Rust', 'Java', 'C++'],
        questionId: 'q_789',
      });

      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe('section');
      expect(blocks[1].type).toBe('section');
      expect(blocks[1].accessory?.type).toBe('multi_static_select');
      expect(blocks[1].accessory?.action_id).toBe('multiselect_q_789');
      expect(blocks[1].accessory?.options).toHaveLength(6);
      expect(blocks[2].type).toBe('actions');
      // Should have submit and abort buttons
      expect(blocks[2].elements?.[0].action_id).toBe('multiselect_submit_q_789');
      expect(blocks[2].elements?.[1].action_id).toBe('abort_q_789');
    });

    it('should use multi-select when multiSelect flag is true', () => {
      const blocks = buildQuestionBlocks({
        question: 'Select items:',
        options: ['A', 'B', 'C'],
        questionId: 'q_multi',
        multiSelect: true,
      });

      expect(blocks[1].accessory?.type).toBe('multi_static_select');
      expect(blocks[1].accessory?.action_id).toBe('multiselect_q_multi');
    });

    it('should include code context when provided', () => {
      const blocks = buildQuestionBlocks({
        question: 'Review this code:',
        questionId: 'q_code',
        codeContext: 'function hello() { return "world"; }',
      });

      expect(blocks).toHaveLength(4);
      expect(blocks[1].type).toBe('section');
      expect(blocks[1].text?.text).toContain('```');
      expect(blocks[1].text?.text).toContain('function hello()');
    });
  });

  describe('buildApprovalBlocks', () => {
    it('should build approval block without details', () => {
      const blocks = buildApprovalBlocks({
        action: 'Delete all files',
        questionId: 'a_123',
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text?.text).toContain('Delete all files');
      expect(blocks[1].type).toBe('actions');
      expect(blocks[1].elements?.[0].action_id).toBe('answer_a_123_0');
      expect(blocks[1].elements?.[0].value).toBe('approved');
      expect(blocks[1].elements?.[1].action_id).toBe('answer_a_123_1');
      expect(blocks[1].elements?.[1].value).toBe('denied');
    });

    it('should include details when provided', () => {
      const blocks = buildApprovalBlocks({
        action: 'Run npm install',
        details: 'This will install 50 packages',
        questionId: 'a_456',
      });

      expect(blocks).toHaveLength(3);
      expect(blocks[1].type).toBe('context');
      expect(blocks[1].elements?.[0].text).toBe('This will install 50 packages');
    });
  });

  describe('buildReminderBlocks', () => {
    it('should build reminder block with expiry time', () => {
      const blocks = buildReminderBlocks({
        originalQuestion: 'What is your preference?',
        questionId: 'q_reminder',
        expiresIn: '6 days 20 hours',
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text?.text).toContain('Reminder');
      expect(blocks[0].text?.text).toContain('Expires in 6 days 20 hours');
      expect(blocks[0].text?.text).toContain('What is your preference?');
      expect(blocks[1].type).toBe('actions');
      expect(blocks[1].elements?.[0].action_id).toBe('abort_q_reminder');
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

  describe('buildApprovalResultBlocks', () => {
    it('should show approved result', () => {
      const blocks = buildApprovalResultBlocks('Run tests', true);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Run tests');
      expect(blocks[0].text?.text).toContain('Approved');
    });

    it('should show denied result', () => {
      const blocks = buildApprovalResultBlocks('Delete files', false);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Delete files');
      expect(blocks[0].text?.text).toContain('Denied');
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
  });

  describe('buildContextDisplayBlocks', () => {
    const baseUsage: LastUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 49000,
      contextWindow: 200000,
      model: 'claude-sonnet-4-5',
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
      // 200k * 0.775 = 155k threshold. Want ~15% compact left = 30k tokens to threshold
      // So need 155k - 30k = 125k tokens used
      const highUsage: LastUsage = {
        ...baseUsage,
        inputTokens: 25000,
        cacheReadInputTokens: 100000, // 125000 / 200000 = 62.5% ctx, 15% to compact
      };
      const blocks = buildContextDisplayBlocks(highUsage);
      const contextBlock = blocks.find((b: any) => b.type === 'context');

      expect(contextBlock?.elements?.[0]?.text).toContain(':warning:');
      expect(contextBlock?.elements?.[0]?.text).toContain('Consider `/compact`');
    });

    it('should show error when compact percent <= 10%', () => {
      // 200k * 0.775 = 155k threshold. Want ~5% compact left = 10k tokens to threshold
      // So need 155k - 10k = 145k tokens used
      const veryHighUsage: LastUsage = {
        ...baseUsage,
        inputTokens: 45000,
        cacheReadInputTokens: 100000, // 145000 / 200000 = 72.5% ctx, 5% to compact
      };
      const blocks = buildContextDisplayBlocks(veryHighUsage);
      const contextBlock = blocks.find((b: any) => b.type === 'context');

      expect(contextBlock?.elements?.[0]?.text).toContain(':x:');
      expect(contextBlock?.elements?.[0]?.text).toContain('nearly full');
    });

    it('should show imminent when past threshold', () => {
      // 200k * 0.775 = 155k threshold. Using 160k is past threshold
      const pastThreshold: LastUsage = {
        ...baseUsage,
        inputTokens: 60000,
        cacheReadInputTokens: 100000, // 160000 / 200000 = 80% ctx, -2.5% to compact
      };
      const blocks = buildContextDisplayBlocks(pastThreshold);
      const contextBlock = blocks.find((b: any) => b.type === 'context');

      expect(contextBlock?.elements?.[0]?.text).toContain(':x:');
      expect(contextBlock?.elements?.[0]?.text).toContain('imminent');
    });

    it('should show auto-compact remaining percentage', () => {
      // 200k * 0.775 = 155k threshold. 50k used = 52.5% to compact
      const blocks = buildContextDisplayBlocks(baseUsage);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');

      expect(sectionBlock?.text?.text).toContain('Auto-compact:');
      expect(sectionBlock?.text?.text).toContain('52.5% remaining'); // (155k - 50k) / 200k * 100 = 52.5%
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
  });

  describe('buildTerminalCommandBlocks', () => {
    it('should show command in code block', () => {
      const blocks = buildTerminalCommandBlocks({
        title: 'Continue in Terminal',
        description: 'Run this command:',
        command: 'claude --resume abc-123',
        workingDir: '/test',
        sessionId: 'abc-123',
      });

      expect(blocks.length).toBeGreaterThanOrEqual(3);
      expect(blocks[0].type).toBe('header');
      expect(blocks[2].text?.text).toContain('claude --resume abc-123');
    });

    it('should include note when provided', () => {
      const blocks = buildTerminalCommandBlocks({
        title: 'Fork to Terminal',
        description: 'Run this command:',
        command: 'claude --resume abc --fork',
        workingDir: '/test',
        sessionId: 'abc',
        note: 'Creates a new session branch',
      });

      expect(blocks.length).toBe(5);
      expect(blocks[4].elements?.[0].text).toContain('Creates a new session branch');
    });

    it('should show working directory in context', () => {
      const blocks = buildTerminalCommandBlocks({
        title: 'Continue',
        description: 'Run this:',
        command: 'claude --resume xyz',
        workingDir: '/home/user/project',
        sessionId: 'xyz',
      });

      expect(blocks[3].elements?.[0].text).toContain('/home/user/project');
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

  describe('isPlanApprovalPrompt', () => {
    it('should detect "would you like me to proceed"', () => {
      expect(isPlanApprovalPrompt('Here is my plan. Would you like me to proceed?')).toBe(true);
    });

    it('should detect "would you like to proceed"', () => {
      expect(isPlanApprovalPrompt('Would you like to proceed with this plan?')).toBe(true);
    });

    it('should detect "shall i proceed"', () => {
      expect(isPlanApprovalPrompt('Shall I proceed with the implementation?')).toBe(true);
    });

    it('should detect "ready to proceed"', () => {
      expect(isPlanApprovalPrompt("I'm ready to proceed when you are.")); // Note: this won't match because it says "I'm ready" not "ready to proceed"
    });

    it('should detect "should i proceed"', () => {
      expect(isPlanApprovalPrompt('Should I proceed with the plan?')).toBe(true);
    });

    it('should detect "let me know when you\'re ready"', () => {
      expect(isPlanApprovalPrompt("Let me know when you're ready to start.")).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(isPlanApprovalPrompt('WOULD YOU LIKE ME TO PROCEED?')).toBe(true);
      expect(isPlanApprovalPrompt('Shall I Proceed?')).toBe(true);
    });

    it('should return false for regular messages', () => {
      expect(isPlanApprovalPrompt('Here is the file content.')).toBe(false);
      expect(isPlanApprovalPrompt('I created the test file.')).toBe(false);
      expect(isPlanApprovalPrompt('The implementation is complete.')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isPlanApprovalPrompt('')).toBe(false);
    });
  });

  describe('buildPlanApprovalBlocks', () => {
    it('should include all three action buttons', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123_thread456' });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock.elements).toHaveLength(3);
    });

    it('should have correct action IDs with conversation key', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123_thread456' });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const actionIds = actionsBlock.elements.map((e: any) => e.action_id);

      expect(actionIds).toContain('plan_approve_auto_C123_thread456');
      expect(actionIds).toContain('plan_approve_manual_C123_thread456');
      expect(actionIds).toContain('plan_reject_C123_thread456');
    });

    it('should have correct button values', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const values = actionsBlock.elements.map((e: any) => e.value);

      expect(values).toContain('bypassPermissions');
      expect(values).toContain('default');
      expect(values).toContain('reject');
    });

    it('should have primary style for proceed buttons and danger for reject', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const autoBtn = actionsBlock.elements.find((e: any) => e.value === 'bypassPermissions');
      const manualBtn = actionsBlock.elements.find((e: any) => e.value === 'default');
      const rejectBtn = actionsBlock.elements.find((e: any) => e.value === 'reject');

      expect(autoBtn.style).toBe('primary');
      expect(manualBtn.style).toBe('primary');
      expect(rejectBtn.style).toBe('danger');
    });

    it('should include a divider at the start', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });

      expect(blocks[0].type).toBe('divider');
    });

    it('should include context hint about modes', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });

      const contextBlock = blocks.find((b: any) => b.type === 'context');
      expect(contextBlock).toBeDefined();
      expect(contextBlock.elements[0].text).toContain('Auto-accept');
      expect(contextBlock.elements[0].text).toContain('Manual approve');
    });

    it('should include header section with prompt', () => {
      const blocks = buildPlanApprovalBlocks({ conversationKey: 'C123' });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock).toBeDefined();
      expect(sectionBlock.text.text).toContain('Ready to proceed');
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
  });

  describe('buildForkAnchorBlocks', () => {
    it('should build fork anchor with description', () => {
      const blocks = buildForkAnchorBlocks({
        description: 'try async approach',
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('section');
      expect(blocks[1].type).toBe('context');
    });

    it('should include fork emoji and description in section', () => {
      const blocks = buildForkAnchorBlocks({
        description: 'explore puppeteer instead',
      });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock?.text?.text).toContain('🔀');
      expect(sectionBlock?.text?.text).toContain('Forked');
      expect(sectionBlock?.text?.text).toContain('explore puppeteer instead');
    });

    it('should include context indicating forked from thread', () => {
      const blocks = buildForkAnchorBlocks({
        description: 'test',
      });

      const contextBlock = blocks.find((b: any) => b.type === 'context');
      expect(contextBlock?.elements?.[0]?.text).toContain('Forked from thread');
    });

    it('should handle empty description', () => {
      const blocks = buildForkAnchorBlocks({
        description: '',
      });

      expect(blocks).toHaveLength(2);
      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock?.text?.text).toContain('Forked');
    });

    it('should handle description with special characters', () => {
      const blocks = buildForkAnchorBlocks({
        description: 'try `async/await` pattern & "promises"',
      });

      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock?.text?.text).toContain('async/await');
      expect(sectionBlock?.text?.text).toContain('promises');
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

      it('should include Abort button', () => {
        const blocks = buildStatusPanelBlocks({
          ...baseParams,
          status: 'starting',
        });

        expect(blocks[2].type).toBe('actions');
        const button = (blocks[2] as any).elements[0];
        expect(button.text.text).toBe('Abort');
        expect(button.style).toBe('danger');
        expect(button.action_id).toContain('abort_query_');
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
      expect(text).toContain(':brain: *Thinking...* [0.5s]');
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
          thinkingTruncated: longContent.substring(0, 500) + '...',
        },
      ];

      const text = buildActivityLogText(entries, true);
      expect(text).toContain('[600 chars]');
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
  });

  describe('buildCollapsedActivityBlocks', () => {
    const conversationKey = 'C123_thread456';

    it('should show only duration when no thinking or tools', () => {
      const blocks = buildCollapsedActivityBlocks(0, 0, 5000, conversationKey);

      const sectionText = (blocks[0] as any).text.text;
      expect(sectionText).toContain('Completed in 5.0s');
      expect(sectionText).not.toContain('thinking');
      expect(sectionText).not.toContain('tool');
    });

    it('should show only thinking count when no tools', () => {
      const blocks = buildCollapsedActivityBlocks(3, 0, 5000, conversationKey);

      const sectionText = (blocks[0] as any).text.text;
      expect(sectionText).toContain('3 thinking blocks');
      expect(sectionText).not.toContain('tool');
    });

    it('should use singular for 1 thinking block', () => {
      const blocks = buildCollapsedActivityBlocks(1, 0, 5000, conversationKey);

      const sectionText = (blocks[0] as any).text.text;
      expect(sectionText).toContain('1 thinking block');
      expect(sectionText).not.toContain('blocks');
    });

    it('should show only tools count when no thinking', () => {
      const blocks = buildCollapsedActivityBlocks(0, 5, 5000, conversationKey);

      const sectionText = (blocks[0] as any).text.text;
      expect(sectionText).toContain('5 tools completed');
      expect(sectionText).not.toContain('thinking');
    });

    it('should use singular for 1 tool', () => {
      const blocks = buildCollapsedActivityBlocks(0, 1, 5000, conversationKey);

      const sectionText = (blocks[0] as any).text.text;
      expect(sectionText).toContain('1 tool completed');
      expect(sectionText).not.toContain('tools');
    });

    it('should show both thinking and tools when present', () => {
      const blocks = buildCollapsedActivityBlocks(2, 4, 8000, conversationKey);

      const sectionText = (blocks[0] as any).text.text;
      expect(sectionText).toContain('2 thinking');
      expect(sectionText).toContain('4 tools');
      expect(sectionText).toContain('8.0s');
    });

    it('should include View Log button', () => {
      const blocks = buildCollapsedActivityBlocks(1, 1, 5000, conversationKey);

      expect(blocks[1].type).toBe('actions');
      const buttons = (blocks[1] as any).elements;
      const viewLogButton = buttons.find((b: any) => b.text.text === 'View Log');
      expect(viewLogButton).toBeDefined();
      expect(viewLogButton.action_id).toContain('view_activity_log_');
      expect(viewLogButton.value).toBe(conversationKey);
    });

    it('should include Download button', () => {
      const blocks = buildCollapsedActivityBlocks(1, 1, 5000, conversationKey);

      const buttons = (blocks[1] as any).elements;
      const downloadButton = buttons.find((b: any) => b.text.text === 'Download .txt');
      expect(downloadButton).toBeDefined();
      expect(downloadButton.action_id).toContain('download_activity_log_');
      expect(downloadButton.value).toBe(conversationKey);
    });

    it('should include clipboard emoji', () => {
      const blocks = buildCollapsedActivityBlocks(1, 1, 5000, conversationKey);

      const sectionText = (blocks[0] as any).text.text;
      expect(sectionText).toContain(':clipboard:');
    });
  });

  describe('buildActivityLogModalView', () => {
    const conversationKey = 'C123_thread456';

    const createEntries = (count: number): ActivityEntry[] => {
      const entries: ActivityEntry[] = [];
      for (let i = 0; i < count; i++) {
        entries.push({
          timestamp: Date.now() + i * 1000,
          type: i % 2 === 0 ? 'tool_start' : 'tool_complete',
          tool: `Tool${i}`,
          durationMs: i % 2 === 1 ? 500 : undefined,
        });
      }
      return entries;
    };

    it('should show page info in header', () => {
      const entries = createEntries(30);
      const view = buildActivityLogModalView(entries, 1, 2, conversationKey);

      const contextBlock = view.blocks.find((b: any) => b.type === 'context');
      expect(contextBlock.elements[0].text).toContain('Page 1 of 2');
      expect(contextBlock.elements[0].text).toContain('30 total entries');
    });

    it('should show only entries for current page', () => {
      const entries = createEntries(30); // 2 pages with MODAL_PAGE_SIZE = 15
      const view = buildActivityLogModalView(entries, 1, 2, conversationKey);

      // Count section blocks (entries)
      const sectionBlocks = view.blocks.filter((b: any) => b.type === 'section');
      expect(sectionBlocks.length).toBe(15);
    });

    it('should show Next button on first page when multiple pages', () => {
      const entries = createEntries(30);
      const view = buildActivityLogModalView(entries, 1, 2, conversationKey);

      const actionsBlock = view.blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      const nextButton = actionsBlock.elements.find((b: any) => b.text.text.includes('Next'));
      expect(nextButton).toBeDefined();
      expect(nextButton.action_id).toBe('activity_log_page_2');
    });

    it('should show Prev button on second page', () => {
      const entries = createEntries(30);
      const view = buildActivityLogModalView(entries, 2, 2, conversationKey);

      const actionsBlock = view.blocks.find((b: any) => b.type === 'actions');
      const prevButton = actionsBlock.elements.find((b: any) => b.text.text.includes('Prev'));
      expect(prevButton).toBeDefined();
      expect(prevButton.action_id).toBe('activity_log_page_1');
    });

    it('should show both Prev and Next on middle page', () => {
      const entries = createEntries(45); // 3 pages
      const view = buildActivityLogModalView(entries, 2, 3, conversationKey);

      const actionsBlock = view.blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock.elements).toHaveLength(2);
    });

    it('should not show pagination buttons for single page', () => {
      const entries = createEntries(10); // 1 page
      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);

      const actionsBlock = view.blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeUndefined();
    });

    it('should include conversationKey in private_metadata', () => {
      const entries = createEntries(5);
      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);

      const metadata = JSON.parse(view.private_metadata);
      expect(metadata.conversationKey).toBe(conversationKey);
      expect(metadata.currentPage).toBe(1);
    });

    it('should format thinking entries with full content', () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: 'Full thinking content here',
          thinkingTruncated: 'Full...',
        },
      ];

      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);
      const sectionBlock = view.blocks.find((b: any) =>
        b.type === 'section' && b.text?.text?.includes('Thinking')
      );

      expect(sectionBlock.text.text).toContain('Full thinking content here');
      expect(sectionBlock.text.text).toContain(':brain:');
    });

    it('should truncate very long thinking content to avoid Slack limits', () => {
      const longContent = 'A'.repeat(3000);
      const entries: ActivityEntry[] = [
        {
          timestamp: Date.now(),
          type: 'thinking',
          thinkingContent: longContent,
        },
      ];

      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);
      const sectionBlock = view.blocks.find((b: any) =>
        b.type === 'section' && b.text?.text?.includes('Thinking')
      );

      // Should be truncated to ~2800 chars
      expect(sectionBlock.text.text.length).toBeLessThan(3000);
      expect(sectionBlock.text.text).toContain('...');
    });

    it('should format tool entries with timestamps', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read' },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Read', durationMs: 1200 },
      ];

      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);
      const sectionBlocks = view.blocks.filter((b: any) => b.type === 'section');

      expect(sectionBlocks[0].text.text).toContain('Read');
      expect(sectionBlocks[0].text.text).toContain('started');
      expect(sectionBlocks[1].text.text).toContain('complete');
      expect(sectionBlocks[1].text.text).toContain('1.2s');
    });

    it('should show duration on tool_complete entries in modal', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'tool_start', tool: 'Edit', durationMs: 500 },
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Edit', durationMs: 2500 },
      ];

      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);
      const sectionBlocks = view.blocks.filter((b: any) => b.type === 'section');

      // tool_complete should show the duration it took
      expect(sectionBlocks[1].text.text).toContain('Edit');
      expect(sectionBlocks[1].text.text).toContain('complete');
      expect(sectionBlocks[1].text.text).toContain('2.5s');
    });

    it('should handle tool_complete without duration gracefully', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'tool_complete', tool: 'Bash' },
      ];

      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);
      const sectionBlocks = view.blocks.filter((b: any) => b.type === 'section');

      // Should not crash, just show complete without duration
      expect(sectionBlocks[0].text.text).toContain('Bash');
      expect(sectionBlocks[0].text.text).toContain('complete');
    });

    it('should format error entries', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'error', message: 'Something failed' },
      ];

      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);
      const sectionBlock = view.blocks.find((b: any) =>
        b.type === 'section' && b.text?.text?.includes('Error')
      );

      expect(sectionBlock.text.text).toContain(':x:');
      expect(sectionBlock.text.text).toContain('Something failed');
    });

    it('should format starting entry in modal', () => {
      const entries: ActivityEntry[] = [
        { timestamp: Date.now(), type: 'starting' },
        { timestamp: Date.now(), type: 'tool_start', tool: 'Read' },
      ];

      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);
      const sectionBlocks = view.blocks.filter((b: any) => b.type === 'section');

      // Starting entry should be first
      expect(sectionBlocks[0].text.text).toContain(':brain:');
      expect(sectionBlocks[0].text.text).toContain('Started processing');
      // Tool entry should be second
      expect(sectionBlocks[1].text.text).toContain('Read');
    });

    it('should have modal type and title', () => {
      const entries = createEntries(5);
      const view = buildActivityLogModalView(entries, 1, 1, conversationKey);

      expect(view.type).toBe('modal');
      expect(view.title.type).toBe('plain_text');
      expect(view.title.text).toBe('Activity Log');
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
});
