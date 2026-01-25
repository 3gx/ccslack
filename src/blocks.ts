/**
 * Block Kit builders for Slack messages.
 * Centralizes construction of interactive message blocks.
 */

import { PermissionMode, LastUsage } from './session-manager.js';
import type { ModelInfo } from './model-cache.js';
import { MESSAGE_SIZE_DEFAULT } from './commands.js';
import { markdownToSlack } from './utils.js';

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
 * Parameters for SDK AskUserQuestion tool blocks.
 * SDK uses {label, description} objects for options (vs simple strings in MCP ask_user).
 */
export interface SdkQuestionBlockParams {
  question: string;
  header: string;  // Short label (max 12 chars), e.g., "Auth method"
  options: Array<{ label: string; description: string }>;
  questionId: string;
  multiSelect: boolean;
}

/**
 * Build blocks for SDK AskUserQuestion tool.
 * Displays questions with label+description options, matching CLI fidelity.
 */
export function buildSdkQuestionBlocks(params: SdkQuestionBlockParams): Block[] {
  const { question, header, options, questionId, multiSelect } = params;
  const blocks: Block[] = [];

  // Header chip + question
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*[${header}]* ${question}`,
    },
  });

  if (options && options.length > 0) {
    const useMultiSelect = multiSelect || options.length > 5;

    if (useMultiSelect) {
      // Show descriptions as context above the dropdown
      const descriptions = options.map(opt => `*${opt.label}:* ${opt.description}`).join('\n');
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: descriptions,
        },
      });

      // Multi-select dropdown
      blocks.push({
        type: "section",
        block_id: `sdkq_multiselect_${questionId}`,
        text: { type: "mrkdwn", text: "_Select one or more options:_" },
        accessory: {
          type: "multi_static_select",
          action_id: `sdkq_multi_${questionId}`,
          placeholder: { type: "plain_text", text: "Select options..." },
          options: options.map(opt => ({
            text: { type: "plain_text", text: opt.label },
            value: opt.label,
          })),
        },
      });

      // Submit + Abort buttons
      blocks.push({
        type: "actions",
        block_id: `sdkq_actions_${questionId}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Submit" },
            action_id: `sdkq_submit_${questionId}`,
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            action_id: `sdkq_abort_${questionId}`,
            style: "danger",
          },
        ],
      });
    } else {
      // Option buttons with descriptions shown in section text
      for (let i = 0; i < options.length; i++) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${options[i].label}*\n${options[i].description}`,
          },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "Select" },
            action_id: `sdkq_${questionId}_${i}`,
            value: options[i].label,
          },
        });
      }

      // "Other" + Abort buttons
      blocks.push({ type: "divider" });
      blocks.push({
        type: "actions",
        block_id: `sdkq_extra_${questionId}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Other..." },
            action_id: `sdkq_other_${questionId}`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            action_id: `sdkq_abort_${questionId}`,
            style: "danger",
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
      block_id: `sdkq_extra_${questionId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Abort" },
          style: "danger",
          action_id: `sdkq_abort_${questionId}`,
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
  lastUsage?: LastUsage;
  maxThinkingTokens?: number;  // undefined = default (31,999), 0 = disabled
  updateRateSeconds?: number;  // undefined = 3 (default), range 1-10
  messageSize?: number;        // undefined = 500 (default), range 100-36000
  stripEmptyTag?: boolean;     // undefined = false (default), true = strip bare ``` wrappers
  planFilePath?: string | null;  // Plan file path for plan mode
}

// Default thinking tokens for display
const THINKING_TOKENS_DEFAULT = 31999;
// Default update rate for display
const UPDATE_RATE_DEFAULT = 3;

/**
 * Build blocks for /status command response.
 */
export function buildStatusDisplayBlocks(params: StatusDisplayParams): Block[] {
  const { sessionId, mode, workingDir, lastActiveAt, pathConfigured, configuredBy, configuredAt, lastUsage, maxThinkingTokens, updateRateSeconds, messageSize, stripEmptyTag, planFilePath } = params;

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

  // Add plan file path if set (only relevant in plan mode)
  if (planFilePath) {
    statusLines.push(`*Plan File:* \`${planFilePath}\``);
  }

  // Add model and context info if available
  if (lastUsage) {
    statusLines.push(`*Model:* ${lastUsage.model}`);
    const totalTokens = lastUsage.inputTokens + (lastUsage.cacheCreationInputTokens ?? 0) + lastUsage.cacheReadInputTokens;
    const contextPercent = lastUsage.contextWindow > 0
      ? Math.min(100, Math.max(0, Math.round((totalTokens / lastUsage.contextWindow) * 100)))
      : 0;
    statusLines.push(`*Context:* ${contextPercent}% (${totalTokens.toLocaleString()} / ${lastUsage.contextWindow.toLocaleString()} tokens)`);
  }

  // Add thinking tokens info
  if (maxThinkingTokens === 0) {
    statusLines.push(`*Thinking Tokens:* disabled`);
  } else if (maxThinkingTokens === undefined) {
    statusLines.push(`*Thinking Tokens:* ${THINKING_TOKENS_DEFAULT.toLocaleString()} (default)`);
  } else {
    statusLines.push(`*Thinking Tokens:* ${maxThinkingTokens.toLocaleString()}`);
  }

  // Add update rate info
  if (updateRateSeconds === undefined) {
    statusLines.push(`*Update Rate:* ${UPDATE_RATE_DEFAULT}s (default)`);
  } else {
    statusLines.push(`*Update Rate:* ${updateRateSeconds}s`);
  }

  // Add message size info
  if (messageSize === undefined) {
    statusLines.push(`*Message Size:* ${MESSAGE_SIZE_DEFAULT} (default)`);
  } else {
    statusLines.push(`*Message Size:* ${messageSize.toLocaleString()}`);
  }

  // Add strip empty tag info
  if (stripEmptyTag === true) {
    statusLines.push(`*Strip Empty Tag:* enabled`);
  } else {
    statusLines.push(`*Strip Empty Tag:* disabled (default)`);
  }

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

// SDK auto-compact constants (from cli.js: var zV6=13000, HV6 caps at 32000)
const COMPACT_BUFFER = 13000;
const DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS = 32000;  // CLI HV6 default cap

/**
 * Compute auto-compact threshold in tokens.
 * CLI formula: contextWindow - effectiveMaxOutput - 13000
 * CLI caps effectiveMaxOutput at 32k (HV6 function) regardless of model's native max.
 */
export function computeAutoCompactThreshold(contextWindow: number, maxOutputTokens?: number): number {
  const effectiveMaxOutput = Math.min(
    DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS,
    maxOutputTokens || DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS
  );
  return contextWindow - effectiveMaxOutput - COMPACT_BUFFER;
}

/** Format token count as "x.yk" with exactly one decimal (e.g., 67516 → "67.5k", 13000 → "13.0k") */
export function formatTokensK(tokens: number): string {
  return (tokens / 1000).toFixed(1) + 'k';
}

/**
 * Build blocks for /context command response.
 * Shows context window usage with a visual progress bar.
 */
export function buildContextDisplayBlocks(usage: LastUsage): Block[] {
  const { inputTokens, outputTokens, cacheReadInputTokens, contextWindow, model } = usage;
  const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0;
  const totalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const percent = contextWindow > 0
    ? Number(((totalTokens / contextWindow) * 100).toFixed(1))
    : 0;
  const remaining = contextWindow - totalTokens;

  // Calculate % left until auto-compact triggers (CLI formula: denominator = threshold, not contextWindow)
  const autoCompactThreshold = computeAutoCompactThreshold(contextWindow, usage.maxOutputTokens);
  const compactPercent = autoCompactThreshold > 0
    ? Math.max(0, Number(((autoCompactThreshold - totalTokens) / autoCompactThreshold * 100).toFixed(1)))
    : 0;
  const tokensToCompact = Math.max(0, autoCompactThreshold - totalTokens);

  // Build visual progress bar using block characters (20 blocks total)
  const filled = Math.min(20, Math.max(0, Math.round(percent / 5)));
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(20 - filled);

  // Determine health status
  let healthText: string;
  let healthEmoji: string;
  if (compactPercent <= 0) {
    healthText = 'Auto-compact imminent. Use `/compact` now.';
    healthEmoji = ':x:';
  } else if (compactPercent <= 10) {
    healthText = 'Context nearly full. Use `/compact` to reduce.';
    healthEmoji = ':x:';
  } else if (compactPercent <= 20) {
    healthText = 'Context usage high. Consider `/compact` to reduce.';
    healthEmoji = ':warning:';
  } else {
    healthText = 'Healthy context usage';
    healthEmoji = ':white_check_mark:';
  }

  // Format compact status
  const compactStatus = compactPercent > 0
    ? `*Auto-compact:* ${compactPercent.toFixed(1)}% remaining (${formatTokensK(tokensToCompact)} tok)`
    : `*Auto-compact:* imminent`;

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Context Usage" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Model:* ${model}`,
          `\n\`${bar}\` *${percent}%*`,
          `\n*Tokens used:* ${totalTokens.toLocaleString()} / ${contextWindow.toLocaleString()}`,
          `*Remaining:* ${remaining.toLocaleString()} tokens`,
          compactStatus,
          `\n_Breakdown:_`,
          `\u2022 Input: ${inputTokens.toLocaleString()}`,
          `\u2022 Output: ${outputTokens.toLocaleString()}`,
          `\u2022 Cache creation: ${cacheCreationInputTokens.toLocaleString()}`,
          `\u2022 Cache read: ${cacheReadInputTokens.toLocaleString()}`,
        ].join('\n'),
      },
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `${healthEmoji} ${healthText}`,
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
 * Parameters for plan approval blocks.
 */
export interface PlanApprovalBlockParams {
  conversationKey: string;  // Used to identify the conversation for the response
  allowedPrompts?: { tool: string; prompt: string }[];  // Requested permissions from ExitPlanMode
}

/**
 * Build blocks for plan approval prompt.
 * Shows CLI-fidelity 5-option approval UI matching the CLI behavior.
 * Displays requested permissions if provided.
 */
export function buildPlanApprovalBlocks(params: PlanApprovalBlockParams): Block[] {
  const { conversationKey, allowedPrompts } = params;
  const blocks: Block[] = [{ type: "divider" }];

  // Show requested permissions (matches CLI)
  if (allowedPrompts && allowedPrompts.length > 0) {
    const permList = allowedPrompts
      .map(p => `  · ${p.tool}(prompt: ${p.prompt})`)
      .join('\n');
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Requested permissions:*\n\`\`\`\n${permList}\n\`\`\`` },
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Would you like to proceed?*" },
  });

  // 5 options matching CLI:
  // 1. Yes, clear context and bypass permissions
  // 2. Yes, and manually approve edits
  // 3. Yes, and bypass permissions
  // 4. Yes, manually approve edits
  // 5. Type here to tell Claude what to change
  blocks.push({
    type: "actions",
    block_id: `plan_approval_1_${conversationKey}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "1. Clear context & bypass" },
        action_id: `plan_clear_bypass_${conversationKey}`,
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "2. Accept edits" },
        action_id: `plan_accept_edits_${conversationKey}`,
        style: "primary",
      },
    ],
  });

  blocks.push({
    type: "actions",
    block_id: `plan_approval_2_${conversationKey}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "3. Bypass permissions" },
        action_id: `plan_bypass_${conversationKey}`,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "4. Manual approve" },
        action_id: `plan_manual_${conversationKey}`,
      },
    ],
  });

  blocks.push({
    type: "actions",
    block_id: `plan_approval_3_${conversationKey}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "5. Change the plan" },
        action_id: `plan_reject_${conversationKey}`,
        style: "danger",
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: "_1: Fresh start + auto. 2: Auto-accept edits only. 3: Auto-accept all. 4: Ask for each. 5: Revise plan._",
    }],
  });

  return blocks;
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

/**
 * Build model selection UI from dynamic model list.
 */
export function buildModelSelectionBlocks(
  models: ModelInfo[],
  currentModel?: string
): Block[] {
  // Create buttons for each model (max 5 for Slack actions block)
  const buttons = models.slice(0, 5).map(model => ({
    type: 'button' as const,
    text: {
      type: 'plain_text' as const,
      text: model.displayName,
      emoji: true,
    },
    action_id: `model_select_${model.value}`,
    value: model.value,
    ...(currentModel === model.value ? { style: 'primary' as const } : {}),
  }));

  // Build description context
  const descriptions = models.slice(0, 5).map(m =>
    `• *${m.displayName}*: ${m.description}`
  ).join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Select Model*\nCurrent: \`${currentModel || 'default (SDK chooses)'}\``,
      },
    },
    {
      type: 'actions',
      block_id: 'model_selection',
      elements: buttons,
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: descriptions,
      }],
    },
  ];
}

/**
 * Build UI for when stored model is no longer available.
 * Shows warning and model selection.
 */
export function buildModelDeprecatedBlocks(
  deprecatedModel: string,
  models: ModelInfo[]
): Block[] {
  const selectionBlocks = buildModelSelectionBlocks(models, undefined);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: *Model No Longer Available*\n\nYour selected model \`${deprecatedModel}\` is no longer supported. Please select a new model to continue.`,
      },
    },
    { type: 'divider' },
    ...selectionBlocks,
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
  forkPointLink: string;
}

/**
 * Build blocks for the anchor message when forking from thread to thread.
 * This message serves as the parent for the new forked thread.
 */
export function buildForkAnchorBlocks(params: ForkAnchorBlockParams): Block[] {
  const { forkPointLink } = params;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔀 Point-in-time fork from <${forkPointLink}|this message>`,
      },
    },
  ];
}

// ============================================================================
// Fork to Channel Modal
// ============================================================================

export interface ForkToChannelModalMetadata {
  sourceChannelId: string;
  sourceMessageTs: string;
  conversationKey: string;
  threadTs?: string;
  sdkMessageId?: string;
  sessionId?: string;
}

/**
 * Build modal view for "Fork here" → new channel creation.
 * User enters channel name, modal creates channel with forked session.
 */
export function buildForkToChannelModalView(params: {
  sourceChannelId: string;
  sourceMessageTs: string;
  conversationKey: string;
  threadTs?: string;
  sdkMessageId?: string;
  sessionId?: string;
  suggestedChannelName?: string;
}): any {
  const inputElement: any = {
    type: 'plain_text_input',
    action_id: 'channel_name_input',
    placeholder: { type: 'plain_text', text: 'my-fork-channel' },
    max_length: 80,
  };

  // Prefill with suggested name if provided
  if (params.suggestedChannelName) {
    inputElement.initial_value = params.suggestedChannelName;
  }

  return {
    type: 'modal',
    callback_id: 'fork_to_channel_modal',
    private_metadata: JSON.stringify(params),
    title: { type: 'plain_text', text: 'Fork to New Channel' },
    submit: { type: 'plain_text', text: 'Create Channel' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Create a new channel with a forked conversation state from this point.',
        },
      },
      {
        type: 'input',
        block_id: 'channel_name_block',
        element: inputElement,
        label: { type: 'plain_text', text: 'Channel Name' },
        hint: { type: 'plain_text', text: 'Lowercase letters, numbers, hyphens, and underscores only' },
      },
    ],
  };
}

// ============================================================================
// Abort Confirmation Modal
// ============================================================================

/**
 * Build modal view for abort confirmation (prevents accidental fat-finger clicks).
 */
export function buildAbortConfirmationModalView(params: {
  abortType: 'query' | 'question' | 'sdk_question';
  key: string;
  channelId: string;
  messageTs: string;
}): any {
  let bodyText: string;
  switch (params.abortType) {
    case 'query':
      bodyText = 'This will interrupt Claude\'s current processing.';
      break;
    case 'question':
      bodyText = 'This will abort the current question.';
      break;
    case 'sdk_question':
      bodyText = 'This will abort Claude\'s question.';
      break;
  }

  return {
    type: 'modal',
    callback_id: 'abort_confirmation_modal',
    private_metadata: JSON.stringify(params),
    title: { type: 'plain_text', text: 'Confirm Abort' },
    submit: { type: 'plain_text', text: 'Abort' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:warning: *${bodyText}*` },
      },
    ],
  };
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
        text: '*Steps:*\n1. `/ls` - explore current directory\n2. `/cd /absolute/path/to/project` - navigate to desired directory\n3. `/set-current-path` - lock the directory',
      },
    },
  ];
}

// ============================================================================
// Real-Time Processing Feedback Blocks
// ============================================================================

// Activity entry type (mirrors session-manager.ts)
export interface ActivityEntry {
  timestamp: number;
  type: 'starting' | 'thinking' | 'tool_start' | 'tool_complete' | 'error' | 'generating' | 'aborted';
  tool?: string;
  durationMs?: number;
  message?: string;
  thinkingContent?: string;
  thinkingTruncated?: string;
  thinkingInProgress?: boolean; // True while thinking is streaming (for rolling window)
  // For generating (text streaming)
  generatingChunks?: number;    // Number of text chunks received
  generatingChars?: number;     // Total characters generated
  generatingInProgress?: boolean; // True while text is streaming
  generatingContent?: string;   // Full response text (stored for modal/download)
  generatingTruncated?: string; // First 500 chars (for live display)
}

// Constants for activity log display
const THINKING_TRUNCATE_LENGTH = 500;
const MAX_LIVE_ENTRIES = 300;
const ROLLING_WINDOW_SIZE = 20;
export const ACTIVITY_LOG_MAX_CHARS = 1000; // Reduced from 2000 for cleaner display

/**
 * Parameters for status panel blocks.
 */
export interface StatusPanelParams {
  status: 'starting' | 'thinking' | 'tool' | 'complete' | 'error' | 'aborted' | 'generating';
  mode: PermissionMode;
  model?: string;
  currentTool?: string;
  toolsCompleted: number;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  contextPercent?: number;
  compactPercent?: number;  // % left until auto-compact triggers
  tokensToCompact?: number;  // Tokens remaining before auto-compact
  costUsd?: number;
  conversationKey: string;
  errorMessage?: string;
  spinner?: string;  // Current spinner frame (cycles to show bot is alive)
  rateLimitHits?: number;  // Number of Slack rate limits encountered
  customStatus?: string;  // Custom status text (overrides default for thinking/complete)
}

/**
 * Get emoji for a tool based on its name.
 */
export function getToolEmoji(toolName?: string): string {
  if (!toolName) return ':gear:';
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower.includes('glob') || lower.includes('grep')) return ':mag:';
  if (lower.includes('edit') || lower.includes('write')) return ':memo:';
  if (lower.includes('bash') || lower.includes('shell')) return ':computer:';
  if (lower.includes('web') || lower.includes('fetch')) return ':globe_with_meridians:';
  if (lower.includes('task')) return ':robot_face:';
  if (lower.includes('todo')) return ':clipboard:';
  return ':gear:';
}

/**
 * Format SDK tool name for display.
 * Handles MCP-style names like "mcp__claude-code__Read" -> "Read"
 */
export function formatToolName(sdkToolName: string): string {
  if (!sdkToolName.includes('__')) return sdkToolName;
  return sdkToolName.split('__').pop()!;
}

/**
 * Build blocks for status panel (Message 1).
 * Shows mode, model, current activity, and abort button during processing.
 * Shows final stats (tokens, context %, cost) on completion.
 */
export function buildStatusPanelBlocks(params: StatusPanelParams): Block[] {
  const {
    status,
    mode,
    model,
    currentTool,
    toolsCompleted,
    elapsedMs,
    inputTokens,
    outputTokens,
    contextPercent,
    compactPercent,
    tokensToCompact,
    costUsd,
    conversationKey,
    errorMessage,
    spinner,
    rateLimitHits,
    customStatus,
  } = params;

  const blocks: Block[] = [];

  // SDK mode labels for display
  const modeLabels: Record<PermissionMode, string> = {
    plan: 'Plan',
    default: 'Default',
    bypassPermissions: 'Bypass',
    acceptEdits: 'AcceptEdits',
  };
  const modeLabel = modeLabels[mode] || mode;

  // Format elapsed time
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  switch (status) {
    case 'starting':
      // Header with spinner and elapsed time
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:robot_face: *Claude is working...* ${spinner || ''} [${elapsedSec}s]`,
        },
      });
      // Status line
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${modeLabel} | Starting..._`,
        }],
      });
      // Abort button only (no View Log)
      blocks.push({
        type: 'actions',
        block_id: `status_panel_${conversationKey}`,
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Abort' },
          style: 'danger',
          action_id: `abort_query_${conversationKey}`,
        }],
      });
      break;

    case 'thinking':
    case 'tool':
    case 'generating':
      // Header with spinner and elapsed time
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:robot_face: *Claude is working...* ${spinner || ''} [${elapsedSec}s]`,
        },
      });
      // Build status line with current activity
      const activityParts = [modeLabel];
      if (model) activityParts.push(model);
      if (customStatus) {
        activityParts.push(customStatus);
      } else if (status === 'thinking') {
        activityParts.push('Thinking...');
      } else if (status === 'generating') {
        activityParts.push('Generating...');
      } else if (currentTool) {
        activityParts.push(`Running: ${currentTool}`);
      }
      if (toolsCompleted > 0) {
        activityParts.push(`Tools: ${toolsCompleted}`);
      }
      activityParts.push(`${elapsedSec}s`);
      if (rateLimitHits && rateLimitHits > 0) {
        activityParts.push(`:warning: ${rateLimitHits} rate limit${rateLimitHits > 1 ? 's' : ''}`);
      }

      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${activityParts.join(' | ')}_`,
        }],
      });
      // Abort button only (no View Log)
      blocks.push({
        type: 'actions',
        block_id: `status_panel_${conversationKey}`,
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Abort' },
          style: 'danger',
          action_id: `abort_query_${conversationKey}`,
        }],
      });
      break;

    case 'complete':
      // Header
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':white_check_mark: *Complete*',
        },
      });
      // Build final stats line
      const statsParts = [modeLabel];
      if (model) statsParts.push(model);
      if (customStatus) {
        // Use custom status text for completion (e.g., compaction results)
        statsParts.push(customStatus);
      } else {
        if (inputTokens || outputTokens) {
          const inStr = inputTokens ? inputTokens.toLocaleString() : '0';
          const outStr = outputTokens ? outputTokens.toLocaleString() : '0';
          statsParts.push(`${inStr} in / ${outStr} out`);
        }
        if (contextPercent !== undefined) {
          if (compactPercent !== undefined && compactPercent > 0) {
            statsParts.push(`${contextPercent}% ctx (${compactPercent}% to compact)`);
          } else if (compactPercent !== undefined && compactPercent <= 0) {
            statsParts.push(`${contextPercent}% ctx (compact soon)`);
          } else {
            statsParts.push(`${contextPercent}% ctx`);
          }
        }
        if (costUsd !== undefined) {
          statsParts.push(`$${costUsd.toFixed(4)}`);
        }
      }
      statsParts.push(`${elapsedSec}s`);
      if (rateLimitHits && rateLimitHits > 0) {
        statsParts.push(`:warning: ${rateLimitHits} rate limit${rateLimitHits > 1 ? 's' : ''}`);
      }

      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${statsParts.join(' | ')}_`,
        }],
      });
      // No abort button when complete
      break;

    case 'error':
      // Header
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':x: *Error*',
        },
      });
      // Error message (customStatus takes precedence if provided)
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${customStatus || errorMessage || 'Unknown error'}_`,
        }],
      });
      break;

    case 'aborted':
      // Header
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':octagonal_sign: *Aborted*',
        },
      });
      // Status line
      const abortedParts = [modeLabel];
      if (model) abortedParts.push(model);
      abortedParts.push('aborted');
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${abortedParts.join(' | ')}_`,
        }],
      });
      break;
  }

  return blocks;
}

/**
 * Parameters for combined status blocks (activity log + status panel).
 */
export interface CombinedStatusParams extends StatusPanelParams {
  activityLog: ActivityEntry[];
  inProgress: boolean;
  sessionId?: string;  // Current session ID (n/a initially)
  isNewSession?: boolean;  // Show [new] prefix in TOP line
  isFinalSegment?: boolean;  // Show Fork button on completion
  forkInfo?: { threadTs?: string; conversationKey: string; sdkMessageId?: string; sessionId?: string };  // For Fork button
  hasFailedUpload?: boolean;  // Show retry button when upload failed
  retryUploadInfo?: {
    activityLogKey: string;   // Key for activity log lookup - NOT conversationKey
    channelId: string;
    threadTs?: string;        // Explicit threadTs for thread/channel parity
    statusMsgTs: string;
  };
}

// SDK mode labels for display (shared by helper functions)
const MODE_LABELS: Record<PermissionMode, string> = {
  plan: 'plan',
  default: 'default',
  bypassPermissions: 'bypass',
  acceptEdits: 'acceptEdits',
};

/**
 * Format token count with K suffix for readability.
 */
function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

/**
 * Build unified status line - progressive display as info becomes available.
 * Always shows mode | model | session, stats appended only at completion.
 *
 * @param mode - Permission mode
 * @param model - Model name (e.g., "claude-sonnet-4") or undefined
 * @param sessionId - Session ID or undefined
 * @param isNewSession - Show [new] prefix if true
 * @param contextPercent - Context usage percentage (completion only)
 * @param compactPercent - Percent remaining until auto-compact (completion only)
 * @param inputTokens - Input token count (completion only)
 * @param outputTokens - Output token count (completion only)
 * @param cost - Cost in USD (completion only)
 * @param durationMs - Duration in milliseconds (completion only)
 * @param rateLimitHits - Number of rate limits encountered
 * @returns Formatted string like "_plan | claude-sonnet-4 | abc123 | 43.7% ctx (43.6% 67.5k tok to ⚡) | 1.5k/800 | $0.05 | 5.0s_"
 */
export function buildUnifiedStatusLine(
  mode: PermissionMode,
  model?: string,
  sessionId?: string,
  isNewSession?: boolean,
  contextPercent?: number,
  compactPercent?: number,
  tokensToCompact?: number,
  inputTokens?: number,
  outputTokens?: number,
  cost?: number,
  durationMs?: number,
  rateLimitHits?: number
): string {
  const modeLabel = MODE_LABELS[mode] || mode;
  const parts: string[] = [modeLabel];

  // Model - always show, n/a if not available
  parts.push(model || 'n/a');

  // Session ID - always show, n/a if not available
  let sessionStr = sessionId || 'n/a';
  if (sessionId && isNewSession) {
    sessionStr = `[new] ${sessionId}`;
  }
  parts.push(sessionStr);

  // Stats - only if available (completion state)
  // Context % with compact info
  if (contextPercent !== undefined) {
    if (compactPercent !== undefined && tokensToCompact !== undefined) {
      parts.push(`${contextPercent.toFixed(1)}% ctx (${compactPercent.toFixed(1)}% ${formatTokensK(tokensToCompact)} tok to ⚡)`);
    } else if (compactPercent !== undefined) {
      parts.push(`${contextPercent.toFixed(1)}% ctx (${compactPercent.toFixed(1)}% to ⚡)`);
    } else {
      parts.push(`${contextPercent.toFixed(1)}% ctx`);
    }
  }

  // Tokens: input/output format
  if (inputTokens !== undefined || outputTokens !== undefined) {
    const inStr = formatTokenCount(inputTokens || 0);
    const outStr = formatTokenCount(outputTokens || 0);
    parts.push(`${inStr}/${outStr}`);
  }

  // Cost
  if (cost !== undefined) {
    parts.push(`$${cost.toFixed(2)}`);
  }

  // Duration
  if (durationMs !== undefined) {
    parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  }

  // Rate limit warning suffix (appended at end when > 0)
  if (rateLimitHits && rateLimitHits > 0) {
    parts.push(`:warning: ${rateLimitHits} limits`);
  }

  // Split into two lines: line 1 = mode | model | session, line 2 = stats
  const line1Parts = parts.slice(0, 3);  // mode, model, session
  const line2Parts = parts.slice(3);     // stats (context, tokens, cost, duration, rate limits)

  if (line2Parts.length === 0) {
    return `_${line1Parts.join(' | ')}_`;
  }
  return `_${line1Parts.join(' | ')}_\n_${line2Parts.join(' | ')}_`;
}

/**
 * Build combined status blocks (activity log + status panel in single message).
 *
 * Unified layout:
 * - Activity log section
 * - Spinner + elapsed (in-progress only)
 * - Unified status line (always above button)
 * - Button: [Abort] during in-progress, [Fork here] on completion
 */
export function buildCombinedStatusBlocks(params: CombinedStatusParams): Block[] {
  const {
    activityLog,
    inProgress,
    status,
    mode,
    model,
    elapsedMs,
    inputTokens,
    outputTokens,
    contextPercent,
    compactPercent,
    tokensToCompact,
    costUsd,
    conversationKey,
    errorMessage,
    spinner,
    rateLimitHits,
    customStatus,
    sessionId,
    isNewSession,
    isFinalSegment,
    forkInfo,
    hasFailedUpload,
    retryUploadInfo,
  } = params;

  const blocks: Block[] = [];

  // Format elapsed time
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  // 1. Activity log section - ALWAYS first
  const activityText = buildActivityLogText(activityLog, inProgress, ACTIVITY_LOG_MAX_CHARS);
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: activityText },
    expand: true,
  } as Block);

  // Determine if in-progress vs terminal state
  const isInProgressStatus = ['starting', 'thinking', 'tool', 'generating'].includes(status);

  if (isInProgressStatus) {
    // 2. Spinner (context) - in-progress only
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${spinner || '⠋'} [${elapsedSec}s]`,
      }],
    });

    // 3. Unified status line (context) - progressive display, rate limits included
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: buildUnifiedStatusLine(
          mode,
          model,
          sessionId,
          isNewSession,
          contextPercent,    // live context% from per-turn data + session.lastUsage fallback
          compactPercent,    // live % remaining to auto-compact
          tokensToCompact,   // live tokens remaining to auto-compact
          undefined,  // no inputTokens during in-progress
          undefined,  // no outputTokens during in-progress
          undefined,  // no cost during in-progress
          undefined,  // no duration during in-progress
          rateLimitHits
        ),
      }],
    });

    // 4. Actions: [Abort]
    blocks.push({
      type: 'actions',
      block_id: `status_panel_${conversationKey}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Abort' },
          style: 'danger',
          action_id: `abort_query_${conversationKey}`,
        },
      ],
    });
  } else {
    // Terminal states: complete, aborted, error

    // Check if we have stats
    const hasStats = contextPercent !== undefined ||
                     inputTokens !== undefined ||
                     outputTokens !== undefined ||
                     costUsd !== undefined;

    // 2. Unified status line (context) - ALWAYS above button
    if (status === 'complete' || status === 'aborted' || (status === 'error' && hasStats)) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: buildUnifiedStatusLine(
            mode,
            model,
            sessionId,
            isNewSession,
            contextPercent,
            compactPercent,
            tokensToCompact,
            inputTokens,
            outputTokens,
            costUsd,
            elapsedMs,
            rateLimitHits
          ),
        }],
      });
    } else if (status === 'error') {
      // Error without stats - show error message in context
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_:x: ${customStatus || errorMessage || 'Unknown error'}_`,
        }],
      });
    }

    // 3. Actions: [Fork here] and/or [Generate Output] on completion
    const actionElements: any[] = [];

    // Fork button only on final segment (for BOTH thread AND main channel)
    if (isFinalSegment && forkInfo && status === 'complete') {
      actionElements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: ':twisted_rightwards_arrows: Fork here',
          emoji: true,
        },
        action_id: `fork_here_${forkInfo.conversationKey}`,
        value: JSON.stringify({
          threadTs: forkInfo.threadTs,
          sdkMessageId: forkInfo.sdkMessageId,
          sessionId: forkInfo.sessionId,
        }),
      });
    }

    // Generate Output button when upload failed (retry mechanism)
    if (hasFailedUpload && retryUploadInfo && status === 'complete') {
      actionElements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: ':page_facing_up: Generate Output',
          emoji: true,
        },
        action_id: `retry_upload_${retryUploadInfo.statusMsgTs}`,
        value: JSON.stringify(retryUploadInfo),
      });
    }

    // Only add actions block if there are buttons to show
    if (actionElements.length > 0) {
      blocks.push({
        type: 'actions',
        block_id: `status_panel_${conversationKey}`,
        elements: actionElements,
      });
    }
  }

  return blocks;
}


/**
 * Build activity log text for live display (during processing).
 * Uses rolling window if too many entries.
 * @param maxChars - Maximum characters for output (truncates from start if exceeded)
 */
export function buildActivityLogText(entries: ActivityEntry[], inProgress: boolean, maxChars: number = Infinity): string {
  // Apply rolling window if too many entries
  const displayEntries = entries.length > MAX_LIVE_ENTRIES
    ? entries.slice(-ROLLING_WINDOW_SIZE)
    : entries;

  const lines: string[] = [];

  // Show truncation notice if in rolling window mode
  if (entries.length > MAX_LIVE_ENTRIES) {
    const hiddenCount = entries.length - ROLLING_WINDOW_SIZE;
    lines.push(`_... ${hiddenCount} earlier entries (see full log after completion) ..._\n`);
  }

  // Build set of completed tools to avoid showing both start and complete
  const completedTools = new Set<string>();
  for (const entry of displayEntries) {
    if (entry.type === 'tool_complete' && entry.tool) {
      completedTools.add(entry.tool);
    }
  }

  for (const entry of displayEntries) {
    switch (entry.type) {
      case 'starting':
        lines.push(':brain: *Analyzing request...*');
        break;
      case 'thinking':
        // Show thinking content - rolling window for in-progress, truncated for complete
        const thinkingText = entry.thinkingTruncated || entry.thinkingContent || '';
        const charCount = entry.thinkingContent?.length || thinkingText.length;
        const thinkingDuration = entry.durationMs
          ? ` [${(entry.durationMs / 1000).toFixed(1)}s]`
          : '';

        if (entry.thinkingInProgress) {
          // In-progress: show "Thinking..." with rolling window of latest content
          const charIndicator = charCount > 0 ? ` _[${charCount} chars]_` : '';
          lines.push(`:brain: *Thinking...*${thinkingDuration}${charIndicator}`);
          if (thinkingText) {
            // Rolling window: thinkingTruncated contains last 500 chars with "..." prefix
            // Show up to 300 chars for live display to keep it readable
            const displayText = thinkingText.replace(/\n/g, ' ').trim();
            const preview = displayText.length > 300
              ? displayText.substring(displayText.length - 300)
              : displayText;
            if (preview) {
              // Add "..." prefix if this is a rolling window (starts with "...")
              const prefix = thinkingText.startsWith('...') && !preview.startsWith('...') ? '...' : '';
              lines.push(`> ${prefix}${preview}`);
            }
          }
        } else {
          // Completed: show final summary with last 500 chars (conclusion)
          const truncatedIndicator = charCount > THINKING_TRUNCATE_LENGTH
            ? ` _[${charCount} chars]_`
            : '';
          lines.push(`:brain: *Thinking*${thinkingDuration}${truncatedIndicator}`);
          if (thinkingText) {
            // Show last 500 chars of thinking (thinkingTruncated already contains last 500 with "..." prefix)
            const displayText = thinkingText.replace(/\n/g, ' ').trim();
            const preview = displayText.length > THINKING_TRUNCATE_LENGTH
              ? '...' + displayText.substring(displayText.length - THINKING_TRUNCATE_LENGTH)
              : displayText;
            if (preview) {
              lines.push(`> ${preview}`);
            }
          }
        }
        break;
      case 'tool_start':
        // Only show tool_start if tool hasn't completed yet (in progress)
        if (!completedTools.has(entry.tool || '')) {
          const startEmoji = getToolEmoji(entry.tool);
          lines.push(`${startEmoji} *${entry.tool}* [in progress]`);
        }
        break;
      case 'tool_complete':
        // Show completed tool with checkmark and duration
        const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
        lines.push(`:white_check_mark: *${entry.tool}*${duration}`);
        break;
      case 'error':
        lines.push(`:x: Error: ${entry.message}`);
        break;
      case 'generating':
        // Show text generation progress with optional content preview
        const responseText = entry.generatingTruncated || entry.generatingContent || '';
        const responseCharCount = entry.generatingContent?.length || entry.generatingChars || responseText.length;
        const genDuration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
        const charInfo = responseCharCount > 0 ? ` _[${responseCharCount.toLocaleString()} chars]_` : '';

        if (entry.generatingInProgress) {
          lines.push(`:pencil: *Generating...*${genDuration}${charInfo}`);
          if (responseText) {
            // Show preview of response (up to 300 chars)
            const displayText = responseText.replace(/\n/g, ' ').trim();
            const preview = displayText.length > 300
              ? displayText.substring(0, 300) + '...'
              : displayText;
            if (preview) {
              lines.push(`> ${preview}`);
            }
          }
        } else {
          lines.push(`:pencil: *Response*${genDuration}${charInfo}`);
          if (responseText) {
            // Show preview of completed response (first 300 chars)
            const displayText = responseText.replace(/\n/g, ' ').trim();
            const preview = displayText.length > 300
              ? displayText.substring(0, 300) + '...'
              : displayText;
            if (preview) {
              lines.push(`> ${preview}`);
            }
          }
        }
        break;
      case 'aborted':
        lines.push(':octagonal_sign: *Aborted by user*');
        break;
    }
  }

  // Fallback only if no entries at all (shouldn't happen with starting entry)
  if (lines.length === 0) {
    lines.push(':brain: Analyzing request...');
  }

  let result = lines.join('\n');

  // Truncate from start if exceeds maxChars (keep most recent)
  if (result.length > maxChars) {
    const excess = result.length - maxChars + 50; // Room for "..." prefix
    const breakPoint = result.indexOf('\n', excess);
    if (breakPoint > 0) {
      result = '...\n' + result.substring(breakPoint + 1);
    } else {
      result = '...' + result.substring(result.length - maxChars + 3);
    }
  }

  return result;
}


/**
 * Build blocks for LIVE activity display (during processing).
 * Shows rolling activity with thinking previews, tool durations, etc.
 * Used by /watch and /ff for in-progress turns AND completed turns.
 * Fork button shown only on final segment when forkInfo is provided.
 *
 * @param activityEntries - Activity entries to display
 * @param inProgress - Whether this segment is still in progress
 * @param isFinalSegment - Whether this is the final segment (shows Fork button)
 * @param forkInfo - Fork button info (required for Fork button to show)
 */
export function buildLiveActivityBlocks(
  activityEntries: ActivityEntry[],
  inProgress: boolean = true,
  isFinalSegment: boolean = false,
  forkInfo?: { threadTs?: string; conversationKey: string; sdkMessageId?: string; sessionId?: string }
): Block[] {
  const activityText = buildActivityLogText(activityEntries, inProgress, ACTIVITY_LOG_MAX_CHARS);

  const blocks: Block[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: activityText,
      },
    },
  ];

  // Fork button only on final segment when forkInfo is provided
  if (isFinalSegment && forkInfo) {
    blocks.push({
      type: 'actions',
      block_id: `activity_actions_fork`,
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':twisted_rightwards_arrows: Fork here',
            emoji: true,
          },
          action_id: `fork_here_${forkInfo.conversationKey}`,
          value: JSON.stringify({
            threadTs: forkInfo.threadTs,
            sdkMessageId: forkInfo.sdkMessageId,
            sessionId: forkInfo.sessionId,
          }),
        },
      ],
    });
  }

  return blocks;
}

// ============================================================================
// Terminal Watcher Blocks
// ============================================================================

/**
 * Build a "Stop Watching" button for terminal watch mode.
 * Used by both /watch and /ff commands to show consistent button styling.
 *
 * @param sessionId - The session ID being watched
 * @param threadTs - Optional thread ts for watcher lookup (anchor ts for thread-based output)
 * @returns Block with danger-styled button
 */
export function buildStopWatchingButton(sessionId: string, threadTs?: string): Block {
  return {
    type: 'actions',
    block_id: `terminal_watch_${sessionId}`,
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '🛑 Stop Watching', emoji: true },
      action_id: 'stop_terminal_watch',
      style: 'danger',
      value: JSON.stringify({ sessionId, threadTs }),
    }],
  };
}

/**
 * Build a Stop Watching button that includes the update rate in the button text.
 * Compact single-element display for terminal watch status.
 *
 * @param sessionId - The session ID being watched
 * @param updateRateSeconds - Update rate in seconds (e.g., 2)
 * @param threadTs - Optional thread ts for watcher lookup (anchor ts for thread-based output)
 * @returns Actions block with stop button including rate info
 */
export function buildWatchingStatusSection(sessionId: string, updateRateSeconds: number, threadTs?: string): Block {
  return {
    type: 'actions',
    block_id: `terminal_watch_${sessionId}`,
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: `🛑 Stop Watching (${updateRateSeconds}s)`, emoji: true },
      action_id: 'stop_terminal_watch',
      style: 'danger',
      value: JSON.stringify({ sessionId, threadTs }),
    }],
  };
}

// ============================================================================
// Thread Activity Formatting Functions
// ============================================================================

/**
 * Format batched activity entries for thread posting.
 * Shows completed tools with checkmarks, in-progress tools with gear.
 *
 * @param entries - Activity entries to format (typically tool_start/tool_complete)
 * @returns Formatted mrkdwn text for thread message
 */
export function formatThreadActivityBatch(entries: ActivityEntry[]): string {
  if (entries.length === 0) return '';

  // Build set of completed tools to avoid showing both start and complete
  const completedTools = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'tool_complete' && entry.tool) {
      completedTools.add(entry.tool);
    }
  }

  const lines: string[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case 'starting':
        lines.push(':brain: *Analyzing request...*');
        break;
      case 'tool_start':
        // Only show tool_start if tool hasn't completed yet
        if (!completedTools.has(entry.tool || '')) {
          const emoji = getToolEmoji(entry.tool);
          lines.push(`${emoji} *${formatToolName(entry.tool || 'Unknown')}* [in progress]`);
        }
        break;
      case 'tool_complete':
        const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
        lines.push(`:white_check_mark: *${formatToolName(entry.tool || 'Unknown')}*${duration}`);
        break;
      case 'error':
        lines.push(`:x: *Error:* ${entry.message || 'Unknown error'}`);
        break;
      case 'aborted':
        lines.push(':octagonal_sign: *Aborted by user*');
        break;
      // Thinking and generating get their own messages, not batched
    }
  }

  return lines.join('\n');
}

/**
 * Options for formatting thinking messages.
 */
export interface ThinkingMessageOptions {
  /** If true, show rolling tail (last N chars) instead of head (first N chars) */
  preserveTail?: boolean;
  /** Link to file message for cross-linking */
  attachmentLink?: string;
}

/**
 * Format thinking message for thread posting.
 * Shows thinking duration, char count, and preview.
 *
 * @param entry - Thinking activity entry
 * @param truncated - Whether the content was truncated (will have .md attachment)
 * @param charLimit - Character limit for display
 * @param options - Optional settings for formatting
 * @returns Formatted mrkdwn text for thread message
 */
export function formatThreadThinkingMessage(
  entry: ActivityEntry,
  truncated: boolean,
  charLimit: number,
  options?: ThinkingMessageOptions
): string {
  const content = entry.thinkingContent || entry.thinkingTruncated || '';
  const charCount = content.length;
  const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
  const charInfo = charCount > 0 ? ` _${charCount.toLocaleString()} chars_` : '';

  const lines: string[] = [];

  if (entry.thinkingInProgress) {
    // During streaming: keep rolling tail format with markdown preserved
    lines.push(`:brain: *Thinking...*${duration}${charInfo}`);
    // Show rolling tail (last N chars) of thinking content
    if (content) {
      const preview = content.length > charLimit
        ? content.substring(content.length - charLimit)  // last N chars
        : content;
      lines.push(preview);
    }
  } else {
    // Completed: apply markdownToSlack, preserve newlines
    lines.push(`:bulb: *Thinking*${duration}${charInfo}`);

    if (content) {
      const slackFormatted = markdownToSlack(content);
      let displayText: string;

      if (options?.preserveTail && slackFormatted.length > charLimit) {
        // Preserve tail (rolling window) - shows conclusion
        displayText = '...' + slackFormatted.substring(slackFormatted.length - charLimit);
      } else if (slackFormatted.length > charLimit) {
        // Default: show head (first N chars)
        displayText = slackFormatted.substring(0, charLimit) + '...';
      } else {
        displayText = slackFormatted;
      }

      lines.push(displayText);
    }

    // Add suffix based on truncation and attachment link
    if (truncated && options?.attachmentLink) {
      // Cross-link to file message
      lines.push(`_Full response <${options.attachmentLink}|attached>._`);
    } else if (truncated && options && !options.attachmentLink) {
      // Options provided but no link - waiting for upload or showing retry button
      // (button will be added separately in blocks)
    } else if (truncated) {
      // Legacy fallback (no options provided)
      lines.push('_Full content attached._');
    }
  }

  return lines.join('\n');
}

/**
 * Metadata stored in retry button value for retrieving thinking content.
 */
export interface AttachThinkingButtonValue {
  threadParentTs: string;
  channelId: string;
  sessionId: string;
  thinkingTimestamp: number;
  thinkingCharCount: number;
  activityMsgTs: string;
}

/**
 * Build "Attach Response" button for failed file uploads.
 * Button stores minimal metadata; content is read from session file on click.
 *
 * @param activityMsgTs - The thinking message ts to update
 * @param threadParentTs - Thread parent ts for uploading files
 * @param channelId - Channel ID
 * @param sessionId - Session ID for looking up thinking content
 * @param thinkingTimestamp - entry.timestamp for session file lookup
 * @param thinkingCharCount - content.length for verification
 * @returns Actions block with retry button
 */
export function buildAttachThinkingFileButton(
  activityMsgTs: string,
  threadParentTs: string,
  channelId: string,
  sessionId: string,
  thinkingTimestamp: number,
  thinkingCharCount: number
): Block {
  const value: AttachThinkingButtonValue = {
    threadParentTs,
    channelId,
    sessionId,
    thinkingTimestamp,
    thinkingCharCount,
    activityMsgTs,
  };

  return {
    type: 'actions',
    block_id: `attach_thinking_${activityMsgTs}`,
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: ':page_facing_up: Attach Response', emoji: true },
      action_id: `attach_thinking_file_${activityMsgTs}`,
      value: JSON.stringify(value),
    }],
  };
}

/**
 * Format response message for thread posting.
 * Shows response duration, char count, and preview.
 *
 * @param charCount - Number of characters in the response
 * @param durationMs - Duration in milliseconds
 * @param preview - Preview text (first ~300 chars)
 * @param truncated - Whether the content was truncated (will have .md attachment)
 * @returns Formatted mrkdwn text for thread message
 */
export function formatThreadResponseMessage(
  charCount: number,
  durationMs: number | undefined,
  content: string,
  truncated: boolean,
  charLimit: number
): string {
  // Convert markdown to Slack format (same as main channel)
  const slackFormatted = markdownToSlack(content);

  const lines: string[] = [];
  lines.push(':speech_balloon: *Response*');  // Same emoji as main channel

  // Show content with newlines preserved (up to charLimit)
  if (slackFormatted) {
    const displayText = slackFormatted.length > charLimit
      ? slackFormatted.substring(0, charLimit) + '...'
      : slackFormatted;
    lines.push(displayText);
  }

  if (truncated) {
    lines.push('_Full content attached._');
  }

  return lines.join('\n');
}

/**
 * Format starting message for thread posting.
 *
 * @returns Formatted mrkdwn text for thread message
 */
export function formatThreadStartingMessage(): string {
  return ':brain: *Analyzing request...*';
}

/**
 * Format error message for thread posting.
 *
 * @param message - Error message
 * @returns Formatted mrkdwn text for thread message
 */
export function formatThreadErrorMessage(message: string): string {
  return `:x: *Error:* ${message}`;
}
