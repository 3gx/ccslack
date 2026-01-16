import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * SDK Permission Mode type - matches @anthropic-ai/claude-code SDK.
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

export interface Session {
  sessionId: string | null;
  workingDir: string;
  mode: PermissionMode;
  createdAt: number;
  lastActiveAt: number;
  // Path configuration fields (immutable once set)
  pathConfigured: boolean;      // Whether /path has been run
  configuredPath: string | null; // The immutable path
  configuredBy: string | null;   // User ID who set it
  configuredAt: number | null;   // When it was set
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
  createdAt: number;
  lastActiveAt: number;
  // Path configuration fields (inherited from channel)
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy: string | null;
  configuredAt: number | null;
  /** SDK message ID this thread forked from (for point-in-time forking via resumeSessionAt) */
  resumeSessionAtMessageId?: string;
}

/**
 * Maps Slack message timestamps to SDK message IDs for point-in-time thread forking.
 */
export interface SlackMessageMapping {
  /** SDK message ID (e.g., "msg_017pagAKz...") */
  sdkMessageId: string;
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
    workingDir: existing?.workingDir ?? process.cwd(),
    mode: existing?.mode ?? 'default',
    createdAt: existing?.createdAt ?? Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: existing?.pathConfigured ?? false,
    configuredPath: existing?.configuredPath ?? null,
    configuredBy: existing?.configuredBy ?? null,
    configuredAt: existing?.configuredAt ?? null,
    threads: existing?.threads,  // Preserve existing threads
    messageMap: existing?.messageMap,  // Preserve message mappings for point-in-time forking
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
    createdAt: existingThread?.createdAt ?? Date.now(),
    lastActiveAt: Date.now(),
    // INHERIT path configuration from channel
    pathConfigured: existingThread?.pathConfigured ?? store.channels[channelId].pathConfigured,
    configuredPath: existingThread?.configuredPath ?? store.channels[channelId].configuredPath,
    configuredBy: existingThread?.configuredBy ?? store.channels[channelId].configuredBy,
    configuredAt: existingThread?.configuredAt ?? store.channels[channelId].configuredAt,
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
 * from the main session.
 *
 * @param channelId - Slack channel ID
 * @param threadTs - Slack thread timestamp
 * @param resumeSessionAtMessageId - Optional SDK message ID for point-in-time forking
 */
export function getOrCreateThreadSession(
  channelId: string,
  threadTs: string,
  resumeSessionAtMessageId?: string | null
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

  const newThreadSession: ThreadSession = {
    sessionId: null,  // Will be set after SDK creates the forked session
    forkedFrom: mainSession?.sessionId ?? null,
    workingDir: mainSession?.workingDir ?? process.cwd(),
    mode: mainSession?.mode ?? 'default',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    // Inherit path configuration from main session
    pathConfigured: mainSession?.pathConfigured ?? false,
    configuredPath: mainSession?.configuredPath ?? null,
    configuredBy: mainSession?.configuredBy ?? null,
    configuredAt: mainSession?.configuredAt ?? null,
    // Point-in-time forking: store the SDK message ID to fork from
    resumeSessionAtMessageId: resumeSessionAtMessageId ?? undefined,
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
 * Find the SDK message ID to fork from, given a parent Slack timestamp.
 *
 * Logic:
 * - If parent is assistant message: Use it directly
 * - If parent is user message (or not found): Find the LAST assistant message BEFORE this timestamp
 *   (not the response TO this message - we want past context, not future)
 *
 * @returns SDK message ID to use for resumeSessionAt, or null if no assistant message found
 */
export function findForkPointMessageId(
  channelId: string,
  parentSlackTs: string
): string | null {
  const store = loadSessions();
  const channelSession = store.channels[channelId];

  if (!channelSession?.messageMap) {
    console.warn(`No message map found for channel ${channelId}`);
    return null;
  }

  const mapping = channelSession.messageMap[parentSlackTs];

  // If parent is assistant message, use it directly
  if (mapping?.type === 'assistant') {
    return mapping.sdkMessageId;
  }

  // Parent is user message (or not found) - find last assistant message BEFORE this timestamp
  // Sort all timestamps and find the most recent assistant message before parentSlackTs
  const sortedTimestamps = Object.keys(channelSession.messageMap)
    .filter(ts => ts < parentSlackTs)  // Only messages BEFORE the parent
    .sort((a, b) => parseFloat(b) - parseFloat(a));  // Sort descending (most recent first)

  for (const ts of sortedTimestamps) {
    const msg = channelSession.messageMap[ts];
    if (msg.type === 'assistant') {
      console.log(`Found last assistant message at ${ts} (before ${parentSlackTs})`);
      return msg.sdkMessageId;
    }
  }

  console.warn(`No assistant message found before ${parentSlackTs}`);
  return null;
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
  const totalSessions = 1 + threadCount; // main + threads

  console.log(`  Found ${totalSessions} session(s) to delete:`);
  console.log(`    - 1 main session`);
  if (threadCount > 0) {
    console.log(`    - ${threadCount} thread session(s)`);
  }

  // Delete main session SDK file
  if (channelSession.sessionId) {
    console.log(`  Deleting main session: ${channelSession.sessionId}`);
    deleteSdkSessionFile(channelSession.sessionId, channelSession.workingDir);
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
