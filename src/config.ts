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

type SafeConfig = Omit<Partial<DigestConfig>, 'apiKey'> & { hasApiKey: boolean };

function trimApiKey(apiKey: string | undefined): string | undefined {
  const normalized = apiKey?.trim();
  return normalized ? normalized : undefined;
}

function hasSavedApiKey(config: Partial<DigestConfig> & { hasApiKey?: boolean }): boolean {
  return Boolean(trimApiKey(config.apiKey)) || Boolean(config.hasApiKey);
}

export function sanitizeConfigForClient(config: Partial<DigestConfig>): SafeConfig {
  const { apiKey: _apiKey, ...rest } = config;
  return {
    ...rest,
    hasApiKey: hasSavedApiKey(config as Partial<DigestConfig> & { hasApiKey?: boolean }),
  };
}

export function sanitizeConfigForHistory(config: Partial<DigestConfig>): SafeConfig {
  const { apiKey: _apiKey, ...rest } = config;
  return {
    ...rest,
    hasApiKey: hasSavedApiKey(config as Partial<DigestConfig> & { hasApiKey?: boolean }),
  };
}

export function mergeConfigUpdate(
  existing: Partial<DigestConfig>,
  incoming: Partial<DigestConfig>,
): Partial<DigestConfig> {
  const next: Partial<DigestConfig> = {
    ...existing,
    ...incoming,
  };

  const normalizedIncomingApiKey = trimApiKey(incoming.apiKey);
  if (normalizedIncomingApiKey) {
    next.apiKey = normalizedIncomingApiKey;
  } else {
    next.apiKey = trimApiKey(existing.apiKey);
  }

  return next;
}
