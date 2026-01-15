import { describe, it, expect } from 'vitest';
import {
  buildQuestionBlocks,
  buildApprovalBlocks,
  buildReminderBlocks,
  buildStatusBlocks,
  buildAnsweredBlocks,
  buildApprovalResultBlocks,
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
});
