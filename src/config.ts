import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DigestConfig } from './types';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

export { DATA_DIR, CONFIG_PATH };

export const HISTORY_DIR = join(DATA_DIR, 'history');

export async function loadConfig(): Promise<Partial<DigestConfig>> {
  try {
    const text = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function saveConfig(config: Partial<DigestConfig>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}
