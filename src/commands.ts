/**
 * Command parser and handlers for slash commands.
 * Commands are prefixed with `/` (e.g., /status, /mode, /continue)
 */

import fs from 'fs';
import path from 'path';
import { Session, PermissionMode } from './session-manager.js';
import {
  Block,
  buildStatusDisplayBlocks,
  buildTerminalCommandBlocks,
  buildModeSelectionBlocks,
  buildContextDisplayBlocks,
  buildWatchingStatusSection,
} from './blocks.js';

// Extended thinking token limits
const THINKING_TOKENS_MIN = 1024;
const THINKING_TOKENS_MAX = 128000;
const THINKING_TOKENS_DEFAULT = 31999;

// Update rate limits (seconds)
export const UPDATE_RATE_MIN = 1;
export const UPDATE_RATE_MAX = 10;
export const UPDATE_RATE_DEFAULT = 2;

// Message size limit (characters before response is truncated)
const MESSAGE_SIZE_MIN = 100;
const MESSAGE_SIZE_MAX = 36000;  // 90% of Slack's 40000 char limit
export const MESSAGE_SIZE_DEFAULT = 500;

export interface CommandResult {
  handled: boolean;
  response?: string;
  blocks?: Block[];
  sessionUpdate?: Partial<Session>;
  // For /wait command - rate limit stress test
  waitTest?: {
    seconds: number;
  };
  // For /model command - triggers model selection UI (async fetch in handler)
  showModelSelection?: boolean;
  // For /compact command - triggers session compaction
  compactSession?: boolean;
  // For /clear command - clears session history
  clearSession?: boolean;
  // For /watch command - signals to start terminal session watching
  startTerminalWatch?: boolean;
  // For /stop-watching command - signals to stop terminal session watching
  stopTerminalWatch?: boolean;
  // For /ff command - signals to fast-forward sync missed terminal messages then start watching
  fastForward?: boolean;
}

/**
 * Parse and handle slash commands.
 * Returns { handled: false } if text is not a command (passes to Claude).
 * @param text - The command text (e.g., "/watch", "/ff")
 * @param session - Current session state
 * @param threadTs - Thread timestamp if command is from a thread (undefined for main channel)
 */
export function parseCommand(
  text: string,
  session: Session,
  threadTs?: string
): CommandResult {
  // Only handle slash commands
  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const [command, ...args] = text.slice(1).split(/\s+/);
  const argString = args.join(' ').trim();

  switch (command.toLowerCase()) {
    case 'help':
      return handleHelp();
    case 'status':
      return handleStatus(session);
    case 'context':
      return handleContext(session);
    case 'mode':
      return handleMode(argString, session);
    case 'set-current-path':
      return handleSetCurrentPath(session);
    case 'cd':
      return handleCd(argString, session);
    case 'ls':
      return handleLs(argString, session);
    case 'watch':
      return handleWatch(session, threadTs);
    case 'stop-watching':
      return handleStopWatching();
    case 'ff':
    case 'fast-forward':
      return handleFastForward(session, threadTs);
    case 'fork':
      return handleFork(session);
    case 'resume':
      return handleResume(argString);
    case 'wait':
      return handleWait(argString);
    case 'model':
      return handleModel(argString);
    case 'compact':
      return handleCompact(session);
    case 'clear':
      return handleClear(session);
    case 'max-thinking-tokens':
      return handleMaxThinkingTokens(argString, session);
    case 'update-rate':
      return handleUpdateRate(argString, session);
    case 'message-size':
      return handleMessageSize(argString, session);
    case 'strip-empty-tag':
      return handleStripEmptyTag(argString, session);
    default:
      // Unknown command - return error
      return {
        handled: true,
        response: `Unknown command: \`/${command}\`\nType \`/help\` for available commands.`,
      };
  }
}

/**
 * /help - Show available commands
 */
function handleHelp(): CommandResult {
  const helpText = `*Available Commands*
\`/help\` - Show this help message
\`/ls [path]\` - List files in directory (relative or absolute)
\`/cd [path]\` - Change directory (only before path locked)
\`/set-current-path\` - Lock current directory (one-time only)
\`/status\` - Show session info (ID, mode, directory, context)
\`/context\` - Show context window usage
\`/mode\` - Show mode picker
\`/model\` - Show model picker
\`/max-thinking-tokens [n]\` - Set thinking budget (0=disable, 1024-128000, default=31999)
\`/update-rate [n]\` - Set status update interval (1-10 seconds, default=2)
\`/message-size [n]\` - Set message size limit before truncation (100-36000, default=500)
\`/strip-empty-tag [true|false]\` - Strip bare \`\`\` wrappers (default=false)
\`/watch\` - Get command to continue session in terminal and watch for activity
\`/stop-watching\` - Stop watching terminal session
\`/ff\` - Fast-forward: sync missed terminal messages and start watching
\`/fork\` - Get command to fork session to terminal
\`/resume <id>\` - Resume a terminal session in Slack
\`/compact\` - Compact session to reduce context size
\`/clear\` - Clear session history (start fresh)
\`/wait <sec>\` - Rate limit test (1-300 seconds)`;

  return {
    handled: true,
    response: helpText,
  };
}

/**
 * /set-current-path - Lock current working directory (one-time only)
 */
function handleSetCurrentPath(session: Session): CommandResult {
  // Check if path already configured
  if (session.pathConfigured) {
    return {
      handled: true,
      response: `❌ Working directory already locked: \`${session.configuredPath}\`\n\nThis cannot be changed. If you need a different directory, use a different channel.`,
    };
  }

  // Use current working directory
  const currentPath = session.workingDir;

  // Normalize path (resolve symlinks, remove trailing slash)
  const normalizedPath = fs.realpathSync(currentPath);

  return {
    handled: true,
    response: `✅ Working directory locked to \`${normalizedPath}\`\n\n⚠️ This cannot be changed. \`/cd\` is now disabled. All Claude Code operations will use this directory.`,
    sessionUpdate: {
      pathConfigured: true,
      configuredPath: normalizedPath,
      workingDir: normalizedPath,
      configuredAt: Date.now(),
    },
  };
}

/**
 * /cd [path] - Change working directory (only before path locked)
 * Accepts relative or absolute paths
 */
function handleCd(pathArg: string, session: Session): CommandResult {
  // Check if path already configured
  if (session.pathConfigured) {
    return {
      handled: true,
      response: `❌ \`/cd\` is disabled after path locked.\n\nWorking directory is locked to: \`${session.configuredPath}\`\n\nUse \`/ls [path]\` to explore other directories.`,
    };
  }

  // If no path provided, show current directory
  if (!pathArg) {
    return {
      handled: true,
      response: `Current directory: \`${session.workingDir}\`\n\nUsage: \`/cd <path>\` (relative or absolute)\n\nTo lock this directory: \`/set-current-path\``,
    };
  }

  // Resolve path (handle both relative and absolute)
  let targetPath: string;

  if (pathArg.startsWith('/')) {
    // Absolute path
    targetPath = pathArg;
  } else {
    // Relative path
    targetPath = path.resolve(session.workingDir, pathArg);
  }

  // Validate: path exists
  if (!fs.existsSync(targetPath)) {
    return {
      handled: true,
      response: `❌ Directory does not exist: \`${targetPath}\``,
    };
  }

  // Check if it's a directory (not a file)
  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    return {
      handled: true,
      response: `❌ Not a directory: \`${targetPath}\``,
    };
  }

  // Check read/execute permissions
  try {
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot access directory: \`${targetPath}\`\n\nPermission denied or directory not readable.`,
    };
  }

  // Normalize path (resolve symlinks)
  const normalizedPath = fs.realpathSync(targetPath);

  return {
    handled: true,
    response: `📂 Changed to \`${normalizedPath}\`\n\nUse \`/ls\` to see files, or \`/set-current-path\` to lock this directory.`,
    sessionUpdate: {
      workingDir: normalizedPath,
    },
  };
}

/**
 * /ls [path] - List files in directory
 * Accepts relative or absolute paths. Always available.
 */
function handleLs(pathArg: string, session: Session): CommandResult {
  // Determine which directory to list
  let targetDir: string;
  if (!pathArg) {
    targetDir = session.workingDir;
  } else if (pathArg.startsWith('/')) {
    // Absolute path
    targetDir = pathArg;
  } else {
    // Relative path
    targetDir = path.resolve(session.workingDir, pathArg);
  }

  // Validate path exists
  if (!fs.existsSync(targetDir)) {
    return {
      handled: true,
      response: `❌ Directory does not exist: \`${targetDir}\``,
    };
  }

  // Check if it's a directory
  try {
    const stats = fs.statSync(targetDir);
    if (!stats.isDirectory()) {
      return {
        handled: true,
        response: `❌ Not a directory: \`${targetDir}\``,
      };
    }
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot access: \`${targetDir}\`\n\n${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const files = fs.readdirSync(targetDir);
    const totalFiles = files.length;

    // Show all files
    const fileList = files.join('\n');

    // Generate hint based on whether path is locked
    let hint: string;
    if (session.pathConfigured) {
      hint = `Current locked directory: \`${session.configuredPath}\``;
    } else {
      hint = `To navigate: \`/cd ${targetDir}\`\nTo lock directory: \`/set-current-path\``;
    }

    return {
      handled: true,
      response: `Files in \`${targetDir}\` (${totalFiles} total):\n\`\`\`\n${fileList}\n\`\`\`\n\n${hint}`,
    };
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * /status - Show session status
 */
function handleStatus(session: Session): CommandResult {
  return {
    handled: true,
    blocks: buildStatusDisplayBlocks({
      sessionId: session.sessionId,
      mode: session.mode,
      workingDir: session.workingDir,
      lastActiveAt: session.lastActiveAt,
      pathConfigured: session.pathConfigured,
      configuredBy: session.configuredBy,
      configuredAt: session.configuredAt,
      lastUsage: session.lastUsage,
      maxThinkingTokens: session.maxThinkingTokens,
      updateRateSeconds: session.updateRateSeconds,
      messageSize: session.threadCharLimit,
      stripEmptyTag: session.stripEmptyTag,
      planFilePath: session.planFilePath,
    }),
  };
}

/**
 * /context - Show context window usage
 */
function handleContext(session: Session): CommandResult {
  if (!session.lastUsage) {
    return {
      handled: true,
      response: 'No context data available. Run a query first.',
    };
  }

  return {
    handled: true,
    blocks: buildContextDisplayBlocks(session.lastUsage),
  };
}

/**
 * /mode - Show mode picker (selection only, no typed arguments)
 */
function handleMode(modeArg: string, session: Session): CommandResult {
  // If user tries to type a mode, redirect to selection UI
  if (modeArg) {
    return {
      handled: true,
      response: `Please use the mode picker to select a mode.`,
      blocks: buildModeSelectionBlocks(session.mode),
    };
  }

  // Show button selection UI
  return {
    handled: true,
    blocks: buildModeSelectionBlocks(session.mode),
  };
}

/**
 * /watch - Show command to continue session in terminal and start watching
 * Only allowed in main channel (rejected in threads).
 */
function handleWatch(session: Session, threadTs?: string): CommandResult {
  // Reject if called from a thread
  if (threadTs) {
    return {
      handled: true,
      response: ':warning: `/watch` can only be used in the main channel, not in threads.',
    };
  }

  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session. Start a conversation first.',
    };
  }

  const command = `cd ${session.workingDir} && claude --dangerously-skip-permissions --resume ${session.sessionId}`;
  const updateRate = session.updateRateSeconds ?? 2;

  return {
    handled: true,
    startTerminalWatch: true,
    blocks: [
      // Existing terminal command blocks
      {
        type: "header",
        text: { type: "plain_text", text: "Continue in Terminal" },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "Run this command to continue your session locally:" },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "```" + command + "```" },
      },
      {
        type: "divider",
      },
      // Watching status and stop button (combined on single line)
      buildWatchingStatusSection(session.sessionId, updateRate),
    ],
  };
}

/**
 * /stop-watching - Stop watching terminal session
 */
function handleStopWatching(): CommandResult {
  return {
    handled: true,
    stopTerminalWatch: true,
  };
}

/**
 * /ff (fast-forward) - Sync missed terminal messages and start watching
 * Use when you forgot to use /watch and did work directly in terminal.
 * Only allowed in main channel (rejected in threads).
 */
function handleFastForward(session: Session, threadTs?: string): CommandResult {
  // Reject if called from a thread
  if (threadTs) {
    return {
      handled: true,
      response: ':warning: `/ff` can only be used in the main channel, not in threads.',
    };
  }

  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session. Start a conversation first.',
    };
  }

  // Return flag - actual fast-forward logic handled in slack-bot.ts
  return {
    handled: true,
    fastForward: true,
  };
}

/**
 * /fork - Show command to fork session in terminal
 */
function handleFork(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session. Start a conversation first.',
    };
  }

  const command = `claude --resume ${session.sessionId} --fork-session`;

  return {
    handled: true,
    blocks: buildTerminalCommandBlocks({
      title: 'Fork to Terminal',
      description: 'Run this command to create a new branch from your session:',
      command,
      workingDir: session.workingDir,
      sessionId: session.sessionId,
      note: 'This creates a new session. The original Slack session remains unchanged.',
    }),
  };
}

/**
 * /resume <session-id> - Resume a terminal session in Slack
 */
function handleResume(sessionId: string): CommandResult {
  if (!sessionId) {
    return {
      handled: true,
      response:
        'Usage: `/resume <session-id>`\n\nGet the session ID from your terminal with `claude --print-session-id`',
    };
  }

  // Validate session ID format (UUID-like: 8-4-4-4-12 hex chars)
  const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuidPattern.test(sessionId)) {
    return {
      handled: true,
      response: `Invalid session ID format: \`${sessionId}\``,
    };
  }

  return {
    handled: true,
    response: `Resuming session \`${sessionId}\`\n\nYour next message will continue this session.`,
    sessionUpdate: { sessionId },
  };
}

/**
 * /wait <seconds> - Rate limit stress test
 * Updates spinner for X seconds to test Slack API limits
 */
function handleWait(secondsArg: string): CommandResult {
  const seconds = parseInt(secondsArg, 10);

  if (isNaN(seconds) || seconds < 1 || seconds > 300) {
    return {
      handled: true,
      response:
        'Usage: `/wait <seconds>` (1-300)\n\nThis command tests Slack rate limits by updating the spinner every second for X seconds.',
    };
  }

  return {
    handled: true,
    waitTest: { seconds },
  };
}

/**
 * /model - Show model picker
 * Model list is fetched dynamically from SDK in slack-bot.ts handler.
 */
function handleModel(modelArg: string): CommandResult {
  if (modelArg) {
    // User tried to type a model directly - redirect to selection UI
    return {
      handled: true,
      response: 'Please use the model picker to select a model.',
      showModelSelection: true,
    };
  }

  // Return flag - actual blocks built async in slack-bot.ts
  return {
    handled: true,
    showModelSelection: true,
  };
}

/**
 * /compact - Compact session to reduce context size
 * Requires an active session. Triggers SDK compaction via /compact prompt.
 */
function handleCompact(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session to compact. Start a conversation first.',
    };
  }

  // Return flag - actual compaction handled in slack-bot.ts
  return {
    handled: true,
    compactSession: true,
  };
}

/**
 * /clear - Clear session history and start fresh
 * Requires an active session. Triggers SDK clear via /clear prompt.
 */
function handleClear(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session to clear. Start a conversation first.',
    };
  }

  // Return flag - actual clear handled in slack-bot.ts
  return {
    handled: true,
    clearSession: true,
  };
}

/**
 * /max-thinking-tokens [n] - Set or show thinking token budget
 * - No args: Show current value
 * - 0: Disable extended thinking
 * - 1024-128000: Set thinking token budget
 */
function handleMaxThinkingTokens(args: string, session: Session): CommandResult {
  // No args - show current value
  if (!args.trim()) {
    const current = session.maxThinkingTokens;
    if (current === 0) {
      return { handled: true, response: 'Thinking tokens: disabled' };
    } else if (current === undefined) {
      return { handled: true, response: `Thinking tokens: ${THINKING_TOKENS_DEFAULT.toLocaleString()} (default)` };
    } else {
      return { handled: true, response: `Thinking tokens: ${current.toLocaleString()}` };
    }
  }

  // Parse value
  const value = parseInt(args.trim(), 10);
  if (isNaN(value)) {
    return {
      handled: true,
      response: 'Invalid value. Please provide a number (0 to disable, or 1,024-128,000).',
    };
  }

  // Validate
  if (value === 0) {
    return {
      handled: true,
      response: 'Extended thinking disabled.',
      sessionUpdate: { maxThinkingTokens: 0 },
    };
  }
  if (value < THINKING_TOKENS_MIN) {
    return {
      handled: true,
      response: `Invalid value. Minimum is ${THINKING_TOKENS_MIN.toLocaleString()} tokens (or 0 to disable).`,
    };
  }
  if (value > THINKING_TOKENS_MAX) {
    return {
      handled: true,
      response: `Invalid value. Maximum is ${THINKING_TOKENS_MAX.toLocaleString()} tokens.`,
    };
  }

  // Set value
  return {
    handled: true,
    response: `Thinking tokens set to ${value.toLocaleString()}.`,
    sessionUpdate: { maxThinkingTokens: value },
  };
}

/**
 * /update-rate [n] - Set or show status update interval
 * - No args: Show current value
 * - 1-10: Set update interval in seconds (fractional allowed)
 */
function handleUpdateRate(args: string, session: Session): CommandResult {
  // No args - show current value
  if (!args.trim()) {
    const current = session.updateRateSeconds;
    if (current === undefined) {
      return { handled: true, response: `Update rate: ${UPDATE_RATE_DEFAULT}s (default)` };
    } else {
      return { handled: true, response: `Update rate: ${current}s` };
    }
  }

  // Parse value (allow fractional)
  const value = parseFloat(args.trim());
  if (isNaN(value)) {
    return {
      handled: true,
      response: `Invalid value. Please provide a number between ${UPDATE_RATE_MIN} and ${UPDATE_RATE_MAX} seconds.`,
    };
  }

  // Validate range
  if (value < UPDATE_RATE_MIN) {
    return {
      handled: true,
      response: `Invalid value. Minimum is ${UPDATE_RATE_MIN} second.`,
    };
  }
  if (value > UPDATE_RATE_MAX) {
    return {
      handled: true,
      response: `Invalid value. Maximum is ${UPDATE_RATE_MAX} seconds.`,
    };
  }

  // Set value
  return {
    handled: true,
    response: `Update rate set to ${value}s.`,
    sessionUpdate: { updateRateSeconds: value },
  };
}

/**
 * /message-size [n] - Set or show message size limit
 * - No args: Show current value
 * - 100-36000: Set char limit before response is truncated
 */
function handleMessageSize(args: string, session: Session): CommandResult {
  // No args - show current value
  if (!args.trim()) {
    const current = session.threadCharLimit;
    if (current === undefined) {
      return { handled: true, response: `Message size limit: ${MESSAGE_SIZE_DEFAULT} (default)` };
    }
    return { handled: true, response: `Message size limit: ${current}` };
  }

  // Parse value
  const value = parseInt(args.trim(), 10);
  if (isNaN(value)) {
    return {
      handled: true,
      response: `Invalid number. Usage: /message-size <${MESSAGE_SIZE_MIN}-${MESSAGE_SIZE_MAX}> (default=${MESSAGE_SIZE_DEFAULT})`,
    };
  }

  // Validate range
  if (value < MESSAGE_SIZE_MIN || value > MESSAGE_SIZE_MAX) {
    return {
      handled: true,
      response: `Value must be between ${MESSAGE_SIZE_MIN} and ${MESSAGE_SIZE_MAX}. Default is ${MESSAGE_SIZE_DEFAULT}.`,
    };
  }

  // Set value
  return {
    handled: true,
    response: `Message size limit set to ${value}.`,
    sessionUpdate: { threadCharLimit: value },
  };
}

/**
 * /strip-empty-tag [true|false] - Control stripping of bare ``` wrappers
 * - No args: Show current value
 * - true: Strip bare ``` wrappers (Case C logic from stripMarkdownCodeFence)
 * - false: Don't strip bare ``` wrappers (default)
 */
function handleStripEmptyTag(args: string, session: Session): CommandResult {
  // No args - show current value
  if (!args.trim()) {
    const current = session.stripEmptyTag;
    if (current === true) {
      return { handled: true, response: 'Strip empty tag: enabled' };
    } else {
      return { handled: true, response: 'Strip empty tag: disabled (default)' };
    }
  }

  // Parse boolean value
  const value = args.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'on' || value === 'yes') {
    return {
      handled: true,
      response: 'Strip empty tag enabled. Bare ``` wrappers will be stripped.',
      sessionUpdate: { stripEmptyTag: true },
    };
  }
  if (value === 'false' || value === '0' || value === 'off' || value === 'no') {
    return {
      handled: true,
      response: 'Strip empty tag disabled. Bare ``` wrappers will be preserved.',
      sessionUpdate: { stripEmptyTag: false },
    };
  }

  // Invalid value
  return {
    handled: true,
    response: 'Invalid value. Usage: `/strip-empty-tag [true|false]`',
  };
}
