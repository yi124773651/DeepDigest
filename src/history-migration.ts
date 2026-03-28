import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DigestConfig } from './types';
import { sanitizeConfigForHistory } from './config';

export function migrateHistoryRecord<T extends Record<string, unknown>>(record: T): T {
  const next = { ...record };
  const config = next.config;

  if (config && typeof config === 'object' && !Array.isArray(config)) {
    next.config = sanitizeConfigForHistory(config as Partial<DigestConfig>);
  }

  return next as T;
}

export async function migrateHistoryFiles(historyDir: string): Promise<{ updated: number; failedFiles: string[] }> {
  const result = { updated: 0, failedFiles: [] as string[] };

  try {
    const files = await readdir(historyDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const fullPath = join(historyDir, file);

      try {
        const rawText = await readFile(fullPath, 'utf-8');
        const rawRecord = JSON.parse(rawText) as Record<string, unknown>;
        const migratedRecord = migrateHistoryRecord(rawRecord);
        const migratedText = JSON.stringify(migratedRecord, null, 2);

        if (migratedText !== rawText) {
          await writeFile(fullPath, migratedText);
          result.updated++;
        }
      } catch {
        result.failedFiles.push(file);
      }
    }
  } catch {
    return result;
  }

  return result;
}
