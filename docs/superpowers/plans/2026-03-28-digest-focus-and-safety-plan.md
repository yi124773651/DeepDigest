# DeepDigest 内容收敛与最小安全修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不重构产品主流程的前提下，降低低收益跨界文章进入 Top N 的概率，并修复持久浏览器未清理与旧历史明文 `apiKey` 残留问题。

**Architecture:** 通过“评分提示收紧 + 阈值提高 + 轻量降权 + wildcard 收紧”改善选文收益密度；通过“digest 生命周期清理 + 进程退出兜底 + 历史脱敏迁移”修复最小安全问题。实现优先保持现有模块边界，仅补充少量可测试辅助函数与迁移脚本。

**Tech Stack:** Bun、TypeScript、Puppeteer、Bun Test

---

### Task 1: 为内容收敛建立可回归测试

**Files:**
- Create: `src/scoring.test.ts`
- Modify: `src/scoring.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: 写出“低收益跨界内容被压低”的失败测试**

```ts
import { describe, expect, test } from 'bun:test';
import { selectArticles } from './scoring';
import type { Article, ArticleScore } from './types';

function makeArticle(title: string, sourceName = 'example.com'): Article {
  return {
    title,
    link: `https://example.com/${encodeURIComponent(title)}`,
    pubDate: new Date('2026-03-28T00:00:00.000Z'),
    description: title,
    sourceName,
    sourceUrl: 'https://example.com',
  };
}

describe('内容收敛排序', () => {
  test('低收益跨界主题在同等质量下应低于主线工程内容', () => {
    const articles = [
      makeArticle('Practical agent patterns for code review'),
      makeArticle('Apple Giveth, Apple Taketh Away', 'daringfireball.net'),
      makeArticle('Computing sine and cosine of complex arguments', 'johndcook.com'),
    ];

    const scores = new Map<number, ArticleScore>([
      [0, { relevance: 8, quality: 8, timeliness: 7, category: 'engineering', keywords: ['agent', 'review'] }],
      [1, { relevance: 7, quality: 8, timeliness: 7, category: 'opinion', keywords: ['Apple', 'Mac'] }],
      [2, { relevance: 7, quality: 8, timeliness: 7, category: 'engineering', keywords: ['math', 'complex analysis'] }],
    ]);

    const { selected } = selectArticles(articles, scores, 3);

    expect(selected[0]?.title).toBe('Practical agent patterns for code review');
  });
});
```

- [ ] **Step 2: 运行测试，确认当前实现失败**

Run: `bun test src/scoring.test.ts`

Expected: `FAIL`，因为当前 `selectArticles()` 还没有轻量主题降权逻辑，排序无法稳定把主线工程内容顶到前面。

- [ ] **Step 3: 再写一个 wildcard 收紧测试**

```ts
test('wildcard 不应挤掉明显更高相关的主线文章', () => {
  const articles = [
    makeArticle('LLM eval pipeline in production'),
    makeArticle('Rust build performance guide'),
    makeArticle('Inside a Win32 message loop', 'devblogs.microsoft.com/oldnewthing'),
  ];

  const scores = new Map<number, ArticleScore>([
    [0, { relevance: 9, quality: 8, timeliness: 8, category: 'ai-ml', keywords: ['LLM', 'eval'] }],
    [1, { relevance: 8, quality: 8, timeliness: 7, category: 'engineering', keywords: ['Rust', 'performance'] }],
    [2, { relevance: 4, quality: 8, timeliness: 7, category: 'engineering', keywords: ['Win32', 'message loop'] }],
  ]);

  const { selected } = selectArticles(articles, scores, 2);

  expect(selected.map(item => item.title)).toEqual([
    'LLM eval pipeline in production',
    'Rust build performance guide',
  ]);
});
```

- [ ] **Step 4: 再次运行测试，确认仍然失败**

Run: `bun test src/scoring.test.ts`

Expected: `FAIL`，因为当前 wildcard 逻辑仍可能让低相关高质量内容抢占最后一个席位。

- [ ] **Step 5: 提交代码**

本项目按仓库约束，`git commit` 属于高风险操作，默认不执行。若用户后续明确要求提交，再单独执行提交步骤。

---

### Task 2: 实现评分提示收紧、阈值提高与轻量降权

**Files:**
- Modify: `src/scoring.ts`
- Modify: `src/types.ts`
- Test: `src/scoring.test.ts`

- [ ] **Step 1: 先提高筛选阈值常量**

将 `src/types.ts` 中的阈值调整为更偏向主线收益内容：

```ts
export const SCORE_THRESHOLDS = { quality: 5, relevance: 5, timeliness: 3 } as const;
export const WILDCARD_RELEVANCE_MAX = 4;
export const WILDCARD_QUALITY_MIN = 8;
```

说明：
- `relevance` 从 3 提高到 5，优先挡掉“技术但收益较低”的文章。
- `quality` 提高到 5，避免靠流量型标题混入。
- `timeliness` 小幅抬高，防止纯热点借时效混入。
- wildcard 仅保留真正“低相关但高质量”的例外。

- [ ] **Step 2: 收紧评分提示语**

把 `src/scoring.ts` 中 `buildScoringPrompt()` 的提示词改成下面的结构化版本：

```ts
return `你是一个技术内容策展人，正在为一份面向技术从业者的高信噪比每日精选筛选文章。

目标读者最关心的是：
- AI / LLM / Agent / 推理 / 评测 / 工具链
- 编程语言、软件工程、系统设计、性能优化
- 开发工具、工作流、能直接提升生产力的实践经验

请注意：下面这些内容除非能直接迁移到 AI 或工程实践，否则相关性应明显降低：
- Apple 品牌新闻、硬件评论、平台八卦
- 纯数学推导、公式演算、复分析技巧
- Windows / Win32 / 旧平台底层冷知识

请继续对每篇文章输出 relevance、quality、timeliness、category、keywords。`;
```

- [ ] **Step 3: 在 `src/scoring.ts` 提取轻量降权辅助函数**

新增一个纯函数，专门根据标题、来源、关键词做轻量扣分：

```ts
function getTopicPenalty(input: {
  title: string;
  sourceName: string;
  keywords: string[];
  category: CategoryId;
  relevance: number;
}): number {
  const haystack = [
    input.title.toLowerCase(),
    input.sourceName.toLowerCase(),
    ...input.keywords.map(k => k.toLowerCase()),
  ].join(' ');

  const lowYieldPatterns = [
    'apple',
    'mac pro',
    'win32',
    'message loop',
    'complex analysis',
    'math',
  ];

  const isLowYieldTopic = lowYieldPatterns.some(pattern => haystack.includes(pattern));
  const isCoreCategory = input.category === 'ai-ml' || input.category === 'tools';

  if (!isLowYieldTopic || isCoreCategory || input.relevance >= 8) {
    return 0;
  }

  return 0.8;
}
```

- [ ] **Step 4: 把轻量降权接入 `selectArticles()`**

在计算 `withScore` 和后续 soft quota 基础分时，统一减去 penalty：

```ts
const withScore = candidates.map(a => {
  const baseScore =
    a.breakdown.relevance * SCORE_WEIGHTS.relevance +
    a.breakdown.quality * SCORE_WEIGHTS.quality +
    a.breakdown.timeliness * SCORE_WEIGHTS.timeliness;

  const penalty = getTopicPenalty({
    title: a.title,
    sourceName: a.sourceName,
    keywords: a.breakdown.keywords || [],
    category: a.breakdown.category,
    relevance: a.breakdown.relevance,
  });

  return {
    ...a,
    score: baseScore - penalty,
    isWildcard: false,
  };
});
```

在 while 循环里重算 `base` 时同样应用 penalty，避免折算后丢失收敛效果。

- [ ] **Step 5: 收紧 wildcard 补位条件**

把最后补 wildcard 的逻辑改成“仅在不会挤掉高相关主线内容时才补”：

```ts
const wildcard = wildcardCandidates.find(a => {
  if (selectedIndices.has(a.index)) return false;
  return a.breakdown.quality >= WILDCARD_QUALITY_MIN &&
         a.breakdown.relevance < WILDCARD_RELEVANCE_MAX;
});

if (wildcard && selected.length < topN) {
  wildcard.isWildcard = true;
  selected.push(wildcard);
} else if (remaining.length > 0 && selected.length < topN) {
  selected.push(remaining[0]);
}
```

- [ ] **Step 6: 运行测试，确认转绿**

Run: `bun test src/scoring.test.ts`

Expected: 所有新增测试 `PASS`

- [ ] **Step 7: 运行全量测试**

Run: `bun test`

Expected: 全量测试 `PASS`

- [ ] **Step 8: 提交代码**

默认不提交；若用户明确要求提交，再执行 `git add` / `git commit`。

---

### Task 3: 为浏览器清理与历史迁移建立失败测试

**Files:**
- Create: `src/history-migration.test.ts`
- Create: `src/history-migration.ts`
- Modify: `server.ts`
- Modify: `src/scraper.ts`

- [ ] **Step 1: 写历史迁移的失败测试**

```ts
import { describe, expect, test } from 'bun:test';
import { migrateHistoryRecord } from './history-migration';

describe('历史记录脱敏迁移', () => {
  test('旧历史中的明文 apiKey 应被移除并保留 hasApiKey', () => {
    const record = {
      id: 'abc',
      config: {
        apiKey: 'sk-secret',
        baseUrl: 'https://api.openai.com',
        modelName: 'gpt-5.4',
        hours: 24,
        topN: 15,
        lang: 'zh',
      },
    };

    expect(migrateHistoryRecord(record)).toEqual({
      id: 'abc',
      config: {
        baseUrl: 'https://api.openai.com',
        modelName: 'gpt-5.4',
        hours: 24,
        topN: 15,
        lang: 'zh',
        hasApiKey: true,
      },
    });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test src/history-migration.test.ts`

Expected: `FAIL`，因为 `migrateHistoryRecord()` 尚不存在。

- [ ] **Step 3: 为浏览器关闭增加最小可测辅助函数设计**

在 `server.ts` 旁边先定义一个可复用清理包装器，测试目标不是直接起浏览器，而是验证“无论成功或失败都调用清理回调”的控制流：

```ts
export async function runWithCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await cleanup().catch(() => {});
  }
}
```

- [ ] **Step 4: 给 `runWithCleanup()` 写失败测试**

```ts
import { describe, expect, test } from 'bun:test';
import { runWithCleanup } from './server-utils';

describe('统一清理包装器', () => {
  test('成功路径也会执行 cleanup', async () => {
    let cleaned = false;

    const result = await runWithCleanup(
      async () => 'ok',
      async () => { cleaned = true; },
    );

    expect(result).toBe('ok');
    expect(cleaned).toBe(true);
  });
});
```

- [ ] **Step 5: 运行测试，确认失败**

Run: `bun test src/history-migration.test.ts src/server-utils.test.ts`

Expected: `FAIL`，因为辅助函数文件还不存在。

- [ ] **Step 6: 提交代码**

默认不提交；若用户明确要求提交，再执行版本控制步骤。

---

### Task 4: 实现统一清理与旧历史脱敏迁移

**Files:**
- Create: `src/history-migration.ts`
- Create: `src/server-utils.ts`
- Create: `src/server-utils.test.ts`
- Modify: `server.ts`
- Modify: `src/history-migration.test.ts`
- Test: `src/history-migration.test.ts`
- Test: `src/server-utils.test.ts`

- [ ] **Step 1: 实现历史迁移纯函数**

在 `src/history-migration.ts` 中加入：

```ts
import type { DigestConfig } from './types';
import { sanitizeConfigForHistory } from './config';

export function migrateHistoryRecord(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  const config = next.config;

  if (config && typeof config === 'object' && !Array.isArray(config)) {
    next.config = sanitizeConfigForHistory(config as Partial<DigestConfig>);
  }

  return next;
}
```

- [ ] **Step 2: 实现统一清理包装器**

在 `src/server-utils.ts` 中加入：

```ts
export async function runWithCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await cleanup().catch(() => {});
  }
}
```

- [ ] **Step 3: 跑测试确认这两个新增模块转绿**

Run: `bun test src/history-migration.test.ts src/server-utils.test.ts`

Expected: `PASS`

- [ ] **Step 4: 把 digest 主流程包进统一清理逻辑**

在 `server.ts` 中：

```ts
import { closeBrowser } from './src/scraper';
import { migrateHistoryRecord } from './src/history-migration';
import { runWithCleanup } from './src/server-utils';
```

并把原本的：

```ts
try {
  await runDigest(config, sendEvent);
} catch (err) {
  sendEvent('error', { message: err instanceof Error ? err.message : String(err) });
}
```

改成：

```ts
await runWithCleanup(
  async () => {
    try {
      await runDigest(config, sendEvent);
    } catch (err) {
      sendEvent('error', { message: err instanceof Error ? err.message : String(err) });
    }
  },
  async () => {
    await closeBrowser();
  },
);
```

- [ ] **Step 5: 给历史读取接入迁移函数**

把 `getHistory()` 中读取 JSON 的代码改成：

```ts
const rawMeta = JSON.parse(await readFile(join(HISTORY_DIR, `${safeId}.json`), 'utf-8')) as Record<string, unknown>;
const meta = migrateHistoryRecord(rawMeta);
```

- [ ] **Step 6: 增加服务退出兜底**

在 `server.ts` 底部加入：

```ts
const cleanupBrowserOnExit = async () => {
  await closeBrowser().catch(() => {});
};

process.on('SIGINT', () => {
  void cleanupBrowserOnExit().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void cleanupBrowserOnExit().finally(() => process.exit(0));
});
```

如果 Bun 当前运行时支持 `beforeExit`，可再补一个非阻塞兜底；若不稳定，则保持 `SIGINT` / `SIGTERM` 即可。

- [ ] **Step 7: 新增旧历史批量迁移入口**

在 `server.ts` 启动前增加一次历史目录脱敏迁移调用，或新增独立脚本 `scripts/migrate-history.ts`：

```ts
for (const file of await readdir(HISTORY_DIR)) {
  if (!file.endsWith('.json')) continue;
  const fullPath = join(HISTORY_DIR, file);
  const raw = JSON.parse(await readFile(fullPath, 'utf-8')) as Record<string, unknown>;
  const migrated = migrateHistoryRecord(raw);
  await writeFile(fullPath, JSON.stringify(migrated, null, 2));
}
```

要求：
- 只在内容实际发生变化时回写更好，但不是必须。
- 单文件失败需要 `console.warn()`，不能中断整个服务启动。

- [ ] **Step 8: 跑测试**

Run: `bun test`

Expected: 全量测试 `PASS`

- [ ] **Step 9: 启动服务做手动验证**

Run: `bun server.ts`

Expected:
- 控制台输出 `DeepDigest server running at http://localhost:3000`
- 启动后不会因迁移逻辑报错退出

- [ ] **Step 10: 提交代码**

默认不提交；若用户明确要求提交，再执行版本控制步骤。

---

### Task 5: 手动回归验证输出与安全行为

**Files:**
- Verify: `data/history/*.json`
- Verify: `public/index.html`
- Verify: `server.ts`

- [ ] **Step 1: 验证旧历史已脱敏**

Run: `rg -n "\"apiKey\"" data/history -S`

Expected: 对历史文件应不再出现明文 `apiKey` 字段；如仍有命中，应只出现在测试夹具或预期例外文件中。

- [ ] **Step 2: 验证配置接口仍不回传明文**

Run: `bun test src/config.test.ts`

Expected: `PASS`

- [ ] **Step 3: 做一次完整 digest 手动检查**

手动操作：
1. 启动 `bun server.ts`
2. 打开页面
3. 运行一次 digest
4. 检查输出 Top N 中主线 AI / 工程 / 工具内容是否更靠前

Expected:
- Apple / 数学 / Win32 等低收益跨界内容显著减少或后移
- 页面与历史接口仍可正常工作

- [ ] **Step 4: 做一次中断验证**

手动操作：
1. 运行 digest
2. 中途 `Ctrl+C` 中断服务

Expected:
- 服务能退出
- 不应出现持续残留的 Puppeteer 管理实例

- [ ] **Step 5: 记录验证结果**

建议在任务输出中记录：
- 测试命令结果
- 历史迁移是否成功
- 一次实际 digest 的内容变化观察

- [ ] **Step 6: 提交代码**

默认不提交；若用户明确要求提交，再执行版本控制步骤。
