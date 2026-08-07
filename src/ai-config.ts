import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AiProvider, AiProviderSafe, AiProviderType } from './types.js';

const CONFIG_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const MAX_PROVIDERS = 10;

function readRoot(): Record<string, any> {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function writeRoot(root: Record<string, any>): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(root, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

/** 加载所有 AI 供应商 */
export function loadAiProviders(): AiProvider[] {
  const root = readRoot();
  if (Array.isArray(root.aiProviders)) {
    return root.aiProviders;
  }
  return [];
}

/** 保存所有 AI 供应商（全量覆写） */
export function saveAiProviders(providers: AiProvider[]): void {
  const root = readRoot();
  root.aiProviders = providers.slice(0, MAX_PROVIDERS);
  writeRoot(root);
}

/** 原子更新：load → mutate → save */
export async function updateAiProviders(
  mutator: (providers: AiProvider[]) => AiProvider[],
): Promise<AiProvider[]> {
  const providers = loadAiProviders();
  const next = mutator(providers);
  if (next.length > MAX_PROVIDERS) {
    throw new Error(`最多 ${MAX_PROVIDERS} 个 AI 供应商`);
  }
  saveAiProviders(next);
  return next;
}

/** 脱敏：隐藏 API Key 中间部分 */
function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return key ? '••••' : '';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

/** 转为前端安全的供应商信息 */
export function toSafeProvider(p: AiProvider): AiProviderSafe {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    defaultModel: p.defaultModel,
    enabled: p.enabled,
    hasApiKey: !!p.apiKey,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** 根据 ID 获取一个供应商 */
export function getAiProvider(id: string): AiProvider | undefined {
  return loadAiProviders().find((p) => p.id === id);
}

/** 创建供应商 */
export async function createAiProvider(input: {
  name: string;
  type?: AiProviderType;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  enabled?: boolean;
}): Promise<AiProvider> {
  const now = new Date().toISOString();
  const provider: AiProvider = {
    id: `ai-${randomUUID()}`,
    name: String(input.name || '').trim().slice(0, 64) || 'Unnamed',
    type: input.type || 'openai-compatible',
    apiKey: String(input.apiKey || '').trim(),
    baseUrl: String(input.baseUrl || '').trim(),
    defaultModel: String(input.defaultModel || '').trim(),
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };

  if (!provider.name) throw new Error('名称不能为空');
  if (!provider.apiKey) throw new Error('API Key 不能为空');
  if (!provider.baseUrl) throw new Error('Base URL 不能为空');
  if (!provider.defaultModel) throw new Error('默认模型不能为空');

  await updateAiProviders((list) => [...list, provider]);
  return provider;
}

/** 更新供应商 */
export async function updateAiProvider(
  id: string,
  patch: {
    name?: string;
    type?: AiProviderType;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    enabled?: boolean;
  },
): Promise<AiProvider> {
  let updated: AiProvider | undefined;
  await updateAiProviders((list) => {
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error('供应商不存在');
    const now = new Date().toISOString();
    const prev = list[idx];
    const next: AiProvider = {
      ...prev,
      name: patch.name !== undefined ? String(patch.name).trim().slice(0, 64) || prev.name : prev.name,
      type: patch.type !== undefined ? patch.type : prev.type,
      apiKey: patch.apiKey !== undefined ? String(patch.apiKey).trim() : prev.apiKey,
      baseUrl: patch.baseUrl !== undefined ? String(patch.baseUrl).trim() : prev.baseUrl,
      defaultModel: patch.defaultModel !== undefined ? String(patch.defaultModel).trim() : prev.defaultModel,
      enabled: patch.enabled !== undefined ? !!patch.enabled : prev.enabled,
      updatedAt: now,
    };
    if (!next.name) throw new Error('名称不能为空');
    if (!next.apiKey) throw new Error('API Key 不能为空');
    if (!next.baseUrl) throw new Error('Base URL 不能为空');
    if (!next.defaultModel) throw new Error('默认模型不能为空');
    list[idx] = next;
    updated = next;
    return list;
  });
  return updated!;
}

/** 删除供应商 */
export async function deleteAiProvider(id: string): Promise<void> {
  await updateAiProviders((list) => {
    const before = list.length;
    const filtered = list.filter((p) => p.id !== id);
    if (filtered.length === before) throw new Error('供应商不存在');
    return filtered;
  });
}

/** 获取供应商脱敏列表（前端展示用） */
export function listSafeProviders(): AiProviderSafe[] {
  return loadAiProviders().map(toSafeProvider);
}

/** 获取一个供应商的脱敏信息 */
export function getSafeProvider(id: string): AiProviderSafe | undefined {
  const p = getAiProvider(id);
  return p ? toSafeProvider(p) : undefined;
}

/** 根据 ID 获取真实 API Key（仅内部使用） */
export function getProviderApiKey(id: string): string {
  const p = getAiProvider(id);
  return p?.apiKey || '';
}
