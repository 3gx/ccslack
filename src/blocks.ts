/**
 * Block Kit builders for Slack messages.
 * Centralizes construction of interactive message blocks.
 */

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
  status: 'processing' | 'done' | 'aborted' | 'error';
  messageTs?: string;
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

    case 'done':
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Done*",
        },
      });
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
