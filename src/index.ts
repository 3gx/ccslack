import 'dotenv/config';
import { startBot } from './slack-bot.js';
import { stopAllWatchers } from './terminal-watcher.js';

startBot();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  stopAllWatchers();  // Stop all terminal watchers
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Interrupted, shutting down...');
  stopAllWatchers();  // Stop all terminal watchers
  process.exit(0);
});
