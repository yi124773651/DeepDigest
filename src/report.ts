import type { ScoredArticle, CategoryId, PyramidStructure } from './types';
import { CATEGORY_META } from './types';

// ============================================================================
// Helper Functions
// ============================================================================

function humanizeTime(pubDate: Date): string {
  const diffMs = Date.now() - pubDate.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;
  return pubDate.toISOString().slice(0, 10);
}

function generateKeywordBarChart(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) for (const kw of a.keywords) {
    const n = kw.toLowerCase();
    kwCount.set(n, (kwCount.get(n) || 0) + 1);
  }
  const sorted = Array.from(kwCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (sorted.length === 0) return '';
  const labels = sorted.map(([k]) => `"${k}"`).join(', ');
  const values = sorted.map(([, v]) => v).join(', ');
  const maxVal = sorted[0][1];
  return `\`\`\`mermaid\nxychart-beta horizontal\n    title "高频关键词"\n    x-axis [${labels}]\n    y-axis "出现次数" 0 --> ${maxVal + 2}\n    bar [${values}]\n\`\`\`\n`;
}

function generateCategoryPieChart(articles: ScoredArticle[]): string {
  const catCount = new Map<CategoryId, number>();
  for (const a of articles) catCount.set(a.category, (catCount.get(a.category) || 0) + 1);
  if (catCount.size === 0) return '';
  const sorted = Array.from(catCount.entries()).sort((a, b) => b[1] - a[1]);
  let chart = `\`\`\`mermaid\npie showData\n    title "文章分类分布"\n`;
  for (const [cat, count] of sorted) {
    const meta = CATEGORY_META[cat];
    chart += `    "${meta.emoji} ${meta.label}" : ${count}\n`;
  }
  return chart + `\`\`\`\n`;
}

function generateAsciiBarChart(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) for (const kw of a.keywords) {
    const n = kw.toLowerCase();
    kwCount.set(n, (kwCount.get(n) || 0) + 1);
  }
  const sorted = Array.from(kwCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (sorted.length === 0) return '';
  const maxVal = sorted[0][1];
  const maxBarWidth = 20;
  const maxLabelLen = Math.max(...sorted.map(([k]) => k.length));
  let chart = '```\n';
  for (const [label, value] of sorted) {
    const barLen = Math.max(1, Math.round((value / maxVal) * maxBarWidth));
    const bar = '█'.repeat(barLen) + '░'.repeat(maxBarWidth - barLen);
    chart += `${label.padEnd(maxLabelLen)} │ ${bar} ${value}\n`;
  }
  return chart + '```\n';
}

function generateTagCloud(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) for (const kw of a.keywords) {
    const n = kw.toLowerCase();
    kwCount.set(n, (kwCount.get(n) || 0) + 1);
  }
  const sorted = Array.from(kwCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (sorted.length === 0) return '';
  return sorted.map(([word, count], i) => i < 3 ? `**${word}**(${count})` : `${word}(${count})`).join(' · ');
}

// ============================================================================
// Pyramid Mindmap
// ============================================================================

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

function escapeMermaidText(text: string): string {
  // Mermaid mindmap nodes can't contain certain chars that break parsing
  return text.replace(/[()[\]{}"`]/g, ' ').replace(/\s+/g, ' ').trim();
}

function generatePyramidMindmap(pyramid: PyramidStructure): string {
  const core = escapeMermaidText(truncate(pyramid.core, 30));
  let mindmap = '```mermaid\nmindmap\n';
  mindmap += `  root((${core}))\n`;
  for (const arg of pyramid.arguments) {
    const point = escapeMermaidText(truncate(arg.point, 30));
    mindmap += `    ${point}\n`;
    if (arg.evidence && Array.isArray(arg.evidence)) {
      for (const ev of arg.evidence) {
        const evidence = escapeMermaidText(truncate(ev, 35));
        mindmap += `      ${evidence}\n`;
      }
    }
  }
  mindmap += '```\n';
  return mindmap;
}

function isValidPyramid(pyramid: unknown): pyramid is PyramidStructure {
  if (!pyramid || typeof pyramid !== 'object') return false;
  const p = pyramid as Record<string, unknown>;
  if (typeof p.core !== 'string' || !p.core) return false;
  if (!Array.isArray(p.arguments) || p.arguments.length === 0) return false;
  return p.arguments.every((arg: unknown) => {
    if (!arg || typeof arg !== 'object') return false;
    const a = arg as Record<string, unknown>;
    return typeof a.point === 'string' && Array.isArray(a.evidence);
  });
}

// ============================================================================
// Report Generation
// ============================================================================

export function generateDigestReport(articles: ScoredArticle[], highlights: string, stats: {
  totalFeeds: number; successFeeds: number; totalArticles: number; filteredArticles: number; hours: number; lang: string;
}): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  let report = `# 📰 AI 博客每日精选 — ${dateStr}\n\n`;
  report += `> 来自 Karpathy 推荐的 ${stats.totalFeeds} 个顶级技术博客，AI 精选 Top ${articles.length}\n\n`;

  if (highlights) {
    report += `## 📝 今日看点\n\n${highlights}\n\n---\n\n`;
  }

  if (articles.length >= 3) {
    report += `## 🏆 今日必读\n\n`;
    for (let i = 0; i < Math.min(3, articles.length); i++) {
      const a = articles[i];
      const medal = ['🥇', '🥈', '🥉'][i];
      const catMeta = CATEGORY_META[a.category];
      const wildcardMarker = a.isWildcard ? ' 🌍' : '';
      report += `${medal} **${a.titleZh || a.title}**${wildcardMarker}\n\n`;
      report += `[${a.title}](${a.link}) — ${a.sourceName} · ${humanizeTime(a.pubDate)} · ${catMeta.emoji} ${catMeta.label} · ⭐ ${a.score.toFixed(1)}/10\n\n`;
      report += `> ${a.oneLiner}\n\n`;
      report += `<details><summary>📖 详细摘要</summary>\n\n`;
      if (isValidPyramid(a.pyramid)) report += `${generatePyramidMindmap(a.pyramid)}\n`;
      report += `${a.summary}\n\n</details>\n\n`;
      if (a.reason) report += `💡 **为什么值得读**: ${a.reason}\n\n`;
      if (a.contentSource === 'rss') report += `*⚠️ 摘要基于 RSS 摘要生成*\n\n`;
      if (a.keywords.length > 0) report += `🏷️ ${a.keywords.join(', ')}\n\n`;
    }
    report += `---\n\n`;
  }

  report += `## 📊 数据概览\n\n`;
  report += `| 扫描源 | 抓取文章 | 时间范围 | 精选 |\n`;
  report += `|:---:|:---:|:---:|:---:|\n`;
  report += `| ${stats.successFeeds}/${stats.totalFeeds} | ${stats.totalArticles} 篇 → ${stats.filteredArticles} 篇 | ${stats.hours}h | **${articles.length} 篇** |\n\n`;

  const pieChart = generateCategoryPieChart(articles);
  if (pieChart) report += `### 分类分布\n\n${pieChart}\n`;
  const barChart = generateKeywordBarChart(articles);
  if (barChart) report += `### 高频关键词\n\n${barChart}\n`;
  const asciiChart = generateAsciiBarChart(articles);
  if (asciiChart) report += `<details>\n<summary>📈 纯文本关键词图（终端友好）</summary>\n\n${asciiChart}\n</details>\n\n`;
  const tagCloud = generateTagCloud(articles);
  if (tagCloud) report += `### 🏷️ 话题标签\n\n${tagCloud}\n\n`;
  report += `---\n\n`;

  const categoryGroups = new Map<CategoryId, ScoredArticle[]>();
  for (const a of articles) {
    const list = categoryGroups.get(a.category) || [];
    list.push(a);
    categoryGroups.set(a.category, list);
  }
  const sortedCategories = Array.from(categoryGroups.entries()).sort((a, b) => b[1].length - a[1].length);

  let globalIndex = 0;
  for (const [catId, catArticles] of sortedCategories) {
    const catMeta = CATEGORY_META[catId];
    report += `## ${catMeta.emoji} ${catMeta.label}\n\n`;
    for (const a of catArticles) {
      globalIndex++;
      const wildcardMarker = a.isWildcard ? ' 🌍' : '';
      report += `### ${globalIndex}. ${a.titleZh || a.title}${wildcardMarker}\n\n`;
      report += `[${a.title}](${a.link}) — **${a.sourceName}** · ${humanizeTime(a.pubDate)} · ⭐ ${a.score.toFixed(1)}/10\n\n`;
      report += `> ${a.oneLiner}\n\n`;
      report += `<details><summary>📖 详细摘要</summary>\n\n`;
      if (isValidPyramid(a.pyramid)) report += `${generatePyramidMindmap(a.pyramid)}\n`;
      report += `${a.summary}\n\n</details>\n\n`;
      if (a.reason) report += `💡 **为什么值得读**: ${a.reason}\n\n`;
      if (a.contentSource === 'rss') report += `*⚠️ 摘要基于 RSS 摘要生成*\n\n`;
      if (a.keywords.length > 0) report += `🏷️ ${a.keywords.join(', ')}\n\n`;
      report += `---\n\n`;
    }
  }

  report += `*生成于 ${dateStr} ${now.toISOString().split('T')[1]?.slice(0, 5) || ''} | 扫描 ${stats.successFeeds} 源 → 获取 ${stats.totalArticles} 篇 → 精选 ${articles.length} 篇*\n`;
  report += `*基于 [Hacker News Popularity Contest 2025](https://refactoringenglish.com/tools/hn-popularity/) RSS 源列表，由 [Andrej Karpathy](https://x.com/karpathy) 推荐*\n`;

  return report;
}
