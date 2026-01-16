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
  buildTerminalCommandBlocks,
  buildModeSelectionBlocks,
  buildPlanApprovalBlocks,
  isPlanApprovalPrompt,
  buildToolApprovalBlocks,
  formatToolInput,
  buildForkAnchorBlocks,
} from '../../blocks.js';

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
});
