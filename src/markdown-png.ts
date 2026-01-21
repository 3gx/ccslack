import puppeteer, { Browser } from 'puppeteer';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import ins from 'markdown-it-ins';
import mark from 'markdown-it-mark';

// Syntax highlighting function for code blocks
function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      // Ignore highlight errors, fall through to escape
    }
  }
  // Escape HTML entities for safety
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Configure markdown-it with syntax highlighting and plugins
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight: highlightCode,
})
  .use(ins)
  .use(mark);

// HTML template with embedded CSS
const HTML_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 32px 40px;
      max-width: 760px;
      line-height: 1.6;
      color: #1a1a1a;
      background: white;
      margin: 0;
    }
    h1 { font-size: 28px; font-weight: 600; margin: 0 0 16px 0; color: #111; }
    h2 { font-size: 22px; font-weight: 600; margin: 24px 0 12px 0; color: #111; }
    h3 { font-size: 18px; font-weight: 600; margin: 20px 0 8px 0; color: #222; }
    h4 { font-size: 16px; font-weight: 600; margin: 16px 0 8px 0; color: #333; }
    p { margin: 0 0 16px 0; }
    code {
      background: #f6f8fa;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 13px;
    }
    pre {
      background: #f6f8fa;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      padding: 16px;
      overflow-x: auto;
      margin: 0 0 16px 0;
    }
    pre code {
      background: none;
      padding: 0;
      font-size: 13px;
      line-height: 1.5;
    }
    table {
      border-collapse: collapse;
      margin: 0 0 16px 0;
      width: auto;
    }
    th, td {
      border: 1px solid #d0d7de;
      padding: 10px 16px;
      text-align: left;
    }
    th { background: #f6f8fa; font-weight: 600; }
    blockquote {
      border-left: 4px solid #d0d7de;
      padding-left: 16px;
      margin: 0 0 16px 0;
      color: #656d76;
    }
    ul, ol { margin: 0 0 16px 0; padding-left: 24px; }
    li { margin: 4px 0; }
    hr { border: none; height: 1px; background: #d0d7de; margin: 24px 0; }
    a { color: #0969da; text-decoration: none; }
    /* Text decorations */
    strong { font-weight: 700; }
    em { font-style: italic; }
    s, del { text-decoration: line-through; color: #6a737d; }
    ins { text-decoration: underline; }
    mark { background: #fff3b0; padding: 1px 4px; border-radius: 2px; }
    /* Syntax highlighting - CLI-like colors */
    .hljs-comment { color: #6a737d; font-style: italic; }
    .hljs-string { color: #22863a; }
    .hljs-number { color: #005cc5; }
    .hljs-literal { color: #005cc5; }
    .hljs-keyword { color: #d73a49; font-weight: 600; }
    .hljs-function { color: #6f42c1; }
    .hljs-title { color: #6f42c1; }
    .hljs-attr { color: #005cc5; }
    .hljs-built_in { color: #e36209; }
    .hljs-params { color: #24292e; }
    .hljs-variable { color: #e36209; }
    .hljs-operator { color: #d73a49; }
    .hljs-punctuation { color: #24292e; }
    .hljs-property { color: #005cc5; }
    .hljs-regexp { color: #22863a; }
    .hljs-selector-tag { color: #22863a; }
    .hljs-selector-class { color: #6f42c1; }
    .hljs-tag { color: #22863a; }
    .hljs-name { color: #22863a; }
    .hljs-attribute { color: #005cc5; }
  </style>
</head>
<body>
{{CONTENT}}
</body>
</html>`;

/**
 * Convert markdown to PNG image.
 * Launches a fresh browser for each render and closes it after.
 * Returns PNG buffer on success, null on failure.
 */
export async function markdownToPng(
  markdown: string,
  width: number = 800
): Promise<Buffer | null> {
  // Validate input
  if (!markdown || typeof markdown !== 'string' || markdown.trim() === '') {
    return null;
  }

  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });

    const page = await browser.newPage();

    // Convert markdown to HTML
    const htmlContent = md.render(markdown);
    const fullHtml = HTML_TEMPLATE.replace('{{CONTENT}}', htmlContent);

    // Set viewport and load content
    await page.setViewport({ width, height: 800 });
    await page.setContent(fullHtml, {
      waitUntil: 'domcontentloaded',
      timeout: 5000,
    });

    // Get actual content height
    const height = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewport({ width, height: Math.min(height + 64, 10000) });

    // Take screenshot
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false,
    });

    return Buffer.from(screenshot);
  } catch (err) {
    console.warn('PNG render failed:', (err as Error).message);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
