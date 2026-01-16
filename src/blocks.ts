/**
 * Block Kit builders for Slack messages.
 * Centralizes construction of interactive message blocks.
 */

import { PermissionMode } from './session-manager.js';

// Slack Block Kit types (simplified for our use case)
export interface Block {
  type: string;
  block_id?: string;
  text?: {
    type: string;
    text: string;
  };
  elements?: any[];
  accessory?: any;
}

export interface QuestionBlockParams {
  question: string;
  options?: string[];
  questionId: string;
  multiSelect?: boolean;
  codeContext?: string;
}

export interface ApprovalBlockParams {
  action: string;
  details?: string;
  questionId: string;
}

export interface ReminderBlockParams {
  originalQuestion: string;
  questionId: string;
  expiresIn: string;
}

export interface StatusBlockParams {
  status: 'processing' | 'aborted' | 'error';
  messageTs?: string;
  errorMessage?: string;
}

export interface HeaderBlockParams {
  status: 'starting' | 'processing' | 'complete' | 'aborted' | 'error';
  mode: PermissionMode;
  conversationKey?: string; // For abort button
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  errorMessage?: string;
}

/**
 * Build blocks for asking user a question.
 * Uses multi_static_select when multiSelect is true or when >5 options.
 */
export function buildQuestionBlocks(params: QuestionBlockParams): Block[] {
  const { question, options, questionId, multiSelect, codeContext } = params;
  const blocks: Block[] = [];

  // Header section with question
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Claude needs your input:*\n${question}`,
    },
  });

  // Optional code context
  if (codeContext) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`\n${codeContext}\n\`\`\``,
      },
    });
  }

  // Add options as buttons or multi-select dropdown
  if (options && options.length > 0) {
    const useMultiSelect = multiSelect || options.length > 5;

    if (useMultiSelect) {
      // Multi-select dropdown for many options
      blocks.push({
        type: "section",
        block_id: `multiselect_section_${questionId}`,
        text: {
          type: "mrkdwn",
          text: "_Select one or more options:_",
        },
        accessory: {
          type: "multi_static_select",
          action_id: `multiselect_${questionId}`,
          placeholder: { type: "plain_text", text: "Select options..." },
          options: options.map(opt => ({
            text: { type: "plain_text", text: opt },
            value: opt,
          })),
        },
      });

      // Submit button - required because multi_static_select doesn't auto-submit
      blocks.push({
        type: "actions",
        block_id: `multiselect_actions_${questionId}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Submit" },
            action_id: `multiselect_submit_${questionId}`,
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            action_id: `abort_${questionId}`,
            style: "danger",
          },
        ],
      });
    } else {
      // Regular buttons for few options
      blocks.push({
        type: "actions",
        block_id: `question_${questionId}`,
        elements: options.map((opt, i) => ({
          type: "button",
          text: { type: "plain_text", text: opt },
          action_id: `answer_${questionId}_${i}`,
          value: opt,
        })),
      });

      // Divider
      blocks.push({ type: "divider" });

      // "Type something" and "Abort" buttons
      blocks.push({
        type: "actions",
        block_id: `question_extra_${questionId}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Type something..." },
            action_id: `freetext_${questionId}`,
            value: "freetext",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            style: "danger",
            action_id: `abort_${questionId}`,
            value: "abort",
          },
        ],
      });
    }
  } else {
    // No options - show text input hint and abort
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Reply to this message with your answer_",
        },
      ],
    });

    blocks.push({
      type: "actions",
      block_id: `question_extra_${questionId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Abort" },
          style: "danger",
          action_id: `abort_${questionId}`,
          value: "abort",
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build blocks for approval requests.
 */
export function buildApprovalBlocks(params: ApprovalBlockParams): Block[] {
  const { action, details, questionId } = params;
  const blocks: Block[] = [];

  // Header section with action
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Claude needs your approval:*\n${action}`,
    },
  });

  // Optional details
  if (details) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: details,
        },
      ],
    });
  }

  // Approve/Deny buttons
  blocks.push({
    type: "actions",
    block_id: `approval_${questionId}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Approve" },
        style: "primary",
        action_id: `answer_${questionId}_0`,
        value: "approved",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Deny" },
        style: "danger",
        action_id: `answer_${questionId}_1`,
        value: "denied",
      },
    ],
  });

  return blocks;
}

/**
 * Build blocks for reminder messages.
 */
export function buildReminderBlocks(params: ReminderBlockParams): Block[] {
  const { originalQuestion, questionId, expiresIn } = params;
  const blocks: Block[] = [];

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Reminder:* I'm still waiting for your answer\n\n_"${originalQuestion}"_\n\n:hourglass: Expires in ${expiresIn}`,
    },
  });

  blocks.push({
    type: "actions",
    block_id: `reminder_${questionId}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Abort" },
        style: "danger",
        action_id: `abort_${questionId}`,
        value: "abort",
      },
    ],
  });

  return blocks;
}

/**
 * Build blocks for processing status messages.
 */
export function buildStatusBlocks(params: StatusBlockParams): Block[] {
  const { status, messageTs, errorMessage } = params;
  const blocks: Block[] = [];

  switch (status) {
    case 'processing':
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "_Processing..._",
        },
      });
      if (messageTs) {
        blocks.push({
          type: "actions",
          block_id: `status_${messageTs}`,
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Abort" },
              style: "danger",
              action_id: `abort_query_${messageTs}`,
            },
          ],
        });
      }
      break;

    case 'aborted':
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Aborted*",
        },
      });
      break;

    case 'error':
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Error:* ${errorMessage || 'Unknown error'}`,
        },
      });
      break;
  }

  return blocks;
}

/**
 * Build blocks for header message showing processing status.
 * Shows: mode | model + Abort during processing
 * Shows: mode | model | tokens | time when complete
 */
export function buildHeaderBlocks(params: HeaderBlockParams): Block[] {
  const { status, mode, conversationKey, model, inputTokens, outputTokens, durationMs, errorMessage } = params;
  const blocks: Block[] = [];

  // SDK mode labels for display
  const modeLabels: Record<PermissionMode, string> = {
    plan: 'Plan',
    default: 'Default',
    bypassPermissions: 'Bypass',
    acceptEdits: 'AcceptEdits',
  };
  const modeLabel = modeLabels[mode] || mode;

  switch (status) {
    case 'starting':
      // Only mode known, waiting for init message
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_${modeLabel}_`,
        }],
      });
      if (conversationKey) {
        blocks.push({
          type: "actions",
          block_id: `header_${conversationKey}`,
          elements: [{
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            style: "danger",
            action_id: `abort_query_${conversationKey}`,
          }],
        });
      }
      break;

    case 'processing':
      // Model known, show mode | model
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_${modeLabel} | ${model || 'Claude'}_`,
        }],
      });
      if (conversationKey) {
        blocks.push({
          type: "actions",
          block_id: `header_${conversationKey}`,
          elements: [{
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            style: "danger",
            action_id: `abort_query_${conversationKey}`,
          }],
        });
      }
      break;

    case 'complete':
      // Show mode | model | tokens | time
      const totalTokens = (inputTokens || 0) + (outputTokens || 0);
      const tokensStr = totalTokens > 0 ? `${totalTokens.toLocaleString()} tokens` : '';
      const durationStr = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '';

      const parts = [modeLabel, model || 'Claude'];
      if (tokensStr) parts.push(tokensStr);
      if (durationStr) parts.push(durationStr);

      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_${parts.join(' | ')}_`,
        }],
      });
      // No abort button when complete
      break;

    case 'aborted':
      // Show mode | model | aborted (or just mode | aborted if no model yet)
      const abortedParts = model ? [modeLabel, model, 'aborted'] : [modeLabel, 'aborted'];
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_${abortedParts.join(' | ')}_`,
        }],
      });
      break;

    case 'error':
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_Error: ${errorMessage || 'Unknown error'}_`,
        }],
      });
      break;
  }

  return blocks;
}

/**
 * Build blocks for answered question display.
 */
export function buildAnsweredBlocks(question: string, answer: string): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Claude asked:* ${question}\n\n*You answered:* ${answer}`,
      },
    },
  ];
}

/**
 * Build blocks for approval result display.
 */
export function buildApprovalResultBlocks(action: string, approved: boolean): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval request:* ${action}\n\n*Result:* ${approved ? "Approved" : "Denied"}`,
      },
    },
  ];
}

// ============================================================================
// Phase 3: Command Response Blocks
// ============================================================================

export interface StatusDisplayParams {
  sessionId: string | null;
  mode: PermissionMode;
  workingDir: string;
  lastActiveAt: number;
  pathConfigured: boolean;
  configuredBy: string | null;
  configuredAt: number | null;
}

/**
 * Build blocks for /status command response.
 */
export function buildStatusDisplayBlocks(params: StatusDisplayParams): Block[] {
  const { sessionId, mode, workingDir, lastActiveAt, pathConfigured, configuredBy, configuredAt } = params;

  // SDK mode emojis for display
  const modeEmoji: Record<PermissionMode, string> = {
    plan: ':clipboard:',
    default: ':question:',
    bypassPermissions: ':rocket:',
    acceptEdits: ':pencil:',
  };
  const lastActive = new Date(lastActiveAt).toLocaleString();

  const statusLines = [
    `*Session ID:* \`${sessionId || 'None'}\``,
    `*Mode:* ${modeEmoji[mode] || ''} ${mode}`,
    `*Working Directory:* \`${workingDir}\``,
    `*Last Active:* ${lastActive}`,
  ];

  if (pathConfigured) {
    const configuredDate = new Date(configuredAt!).toLocaleString();
    statusLines.push(`*Path Configured:* ✅ Yes (by <@${configuredBy}> on ${configuredDate})`);
    statusLines.push(`*Path Locked:* Yes (cannot be changed)`);
  } else {
    statusLines.push(`*Path Configured:* ❌ No - use \`/path <directory>\` to set`);
  }

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Session Status" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: statusLines.join('\n'),
      },
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        // NOTE: Terminal detection disabled - see README.md for details
        text: ":warning: *Terminal detection:* _disabled (coming soon)_",
      }],
    },
  ];
}

export interface TerminalCommandParams {
  title: string;
  description: string;
  command: string;
  workingDir: string;
  sessionId: string;
  note?: string;
}

/**
 * Build blocks for /continue and /fork command responses.
 */
export function buildTerminalCommandBlocks(params: TerminalCommandParams): Block[] {
  const { title, description, command, workingDir, sessionId, note } = params;

  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: title },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: description },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "```" + command + "```" },
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `:file_folder: Working directory: \`${workingDir}\`\n:key: Session: \`${sessionId}\``,
      }],
    },
  ];

  if (note) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `:bulb: ${note}` }],
    });
  }

  return blocks;
}

/**
 * Check if a message from Claude looks like a plan approval prompt.
 * Used to detect when Claude in plan mode is asking to proceed.
 */
export function isPlanApprovalPrompt(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  // Common phrases Claude uses when asking to proceed with a plan
  const approvalPhrases = [
    'would you like me to proceed',
    'would you like to proceed',
    'shall i proceed',
    'ready to proceed',
    'want me to proceed',
    'like me to execute',
    'shall i execute',
    'want me to execute',
    'would you like me to implement',
    'shall i implement',
    'ready to implement',
    'would you like me to go ahead',
    'shall i go ahead',
    'want me to go ahead',
    'should i proceed',
    'should i go ahead',
    'should i execute',
    'should i implement',
    'let me know if you\'d like me to proceed',
    'let me know when you\'re ready',
    'approve this plan',
    'confirm you want',
    'confirm to proceed',
  ];

  return approvalPhrases.some(phrase => lowerMessage.includes(phrase));
}

/**
 * Parameters for plan approval blocks.
 */
export interface PlanApprovalBlockParams {
  conversationKey: string;  // Used to identify the conversation for the response
}

/**
 * Build blocks for plan approval prompt.
 * Shown when Claude is in plan mode and asks to proceed.
 */
export function buildPlanApprovalBlocks(params: PlanApprovalBlockParams): Block[] {
  const { conversationKey } = params;

  return [
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Ready to proceed?* Choose how to execute the plan:",
      },
    },
    {
      type: "actions",
      block_id: `plan_approval_${conversationKey}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: ":rocket: Proceed (auto-accept)" },
          action_id: `plan_approve_auto_${conversationKey}`,
          value: "bypassPermissions",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":question: Proceed (manual approve)" },
          action_id: `plan_approve_manual_${conversationKey}`,
          value: "default",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":x: Reject" },
          action_id: `plan_reject_${conversationKey}`,
          value: "reject",
          style: "danger",
        },
      ],
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "_Auto-accept runs tools without prompting. Manual approve asks for each tool use._",
      }],
    },
  ];
}

/**
 * Build blocks for /mode command (button selection).
 * Uses SDK permission mode names directly.
 */
export function buildModeSelectionBlocks(currentMode: PermissionMode): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Select Permission Mode*\nCurrent: \`${currentMode}\``,
      },
    },
    {
      type: "actions",
      block_id: "mode_selection",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: ":clipboard: plan" },
          action_id: "mode_plan",
          value: "plan",
          ...(currentMode === 'plan' ? { style: "primary" } : {}),
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":question: default (ask)" },
          action_id: "mode_default",
          value: "default",
          ...(currentMode === 'default' ? { style: "primary" } : {}),
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":rocket: bypassPermissions" },
          action_id: "mode_bypassPermissions",
          value: "bypassPermissions",
          ...(currentMode === 'bypassPermissions' ? { style: "primary" } : {}),
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":pencil: acceptEdits" },
          action_id: "mode_acceptEdits",
          value: "acceptEdits",
          ...(currentMode === 'acceptEdits' ? { style: "primary" } : {}),
        },
      ],
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "• *plan* - Read-only, writes to plan file\n• *default* - Prompts for approval\n• *bypassPermissions* - Runs without approval\n• *acceptEdits* - Accept code edits without prompting",
      }],
    },
  ];
}

// ============================================================================
// Tool Approval Blocks (for manual approval mode)
// ============================================================================

/**
 * Parameters for tool approval blocks.
 */
export interface ToolApprovalBlockParams {
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

/**
 * Format tool input for display in Slack.
 * Truncates long values to keep the message readable.
 */
export function formatToolInput(input: Record<string, unknown>): string {
  const str = JSON.stringify(input, null, 2);
  return str.length > 500 ? str.slice(0, 500) + '...' : str;
}

/**
 * Build blocks for tool approval request.
 * Shown when in default mode and Claude wants to use a tool.
 */
export function buildToolApprovalBlocks(params: ToolApprovalBlockParams): Block[] {
  const { approvalId, toolName, toolInput } = params;
  const inputPreview = formatToolInput(toolInput);

  return [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Claude wants to use:* \`${toolName}\`\n\`\`\`${inputPreview}\`\`\``,
      },
    },
    {
      type: 'actions',
      block_id: `tool_approval_${approvalId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          style: 'primary',
          action_id: `tool_approve_${approvalId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny', emoji: true },
          style: 'danger',
          action_id: `tool_deny_${approvalId}`,
        },
      ],
    },
  ];
}

// ============================================================================
// Thread-to-Thread Fork Blocks
// ============================================================================

/**
 * Parameters for fork anchor blocks.
 */
export interface ForkAnchorBlockParams {
  description: string;
}

/**
 * Build blocks for the anchor message when forking from thread to thread.
 * This message serves as the parent for the new forked thread.
 */
export function buildForkAnchorBlocks(params: ForkAnchorBlockParams): Block[] {
  const { description } = params;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔀 *Forked:* ${description}`,
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

// ============================================================================
// Path Configuration Blocks
// ============================================================================

/**
 * Build blocks for path setup prompt when working directory not configured.
 */
export function buildPathSetupBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':warning: *Working directory not configured*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Before I can help, you need to set the working directory for this channel.\n\nThis is a *one-time setup* and cannot be changed later.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Usage:*\n```/path /absolute/path/to/your/project```',
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: ':bulb: Tip: Use `/ls` to explore the current directory first.',
      }],
    },
  ];
}
