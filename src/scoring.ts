import type { Article, ArticleScore, AIScoringResult, DigestConfig, CategoryId, SendEvent } from './types';
import {
  VALID_CATEGORIES, AI_BATCH_SIZE, MAX_CONCURRENT_AI,
  SCORE_WEIGHTS, SCORE_THRESHOLDS,
  SOFT_QUOTA_MAX, SOFT_QUOTA_DISCOUNT,
  WILDCARD_RELEVANCE_MAX, WILDCARD_QUALITY_MIN,
} from './types';
import { callAI, parseJsonResponse } from './ai-client';

function buildScoringPrompt(articles: Array<{ index: number; title: string; description: string; sourceName: string }>): string {
  const articlesList = articles.map(a =>
    `Index ${a.index}: [${a.sourceName}] ${a.title}\n${a.description.slice(0, 300)}`
  ).join('\n\n---\n\n');

  return `你是一个技术内容策展人，正在为一份面向工程实践的每日精选摘要筛选文章。

请对以下文章进行三个维度的评分（1-10 整数，10 分最高），并为每篇文章分配一个分类标签和提取 2-4 个关键词。

## 评分维度

### 1. 相关性 (relevance) - 对 AI/工程主线从业者的直接价值
- 10: AI/LLM/Agent 的重大突破、重要模型发布、可复现工程方法
- 8-9: 工程实践、开发工具、编程语言、系统设计、性能优化中的高价值实战内容
- 6-7: 与主线相关但偏外围，迁移成本较高
- 3-5: 仅弱相关或需要大量转译才可用于 AI 或工程实践
- 1-2: 与主线收益关系很弱

### 2. 质量 (quality) - 文章本身的深度和写作质量
- 10: 深度分析，原创洞见，引用丰富
- 7-9: 有深度，观点独到
- 4-6: 信息准确，表达清晰
- 1-3: 浅尝辄止或纯转述

### 3. 时效性 (timeliness) - 当前是否值得阅读
- 10: 正在发生的重大事件/刚发布的重要工具
- 7-9: 近期热点相关
- 4-6: 常青内容，不过时
- 1-3: 过时或无时效价值

## 分类标签（必须从以下选一个）
- ai-ml: AI、机器学习、LLM、深度学习相关
- security: 安全、隐私、漏洞、加密相关
- engineering: 软件工程、架构、编程语言、系统设计
- tools: 开发工具、开源项目、新发布的库/框架
- opinion: 行业观点、个人思考、职业发展、文化评论
- other: 以上都不太适合的

## 关键词提取
提取 2-4 个最能代表文章主题的关键词（用英文，简短，如 "Rust", "LLM", "database", "performance"）

## 额外判定规则（非常重要）
- 优先选择：AI / LLM / Agent / 工程实践 / 开发工具 / 编程语言 / 系统设计 / 性能优化
- Apple 品牌新闻、纯数学推导、Windows/Win32 冷知识：如果不能直接迁移到 AI 或工程实践，请显著降低 relevance
- 不要因为热点或标题党给出虚高 relevance

## 待评分文章

${articlesList}

请严格按 JSON 格式返回，不要包含 markdown 代码块或其他文字：
{
  "results": [
    {
      "index": 0,
      "relevance": 8,
      "quality": 7,
      "timeliness": 9,
      "category": "engineering",
      "keywords": ["Rust", "compiler", "performance"]
    }
  ]
}`;
}

const MAINLINE_TOPIC_PATTERN = /(ai|llm|agent|prompt|模型|工程|架构|系统设计|性能|优化|编程|语言|代码|开发工具|framework|database|后端|前端|infra|observability|security)/i;
const APPLE_NEWS_PATTERN = /(apple|iphone|ipad|macbook|ios|macos)/i;
const PURE_MATH_PATTERN = /(纯数学|数学推导|定理|证明|lemma|theorem|equation)/i;
const WINDOWS_TRIVIA_PATTERN = /(windows|win32).*(冷知识|trivia|八卦|趣闻)|((冷知识|trivia).*(windows|win32))/i;
const LIFESTYLE_PATTERN = /(生活方式|效率习惯|habit|lifestyle|self-help|时间管理)/i;

function calculateLowValuePenalty(
  article: Pick<Article, 'title' | 'sourceName' | 'description'>,
  breakdown: Pick<ArticleScore, 'keywords'>,
): number {
  const text = `${article.title} ${article.sourceName} ${article.description} ${breakdown.keywords.join(' ')}`;
  const hasMainlineSignal = MAINLINE_TOPIC_PATTERN.test(text);
  let penalty = 0;

  if (APPLE_NEWS_PATTERN.test(text) && !hasMainlineSignal) penalty += 0.7;
  if (PURE_MATH_PATTERN.test(text) && !hasMainlineSignal) penalty += 0.7;
  if (WINDOWS_TRIVIA_PATTERN.test(text) && !hasMainlineSignal) penalty += 0.7;
  if (LIFESTYLE_PATTERN.test(text) && !hasMainlineSignal) penalty += 0.8;

  return Math.min(1.6, penalty);
}

function calculateBaseScore(
  article: Pick<Article, 'title' | 'sourceName' | 'description'>,
  breakdown: ArticleScore,
): number {
  const raw = breakdown.relevance * SCORE_WEIGHTS.relevance
            + breakdown.quality * SCORE_WEIGHTS.quality
            + breakdown.timeliness * SCORE_WEIGHTS.timeliness;
  return Math.max(0, raw - calculateLowValuePenalty(article, breakdown));
}

export async function scoreArticlesWithAI(
  articles: Article[],
  config: DigestConfig,
  sendEvent?: SendEvent,
): Promise<Map<number, ArticleScore>> {
  const allScores = new Map<number, ArticleScore>();
  const indexed = articles.map((article, index) => ({
    index, title: article.title, description: article.description, sourceName: article.sourceName,
  }));

  const batches: typeof indexed[] = [];
  for (let i = 0; i < indexed.length; i += AI_BATCH_SIZE) batches.push(indexed.slice(i, i + AI_BATCH_SIZE));

  const validCategories = new Set<string>(VALID_CATEGORIES);

  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_AI) {
    const batchGroup = batches.slice(i, i + MAX_CONCURRENT_AI);
    const promises = batchGroup.map(async (batch) => {
      try {
        const prompt = buildScoringPrompt(batch);
        const responseText = await callAI(prompt, config);
        const parsed = parseJsonResponse<AIScoringResult>(responseText);
        if (parsed.results && Array.isArray(parsed.results)) {
          for (const result of parsed.results) {
            const clamp = (v: number) => Math.min(10, Math.max(1, Math.round(v)));
            const cat = (validCategories.has(result.category) ? result.category : 'other') as CategoryId;
            allScores.set(result.index, {
              relevance: clamp(result.relevance), quality: clamp(result.quality), timeliness: clamp(result.timeliness),
              category: cat, keywords: Array.isArray(result.keywords) ? result.keywords.slice(0, 4) : [],
            });
          }
        }
      } catch (error) {
        sendEvent?.('log', { message: `Scoring batch failed: ${error instanceof Error ? error.message : String(error)}` });
        for (const item of batch) {
          allScores.set(item.index, { relevance: 5, quality: 5, timeliness: 5, category: 'other', keywords: [] });
        }
      }
    });
    await Promise.all(promises);
    const done = Math.min(i + MAX_CONCURRENT_AI, batches.length);
    sendEvent?.('progress', { step: 3, current: done, total: batches.length });
  }
  return allScores;
}

export function selectArticles(
  articles: Article[],
  scores: Map<number, ArticleScore>,
  topN: number,
): { selected: Array<Article & { score: number; breakdown: ArticleScore; isWildcard: boolean }> } {
  const allCandidates = articles
    .map((article, index) => {
      const s = scores.get(index) || { relevance: 5, quality: 5, timeliness: 5, category: 'other' as CategoryId, keywords: [] };
      return { ...article, index, breakdown: s };
    });

  const candidates = allCandidates
    .filter(a =>
      a.breakdown.quality >= SCORE_THRESHOLDS.quality &&
      a.breakdown.relevance >= SCORE_THRESHOLDS.relevance &&
      a.breakdown.timeliness >= SCORE_THRESHOLDS.timeliness
    );

  const withScore = candidates.map(a => ({
    ...a,
    score: calculateBaseScore(a, a.breakdown),
    isWildcard: false,
  }));

  const wildcardCandidates = allCandidates
    .filter(a =>
      a.breakdown.relevance <= WILDCARD_RELEVANCE_MAX &&
      a.breakdown.quality >= WILDCARD_QUALITY_MIN &&
      a.breakdown.timeliness >= SCORE_THRESHOLDS.timeliness
    )
    .map(a => ({
      ...a,
      score: calculateBaseScore(a, a.breakdown),
      isWildcard: false,
    }))
    .sort((a, b) => b.score - a.score);

  const normalSlots = topN - 1;
  const selected: typeof withScore = [];
  const categoryCount = new Map<CategoryId, number>();
  const remaining = [...withScore].sort((a, b) => b.score - a.score);

  while (selected.length < normalSlots && remaining.length > 0) {
    for (const a of remaining) {
      const count = categoryCount.get(a.breakdown.category) || 0;
      const base = calculateBaseScore(a, a.breakdown);
      a.score = base * (count >= SOFT_QUOTA_MAX ? SOFT_QUOTA_DISCOUNT : 1);
    }
    remaining.sort((a, b) => b.score - a.score);

    const pick = remaining.shift()!;
    selected.push(pick);
    categoryCount.set(pick.breakdown.category, (categoryCount.get(pick.breakdown.category) || 0) + 1);
  }

  const selectedIndices = new Set(selected.map(a => a.index));
  const wildcard = wildcardCandidates.find(a => !selectedIndices.has(a.index));
  const bestRemainingMainline = remaining.find(a =>
    !selectedIndices.has(a.index) &&
    a.breakdown.relevance > WILDCARD_RELEVANCE_MAX
  );
  const wildcardShouldYield = Boolean(
    wildcard &&
    bestRemainingMainline &&
    (bestRemainingMainline.breakdown.relevance - wildcard.breakdown.relevance >= 2) &&
    (bestRemainingMainline.score >= wildcard.score)
  );

  if (wildcard && !wildcardShouldYield) {
    wildcard.isWildcard = true;
    selected.push(wildcard);
  } else if (remaining.length > 0) {
    selected.push(remaining[0]);
  }

  // Backfill: when selected < topN, fill from below-threshold articles by score
  if (selected.length < topN) {
    const selectedIndicesAfterWildcard = new Set(selected.map(a => a.index));
    const backfillCandidates = allCandidates
      .filter(a => !selectedIndicesAfterWildcard.has(a.index))
      .map(a => ({
        ...a,
        score: calculateBaseScore(a, a.breakdown),
        isWildcard: false,
      }))
      .sort((a, b) => b.score - a.score);

    for (const candidate of backfillCandidates) {
      if (selected.length >= topN) break;
      selected.push(candidate);
    }
  }

  return { selected };
}
