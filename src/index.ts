import { loadConfig } from './config.js';
import { createPool, initSchema } from './db.js';
import { XClient } from './x-client.js';
import { UserRepository } from './user-repository.js';
import { Service } from './service.js';
import { TaskManager } from './task-manager.js';
import { createServer } from './server.js';

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  const config = loadConfig();

  const pool = createPool(config.db);
  await initSchema(pool);

  const xClient = new XClient({
    bearerToken: config.x.bearerToken,
    accessToken: config.x.accessToken,
  });

  const repo = new UserRepository(pool);
  const service = new Service(xClient, repo);
  const taskManager = new TaskManager(service, repo);

  try {
    const me = await xClient.getMyUser();
    taskManager.setMe(me);
    console.log(`Logged in as: @${me.username} (${me.id})`);
  } catch (err) {
    console.warn('X API login failed. Set X_BEARER_TOKEN or X_ACCESS_TOKEN in .env');
    console.warn('The app will start but API calls will fail until authenticated.');
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
