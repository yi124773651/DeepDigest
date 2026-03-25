import puppeteer, { type Browser } from 'puppeteer';
import { existsSync } from 'node:fs';
import type { Article, SendEvent } from './types';
import { SCRAPER_CONCURRENCY, SCRAPER_TIMEOUT_MS } from './types';

// Auto-detect Chrome executable path
function findChromePath(): string | undefined {
  const candidates = [
    // Windows
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

let _chromePath: string | undefined | null = null; // null = not checked yet

function getChromePath(): string | undefined {
  if (_chromePath === null) {
    _chromePath = findChromePath();
    if (_chromePath) {
      console.log(`Chrome found: ${_chromePath}`);
    } else {
      console.warn('Chrome not found in common paths. Puppeteer will try its bundled browser. If scraping fails, install Chrome or run: npx puppeteer browsers install chrome');
    }
  }
  return _chromePath || undefined;
}

// Persistent browser instance
let _browser: Browser | null = null;
let _browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.connected) return _browser;
  if (_browserPromise) return _browserPromise;
  const chromePath = getChromePath();
  _browserPromise = puppeteer.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }).then(b => {
    _browser = b;
    _browserPromise = null;
    b.on('disconnected', () => { _browser = null; });
    return b;
  });
  return _browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

async function scrapeArticle(browser: Browser, url: string): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('DeepDigest/2.0 (Content Reader)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: SCRAPER_TIMEOUT_MS });

    const content = await page.evaluate(() => {
      const noise = document.querySelectorAll('nav, footer, header, aside, script, style, [role="navigation"], [role="banner"], .sidebar, .comments, #comments');
      noise.forEach(el => el.remove());

      const container = document.querySelector('article') || document.querySelector('main') || document.body;
      return container?.innerText || '';
    });

    return content;
  } finally {
    await page.close();
  }
}

export interface ScrapeResult {
  content: string;
  source: 'full' | 'rss';
}

// Scrape a single article (used by pipeline)
export async function scrapeSingle(article: Article): Promise<ScrapeResult> {
  try {
    const browser = await getBrowser();
    const content = await scrapeArticle(browser, article.link);
    if (content.length > 100) {
      return { content, source: 'full' };
    }
    return { content: article.description, source: 'rss' };
  } catch {
    return { content: article.description, source: 'rss' };
  }
}

// Batch scrape (kept for backward compat, uses persistent browser)
export async function scrapeArticles(
  articles: Article[],
  sendEvent?: SendEvent,
): Promise<Map<number, ScrapeResult>> {
  const results = new Map<number, ScrapeResult>();

  try {
    const browser = await getBrowser();

    for (let i = 0; i < articles.length; i += SCRAPER_CONCURRENCY) {
      const batch = articles.slice(i, i + SCRAPER_CONCURRENCY);
      const promises = batch.map(async (article, batchIdx) => {
        const globalIdx = i + batchIdx;
        try {
          const content = await scrapeArticle(browser, article.link);
          if (content.length > 100) {
            results.set(globalIdx, { content, source: 'full' });
          } else {
            results.set(globalIdx, { content: article.description, source: 'rss' });
          }
        } catch (error) {
          sendEvent?.('log', { message: `Scrape failed for ${article.link}: ${error instanceof Error ? error.message : String(error)}` });
          results.set(globalIdx, { content: article.description, source: 'rss' });
        }
      });
      await Promise.all(promises);
      sendEvent?.('progress', { step: 4, current: Math.min(i + SCRAPER_CONCURRENCY, articles.length), total: articles.length });
    }
  } catch (error) {
    sendEvent?.('log', { message: `Browser launch failed: ${error instanceof Error ? error.message : String(error)}` });
    for (let i = 0; i < articles.length; i++) {
      if (!results.has(i)) {
        results.set(i, { content: articles[i].description, source: 'rss' });
      }
    }
  }

  return results;
}
