import fs from 'fs';
import path from 'path';

const CONFIG_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface PostConfig {
  templates: string[];
  autoPostEnabled: boolean;
  autoPostIntervalMinutes: number;
  autoPostTemplateIndex: number;
  lastPostAt: string | null;
  postAutoIndex: number;
}

export const DEFAULT_POST: PostConfig = {
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

// ── 发帖配置 ──────────────────────────────────────────

export function loadPostConfig(): PostConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (raw.post) {
        return { ...DEFAULT_POST, ...raw.post };
      }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_POST };
}

export function savePostConfig(config: PostConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  let existing: Record<string, any> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }

  existing.post = config;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
}
