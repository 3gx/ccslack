import puppeteer, { Browser } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Include PID to avoid collision with parallel CI jobs
const WS_ENDPOINT_FILE = path.join(os.tmpdir(), `vitest-puppeteer-ws-endpoint-${process.pid}`);

let browser: Browser | null = null;

export async function setup() {
  // Launch browser in main process
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  // Save wsEndpoint for test workers to connect
  fs.writeFileSync(WS_ENDPOINT_FILE, browser.wsEndpoint());

  // Pass exact filename to workers via env var (prevents cross-talk between parallel test runs)
  process.env.VITEST_PUPPETEER_WS_FILE = WS_ENDPOINT_FILE;

  // Cleanup function
  const cleanup = async () => {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    try {
      fs.unlinkSync(WS_ENDPOINT_FILE);
    } catch {}
  };

  // Cleanup with 5s timeout to prevent hanging on browser.close()
  const cleanupWithTimeout = async () => {
    await Promise.race([
      cleanup(),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  };

  // Use process.once() to avoid conflict with Vitest's handlers
  // Re-send signal after cleanup instead of process.exit()
  process.once('SIGINT', async () => {
    await cleanupWithTimeout();
    process.kill(process.pid, 'SIGINT');
  });

  process.once('SIGTERM', async () => {
    await cleanupWithTimeout();
    process.kill(process.pid, 'SIGTERM');
  });
}

export async function teardown() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  try {
    fs.unlinkSync(WS_ENDPOINT_FILE);
  } catch {}
}
