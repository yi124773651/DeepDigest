export type CategoryId = 'ai-ml' | 'security' | 'engineering' | 'tools' | 'opinion' | 'other';

export const CATEGORY_META: Record<CategoryId, { emoji: string; label: string }> = {
  'ai-ml':       { emoji: '🤖', label: 'AI / ML' },
  'security':    { emoji: '🔒', label: '安全' },
  'engineering': { emoji: '⚙️', label: '工程' },
  'tools':       { emoji: '🛠', label: '工具 / 开源' },
  'opinion':     { emoji: '💡', label: '观点 / 杂谈' },
  'other':       { emoji: '📝', label: '其他' },
};

export const VALID_CATEGORIES = new Set<string>(Object.keys(CATEGORY_META));

export const CATEGORY_COLORS: Record<CategoryId, string> = {
  'ai-ml':       '#6c8cff',
  'security':    '#f87171',
  'engineering': '#4ade80',
  'tools':       '#a78bfa',
  'opinion':     '#fbbf24',
  'other':       '#9196a8',
};

export interface Article {
  title: string;
  link: string;
  pubDate: Date;
  description: string;
  sourceName: string;
  sourceUrl: string;
}

export interface ArticleScore {
  relevance: number;
  quality: number;
  timeliness: number;
  category: CategoryId;
  keywords: string[];
}

export interface PyramidStructure {
  core: string;
  arguments: Array<{ point: string; evidence: string[] }>;
}

export interface ScoredArticle extends Article {
  score: number;
  scoreBreakdown: { relevance: number; quality: number; timeliness: number };
  category: CategoryId;
  keywords: string[];
  titleZh: string;
  oneLiner: string;
  summary: string;
  reason: string;
  pyramid?: PyramidStructure;
  isWildcard: boolean;
  contentSource: 'full' | 'rss';
}

export interface AIScoringResult {
  results: Array<{
    index: number;
    relevance: number;
    quality: number;
    timeliness: number;
    category: string;
    keywords: string[];
  }>;
}

export interface AISummaryResult {
  results: Array<{
    index: number;
    titleZh: string;
    oneLiner: string;
    summary: string;
    reason: string;
    pyramid?: PyramidStructure;
  }>;
}

export interface DigestConfig {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  hours: number;
  topN: number;
  lang: 'zh' | 'en';
}

export type SendEvent = (type: string, data: Record<string, unknown>) => void;

export const SCORE_WEIGHTS = { relevance: 0.4, quality: 0.4, timeliness: 0.2 } as const;
export const SCORE_THRESHOLDS = { quality: 5, relevance: 5, timeliness: 3 } as const;
export const SOFT_QUOTA_MAX = 5;
export const SOFT_QUOTA_DISCOUNT = 0.6;
export const WILDCARD_RELEVANCE_MAX = 4;
export const WILDCARD_QUALITY_MIN = 8;

export const FEED_FETCH_TIMEOUT_MS = 15_000;
export const FEED_CONCURRENCY = 20;
export const AI_BATCH_SIZE = 10;
export const MAX_CONCURRENT_AI = 4;
export const SCRAPER_CONCURRENCY = 5;
export const SCRAPER_TIMEOUT_MS = 20_000;
