import type { Article, AISummaryResult, DigestConfig, ScoredArticle, SendEvent, PyramidStructure } from './types';
import { AI_BATCH_SIZE, MAX_CONCURRENT_AI } from './types';
import { callAI, parseJsonResponse } from './ai-client';
import type { ScrapeResult } from './scraper';

function buildSummaryPrompt(
  articles: Array<{ index: number; title: string; content: string; sourceName: string; link: string }>,
  lang: 'zh' | 'en',
): string {
  const articlesList = articles.map(a =>
    `Index ${a.index}: [${a.sourceName}] ${a.title}\nURL: ${a.link}\n${a.content}`
  ).join('\n\n---\n\n');

  const langInstruction = lang === 'zh'
    ? '请用中文撰写所有输出。如果原文是英文，请翻译为中文。'
    : 'Write all output in English.';

  return `你是一个技术内容深度分析专家。请为以下文章完成四件事：

1. **中文标题** (titleZh): 将英文标题翻译成自然的中文。如果原标题已经是中文则保持不变。

2. **一句话结论** (oneLiner): 1句话概括文章最核心的结论，金字塔顶端，让读者一眼抓住重点。

3. **深度分析** (summary): 使用 Markdown 格式输出结构化深度分析，目标是读完分析等于读完原文 80%。严格按以下结构：

**核心结论**：1句话，作者最终要表达的核心观点或发现（金字塔顶端，结论先行）

**背景与动机**：
- 这个领域/问题的现状是什么（回到基本事实）
- 作者为什么写这篇文章，要解决什么痛点或回答什么问题

**关键洞察**：
- 洞察1：具体论点 + 数据/案例支撑（保留具体技术名词、数字、方案名称）
- 洞察2：具体论点 + 数据/案例支撑
- （根据文章内容列出 2-4 个关键洞察）

**创新与独特性**：
- 和已有方案/主流观点相比，这篇文章新在哪里
- 作者的独到视角、方法论或反直觉结论是什么

**局限与反思**（如果有的话）：
- 哪些前提假设可能不成立
- 社区有什么不同声音

4. **推荐理由** (reason): 1句话说明"为什么值得读"，聚焦于这篇文章能给读者带来什么独特价值。

5. **金字塔结构** (pyramid): 【必填，不可省略】提取文章的论证金字塔，用于生成思维导图。JSON 格式：
   - core: 核心结论（10字以内，精炼概括）
   - arguments: 2-3 个关键论点，每个包含：
     - point: 论点概述（15字以内）
     - evidence: 1-2 条支撑证据/数据（每条20字以内）
   注意：每个字段必须极度精简，因为会用于生成 Mermaid 思维导图，文字过长会导致排版溢出。
   ⚠️ pyramid 字段是必须的，每篇文章都必须包含，绝对不能省略！

${langInstruction}

分析要求：
- 结论先行，不要用"本文讨论了..."这种开头
- 每个板块用 Markdown 加粗标题分隔，用 - 列表展开要点
- 保留具体的技术名词、数字、对比结论
- 突出"这篇文章和别的文章有什么不同"，而非简单复述内容
- 如果文章本身缺乏创新性（纯资讯/转述），在"创新与独特性"中如实说明

## 待分析文章

${articlesList}

请严格按 JSON 格式返回，每个 result 必须包含所有 6 个字段（index, titleZh, oneLiner, summary, reason, pyramid），缺一不可：
{
  "results": [
    {
      "index": 0,
      "titleZh": "中文翻译的标题",
      "oneLiner": "一句话核心结论",
      "summary": "**核心结论**：...\\n\\n**背景与动机**：\\n- ...\\n\\n**关键洞察**：\\n- ...\\n\\n**创新与独特性**：\\n- ...\\n\\n**局限与反思**：\\n- ...",
      "reason": "推荐理由...",
      "pyramid": {
        "core": "核心结论",
        "arguments": [
          { "point": "论点1", "evidence": ["证据1a", "证据1b"] },
          { "point": "论点2", "evidence": ["证据2a"] }
        ]
      }
    }
  ]
}`;
}

const SYSTEM_PROMPT_ZH = '你是一个技术内容摘要专家。你必须用中文回答所有内容，包括摘要、标题翻译和推荐理由。即使原文是英文，你的输出也必须全部是中文。';
const SYSTEM_PROMPT_EN = 'You are a tech content summarization expert. Write all output in English.';

function getSystemPrompt(lang: 'zh' | 'en'): string {
  return lang === 'zh' ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN;
}

export type SummaryResult = { titleZh: string; oneLiner: string; summary: string; reason: string; pyramid?: PyramidStructure; contentSource: 'full' | 'rss' };

/**
 * Build a fallback pyramid from summary text when LLM doesn't return one.
 * Extracts key insights from the markdown-formatted summary.
 */
function buildFallbackPyramid(oneLiner: string, summary: string): PyramidStructure | undefined {
  if (!oneLiner && !summary) return undefined;
  const core = (oneLiner || summary.slice(0, 30)).slice(0, 30);

  // Try to extract "关键洞察" or "**关键洞察**" section bullet points
  const insightMatch = summary.match(/\*\*关键洞察\*\*[：:]\s*\n([\s\S]*?)(?=\n\*\*|$)/);
  const bullets: string[] = [];
  if (insightMatch) {
    const lines = insightMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines.slice(0, 3)) {
      bullets.push(line.replace(/^-\s*/, '').slice(0, 40));
    }
  }

  // If no insights found, try generic bullet extraction
  if (bullets.length === 0) {
    const allBullets = summary.split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of allBullets.slice(0, 3)) {
      bullets.push(line.replace(/^-\s*/, '').slice(0, 40));
    }
  }

  if (bullets.length === 0) return undefined;

  return {
    core,
    arguments: bullets.map(b => ({ point: b.slice(0, 15), evidence: [b] })),
  };
}

// Summarize a single article (used by pipeline)
export async function summarizeSingle(
  article: { index: number; title: string; sourceName: string; link: string },
  content: string,
  contentSource: 'full' | 'rss',
  config: DigestConfig,
): Promise<SummaryResult> {
  try {
    const prompt = buildSummaryPrompt([{
      index: article.index, title: article.title,
      content, sourceName: article.sourceName, link: article.link,
    }], config.lang);
    const responseText = await callAI(prompt, config, getSystemPrompt(config.lang));
    const parsed = parseJsonResponse<AISummaryResult>(responseText);
    if (parsed.results?.[0]) {
      const r = parsed.results[0];
      const pyramid = r.pyramid || buildFallbackPyramid(r.oneLiner || '', r.summary || '');
      if (!r.pyramid) console.warn(`[pyramid] MISSING from LLM for "${article.title}", using fallback: ${!!pyramid}`);
      return { titleZh: r.titleZh || '', oneLiner: r.oneLiner || '', summary: r.summary || '', reason: r.reason || '', pyramid, contentSource };
    }
  } catch { /* fallback below */ }
  return { titleZh: article.title, oneLiner: article.title, summary: content.slice(0, 200), reason: '', contentSource };
}

export async function summarizeArticles(
  articles: Array<Article & { index: number }>,
  scrapeResults: Map<number, ScrapeResult>,
  config: DigestConfig,
  sendEvent?: SendEvent,
): Promise<Map<number, SummaryResult>> {
  const summaries = new Map<number, SummaryResult>();

  const indexed = articles.map(a => {
    const scrape = scrapeResults.get(a.index);
    return {
      index: a.index,
      title: a.title,
      content: scrape?.content || a.description,
      sourceName: a.sourceName,
      link: a.link,
      contentSource: (scrape?.source || 'rss') as 'full' | 'rss',
    };
  });

  const batches: typeof indexed[] = [];
  for (let i = 0; i < indexed.length; i += AI_BATCH_SIZE) batches.push(indexed.slice(i, i + AI_BATCH_SIZE));

  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_AI) {
    const batchGroup = batches.slice(i, i + MAX_CONCURRENT_AI);
    const promises = batchGroup.map(async (batch) => {
      try {
        const prompt = buildSummaryPrompt(batch, config.lang);
        const responseText = await callAI(prompt, config, getSystemPrompt(config.lang));        const parsed = parseJsonResponse<AISummaryResult>(responseText);
        if (parsed.results && Array.isArray(parsed.results)) {
          for (const result of parsed.results) {
            const item = batch.find(b => b.index === result.index);
            summaries.set(result.index, {
              titleZh: result.titleZh || '',
              oneLiner: result.oneLiner || '',
              summary: result.summary || '',
              reason: result.reason || '',
              pyramid: result.pyramid || buildFallbackPyramid(result.oneLiner || '', result.summary || ''),
              contentSource: item?.contentSource || 'rss',
            });
          }
        }
      } catch (error) {
        sendEvent?.('log', { message: `Summary batch failed: ${error instanceof Error ? error.message : String(error)}` });
        for (const item of batch) {
          summaries.set(item.index, {
            titleZh: item.title,
            oneLiner: item.title,
            summary: item.content.slice(0, 200),
            reason: '',
            contentSource: item.contentSource,
          });
        }
      }
    });
    await Promise.all(promises);
    const done = Math.min(i + MAX_CONCURRENT_AI, batches.length);
    sendEvent?.('progress', { step: 5, current: done, total: batches.length });
  }

  return summaries;
}

export async function generateHighlights(articles: ScoredArticle[], config: DigestConfig, sendEvent?: SendEvent): Promise<string> {
  const articleList = articles.slice(0, 10).map((a, i) =>
    `${i + 1}. [${a.category}] ${a.titleZh || a.title} — ${a.oneLiner}`
  ).join('\n');

  const langNote = config.lang === 'zh' ? '用中文回答。' : 'Write in English.';

  const prompt = `根据以下今日精选技术文章列表，写一段 3-5 句话的"今日看点"总结。
要求：
- 提炼出今天技术圈的 2-3 个主要趋势或话题
- 不要逐篇列举，要做宏观归纳
- 风格简洁有力，像新闻导语
${langNote}

文章列表：
${articleList}

直接返回纯文本总结，不要 JSON，不要 markdown 格式。`;

  try {
    const text = await callAI(prompt, config, getSystemPrompt(config.lang));
    return text.trim();
  } catch (error) {
    sendEvent?.('log', { message: `Highlights generation failed: ${error instanceof Error ? error.message : String(error)}` });
    return '';
  }
}
