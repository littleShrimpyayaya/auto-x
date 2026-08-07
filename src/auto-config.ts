import fs from 'fs';
import path from 'path';

const CONFIG_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** Fixed id for the default migrated task (legacy dual-write + postSchedule) */
export const COMPOSER_TASK_ID = 'task-migrated-default';
export const MAX_POST_TASKS = 10;
export const MIN_POST_INTERVAL_MINUTES = 5;
export const TWEET_MAX_CHARS = 280;

export type PostContentMode = 'static' | 'ai';

export type PostTaskPhase =
  | 'idle'
  | 'waiting'
  | 'generating'
  | 'queued'
  | 'posting'
  | 'error';

export interface PostTaskConfig {
  id: string;
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  contentMode: PostContentMode;
  content: string;
  model?: string | null;
  lastPostAt: string | null;
  postAutoIndex: number;
  postCount: number;
  lastResult: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostAiSettings {
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
}

/**
 * Post config v2: multi-task under `tasks[]`.
 * Legacy fields (templates / autoPost*) always dual-written from COMPOSER_TASK_ID for old UI.
 */
export interface PostConfig {
  version: 2;
  tasks: PostTaskConfig[];
  ai: PostAiSettings;
  // Legacy dual-write mirror of COMPOSER_TASK_ID
  templates: string[];
  autoPostEnabled: boolean;
  autoPostIntervalMinutes: number;
  autoPostTemplateIndex: number;
  lastPostAt: string | null;
  postAutoIndex: number;
}

export const DEFAULT_POST_AI: PostAiSettings = {
  defaultModel: 'grok-4.5',
  maxTokens: 200,
  temperature: 0.8,
  systemPrompt:
    'You write short posts for X/Twitter. Reply with only the post text, no quotes or preamble. Stay under 240 characters so a short timestamp suffix can be added.',
};

export const DEFAULT_POST: PostConfig = {
  version: 2,
  tasks: [],
  ai: { ...DEFAULT_POST_AI },
  templates: [
    '互相关注了！感谢关注 🙏',
    'Thanks for the mutual follow! 🤝',
  ],
  autoPostEnabled: false,
  autoPostIntervalMinutes: 60,
  autoPostTemplateIndex: 0,
  lastPostAt: null,
  postAutoIndex: 0,
};

export interface AutomationConfig {
  batchSizeMin: number;
  batchSizeMax: number;
  batchIntervalMinMinutes: number;
  batchIntervalMaxMinutes: number;
  actionIntervalMinSeconds: number;
  actionIntervalMaxSeconds: number;
  dailyLimit: number;
  /** 活跃时段开始小时（0-23），按时区 timezone 计算 */
  activeHoursStart: number;
  /** 活跃时段结束小时（1-24，不含），按时区 timezone 计算 */
  activeHoursEnd: number;
  /** 活跃时段使用的时区，默认 Asia/Shanghai（容器多为 UTC） */
  timezone: string;
  /** 是否开启自动扫描+回关（服务端定时，关 UI 也继续） */
  followBackAutoEnabled: boolean;
  /** 自动扫描周期（分钟），最低 10 */
  followBackAutoIntervalMinutes: number;
  /** 上一轮自动扫描回关完成时间 ISO */
  lastFollowBackAutoAt: string | null;
  authToken: string;
  ct0: string;
}

export const DEFAULT_AUTOMATION: AutomationConfig = {
  batchSizeMin: 10,
  batchSizeMax: 18,
  batchIntervalMinMinutes: 5,
  batchIntervalMaxMinutes: 15,
  actionIntervalMinSeconds: 8,
  actionIntervalMaxSeconds: 25,
  dailyLimit: 400,
  activeHoursStart: 9,
  activeHoursEnd: 23,
  timezone: 'Asia/Shanghai',
  followBackAutoEnabled: false,
  followBackAutoIntervalMinutes: 30,
  lastFollowBackAutoAt: null,
  authToken: '',
  ct0: '',
};

/** 自动扫描回关最短周期（分钟） */
export const MIN_FOLLOW_BACK_AUTO_INTERVAL = 10;

export function loadAutomationConfig(): AutomationConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (raw.automation) {
        return { ...DEFAULT_AUTOMATION, ...raw.automation };
      }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_AUTOMATION };
}

export function saveAutomationConfig(config: AutomationConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  let existing: Record<string, any> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }

  existing.automation = config;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
}

/** 应用默认时区：活跃时段、日志、UI 展示统一用北京时间 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 将时间格式化为指定时区的本地字符串（默认北京时间） */
export function formatInTimezone(
  date: Date | string | number = new Date(),
  timezone: string = DEFAULT_TIMEZONE,
  opts?: { withSeconds?: boolean; compact?: boolean },
): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return String(date);
  const withSeconds = opts?.withSeconds !== false;
  if (opts?.compact) {
    return d.toLocaleString('zh-CN', {
      timeZone: timezone,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return d.toLocaleString('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false,
  });
}

/** 按配置时区获取当前小时（0-23） */
export function getLocalHour(config: AutomationConfig): number {
  const tz = config.timezone || DEFAULT_TIMEZONE;
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    }).format(new Date());
    let hour = parseInt(hourStr, 10);
    // 部分环境午夜会返回 24
    if (hour === 24) hour = 0;
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) return hour;
  } catch { /* fall through */ }
  // 回退也尽量用北京时间，避免容器 UTC 把活跃时段判错
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TIMEZONE,
      hour: 'numeric',
      hour12: false,
    }).format(new Date());
    let hour = parseInt(hourStr, 10);
    if (hour === 24) hour = 0;
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) return hour;
  } catch { /* ignore */ }
  return new Date().getHours();
}

/** 检查当前时间是否在活跃时段内（使用 config.timezone，默认 Asia/Shanghai） */
export function isActiveHours(config: AutomationConfig): boolean {
  const hour = getLocalHour(config);
  if (config.activeHoursStart <= config.activeHoursEnd) {
    return hour >= config.activeHoursStart && hour < config.activeHoursEnd;
  }
  // 跨午夜的情况，如 22:00 - 06:00
  return hour >= config.activeHoursStart || hour < config.activeHoursEnd;
}

/** 泊松间隔：用指数分布生成批次间等待时间（毫秒） */
export function poissonInterval(lambdaMinutes: number): number {
  return -Math.log(1 - Math.random()) * lambdaMinutes * 60_000;
}

/** 在 [min, max] 范围内取随机整数 */
export function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** 在 [min, max] 范围内取随机浮点数 */
export function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** 计算批次间的等待时间（毫秒） */
export function batchInterval(config: AutomationConfig): number {
  const lambda = randomBetween(config.batchIntervalMinMinutes, config.batchIntervalMaxMinutes);
  return poissonInterval(lambda);
}

/** 计算批次内单个操作间的等待时间（毫秒） */
export function actionInterval(config: AutomationConfig): number {
  return randomBetween(config.actionIntervalMinSeconds, config.actionIntervalMaxSeconds) * 1000;
}

/** 计算本批次的操作数量 */
export function batchSize(config: AutomationConfig): number {
  return randomInt(config.batchSizeMin, config.batchSizeMax);
}

// ── 发帖配置（v2 multi-task + legacy dual-write）────────────────

export function isPostConfigV2(raw: unknown): raw is PostConfig {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as { version?: unknown }).version === 2 &&
    Array.isArray((raw as { tasks?: unknown }).tasks)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampInterval(minutes: number | undefined | null): number {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < MIN_POST_INTERVAL_MINUTES) return 60;
  return Math.floor(n);
}

export function getComposerTask(cfg: PostConfig): PostTaskConfig | undefined {
  return cfg.tasks.find((t) => t.id === COMPOSER_TASK_ID);
}

/** Mirror COMPOSER_TASK_ID into legacy top-level fields (never tasks[0] by index). */
export function mirrorComposerToLegacy(cfg: PostConfig): PostConfig {
  const composer = getComposerTask(cfg);
  const templates = Array.isArray(cfg.templates) ? [...cfg.templates] : [...DEFAULT_POST.templates];
  if (composer) {
    if (templates.length === 0) templates.push(composer.content || '');
    else templates[0] = composer.content || templates[0] || '';
    return {
      ...cfg,
      version: 2,
      templates,
      autoPostEnabled: !!composer.enabled,
      autoPostIntervalMinutes: clampInterval(composer.intervalMinutes),
      autoPostTemplateIndex: 0,
      lastPostAt: composer.lastPostAt ?? null,
      postAutoIndex: composer.postAutoIndex || 0,
      ai: { ...DEFAULT_POST_AI, ...(cfg.ai || {}) },
      tasks: cfg.tasks,
    };
  }
  return {
    ...cfg,
    version: 2,
    templates: templates.length ? templates : [...DEFAULT_POST.templates],
    autoPostEnabled: false,
    autoPostIntervalMinutes: clampInterval(cfg.autoPostIntervalMinutes),
    autoPostTemplateIndex: 0,
    lastPostAt: cfg.lastPostAt ?? null,
    postAutoIndex: cfg.postAutoIndex || 0,
    ai: { ...DEFAULT_POST_AI, ...(cfg.ai || {}) },
    tasks: Array.isArray(cfg.tasks) ? cfg.tasks : [],
  };
}

/**
 * Lift legacy top-level fields into COMPOSER_TASK_ID (only for deprecated savePostConfig path).
 * Does not remove other tasks.
 */
export function liftLegacyIntoComposer(cfg: PostConfig): PostConfig {
  const content =
    (cfg.templates && cfg.templates[cfg.autoPostTemplateIndex ?? 0]) ||
    (cfg.templates && cfg.templates[0]) ||
    '';
  const now = nowIso();
  const existing = getComposerTask(cfg);
  const composer: PostTaskConfig = {
    id: COMPOSER_TASK_ID,
    name: existing?.name || 'Default',
    enabled: !!cfg.autoPostEnabled && !!String(content).trim(),
    intervalMinutes: clampInterval(cfg.autoPostIntervalMinutes),
    contentMode: existing?.contentMode || 'static',
    content: String(content || ''),
    model: existing?.model ?? null,
    lastPostAt: cfg.lastPostAt ?? existing?.lastPostAt ?? null,
    postAutoIndex: cfg.postAutoIndex ?? existing?.postAutoIndex ?? 0,
    postCount: existing?.postCount ?? 0,
    lastResult: existing?.lastResult ?? null,
    lastError: existing?.lastError ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const others = (cfg.tasks || []).filter((t) => t.id !== COMPOSER_TASK_ID);
  return {
    ...cfg,
    version: 2,
    tasks: [composer, ...others].slice(0, MAX_POST_TASKS),
  };
}

/** Ensure composer task exists (e.g. first Post Now). */
export function ensureComposerTask(
  cfg: PostConfig,
  opts?: { content?: string; enabled?: boolean; intervalMinutes?: number },
): PostConfig {
  const existing = getComposerTask(cfg);
  const now = nowIso();
  const content =
    opts?.content !== undefined
      ? opts.content
      : existing?.content ||
        (cfg.templates && cfg.templates[0]) ||
        '';
  const enabled =
    opts?.enabled !== undefined
      ? opts.enabled
      : existing
        ? existing.enabled
        : false;
  const intervalMinutes = clampInterval(
    opts?.intervalMinutes ?? existing?.intervalMinutes ?? cfg.autoPostIntervalMinutes,
  );

  const composer: PostTaskConfig = {
    id: COMPOSER_TASK_ID,
    name: existing?.name || 'Default',
    enabled: !!enabled && !!String(content).trim(),
    intervalMinutes,
    contentMode: existing?.contentMode || 'static',
    content: String(content || ''),
    model: existing?.model ?? null,
    lastPostAt: existing?.lastPostAt ?? cfg.lastPostAt ?? null,
    postAutoIndex: existing?.postAutoIndex ?? cfg.postAutoIndex ?? 0,
    postCount: existing?.postCount ?? 0,
    lastResult: existing?.lastResult ?? null,
    lastError: existing?.lastError ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const others = (cfg.tasks || []).filter((t) => t.id !== COMPOSER_TASK_ID);
  const next: PostConfig = {
    ...cfg,
    version: 2,
    ai: { ...DEFAULT_POST_AI, ...(cfg.ai || {}) },
    tasks: [composer, ...others].slice(0, MAX_POST_TASKS),
  };
  return mirrorComposerToLegacy(next);
}

export function migratePostConfigV1ToV2(raw: Record<string, any>): PostConfig {
  const templates = Array.isArray(raw.templates)
    ? [...raw.templates]
    : [...DEFAULT_POST.templates];
  const idx = Number(raw.autoPostTemplateIndex) || 0;
  const content = String(templates[idx] || templates[0] || '');
  const now = nowIso();
  const enabled = !!raw.autoPostEnabled && !!content.trim();
  if (raw.autoPostEnabled && !content.trim()) {
    console.warn('[PostConfig] 迁移: autoPostEnabled 为 true 但模板为空，已强制 enabled=false');
  }
  const composer: PostTaskConfig = {
    id: COMPOSER_TASK_ID,
    name: 'Default',
    enabled,
    intervalMinutes: clampInterval(raw.autoPostIntervalMinutes),
    contentMode: 'static',
    content,
    model: null,
    lastPostAt: raw.lastPostAt ?? null,
    postAutoIndex: Number(raw.postAutoIndex) || 0,
    postCount: 0,
    lastResult: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  const cfg: PostConfig = {
    version: 2,
    tasks: [composer],
    ai: { ...DEFAULT_POST_AI },
    templates: templates.length ? templates : [...DEFAULT_POST.templates],
    autoPostEnabled: false,
    autoPostIntervalMinutes: 60,
    autoPostTemplateIndex: 0,
    lastPostAt: null,
    postAutoIndex: 0,
  };
  return mirrorComposerToLegacy(cfg);
}

function normalizePostConfigV2(raw: Record<string, any>): PostConfig {
  const tasksIn = Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks: PostTaskConfig[] = tasksIn
    .filter((t) => t && t.id)
    .slice(0, MAX_POST_TASKS)
    .map((t) => ({
      id: String(t.id),
      name: String(t.name || t.id),
      enabled: !!t.enabled,
      intervalMinutes: clampInterval(t.intervalMinutes),
      contentMode: t.contentMode === 'ai' ? 'ai' : 'static',
      content: String(t.content || ''),
      model: t.model ?? null,
      lastPostAt: t.lastPostAt ?? null,
      postAutoIndex: Number(t.postAutoIndex) || 0,
      postCount: Number(t.postCount) || 0,
      lastResult: t.lastResult ?? null,
      lastError: t.lastError ?? null,
      createdAt: t.createdAt || nowIso(),
      updatedAt: t.updatedAt || nowIso(),
    }));
  // Ensure at most one composer id
  const seen = new Set<string>();
  const deduped: PostTaskConfig[] = [];
  for (const t of tasks) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    deduped.push(t);
  }
  // Keep legacy fields as-is (do not mirror here). Callers choose:
  // - load/update: mirrorComposerToLegacy after mutator
  // - savePostConfig: liftLegacyIntoComposer then mirror
  return {
    version: 2,
    tasks: deduped,
    ai: { ...DEFAULT_POST_AI, ...(raw.ai || {}) },
    templates: Array.isArray(raw.templates) ? raw.templates : [...DEFAULT_POST.templates],
    autoPostEnabled: !!raw.autoPostEnabled,
    autoPostIntervalMinutes: clampInterval(raw.autoPostIntervalMinutes),
    autoPostTemplateIndex: Number(raw.autoPostTemplateIndex) || 0,
    lastPostAt: raw.lastPostAt ?? null,
    postAutoIndex: Number(raw.postAutoIndex) || 0,
  };
}

function readConfigRoot(): Record<string, any> {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

/** Full-root atomic save: set root.post only; never wipe automation. */
export function atomicSavePostConfig(cfg: PostConfig, opts?: { writeBak?: boolean }): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const root = readConfigRoot();
  if (opts?.writeBak && fs.existsSync(CONFIG_FILE) && !fs.existsSync(CONFIG_FILE + '.bak')) {
    try {
      fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak');
    } catch (err) {
      console.warn('[PostConfig] 写 .bak 失败:', (err as Error).message);
    }
  }
  root.post = cfg;
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(root, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

export function loadPostConfig(): PostConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (raw.post) {
        if (isPostConfigV2(raw.post)) {
          return mirrorComposerToLegacy(normalizePostConfigV2(raw.post));
        }
        // v1 → v2 migrate + eager rewrite
        const migrated = migratePostConfigV1ToV2(raw.post);
        try {
          atomicSavePostConfig(migrated, { writeBak: true });
          console.log('[PostConfig] 已从 v1 迁移为 v2（composer task + dual-write）');
        } catch (err) {
          console.warn('[PostConfig] 迁移后写盘失败（仍返回内存 v2）:', (err as Error).message);
        }
        return migrated;
      }
    }
  } catch (err) {
    console.warn('[PostConfig] load 失败:', (err as Error).message);
  }
  return { ...DEFAULT_POST, ai: { ...DEFAULT_POST_AI }, tasks: [], templates: [...DEFAULT_POST.templates] };
}

/**
 * Deprecated legacy path: lift legacy fields into composer, then mirror + save.
 * Prefer updatePostConfig for all live code paths.
 */
export function savePostConfig(config: PostConfig | Record<string, any>): void {
  let cfg: PostConfig;
  if (isPostConfigV2(config)) {
    // Treat as possibly legacy-touched: lift then mirror
    cfg = mirrorComposerToLegacy(liftLegacyIntoComposer(normalizePostConfigV2(config)));
  } else {
    cfg = migratePostConfigV1ToV2(config as Record<string, any>);
  }
  atomicSavePostConfig(cfg);
}

/** Serialize concurrent config RMW */
let postConfigLock: Promise<void> = Promise.resolve();

/**
 * Live path (composer-first): load → mutator (edit tasks by id) → mirror only → atomic save.
 * **No lift** — avoids stale legacy overwriting composer fields.
 */
export async function updatePostConfig(
  mutator: (cfg: PostConfig) => PostConfig | void,
): Promise<PostConfig> {
  let release!: () => void;
  const prev = postConfigLock;
  postConfigLock = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    const loaded = loadPostConfig();
    const draft: PostConfig = {
      ...loaded,
      tasks: loaded.tasks.map((t) => ({ ...t })),
      templates: [...(loaded.templates || [])],
      ai: { ...DEFAULT_POST_AI, ...(loaded.ai || {}) },
    };
    const maybe = mutator(draft);
    const next = maybe || draft;
    if ((next.tasks || []).length > MAX_POST_TASKS) {
      throw new Error(`最多 ${MAX_POST_TASKS} 个发帖任务`);
    }
    const finalCfg = mirrorComposerToLegacy({
      ...next,
      version: 2,
      ai: { ...DEFAULT_POST_AI, ...(next.ai || {}) },
      tasks: (next.tasks || []).slice(0, MAX_POST_TASKS),
    });
    atomicSavePostConfig(finalCfg);
    return finalCfg;
  } finally {
    release();
  }
}

/** Build anti-dupe suffix; length is locale-dependent — always measure at runtime. */
export function antiDupeSuffix(date: Date = new Date(), timezone: string = DEFAULT_TIMEZONE): string {
  const ts = formatInTimezone(date, timezone, { compact: true });
  return `\n\n${ts} ⏳`;
}

/** Clamp body so body + suffix ≤ 280 graphemes (Array.from). */
export function clampTweetBody(body: string, suffix: string, max: number = TWEET_MAX_CHARS): string {
  const suffixChars = Array.from(suffix);
  const maxBody = Math.max(0, max - suffixChars.length);
  const bodyChars = Array.from(body || '');
  if (bodyChars.length <= maxBody) return bodyChars.join('');
  return bodyChars.slice(0, maxBody).join('');
}
