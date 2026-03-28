import { expect, test } from 'bun:test';
import { selectArticles } from './scoring';
import type { Article, ArticleScore } from './types';

function 构造文章(title: string): Article {
  return {
    title,
    link: `https://example.com/${encodeURIComponent(title)}`,
    pubDate: new Date('2026-03-28T00:00:00.000Z'),
    description: `${title} 的摘要`,
    sourceName: '测试源',
    sourceUrl: 'https://example.com',
  };
}

function 构造评分映射(
  articles: Article[],
  按标题评分: Record<string, ArticleScore>,
): Map<number, ArticleScore> {
  return new Map(
    articles.map((article, index) => {
      const score = 按标题评分[article.title];
      if (!score) {
        throw new Error(`缺少文章评分: ${article.title}`);
      }
      return [index, score] as const;
    }),
  );
}

test('低收益跨界主题在同等质量下应低于主线工程内容', () => {
  const articles: Article[] = [
    构造文章('跨界杂谈：技术人如何做生活方式管理'),
    构造文章('主线工程：面向后端系统的可观测性实践'),
  ];

  const scores = 构造评分映射(articles, {
    '跨界杂谈：技术人如何做生活方式管理': {
      relevance: 7,
      quality: 8,
      timeliness: 8,
      category: 'opinion',
      keywords: ['lifestyle'],
    },
    '主线工程：面向后端系统的可观测性实践': {
      relevance: 7,
      quality: 8,
      timeliness: 8,
      category: 'engineering',
      keywords: ['observability'],
    },
  });

  const { selected } = selectArticles(articles, scores, 1);
  expect(selected).toHaveLength(1);
  expect(selected[0]?.title).toBe('主线工程：面向后端系统的可观测性实践');
});

test('wildcard 不应挤掉明显更高相关的主线文章', () => {
  const articles: Article[] = [
    构造文章('主线工程 A：数据库内核优化'),
    构造文章('主线工程 B：微服务发布治理'),
    构造文章('跨界 wildcard：效率习惯学'),
    构造文章('主线工程 C：分布式事务实战'),
  ];

  const scores = 构造评分映射(articles, {
    '主线工程 A：数据库内核优化': {
      relevance: 9,
      quality: 8,
      timeliness: 8,
      category: 'engineering',
      keywords: ['database'],
    },
    '主线工程 B：微服务发布治理': {
      relevance: 8,
      quality: 8,
      timeliness: 8,
      category: 'tools',
      keywords: ['delivery'],
    },
    '跨界 wildcard：效率习惯学': {
      relevance: 4,
      quality: 9,
      timeliness: 9,
      category: 'opinion',
      keywords: ['habit'],
    },
    '主线工程 C：分布式事务实战': {
      relevance: 8,
      quality: 7,
      timeliness: 7,
      category: 'engineering',
      keywords: ['distributed'],
    },
  });

  const { selected } = selectArticles(articles, scores, 3);
  const selectedTitles = new Set(selected.map(item => item.title));
  const expectedTitles = new Set([
    '主线工程 A：数据库内核优化',
    '主线工程 B：微服务发布治理',
    '主线工程 C：分布式事务实战',
  ]);

  expect(selected).toHaveLength(3);
  expect(selectedTitles).toEqual(expectedTitles);
});

test('wildcard 候选可来自未过主线阈值的跨界例外', () => {
  const articles: Article[] = [
    构造文章('主线工程 A：数据库内核优化'),
    构造文章('主线工程 B：微服务发布治理'),
    构造文章('跨界 wildcard：品牌战略写作框架'),
  ];

  const scores = 构造评分映射(articles, {
    '主线工程 A：数据库内核优化': {
      relevance: 9,
      quality: 8,
      timeliness: 8,
      category: 'engineering',
      keywords: ['database'],
    },
    '主线工程 B：微服务发布治理': {
      relevance: 8,
      quality: 7,
      timeliness: 7,
      category: 'tools',
      keywords: ['delivery'],
    },
    '跨界 wildcard：品牌战略写作框架': {
      relevance: 4,
      quality: 9,
      timeliness: 8,
      category: 'opinion',
      keywords: ['strategy'],
    },
  });

  const { selected } = selectArticles(articles, scores, 3);
  const selectedTitles = new Set(selected.map(item => item.title));

  expect(selected).toHaveLength(3);
  expect(selectedTitles.has('跨界 wildcard：品牌战略写作框架')).toBe(true);
});
