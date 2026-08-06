import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const CONFIG_FILE = path.join(process.cwd(), 'data', 'config.json');

export interface AppConfig {
  x: {
    bearerToken?: string;
    accessToken?: string;
  };
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
}

export function loadConfig(): AppConfig {
  const fileConfig = loadFileConfig();
  return {
    x: {
      bearerToken: fileConfig?.x?.bearerToken || process.env.X_BEARER_TOKEN,
      accessToken: fileConfig?.x?.accessToken || process.env.X_ACCESS_TOKEN,
    },
    db: {
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME ?? 'auto_x',
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? '',
    },
  };
}

interface FileConfig {
  x?: { bearerToken?: string; accessToken?: string };
  mode?: 'api' | 'browser';
  automation?: import('./auto-config.js').AutomationConfig;
}

function loadFileConfig(): FileConfig | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

export function saveXConfig(bearerToken?: string, accessToken?: string): void {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = loadFileConfig() ?? {};
  const config: FileConfig = {
    ...existing,
    x: {
      bearerToken: bearerToken ?? existing.x?.bearerToken,
      accessToken: accessToken ?? existing.x?.accessToken,
    },
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getXConfigStatus(): { hasBearerToken: boolean; hasAccessToken: boolean } {
  const config = loadConfig();
  return {
    hasBearerToken: !!config.x.bearerToken,
    hasAccessToken: !!config.x.accessToken,
  };
}

export function getMode(): 'api' | 'browser' {
  try {
    const raw = loadFileConfig();
    return raw?.mode ?? 'browser';
  } catch {
    return 'browser';
  }
}
