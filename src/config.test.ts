import { describe, expect, test } from 'bun:test';
import type { DigestConfig } from './types';
import {
  mergeConfigUpdate,
  sanitizeConfigForClient,
  sanitizeConfigForHistory,
} from './config';

describe('配置脱敏与合并', () => {
  const fullConfig: DigestConfig = {
    apiKey: 'sk-secret-value',
    baseUrl: 'https://api.openai.com',
    modelName: 'gpt-5.4',
    hours: 24,
    topN: 15,
    lang: 'zh',
  };

  test('客户端配置不返回明文 apiKey', () => {
    const result = sanitizeConfigForClient(fullConfig);

    expect(result).toEqual({
      baseUrl: 'https://api.openai.com',
      modelName: 'gpt-5.4',
      hours: 24,
      topN: 15,
      lang: 'zh',
      hasApiKey: true,
    });
    expect('apiKey' in result).toBe(false);
  });

  test('空白 apiKey 更新不会覆盖已保存值', () => {
    const result = mergeConfigUpdate(fullConfig, {
      apiKey: '   ',
      topN: 20,
    });

    expect(result.apiKey).toBe('sk-secret-value');
    expect(result.topN).toBe(20);
  });

  test('历史记录配置不写入明文 apiKey', () => {
    const result = sanitizeConfigForHistory(fullConfig);

    expect(result).toEqual({
      baseUrl: 'https://api.openai.com',
      modelName: 'gpt-5.4',
      hours: 24,
      topN: 15,
      lang: 'zh',
      hasApiKey: true,
    });
    expect('apiKey' in result).toBe(false);
  });

  test('已脱敏配置再次处理时应保留 hasApiKey', () => {
    const result = sanitizeConfigForHistory({
      baseUrl: 'https://api.openai.com',
      modelName: 'gpt-5.4',
      hours: 24,
      topN: 15,
      lang: 'zh',
      hasApiKey: true,
    } as Partial<DigestConfig> & { hasApiKey: boolean });

    expect(result.hasApiKey).toBe(true);
  });
});
