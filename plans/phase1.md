# Phase 1: Core Infrastructure + MCP Server

**Duration:** 10-14 days (Weeks 1-2)
**Goal:** Basic Slack bot that responds to messages using Claude Agent SDK with MCP tools

---

## Overview

**Slack App:** Connecting to existing **@Claude Code** app (tokens already in `.env`)

By the end of Phase 1, you will have:
- A working Slack bot connected to @Claude Code via Socket Mode
- Claude Agent SDK integrated with Claude Code preset
- Basic MCP server with `ask_user` tool (simplified version)
- Session persistence across messages
- Streaming responses to Slack

---

## Step-by-Step Implementation

### Step 1: Project Setup (Day 1)

**Goal:** Initialize TypeScript project with dependencies

**Status:** `.env` already exists with Slack tokens. `.gitignore` and `.env.example` created.

**Tasks:**
1. Create project directory structure
2. Initialize `package.json`
3. Configure TypeScript

**Existing files:**
```
/Users/egx/ai/ccslack/
├── .env              # ✅ EXISTS - contains SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET
├── .env.example      # ✅ CREATED - template without secrets
├── .gitignore        # ✅ CREATED - excludes .env, node_modules, sessions.json
```

**Files to create:**
```
/Users/egx/ai/ccslack/
├── src/
│   └── (empty for now)
├── package.json
└── tsconfig.json
```

**Dependencies:**
```json
{
  "dependencies": {
    "@slack/bolt": "^3.x",
    "@slack/web-api": "^7.x",
    "@anthropic-ai/claude-agent-sdk": "^0.2.x",
    "zod": "^3.x",
    "dotenv": "^16.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/node": "^20.x",
    "tsx": "^4.x"
  }
}
```

**Test:** `npm install` succeeds

---

### Step 2: Slack App Configuration

**Status:** ✅ ALREADY DONE - using existing **@Claude Code** Slack app

**Tokens configured (in `.env`):**
- `SLACK_BOT_TOKEN` - Bot User OAuth Token (xoxb-...)
- `SLACK_APP_TOKEN` - App-Level Token for Socket Mode (xapp-...)
- `SLACK_SIGNING_SECRET` - Signing Secret

**Note:** These are the same tokens used by the @Claude Code app. Our bot will respond as @Claude Code in Slack.

**Test:** Tokens are in `.env` file ✅

---

### Step 3: Basic Slack Bot (Day 2)

**Goal:** Bot connects and responds to DMs

**Files to create:**
- `src/index.ts` - Entry point
- `src/slack-bot.ts` - Slack event handlers

**Implementation:**
```typescript
// src/index.ts
import 'dotenv/config';
import { startBot } from './slack-bot';

startBot();
```

```typescript
// src/slack-bot.ts
import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Handle DM messages
app.message(async ({ message, say }) => {
  if (message.channel_type === 'im') {
    await say(`Echo: ${message.text}`);
  }
});

export async function startBot() {
  await app.start();
  console.log('Bot is running!');
}
```

**Test:**
1. Run `npx tsx src/index.ts`
2. DM the bot "hello"
3. Bot replies "Echo: hello"

---

### Step 4: Session Manager (Day 3)

**Goal:** Persist session IDs per DM channel

**Files to create:**
- `src/session-manager.ts`

**Implementation:**
```typescript
// src/session-manager.ts
import fs from 'fs';
import path from 'path';

interface Session {
  sessionId: string | null;
  workingDir: string;
  mode: 'plan' | 'auto' | 'ask';
  createdAt: number;
  lastActiveAt: number;
}

interface SessionStore {
  channels: {
    [channelId: string]: Session;
  };
}

const SESSIONS_FILE = './sessions.json';

export function loadSessions(): SessionStore {
  if (fs.existsSync(SESSIONS_FILE)) {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
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
  store.channels[channelId] = {
    sessionId: null,
    workingDir: process.cwd(),
    mode: 'plan',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    ...store.channels[channelId],
    ...session,
    lastActiveAt: Date.now(),
  };
  saveSessions(store);
}
```

**Test:**
1. Call `saveSession('C123', { workingDir: '/tmp' })`
2. Check `sessions.json` exists with correct data
3. Call `getSession('C123')` returns the session

---

### Step 5: Claude SDK Integration (Day 4-5)

**Goal:** Connect to Claude Agent SDK with Claude Code preset

**Files to create:**
- `src/claude-client.ts`

**Implementation:**
```typescript
// src/claude-client.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeResponse {
  content: string;
  sessionId: string;
}

export async function* streamClaude(
  prompt: string,
  options: {
    sessionId?: string;
    workingDir?: string;
  }
): AsyncGenerator<{ type: string; content?: string; sessionId?: string }> {

  for await (const message of query({
    prompt,
    options: {
      resume: options.sessionId,
      cwd: options.workingDir || process.cwd(),

      // Claude Code preset
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code'
      },
      tools: {
        type: 'preset',
        preset: 'claude_code'
      },
      settingSources: ['project'],

      // Permission mode
      permissionMode: 'plan',
    }
  })) {
    yield message;
  }
}
```

**Test:**
1. Create test script that calls `streamClaude('What is 2+2?', {})`
2. Verify response streams back
3. Verify session ID is returned

---

### Step 6: Wire Slack to Claude (Day 5-6)

**Goal:** DM messages go to Claude, responses stream back

**Update:** `src/slack-bot.ts`

```typescript
// src/slack-bot.ts (updated)
import { App } from '@slack/bolt';
import { streamClaude } from './claude-client';
import { getSession, saveSession } from './session-manager';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.message(async ({ message, client }) => {
  if (message.channel_type !== 'im' || !('text' in message)) return;

  const channelId = message.channel;
  const userText = message.text;

  // Get or create session
  let session = getSession(channelId);
  if (!session) {
    session = { sessionId: null, workingDir: process.cwd(), mode: 'plan', createdAt: Date.now(), lastActiveAt: Date.now() };
    saveSession(channelId, session);
  }

  // Post initial "thinking" message
  const result = await client.chat.postMessage({
    channel: channelId,
    text: '...',
  });
  const messageTs = result.ts!;

  // Stream Claude response
  let fullResponse = '';
  let newSessionId: string | null = null;
  let lastUpdate = 0;

  try {
    for await (const msg of streamClaude(userText, {
      sessionId: session.sessionId || undefined,
      workingDir: session.workingDir,
    })) {
      // Capture session ID
      if (msg.type === 'system' && msg.subtype === 'init' && msg.sessionId) {
        newSessionId = msg.sessionId;
      }

      // Accumulate content
      if (msg.type === 'assistant' && msg.content) {
        fullResponse += msg.content;

        // Update message every 2 seconds (rate limit safe)
        if (Date.now() - lastUpdate >= 2000) {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: fullResponse || '...',
          });
          lastUpdate = Date.now();
        }
      }
    }

    // Final update
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: fullResponse || 'Done.',
    });

    // Save session
    if (newSessionId) {
      saveSession(channelId, { sessionId: newSessionId });
    }

  } catch (error) {
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Error: ${error.message}`,
    });
  }
});

export async function startBot() {
  await app.start();
  console.log('Bot is running!');
}
```

**Test:**
1. DM bot "What files are in the current directory?"
2. Bot responds with streaming updates
3. Session persists (second message continues context)

---

### Step 7: Basic MCP Server (Day 7-8)

**Goal:** Create in-process MCP server with `ask_user` tool (simplified)

**Files to create:**
- `src/mcp-server.ts`

**Implementation:**
```typescript
// src/mcp-server.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// Store for pending questions (will be enhanced in Phase 2)
const pendingQuestions = new Map<string, {
  resolve: (answer: string) => void;
  channelId: string;
  messageTs: string;
}>();

// Slack client reference (set by slack-bot.ts)
let slackClient: any = null;
let currentChannelId: string = '';

export function setSlackContext(client: any, channelId: string) {
  slackClient = client;
  currentChannelId = channelId;
}

export const mcpServer = createSdkMcpServer({
  name: 'slack-interaction',
  version: '1.0.0',
  tools: [
    tool(
      'ask_user',
      'Ask the user a question and wait for their response via Slack',
      z.object({
        question: z.string().describe('The question to ask the user'),
        options: z.array(z.string()).optional().describe('Optional list of choices'),
      }),
      async ({ question, options }) => {
        if (!slackClient || !currentChannelId) {
          return 'Error: Slack context not set';
        }

        const questionId = crypto.randomUUID();

        // Build blocks
        const blocks: any[] = [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Claude needs your input:*\n${question}` }
          }
        ];

        // Add buttons if options provided
        if (options && options.length > 0) {
          blocks.push({
            type: 'actions',
            block_id: `question_${questionId}`,
            elements: options.map((opt, i) => ({
              type: 'button',
              text: { type: 'plain_text', text: opt },
              action_id: `answer_${questionId}_${i}`,
              value: opt,
            })),
          });
        }

        // Post question
        const msg = await slackClient.chat.postMessage({
          channel: currentChannelId,
          blocks,
          text: question,
        });

        // Wait for answer (simplified - no timeout for Phase 1)
        const answer = await new Promise<string>((resolve) => {
          pendingQuestions.set(questionId, {
            resolve,
            channelId: currentChannelId,
            messageTs: msg.ts,
          });
        });

        return answer;
      }
    ),
  ],
});

// Called by Slack action handler
export function resolveQuestion(questionId: string, answer: string): boolean {
  const pending = pendingQuestions.get(questionId);
  if (pending) {
    pending.resolve(answer);
    pendingQuestions.delete(questionId);
    return true;
  }
  return false;
}

// Check if we have pending questions
export function hasPendingQuestion(): boolean {
  return pendingQuestions.size > 0;
}
```

**Test:** Unit test that MCP server creates without error

---

### Step 8: Wire MCP to SDK (Day 8-9)

**Goal:** Connect MCP server to Claude SDK

**Update:** `src/claude-client.ts`

```typescript
// src/claude-client.ts (updated)
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mcpServer } from './mcp-server';

export async function* streamClaude(
  prompt: string,
  options: {
    sessionId?: string;
    workingDir?: string;
  }
): AsyncGenerator<{ type: string; content?: string; sessionId?: string; [key: string]: any }> {

  for await (const message of query({
    prompt,
    options: {
      resume: options.sessionId,
      cwd: options.workingDir || process.cwd(),

      // Claude Code preset
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code'
      },
      tools: {
        type: 'preset',
        preset: 'claude_code'
      },
      settingSources: ['project'],
      permissionMode: 'plan',

      // MCP server for user interaction
      mcpServers: {
        'slack-interaction': {
          type: 'sdk',
          instance: mcpServer,
        }
      },
    }
  })) {
    yield message;
  }
}
```

**Test:** SDK loads with MCP server configured

---

### Step 9: Handle Button Clicks (Day 9-10)

**Goal:** Slack button clicks resolve MCP questions

**Update:** `src/slack-bot.ts`

```typescript
// Add to slack-bot.ts

import { resolveQuestion } from './mcp-server';

// Handle button clicks
app.action(/^answer_(.+)_(\d+)$/, async ({ action, ack, body, client }) => {
  await ack();

  // Extract question ID from action_id: "answer_{questionId}_{index}"
  const parts = action.action_id.split('_');
  const questionId = parts[1];
  const answer = action.value;

  // Resolve the pending question
  const resolved = resolveQuestion(questionId, answer);

  if (resolved) {
    // Update message to show selection
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `You selected: *${answer}*`,
      blocks: [],
    });
  }
});
```

**Test:**
1. Ask Claude to do something that triggers `ask_user`
2. Buttons appear in Slack
3. Click button
4. Claude continues with selected answer

---

### Step 10: End-to-End Testing (Day 10-12)

**Goal:** Verify full flow works

**Test Cases:**

| # | Test | Expected |
|---|------|----------|
| 1 | DM "hello" | Bot responds |
| 2 | DM "What is 2+2?" | Bot answers "4" with streaming |
| 3 | DM "List files in current dir" | Bot uses Bash tool, shows files |
| 4 | Send follow-up message | Context preserved (session works) |
| 5 | Restart bot, send message | Session restored from file |
| 6 | Trigger question (if possible) | Block Kit buttons appear |
| 7 | Click button | Claude continues |

**Manual Test Script:**
```bash
# Terminal 1: Run bot
cd /Users/egx/ai/ccslack
npm run dev

# Terminal 2: Watch logs
tail -f sessions.json

# Slack: Run tests manually
```

---

## Files Summary

| File | Purpose | Status |
|------|---------|--------|
| `.env` | Secrets (Slack tokens) | ✅ EXISTS |
| `.env.example` | Template for .env | ✅ CREATED |
| `.gitignore` | Git ignore rules | ✅ CREATED |
| `src/index.ts` | Entry point | To create |
| `src/slack-bot.ts` | Slack event handlers | To create |
| `src/claude-client.ts` | Claude SDK wrapper | To create |
| `src/session-manager.ts` | Session persistence | To create |
| `src/mcp-server.ts` | MCP tools for user interaction | To create |
| `sessions.json` | Session storage | Auto-generated |
| `package.json` | Dependencies | To create |
| `tsconfig.json` | TypeScript config | To create |

---

## Success Criteria

Phase 1 is complete when:

- [ ] Bot connects to Slack via Socket Mode
- [ ] DM messages are processed by Claude Agent SDK
- [ ] Responses stream back to Slack (2s update interval)
- [ ] Session persists across messages (same context)
- [ ] Session survives bot restart
- [ ] MCP server is connected (ask_user tool available)
- [ ] Button clicks resolve questions (basic flow)

---

## Not In Phase 1 (Deferred to Later Phases)

- Daily reminders (Phase 2)
- Abort commands (Phase 2)
- Persistence for pending questions (Phase 2)
- Terminal handoff (Phase 3)
- Thread forking (Phase 4)
- Concurrent session detection (Phase 3)
