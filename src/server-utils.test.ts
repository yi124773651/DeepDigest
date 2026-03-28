import { expect, test } from 'bun:test';
import { runWithCleanup } from './server-utils';

test('runWithCleanup 在成功路径也会执行 cleanup', async () => {
  const 执行顺序: string[] = [];

  const 结果 = await runWithCleanup(
    async () => {
      执行顺序.push('run');
      return 'ok';
    },
    async () => {
      执行顺序.push('cleanup');
    },
  );

  expect(结果).toBe('ok');
  expect(执行顺序).toEqual(['run', 'cleanup']);
});
