import { expect, test } from 'bun:test';
import { migrateHistoryRecord } from './history-migration';

test('迁移旧历史记录时应移除明文 apiKey 并保留 hasApiKey 标记', () => {
  const 旧记录 = {
    id: '2026-03-28T08-00-00-000Z',
    createdAt: '2026-03-28T08:00:00.000Z',
    config: {
      apiKey: 'sk-legacy-secret',
      baseUrl: 'https://api.openai.com',
      modelName: 'gpt-4o-mini',
      hours: 48,
      topN: 15,
      lang: 'zh',
    },
    articles: [],
    highlights: [],
    stats: {
      totalFeeds: 10,
      successFeeds: 9,
      totalArticles: 100,
      filteredArticles: 40,
      selectedArticles: 15,
    },
  };

  const 迁移结果 = migrateHistoryRecord(旧记录);

  expect(迁移结果.config).not.toHaveProperty('apiKey');
  expect(迁移结果.config.hasApiKey).toBe(true);
  expect(迁移结果.config.baseUrl).toBe('https://api.openai.com');
});
