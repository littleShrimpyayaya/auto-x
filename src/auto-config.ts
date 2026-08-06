import fs from 'fs';
import path from 'path';

const CONFIG_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface PostConfig {
  templates: string[];
  autoPostEnabled: boolean;
  autoPostIntervalMinutes: number;
  autoPostTemplateIndex: number;
}

export const DEFAULT_POST: PostConfig = {
  templates: [
    '互相关注了！感谢关注 🙏',
    'Thanks for the mutual follow! 🤝',
  ],
  autoPostEnabled: false,
  autoPostIntervalMinutes: 60,
  autoPostTemplateIndex: 0,
};

export interface AutomationConfig {
  batchSizeMin: number;
  batchSizeMax: number;
  batchIntervalMinMinutes: number;
  batchIntervalMaxMinutes: number;
  actionIntervalMinSeconds: number;
  actionIntervalMaxSeconds: number;
  dailyLimit: number;
  activeHoursStart: number;
  activeHoursEnd: number;
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
  authToken: '',
  ct0: '',
};

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

/** 检查当前时间是否在活跃时段内 */
export function isActiveHours(config: AutomationConfig): boolean {
  const hour = new Date().getHours();
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
