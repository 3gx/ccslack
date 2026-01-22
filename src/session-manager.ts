import fs from 'fs';
import path from 'path';
import os from 'os';
import * as crypto from 'crypto';

/**
 * SDK Permission Mode type - matches @anthropic-ai/claude-agent-sdk.
 * - 'plan': Read-only mode, writes to plan file via ExitPlanMode tool
 * - 'default': Ask-based mode, prompts for approval on tool use
 * - 'bypassPermissions': Auto mode, runs tools without approval
 * - 'acceptEdits': Accept code edits without prompting
 */
export type PermissionMode = 'plan' | 'default' | 'bypassPermissions' | 'acceptEdits';

/**
 * All available permission modes for UI display.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = ['plan', 'default', 'bypassPermissions', 'acceptEdits'];

/**
 * Usage data from the last query (for /status and /context commands).
 */
export interface LastUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  contextWindow: number;
  model: string;
}

export interface Session {
  sessionId: string | null;
  previousSessionIds?: string[];  // Track all sessions before /clear
  workingDir: string;
  mode: PermissionMode;
  model?: string;  // Selected model ID (e.g., "claude-sonnet-4-5-20250929")
  createdAt: number;
  lastActiveAt: number;
  // Path configuration fields (immutable once set)
  pathConfigured: boolean;      // Whether /path has been run
  configuredPath: string | null; // The immutable path
  configuredBy: string | null;   // User ID who set it
  configuredAt: number | null;   // When it was set
  // Usage data from last query (for /status and /context)
  lastUsage?: LastUsage;
  // Extended thinking configuration
  maxThinkingTokens?: number;  // undefined = default (31,999), 0 = disabled
  // Status update rate configuration
  updateRateSeconds?: number;  // undefined = 2 (default), range 1-10
  // Message size limit configuration
  threadCharLimit?: number;  // undefined = 500 (default), range 100-36000
  // Strip empty code fence tag configuration
  stripEmptyTag?: boolean;  // undefined = false (default), true = strip bare ``` wrappers
  // Persistent plan file path for plan mode (detected from tool usage)
  planFilePath?: string | null;
  // UUIDs of messages synced from terminal via /ff (for resumable fast-forward)
  syncedMessageUuids?: string[];
  // UUIDs of user messages that originated from Slack bot (to skip in /ff)
  slackOriginatedUserUuids?: string[];
}

/**
 * Thread session that is forked from a main session.
 */
export interface ThreadSession {
  sessionId: string | null;
  forkedFrom: string | null;  // Parent session ID
  forkedFromThreadTs?: string;  // Source thread's timestamp (for thread-to-thread forks)
  workingDir: string;
  mode: PermissionMode;
  model?: string;  // Selected model ID (inherited from channel)
  createdAt: number;
  lastActiveAt: number;
  // Path configuration fields (inherited from channel)
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy: string | null;
  configuredAt: number | null;
  /** SDK message ID this thread forked from (for point-in-time forking via resumeSessionAt) */
  resumeSessionAtMessageId?: string;
  // Usage data from last query (for /status and /context)
  lastUsage?: LastUsage;
  // Extended thinking configuration (inherited from channel)
  maxThinkingTokens?: number;  // undefined = default (31,999), 0 = disabled
  // Status update rate configuration (inherited from channel)
  updateRateSeconds?: number;  // undefined = 2 (default), range 1-10
  // Message size limit configuration (inherited from channel)
  threadCharLimit?: number;  // undefined = 500 (default), range 100-36000
  // Strip empty code fence tag configuration (inherited from channel)
  stripEmptyTag?: boolean;  // undefined = false (default), true = strip bare ``` wrappers
  // Persistent plan file path for plan mode (NOT inherited - each thread has its own)
  planFilePath?: string | null;
  // UUIDs of messages synced from terminal via /ff (for resumable fast-forward)
  syncedMessageUuids?: string[];
  // UUIDs of user messages that originated from Slack bot (to skip in /ff)
  slackOriginatedUserUuids?: string[];
}

/**
 * Activity log entry for real-time processing feedback.
 */
export interface ActivityEntry {
  timestamp: number;
  type: 'starting' | 'thinking' | 'tool_start' | 'tool_complete' | 'error' | 'generating';
  tool?: string;
  durationMs?: number;
  message?: string;
  // For thinking blocks
  thinkingContent?: string;     // Full content (stored for modal/download)
  thinkingTruncated?: string;   // First 500 chars (for live display)
  thinkingInProgress?: boolean; // True while thinking is streaming (for rolling window)
  // For generating (text streaming)
  generatingChunks?: number;    // Number of text chunks received
  generatingChars?: number;     // Total characters generated
  generatingInProgress?: boolean; // True while text is streaming
  generatingContent?: string;   // Full response text (stored for modal/download)
  generatingTruncated?: string; // First 500 chars (for live display)
}

/**
 * Maps Slack message timestamps to SDK message IDs for point-in-time thread forking.
 */
export interface SlackMessageMapping {
  /** SDK message ID (e.g., "msg_017pagAKz...") */
  sdkMessageId: string;
  /** Session ID this message belongs to (for forking from correct session after /clear) */
  sessionId: string;
  /** Message type */
  type: 'user' | 'assistant';
  /** Parent Slack timestamp - links assistant response to user message that triggered it */
  parentSlackTs?: string;
  /** True if this is a continuation of a split message (not the first part) */
  isContinuation?: boolean;
}

/**
 * Channel session data including main session and thread sessions.
 */
interface ChannelSession extends Session {
  threads?: {
    [threadTs: string]: ThreadSession;
  };
  /** Map of Slack ts → SDK message ID for point-in-time thread forking */
  messageMap?: Record<string, SlackMessageMapping>;
  /** Activity logs by conversationKey (for View Log modal) */
  activityLogs?: Record<string, ActivityEntry[]>;
}

interface SessionStore {
  channels: {
    [channelId: string]: ChannelSession;
  };
}

const SESSIONS_FILE = './sessions.json';

/**
 * Load sessions from disk. Handles corrupted files gracefully.
 */
export function loadSessions(): SessionStore {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const content = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      // Validate basic structure
      if (parsed && typeof parsed === 'object' && parsed.channels) {
        // Migration: Add default path config fields to existing sessions
        for (const channelId in parsed.channels) {
          const channel = parsed.channels[channelId];
          if (channel.pathConfigured === undefined) {
            channel.pathConfigured = false;
            channel.configuredPath = null;
            channel.configuredBy = null;
            channel.configuredAt = null;
          }
          // Migration: Add previousSessionIds field to existing sessions
          if (channel.previousSessionIds === undefined) {
            channel.previousSessionIds = [];
          }
          // Migrate threads too
          if (channel.threads) {
            for (const threadTs in channel.threads) {
              const thread = channel.threads[threadTs];
              if (thread.pathConfigured === undefined) {
                thread.pathConfigured = channel.pathConfigured;
                thread.configuredPath = channel.configuredPath;
                thread.configuredBy = channel.configuredBy;
                thread.configuredAt = channel.configuredAt;
              }
            }
          }
          // Migration: Add sessionId to messageMap entries that don't have it
          // This enables "time travel" forking after /clear
          if (channel.messageMap && channel.sessionId) {
            for (const slackTs in channel.messageMap) {
              const mapping = channel.messageMap[slackTs];
              if (!mapping.sessionId) {
                // Assign current sessionId to old entries (best effort)
                mapping.sessionId = channel.sessionId;
              }
            }
          }
        }
        return parsed;
      }
      console.error('sessions.json has invalid structure, resetting');
      return { channels: {} };
    } catch (error) {
      console.error('Failed to parse sessions.json, resetting:', error);
      return { channels: {} };
    }
  }
  return { channels: {} };
}

export function saveSessions(store: SessionStore): void {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2));
}

export function getSession(channelId: string): Session | null {
  const store = loadSessions();
  return store.channels[channelId] || null;
}

export function saveSession(channelId: string, session: Partial<Session>): void {
  const store = loadSessions();
  const existing = store.channels[channelId];

  store.channels[channelId] = {
    sessionId: existing?.sessionId ?? null,
    previousSessionIds: existing?.previousSessionIds ?? [],  // Preserve previous session history
    workingDir: existing?.workingDir ?? process.cwd(),
    mode: existing?.mode ?? 'default',
    model: existing?.model,  // Preserve selected model
    createdAt: existing?.createdAt ?? Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: existing?.pathConfigured ?? false,
    configuredPath: existing?.configuredPath ?? null,
    configuredBy: existing?.configuredBy ?? null,
    configuredAt: existing?.configuredAt ?? null,
    lastUsage: existing?.lastUsage,  // Preserve usage data for /status and /context
    maxThinkingTokens: existing?.maxThinkingTokens,  // Preserve thinking token config
    updateRateSeconds: existing?.updateRateSeconds,  // Preserve update rate config
    threadCharLimit: existing?.threadCharLimit,  // Preserve thread char limit config
    stripEmptyTag: existing?.stripEmptyTag,  // Preserve strip empty tag config
    planFilePath: existing?.planFilePath,  // Preserve plan file path for plan mode
    threads: existing?.threads,  // Preserve existing threads
    messageMap: existing?.messageMap,  // Preserve message mappings for point-in-time forking
    activityLogs: existing?.activityLogs,  // Preserve activity logs for View Log modal
    ...session,
  };
  saveSessions(store);
}

// ============================================================================
// Thread Session Management
// ============================================================================

/**
 * Get a thread session if it exists.
 */
export function getThreadSession(
  channelId: string,
  threadTs: string
): ThreadSession | null {
  const store = loadSessions();
  const channel = store.channels[channelId];
  if (!channel?.threads) {
    return null;
  }
  return channel.threads[threadTs] || null;
}

/**
 * Save a thread session.
 */
export function saveThreadSession(
  channelId: string,
  threadTs: string,
  session: Partial<ThreadSession>
): void {
  const store = loadSessions();
  const channel = store.channels[channelId];

  if (!channel) {
    // No main session exists - create a minimal one
    store.channels[channelId] = {
      sessionId: null,
      workingDir: process.cwd(),
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
      configuredBy: null,
      configuredAt: null,
      threads: {},
    };
  }

  if (!store.channels[channelId].threads) {
    store.channels[channelId].threads = {};
  }

  const existingThread = store.channels[channelId].threads![threadTs];

  store.channels[channelId].threads![threadTs] = {
    sessionId: existingThread?.sessionId ?? null,
    forkedFrom: existingThread?.forkedFrom ?? null,
    workingDir: existingThread?.workingDir ?? store.channels[channelId].workingDir,
    mode: existingThread?.mode ?? store.channels[channelId].mode,
    model: existingThread?.model ?? store.channels[channelId].model,  // Inherit model from channel
    createdAt: existingThread?.createdAt ?? Date.now(),
    lastActiveAt: Date.now(),
    // INHERIT path configuration from channel
    pathConfigured: existingThread?.pathConfigured ?? store.channels[channelId].pathConfigured,
    configuredPath: existingThread?.configuredPath ?? store.channels[channelId].configuredPath,
    configuredBy: existingThread?.configuredBy ?? store.channels[channelId].configuredBy,
    configuredAt: existingThread?.configuredAt ?? store.channels[channelId].configuredAt,
    lastUsage: existingThread?.lastUsage,  // Preserve usage data for /status and /context
    // Inherit thinking token config from channel
    maxThinkingTokens: existingThread?.maxThinkingTokens ?? store.channels[channelId].maxThinkingTokens,
    // Inherit thread char limit config from channel
    threadCharLimit: existingThread?.threadCharLimit ?? store.channels[channelId].threadCharLimit,
    // Inherit strip empty tag config from channel
    stripEmptyTag: existingThread?.stripEmptyTag ?? store.channels[channelId].stripEmptyTag,
    // NOT inherited - each thread has its own plan file path
    planFilePath: existingThread?.planFilePath,
    ...session,
  };

  saveSessions(store);
}

/**
 * Result of getting or creating a thread session.
 */
export interface ThreadSessionResult {
  session: ThreadSession;
  isNewFork: boolean;  // True if this is the first message in thread (needs fork)
}

/**
 * Get or create a thread session.
 * If the thread doesn't have a session, returns a new session that should be forked
 * from the appropriate session (determined by fork point, not current main session).
 *
 * @param channelId - Slack channel ID
 * @param threadTs - Slack thread timestamp
 * @param forkPoint - Fork point info from findForkPointMessageId (messageId + sessionId)
 */
export function getOrCreateThreadSession(
  channelId: string,
  threadTs: string,
  forkPoint?: ForkPointResult | null
): ThreadSessionResult {
  const existing = getThreadSession(channelId, threadTs);

  if (existing) {
    return {
      session: existing,
      isNewFork: false,
    };
  }

  // Thread doesn't have a session - create one that will be forked
  const mainSession = getSession(channelId);

  // IMPORTANT: Use the session ID from the fork point (where the message lives)
  // NOT the current main session (which may be null after /clear)
  // This enables "time travel" - forking a message from before /clear uses old session
  const forkedFromSessionId = forkPoint?.sessionId ?? mainSession?.sessionId ?? null;

  const newThreadSession: ThreadSession = {
    sessionId: null,  // Will be set after SDK creates the forked session
    forkedFrom: forkedFromSessionId,
    workingDir: mainSession?.workingDir ?? process.cwd(),
    mode: mainSession?.mode ?? 'default',
    model: mainSession?.model,  // Inherit model from main session
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    // Inherit path configuration from main session
    pathConfigured: mainSession?.pathConfigured ?? false,
    configuredPath: mainSession?.configuredPath ?? null,
    configuredBy: mainSession?.configuredBy ?? null,
    configuredAt: mainSession?.configuredAt ?? null,
    // Point-in-time forking: store the SDK message ID to fork from
    resumeSessionAtMessageId: forkPoint?.messageId,
    // Inherit thinking token config from main session
    maxThinkingTokens: mainSession?.maxThinkingTokens,
    // Inherit update rate config from main session
    updateRateSeconds: mainSession?.updateRateSeconds,
    // Inherit thread char limit config from main session
    threadCharLimit: mainSession?.threadCharLimit,
    // Inherit strip empty tag config from main session
    stripEmptyTag: mainSession?.stripEmptyTag,
  };

  // Save the new thread session
  saveThreadSession(channelId, threadTs, newThreadSession);

  return {
    session: newThreadSession,
    isNewFork: true,
  };
}

// ============================================================================
// Message Mapping (for point-in-time thread forking)
// ============================================================================

/**
 * Save a message mapping (Slack ts → SDK message ID).
 * Used for point-in-time thread forking - maps Slack message timestamps
 * to SDK message IDs so threads can fork from a specific point in history.
 */
export function saveMessageMapping(
  channelId: string,
  slackTs: string,
  mapping: SlackMessageMapping
): void {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    console.warn(`Cannot save message mapping - channel ${channelId} has no session`);
    return;
  }

  // Initialize messageMap if needed
  if (!channelSession.messageMap) {
    channelSession.messageMap = {};
  }

  channelSession.messageMap[slackTs] = mapping;
  saveSessions(store);
}

/**
 * Get a message mapping by Slack timestamp.
 */
export function getMessageMapping(
  channelId: string,
  slackTs: string
): SlackMessageMapping | null {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession?.messageMap) {
    return null;
  }

  return channelSession.messageMap[slackTs] ?? null;
}

/**
 * Result of finding a fork point - includes both message ID and session ID.
 */
export interface ForkPointResult {
  /** SDK message ID to use for resumeSessionAt */
  messageId: string;
  /** Session ID the message belongs to (for forking from correct session) */
  sessionId: string;
}

/**
 * Find the SDK message ID to fork from, given a parent Slack timestamp.
 *
 * Logic:
 * - If parent is assistant message: Use it directly
 * - If parent is user message (or not found): Find the LAST assistant message BEFORE this timestamp
 *   (not the response TO this message - we want past context, not future)
 *
 * @returns Fork point info (messageId + sessionId), or null if no assistant message found
 */
export function findForkPointMessageId(
  channelId: string,
  parentSlackTs: string
): ForkPointResult | null {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession?.messageMap) {
    console.warn(`No message map found for channel ${channelId}`);
    return null;
  }

  const mapping = channelSession.messageMap[parentSlackTs];

  // If parent is assistant message, use it directly
  if (mapping?.type === 'assistant' && mapping.sessionId) {
    return { messageId: mapping.sdkMessageId, sessionId: mapping.sessionId };
  }

  // Parent is user message (or not found) - find last assistant message BEFORE this timestamp
  // Sort all timestamps and find the most recent assistant message before parentSlackTs
  const sortedTimestamps = Object.keys(channelSession.messageMap)
    .filter(ts => ts < parentSlackTs)  // Only messages BEFORE the parent
    .sort((a, b) => parseFloat(b) - parseFloat(a));  // Sort descending (most recent first)

  for (const ts of sortedTimestamps) {
    const msg = channelSession.messageMap[ts];
    if (msg.type === 'assistant' && msg.sessionId) {
      console.log(`Found last assistant message at ${ts} (before ${parentSlackTs}) in session ${msg.sessionId}`);
      return { messageId: msg.sdkMessageId, sessionId: msg.sessionId };
    }
  }

  console.warn(`No assistant message found before ${parentSlackTs}`);
  return null;
}

/**
 * Result of finding the last synced message.
 */
export interface LastSyncedResult {
  /** SDK message ID (UUID from session file) */
  sdkMessageId: string;
  /** Session ID the message belongs to */
  sessionId: string;
}

/**
 * Get the last synced message ID for a channel/thread.
 * Used by /ff command to determine where to start syncing missed messages.
 *
 * Finds the newest messageMap entry by Slack timestamp for the current session.
 *
 * @param channelId - Slack channel ID
 * @param threadTs - Thread timestamp (optional, for thread sessions)
 * @param currentSessionId - Current session ID to filter by (optional)
 * @returns Last synced message info, or null if no messages synced yet
 */
export function getLastSyncedMessageId(
  channelId: string,
  threadTs?: string,
  currentSessionId?: string
): LastSyncedResult | null {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession?.messageMap) {
    return null;
  }

  // Get all messageMap entries
  const entries = Object.entries(channelSession.messageMap);
  if (entries.length === 0) {
    return null;
  }

  // Filter by sessionId if provided (to only sync messages from current session)
  // Also filter by thread context if in a thread
  const filteredEntries = entries.filter(([_ts, mapping]) => {
    // If currentSessionId provided, only consider messages from that session
    if (currentSessionId && mapping.sessionId !== currentSessionId) {
      return false;
    }
    return true;
  });

  if (filteredEntries.length === 0) {
    return null;
  }

  // Sort by Slack timestamp (descending) to find the newest
  const sortedEntries = filteredEntries.sort(([tsA], [tsB]) =>
    parseFloat(tsB) - parseFloat(tsA)
  );

  const [_ts, newestMapping] = sortedEntries[0];

  return {
    sdkMessageId: newestMapping.sdkMessageId,
    sessionId: newestMapping.sessionId,
  };
}

/**
 * Get all message UUIDs from messageMap for a channel.
 * Used by /ff command to filter out messages already posted to Slack.
 *
 * messageMap contains UUIDs from ALL sources:
 * - Regular Slack bot conversations
 * - /watch terminal imports
 * - /ff fast-forward imports
 *
 * @param channelId - Slack channel ID
 * @returns Set of all UUIDs already posted to Slack
 */
export function getMessageMapUuids(channelId: string): Set<string> {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession?.messageMap) {
    return new Set();
  }

  const uuids = new Set<string>();
  for (const mapping of Object.values(channelSession.messageMap)) {
    uuids.add(mapping.sdkMessageId);
  }

  return uuids;
}

/**
 * Get the set of synced message UUIDs for a channel/thread.
 * Used by /ff command for resumable fast-forward sync.
 *
 * @param channelId - Slack channel ID
 * @param threadTs - Thread timestamp (optional, for thread sessions)
 * @returns Set of synced UUIDs, empty set if none
 */
export function getSyncedMessageUuids(
  channelId: string,
  threadTs?: string
): Set<string> {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    return new Set();
  }

  if (threadTs) {
    const threadSession = channelSession.threads?.[threadTs];
    return new Set(threadSession?.syncedMessageUuids ?? []);
  }

  return new Set(channelSession.syncedMessageUuids ?? []);
}

/**
 * Add a synced message UUID for a channel/thread.
 * Called after each successful message post in /ff for crash-safe progress.
 *
 * @param channelId - Slack channel ID
 * @param uuid - Message UUID from session file
 * @param threadTs - Thread timestamp (optional, for thread sessions)
 */
export function addSyncedMessageUuid(
  channelId: string,
  uuid: string,
  threadTs?: string
): void {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    console.warn(`Cannot add synced UUID: channel ${channelId} not found`);
    return;
  }

  if (threadTs) {
    // Thread session
    if (!channelSession.threads?.[threadTs]) {
      console.warn(`Cannot add synced UUID: thread ${threadTs} not found`);
      return;
    }
    const existing = channelSession.threads[threadTs].syncedMessageUuids ?? [];
    if (!existing.includes(uuid)) {
      channelSession.threads[threadTs].syncedMessageUuids = [...existing, uuid];
      saveSessions(store);
    }
  } else {
    // Main channel session
    const existing = channelSession.syncedMessageUuids ?? [];
    if (!existing.includes(uuid)) {
      channelSession.syncedMessageUuids = [...existing, uuid];
      saveSessions(store);
    }
  }
}

/**
 * Clear synced message UUIDs for a channel/thread.
 * Called when session is cleared via /clear.
 *
 * @param channelId - Slack channel ID
 * @param threadTs - Thread timestamp (optional, for thread sessions)
 */
export function clearSyncedMessageUuids(
  channelId: string,
  threadTs?: string
): void {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    return;
  }

  if (threadTs) {
    if (channelSession.threads?.[threadTs]) {
      channelSession.threads[threadTs].syncedMessageUuids = [];
      saveSessions(store);
    }
  } else {
    channelSession.syncedMessageUuids = [];
    saveSessions(store);
  }
}

// ============================================================================
// Slack-Originated User Message Tracking
// ============================================================================

/**
 * Add a user message UUID that originated from Slack bot interaction.
 * Called after bot processes @mention to track that this user input came from Slack.
 * Used by /ff to skip posting these messages (they're already in Slack).
 *
 * @param channelId - Slack channel ID
 * @param uuid - User message UUID from session file
 * @param threadTs - Thread timestamp (optional, for thread sessions)
 */
export function addSlackOriginatedUserUuid(
  channelId: string,
  uuid: string,
  threadTs?: string
): void {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    console.warn(`Cannot add Slack-originated UUID: channel ${channelId} not found`);
    return;
  }

  if (threadTs) {
    // Thread session
    if (!channelSession.threads?.[threadTs]) {
      console.warn(`Cannot add Slack-originated UUID: thread ${threadTs} not found`);
      return;
    }
    const existing = channelSession.threads[threadTs].slackOriginatedUserUuids ?? [];
    if (!existing.includes(uuid)) {
      channelSession.threads[threadTs].slackOriginatedUserUuids = [...existing, uuid];
      saveSessions(store);
      console.log(`[SessionManager] Added Slack-originated user UUID: ${uuid} (thread ${threadTs})`);
    }
  } else {
    // Main channel session
    const existing = channelSession.slackOriginatedUserUuids ?? [];
    if (!existing.includes(uuid)) {
      channelSession.slackOriginatedUserUuids = [...existing, uuid];
      saveSessions(store);
      console.log(`[SessionManager] Added Slack-originated user UUID: ${uuid} (channel ${channelId})`);
    }
  }
}

/**
 * Check if a user message UUID originated from Slack bot interaction.
 * Used by /ff to skip posting messages that are already in Slack.
 *
 * @param channelId - Slack channel ID
 * @param uuid - User message UUID to check
 * @param threadTs - Thread timestamp (optional, for thread sessions)
 * @returns True if this message originated from Slack (should be skipped by /ff)
 */
export function isSlackOriginatedUserUuid(
  channelId: string,
  uuid: string,
  threadTs?: string
): boolean {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    return false;
  }

  if (threadTs) {
    const threadSession = channelSession.threads?.[threadTs];
    return threadSession?.slackOriginatedUserUuids?.includes(uuid) ?? false;
  }

  return channelSession.slackOriginatedUserUuids?.includes(uuid) ?? false;
}

/**
 * Clear Slack-originated user UUIDs for a channel/thread.
 * Called when session is cleared via /clear.
 *
 * @param channelId - Slack channel ID
 * @param threadTs - Thread timestamp (optional, for thread sessions)
 */
export function clearSlackOriginatedUserUuids(
  channelId: string,
  threadTs?: string
): void {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    return;
  }

  if (threadTs) {
    if (channelSession.threads?.[threadTs]) {
      channelSession.threads[threadTs].slackOriginatedUserUuids = [];
      saveSessions(store);
    }
  } else {
    channelSession.slackOriginatedUserUuids = [];
    saveSessions(store);
  }
}

// ============================================================================
// Session Cleanup
// ============================================================================

/**
 * Delete a single SDK session file from ~/.claude/projects/
 */
function deleteSdkSessionFile(sessionId: string, workingDir: string): void {
  try {
    // Convert working directory to project path format
    // Example: /Users/egx/ai/ccslack -> -Users-egx-ai-ccslack
    const projectPath = workingDir.replace(/\//g, '-').replace(/^-/, '-');

    // Build session file path
    const sessionFile = path.join(
      os.homedir(),
      '.claude/projects',
      projectPath,
      `${sessionId}.jsonl`
    );

    // Delete if exists
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
      console.log(`  ✓ Deleted SDK session file: ${sessionId}.jsonl`);
    } else {
      console.log(`  ℹ SDK session file not found (may have been deleted): ${sessionId}.jsonl`);
    }
  } catch (error) {
    console.error(`  ✗ Error deleting SDK session file ${sessionId}:`, error);
    // Don't throw - continue with other cleanups
  }
}

/**
 * Delete session for a channel (including all SDK files)
 *
 * Deletes:
 * 1. Main channel session from sessions.json
 * 2. All thread sessions from sessions.json
 * 3. All corresponding SDK .jsonl files
 *
 * @param channelId - Slack channel ID (e.g., "C0123456789")
 */
export function deleteSession(channelId: string): void {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession) {
    console.log(`No session found for channel ${channelId}`);
    return;
  }

  console.log(`Deleting sessions for channel ${channelId}...`);

  // Count sessions for logging
  const threadCount = channelSession.threads
    ? Object.keys(channelSession.threads).length
    : 0;
  const previousCount = channelSession.previousSessionIds?.length ?? 0;
  const totalSessions = 1 + previousCount + threadCount; // main + previous + threads

  console.log(`  Found ${totalSessions} session(s) to delete:`);
  console.log(`    - 1 main session`);
  if (previousCount > 0) {
    console.log(`    - ${previousCount} previous session(s) (from /clear operations)`);
  }
  if (threadCount > 0) {
    console.log(`    - ${threadCount} thread session(s)`);
  }

  // Delete main session SDK file
  if (channelSession.sessionId) {
    console.log(`  Deleting main session: ${channelSession.sessionId}`);
    deleteSdkSessionFile(channelSession.sessionId, channelSession.workingDir);
  }

  // Delete all previous session SDK files (from /clear operations)
  if (channelSession.previousSessionIds && channelSession.previousSessionIds.length > 0) {
    console.log(`  Deleting ${channelSession.previousSessionIds.length} previous session(s)...`);
    for (const prevId of channelSession.previousSessionIds) {
      if (prevId) {
        console.log(`    Previous: ${prevId}`);
        deleteSdkSessionFile(prevId, channelSession.workingDir);
      }
    }
  }

  // Delete all thread session SDK files
  if (channelSession.threads) {
    const threadEntries = Object.entries(channelSession.threads);
    console.log(`  Deleting ${threadEntries.length} thread session(s)...`);

    threadEntries.forEach(([threadTs, threadSession]) => {
      if (threadSession.sessionId) {
        console.log(`    Thread ${threadTs}: ${threadSession.sessionId}`);
        deleteSdkSessionFile(threadSession.sessionId, channelSession.workingDir);
      }
    });
  }

  // Delete from sessions.json
  delete store.channels[channelId];
  saveSessions(store);
  console.log(`  ✓ Removed channel ${channelId} from sessions.json`);

  console.log(`✅ Cleanup complete for channel ${channelId}`);
}

// ============================================================================
// Activity Log Storage (for View Log modal)
// ============================================================================

/**
 * Save activity log for a conversation.
 * Activity logs are stored by conversationKey (channelId or channelId_threadTs).
 */
export async function saveActivityLog(
  conversationKey: string,
  entries: ActivityEntry[]
): Promise<void> {
  const store = loadSessions();

  // Extract channelId from conversationKey
  const channelId = conversationKey.includes('_')
    ? conversationKey.split('_')[0]
    : conversationKey;

  const channelSession = store.channels[channelId];
  if (!channelSession) {
    console.warn(`Cannot save activity log - channel ${channelId} has no session`);
    return;
  }

  // Initialize activityLogs if needed
  if (!channelSession.activityLogs) {
    channelSession.activityLogs = {};
  }

  channelSession.activityLogs[conversationKey] = entries;
  saveSessions(store);
}

/**
 * Get activity log for a conversation.
 */
export async function getActivityLog(
  conversationKey: string
): Promise<ActivityEntry[] | null> {
  const store = loadSessions();

  // Extract channelId from conversationKey
  const channelId = conversationKey.includes('_')
    ? conversationKey.split('_')[0]
    : conversationKey;

  const channelSession = store.channels[channelId];

  if (!channelSession?.activityLogs) {
    return null;
  }

  return channelSession.activityLogs[conversationKey] ?? null;
}

/**
 * Merge activity entries into existing log (append, dedupe by timestamp).
 * Used by /watch and /ff to unify with bot's activity log.
 *
 * Deduplication is done by timestamp to handle:
 * - /ff re-syncing turns that were already partially synced
 * - /watch updating activity that was already saved
 *
 * @param conversationKey - The conversation key (channelId or channelId_threadTs)
 * @param newEntries - New activity entries to merge
 */
export async function mergeActivityLog(
  conversationKey: string,
  newEntries: ActivityEntry[]
): Promise<void> {
  const existing = await getActivityLog(conversationKey) ?? [];

  // Dedupe by timestamp (avoid duplicates when /ff re-syncs)
  const existingTimestamps = new Set(existing.map(e => e.timestamp));
  const uniqueNew = newEntries.filter(e => !existingTimestamps.has(e.timestamp));

  // Merge and sort by timestamp
  const merged = [...existing, ...uniqueNew].sort((a, b) => a.timestamp - b.timestamp);

  // Save the merged log using the internal save function
  const store = loadSessions();

  // Extract channelId from conversationKey
  const channelId = conversationKey.includes('_')
    ? conversationKey.split('_')[0]
    : conversationKey;

  const channelSession = store.channels[channelId];
  if (!channelSession) {
    console.warn(`Cannot merge activity log - channel ${channelId} has no session`);
    return;
  }

  // Initialize activityLogs if needed
  if (!channelSession.activityLogs) {
    channelSession.activityLogs = {};
  }

  channelSession.activityLogs[conversationKey] = merged;
  saveSessions(store);
}

// ============================================================================
// Segment Activity Log Storage (for View Log per-segment isolation)
// ============================================================================

/**
 * In-memory storage for segment activity logs.
 * Each segment gets a unique key and stores only that segment's entries.
 * This enables View Log buttons to show only their segment's activity.
 */
const segmentActivityLogs: Map<string, ActivityEntry[]> = new Map();

/**
 * Generate unique segment key using UUID (100% collision-free).
 * Format: {channelId}_{messageTs}_seg_{uuid}
 *
 * @param channelId - Slack channel ID
 * @param messageTs - threadTs if in thread, originalTs if main channel (never undefined)
 */
export function generateSegmentKey(
  channelId: string,
  messageTs: string
): string {
  const uuid = crypto.randomUUID();
  return `${channelId}_${messageTs}_seg_${uuid}`;
}

/**
 * Save activity log for a specific segment.
 * Creates a copy to avoid mutation issues.
 */
export function saveSegmentActivityLog(segmentKey: string, entries: ActivityEntry[]): void {
  segmentActivityLogs.set(segmentKey, [...entries]);
}

/**
 * Get activity log for a specific segment.
 * Returns a copy of the entries, or null if not found.
 */
export function getSegmentActivityLog(segmentKey: string): ActivityEntry[] | null {
  const entries = segmentActivityLogs.get(segmentKey);
  return entries ? [...entries] : null;
}

/**
 * Update segment activity log (for in-progress segments).
 * Replaces existing entries with new ones.
 */
export function updateSegmentActivityLog(segmentKey: string, entries: ActivityEntry[]): void {
  segmentActivityLogs.set(segmentKey, [...entries]);
}

/**
 * Clear segment activity logs for a conversation (on /clear or channel delete).
 *
 * For threads: clears all segments with prefix {channelId}_{threadTs}_seg_
 * For main channel (no threadTs): clears all segments with prefix {channelId}_
 *
 * @param channelId - Slack channel ID
 * @param threadTs - Thread timestamp (optional, for thread sessions)
 */
export function clearSegmentActivityLogs(channelId: string, threadTs?: string): void {
  if (threadTs) {
    // Thread: clear all segments for this specific thread
    const prefix = `${channelId}_${threadTs}_seg_`;
    for (const key of segmentActivityLogs.keys()) {
      if (key.startsWith(prefix)) {
        segmentActivityLogs.delete(key);
      }
    }
    console.log(`[SegmentActivity] Cleared segments for thread ${threadTs} in channel ${channelId}`);
  } else {
    // Main channel: clear ALL segments for this channel (includes thread segments)
    const prefix = `${channelId}_`;
    for (const key of segmentActivityLogs.keys()) {
      if (key.startsWith(prefix)) {
        segmentActivityLogs.delete(key);
      }
    }
    console.log(`[SegmentActivity] Cleared all segments for channel ${channelId}`);
  }
}

/**
 * Clear ALL segment activity logs (for testing).
 */
export function clearAllSegmentActivityLogs(): void {
  segmentActivityLogs.clear();
}
