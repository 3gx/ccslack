import 'dotenv/config';
import { startBot } from './slack-bot.js';
import fs from 'fs';

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
