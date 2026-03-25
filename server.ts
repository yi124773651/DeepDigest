import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { DigestConfig, ScoredArticle, SendEvent } from './src/types';
import { loadConfig, saveConfig, HISTORY_DIR, DATA_DIR } from './src/config';
import { RSS_FEEDS, fetchAllFeeds } from './src/feeds';
import { scoreArticlesWithAI, selectArticles } from './src/scoring';
import { scrapeSingle } from './src/scraper';
import { summarizeSingle, generateHighlights } from './src/summarizer';
import type { SummaryResult } from './src/summarizer';
import { generateDigestReport } from './src/report';

const PORT = Number(process.env.PORT) || 3000;
const indexHtmlPath = join(import.meta.dir, 'public', 'index.html');

// ============================================================================
// Digest Pipeline
// ============================================================================

async function runDigest(config: DigestConfig, sendEvent: SendEvent): Promise<void> {
  // Step 1: Fetch RSS feeds
  sendEvent('step', { step: 1, stepName: 'Fetching RSS feeds' });
  const allArticles = await fetchAllFeeds(RSS_FEEDS, sendEvent);
  if (allArticles.length === 0) {
    sendEvent('error', { message: 'No articles fetched from any feed. Check network connection.' });
    return;
  }

  // Step 2: Filter by time range
  sendEvent('step', { step: 2, stepName: `Filtering articles (last ${config.hours}h)` });
  const cutoffTime = new Date(Date.now() - config.hours * 60 * 60 * 1000);
  const recentArticles = allArticles.filter(a => a.pubDate.getTime() > cutoffTime.getTime());
  sendEvent('log', { message: `Found ${recentArticles.length} articles within last ${config.hours} hours (from ${allArticles.length} total)` });

  if (recentArticles.length === 0) {
    sendEvent('error', { message: `No articles found within the last ${config.hours} hours. Try increasing the time range.` });
    return;
  }

  // Step 3: AI scoring
  sendEvent('step', { step: 3, stepName: `AI scoring ${recentArticles.length} articles` });
  const scores = await scoreArticlesWithAI(recentArticles, config, sendEvent);

  // Selection (threshold + weighted + soft quota + wildcard)
  const { selected } = selectArticles(recentArticles, scores, config.topN);
  sendEvent('log', { message: `Selected ${selected.length} articles after filtering` });

  if (selected.length === 0) {
    sendEvent('error', { message: 'No articles passed the quality threshold. Try adjusting settings.' });
    return;
  }

  // Step 4+5: Pipeline — scrape and summarize concurrently
  sendEvent('step', { step: 4, stepName: `Scraping & summarizing ${selected.length} articles` });
  const PIPELINE_CONCURRENCY = 5;
  const summaries = new Map<number, SummaryResult>();
  let completedCount = 0;
  const totalCount = selected.length;

  // Process articles through pipeline: scrape -> summarize, with concurrency limit
  const indexedSelected = selected.map((a, i) => ({ ...a, index: i }));

  for (let i = 0; i < indexedSelected.length; i += PIPELINE_CONCURRENCY) {
    const batch = indexedSelected.slice(i, i + PIPELINE_CONCURRENCY);
    const promises = batch.map(async (article) => {
      // Scrape
      const scrapeResult = await scrapeSingle(article);
      // Immediately summarize with scraped content
      const summary = await summarizeSingle(
        article, scrapeResult.content, scrapeResult.source, config,
      );
      summaries.set(article.index, summary);
      completedCount++;
      sendEvent('progress', { step: 4, current: completedCount, total: totalCount });
    });
    await Promise.all(promises);
  }

  const fullCount = Array.from(summaries.values()).filter(s => s.contentSource === 'full').length;
  sendEvent('log', { message: `Scraped & summarized: ${fullCount} full-text, ${totalCount - fullCount} RSS fallback` });

  // Assemble final articles
  const finalArticles: ScoredArticle[] = selected.map((a, i) => {
    const sm = summaries.get(i) || { titleZh: a.title, oneLiner: a.title, summary: a.description.slice(0, 200), reason: '', contentSource: 'rss' as const };
    return {
      title: a.title, link: a.link, pubDate: a.pubDate, description: a.description,
      sourceName: a.sourceName, sourceUrl: a.sourceUrl,
      score: a.score,
      scoreBreakdown: { relevance: a.breakdown.relevance, quality: a.breakdown.quality, timeliness: a.breakdown.timeliness },
      category: a.breakdown.category, keywords: a.breakdown.keywords || [],
      titleZh: sm.titleZh, oneLiner: sm.oneLiner, summary: sm.summary, reason: sm.reason,
      isWildcard: a.isWildcard,
      contentSource: sm.contentSource,
    };
  });

  // Step 5: Highlights
  sendEvent('step', { step: 5, stepName: "Generating today's highlights" });
  const highlights = await generateHighlights(finalArticles, config, sendEvent);

  // Step 6: Report
  sendEvent('step', { step: 6, stepName: 'Generating report' });
  const successfulSources = new Set(allArticles.map(a => a.sourceName));
  const report = generateDigestReport(finalArticles, highlights, {
    totalFeeds: RSS_FEEDS.length, successFeeds: successfulSources.size,
    totalArticles: allArticles.length, filteredArticles: recentArticles.length,
    hours: config.hours, lang: config.lang,
  });

  // Save history
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(join(HISTORY_DIR, `${id}.md`), report);
  await writeFile(join(HISTORY_DIR, `${id}.json`), JSON.stringify({
    id, createdAt: new Date().toISOString(), config,
    articles: finalArticles,
    highlights,
    stats: {
      totalFeeds: RSS_FEEDS.length, successFeeds: successfulSources.size,
      totalArticles: allArticles.length, filteredArticles: recentArticles.length,
      selectedArticles: finalArticles.length,
    },
  }, null, 2));

  sendEvent('done', { result: { markdown: report, id, articles: finalArticles, highlights } });
}

// ============================================================================
// History Persistence
// ============================================================================

async function listHistory(): Promise<Array<{ id: string; createdAt: string; stats: Record<string, number> }>> {
  try {
    const files = await readdir(HISTORY_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse();
    const results = [];
    for (const f of jsonFiles) {
      try {
        const text = await readFile(join(HISTORY_DIR, f), 'utf-8');
        results.push(JSON.parse(text));
      } catch { /* skip */ }
    }
    return results;
  } catch {
    return [];
  }
}

async function getHistory(id: string): Promise<{ meta: Record<string, unknown>; markdown: string } | null> {
  try {
    const safeId = id.replace(/[^a-zA-Z0-9\-T]/g, '');
    const meta = JSON.parse(await readFile(join(HISTORY_DIR, `${safeId}.json`), 'utf-8'));
    const markdown = await readFile(join(HISTORY_DIR, `${safeId}.md`), 'utf-8');
    return { meta, markdown };
  } catch {
    return null;
  }
}

async function deleteHistory(id: string): Promise<boolean> {
  try {
    const safeId = id.replace(/[^a-zA-Z0-9\-T]/g, '');
    await unlink(join(HISTORY_DIR, `${safeId}.json`)).catch(() => {});
    await unlink(join(HISTORY_DIR, `${safeId}.md`)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Favorites Persistence
// ============================================================================

const FAVORITES_PATH = join(DATA_DIR, 'favorites.json');

interface FavoriteItem {
  id: string;
  article: Record<string, unknown>;
  addedAt: string;
  read: boolean;
}

async function loadFavorites(): Promise<FavoriteItem[]> {
  try {
    const text = await readFile(FAVORITES_PATH, 'utf-8');
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function saveFavorites(favorites: FavoriteItem[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FAVORITES_PATH, JSON.stringify(favorites, null, 2));
}

// ============================================================================
// HTTP Server
// ============================================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      return new Response(Bun.file(indexHtmlPath), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (path === '/api/config' && req.method === 'GET') {
      const config = await loadConfig();
      return jsonResponse(config);
    }

    if (path === '/api/config' && req.method === 'POST') {
      const body = await req.json() as Partial<DigestConfig>;
      await saveConfig(body);
      return jsonResponse({ ok: true });
    }

    if (path === '/api/run' && req.method === 'POST') {
      const body = await req.json() as Partial<DigestConfig>;
      const saved = await loadConfig();
      const config: DigestConfig = {
        apiKey: body.apiKey || saved.apiKey || process.env.OPENAI_API_KEY || '',
        baseUrl: body.baseUrl || saved.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com',
        modelName: body.modelName || saved.modelName || process.env.MODEL_NAME || 'gpt-4o-mini',
        hours: body.hours ?? saved.hours ?? 48,
        topN: body.topN ?? saved.topN ?? 15,
        lang: (body.lang || saved.lang || 'zh') as 'zh' | 'en',
      };

      if (!config.apiKey) {
        return jsonResponse({ error: 'API key is required' }, 400);
      }

      const stream = new ReadableStream({
        type: "direct",
        async pull(controller) {
          const encoder = new TextEncoder();
          const sendEvent: SendEvent = (type, data) => {
            try {
              controller.write(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
              controller.flush();
            } catch { /* stream closed */ }
          };

          try {
            await runDigest(config, sendEvent);
          } catch (err) {
            sendEvent('error', { message: err instanceof Error ? err.message : String(err) });
          }

          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    if (path === '/api/history' && req.method === 'GET') {
      const list = await listHistory();
      return jsonResponse(list);
    }

    const historyMatch = path.match(/^\/api\/history\/(.+)$/);
    if (historyMatch && req.method === 'GET') {
      const result = await getHistory(historyMatch[1]);
      if (!result) return jsonResponse({ error: 'Not found' }, 404);
      return jsonResponse(result);
    }

    if (historyMatch && req.method === 'DELETE') {
      await deleteHistory(historyMatch[1]);
      return jsonResponse({ ok: true });
    }

    // GET /api/favorites
    if (path === '/api/favorites' && req.method === 'GET') {
      const favorites = await loadFavorites();
      return jsonResponse(favorites);
    }

    // POST /api/favorites — add a favorite
    if (path === '/api/favorites' && req.method === 'POST') {
      const body = await req.json() as { article: Record<string, unknown> };
      const favorites = await loadFavorites();
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const link = String(body.article?.link || '');
      // Deduplicate by link
      if (favorites.some(f => String(f.article?.link || '') === link)) {
        return jsonResponse({ ok: true, msg: 'already exists' });
      }
      favorites.unshift({ id, article: body.article, addedAt: new Date().toISOString(), read: false });
      await saveFavorites(favorites);
      return jsonResponse({ ok: true, id });
    }

    // PATCH /api/favorites/:id — mark read/unread
    const favMatch = path.match(/^\/api\/favorites\/(.+)$/);
    if (favMatch && req.method === 'PATCH') {
      const favorites = await loadFavorites();
      const item = favorites.find(f => f.id === favMatch[1]);
      if (item) {
        const body = await req.json() as { read?: boolean };
        if (body.read !== undefined) item.read = body.read;
        await saveFavorites(favorites);
      }
      return jsonResponse({ ok: true });
    }

    // DELETE /api/favorites/:id
    if (favMatch && req.method === 'DELETE') {
      let favorites = await loadFavorites();
      favorites = favorites.filter(f => f.id !== favMatch[1]);
      await saveFavorites(favorites);
      return jsonResponse({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`DeepDigest server running at http://localhost:${PORT}`);
