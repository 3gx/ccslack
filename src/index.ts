import 'dotenv/config';
import { startBot } from './slack-bot.js';
import fs from 'fs';
import { shutdownBrowser } from './markdown-png.js';

// Answer directory for MCP <-> Slack communication
export const ANSWER_DIR = '/tmp/ccslack-answers';

// Create answer directory and clear stale files on startup
function initAnswerDirectory() {
  if (!fs.existsSync(ANSWER_DIR)) {
    fs.mkdirSync(ANSWER_DIR, { recursive: true });
    console.log(`Created answer directory: ${ANSWER_DIR}`);
  } else {
    // Clear stale answer files
    const files = fs.readdirSync(ANSWER_DIR);
    for (const file of files) {
      fs.unlinkSync(`${ANSWER_DIR}/${file}`);
    }
    if (files.length > 0) {
      console.log(`Cleared ${files.length} stale answer files`);
    }
  }
}

initAnswerDirectory();
startBot();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await shutdownBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Interrupted, shutting down...');
  await shutdownBrowser();
  process.exit(0);
});
