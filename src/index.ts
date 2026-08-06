import { loadConfig } from './config.js';
import { createPool, initSchema } from './db.js';
import { XClient } from './x-client.js';
import { UserRepository } from './user-repository.js';
import { Service } from './service.js';

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

  const me = await xClient.getMyUser();
  console.log(`Logged in as: @${me.username} (${me.id})`);

  const action = process.argv[2] ?? 'status';

  switch (action) {
    case 'sync-followers': {
      console.log('Syncing followers...');
      const result = await service.syncFollowers(me.id);
      console.log(`Done. Total: ${result.total}, New: ${result.newCount}`);
      break;
    }
    case 'sync-following': {
      console.log('Syncing following...');
      const result = await service.syncFollowing(me.id);
      console.log(`Done. Total: ${result.total}, New: ${result.newCount}`);
      break;
    }
    case 'auto-follow': {
      console.log('Auto follow-back...');
      const result = await service.autoFollowBack(me.id);
      console.log(`Done. Followed: ${result.followed.length}, Already following: ${result.alreadyFollowing}`);
      break;
    }
    case 'sync-all': {
      console.log('Syncing followers...');
      const fr = await service.syncFollowers(me.id);
      console.log(`Followers synced. Total: ${fr.total}, New: ${fr.newCount}`);

      console.log('Syncing following...');
      const fg = await service.syncFollowing(me.id);
      console.log(`Following synced. Total: ${fg.total}, New: ${fg.newCount}`);

      console.log('Auto follow-back...');
      const af = await service.autoFollowBack(me.id);
      console.log(`Follow-back done. Followed: ${af.followed.length}, Already following: ${af.alreadyFollowing}`);
      break;
    }
    case 'status':
    default: {
      const followerIds = await repo.getRelationshipIds(me.id, 'follower');
      const followingIds = await repo.getRelationshipIds(me.id, 'following');
      console.log(`Followers in DB: ${followerIds.length}`);
      console.log(`Following in DB: ${followingIds.length}`);
      console.log('\nAvailable commands: sync-followers, sync-following, auto-follow, sync-all');
      break;
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
