import { loadConfig, getMode } from './config.js';
import { loadAutomationConfig } from './auto-config.js';
import { createPool, initSchema } from './db.js';
import { XClient } from './x-client.js';
import { BrowserClient } from './browser-client.js';
import { UserRepository } from './user-repository.js';
import { Service } from './service.js';
import { TaskManager } from './task-manager.js';
import { createServer } from './server.js';

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  const config = loadConfig();
  const mode = getMode();

  const pool = createPool(config.db);
  await initSchema(pool);

  const repo = new UserRepository(pool);

  const isBrowser = mode === 'browser';

  const client = isBrowser
    ? new BrowserClient(loadAutomationConfig())
    : new XClient({
        bearerToken: config.x.bearerToken,
        accessToken: config.x.accessToken,
      });

  if (isBrowser) {
    console.log('[启动] 使用浏览器自动化模式');
    const browserClient = client as BrowserClient;
    const autoConfig = loadAutomationConfig();

    if (!autoConfig.authToken) {
      console.warn('[启动] 未配置 auth_token，浏览器将无法登录。请在 Web UI 中配置。');
    } else {
      try {
        await browserClient.init();
      } catch (err) {
        console.warn('浏览器启动失败:', (err as Error).message);
      }
    }
  } else {
    console.log('[启动] 使用 X API 模式');
  }

  // 尝试登录并获取用户信息
  let me = null;
  try {
    me = await client.getMyUser();
    console.log(`Logged in as: @${me.username} (${me.id})`);
  } catch (err) {
    const label = isBrowser ? '浏览器登录' : 'X API login';
    console.warn(`${label} 失败:`, (err as Error).message);
    if (isBrowser) {
      console.warn('请通过 Web UI 更新 auth_token 后重启服务');
    } else {
      console.warn('请通过 Web UI 配置 API tokens');
    }
  }

  const service = new Service(client as any, repo);
  const taskManager = new TaskManager(client as any, service, repo);

  if (me) {
    taskManager.setMe(me);
  }

  // 若配置里已开启自动发推，重启后恢复定时（不立刻发）
  try {
    taskManager.restorePostScheduleFromConfig();
  } catch (err) {
    console.warn('[Post] 恢复自动发推失败:', (err as Error).message);
  }

  const app = createServer(taskManager);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
