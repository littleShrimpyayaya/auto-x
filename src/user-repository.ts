import type pg from 'pg';
import type { XUser, DBUser, SyncState, PendingItem, PendingStats } from './types.js';

export class UserRepository {
  constructor(private pool: pg.Pool) {}

  async upsertUser(user: XUser): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, username, name, description, followers_count, following_count, tweet_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         followers_count = EXCLUDED.followers_count,
         following_count = EXCLUDED.following_count,
         tweet_count = EXCLUDED.tweet_count,
         updated_at = NOW()`,
      [
        user.id,
        user.username,
        user.name,
        user.description ?? null,
        user.publicMetrics?.followersCount ?? 0,
        user.publicMetrics?.followingCount ?? 0,
        user.publicMetrics?.postCount ?? 0,
        user.createdAt ?? null,
      ],
    );
  }

  async upsertUsers(users: XUser[]): Promise<void> {
    for (const user of users) {
      await this.upsertUser(user);
    }
  }

  async getUser(id: string): Promise<DBUser | null> {
    const res = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0] ?? null;
  }

  async upsertRelationships(ownerId: string, users: XUser[], type: 'follower' | 'following'): Promise<void> {
    if (users.length === 0) return;

    const values: any[] = [];
    const placeholders: string[] = [];
    let i = 1;
    for (const user of users) {
      placeholders.push(`($${i++}, $${i++}, $${i++}, NOW())`);
      values.push(ownerId, user.id, type);
    }

    await this.pool.query(
      `INSERT INTO relationships (source_user_id, target_user_id, type, synced_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (source_user_id, target_user_id, type) DO UPDATE SET synced_at = NOW()`,
      values,
    );
  }

  async getRelationshipIds(ownerId: string, type: 'follower' | 'following'): Promise<string[]> {
    const res = await this.pool.query(
      'SELECT target_user_id FROM relationships WHERE source_user_id = $1 AND type = $2',
      [ownerId, type],
    );
    return res.rows.map((r: any) => String(r.target_user_id));
  }

  async getSyncState(userId: string): Promise<SyncState | null> {
    const res = await this.pool.query('SELECT * FROM sync_state WHERE user_id = $1', [userId]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      userId: String(row.user_id),
      followersCursor: row.followers_cursor,
      followingCursor: row.following_cursor,
      lastSyncedAt: row.last_synced_at,
    };
  }

  async updateSyncCursor(userId: string, type: 'followers' | 'following', cursor: string): Promise<void> {
    const column = type === 'followers' ? 'followers_cursor' : 'following_cursor';
    await this.pool.query(
      `INSERT INTO sync_state (user_id, ${column}, last_synced_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET ${column} = EXCLUDED.${column}, last_synced_at = NOW()`,
      [userId, cursor],
    );
  }

  async clearSyncCursor(userId: string, type: 'followers' | 'following'): Promise<void> {
    const column = type === 'followers' ? 'followers_cursor' : 'following_cursor';
    await this.pool.query(
      `UPDATE sync_state SET ${column} = NULL, last_synced_at = NOW() WHERE user_id = $1`,
      [userId],
    );
  }

  async upsertPendingFollow(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const res = await this.pool.query(
      `SELECT u.id, u.username, u.name FROM users u WHERE u.id = ANY($1)`,
      [userIds],
    );
    const userMap = new Map(res.rows.map((r: any) => [String(r.id), { username: r.username, name: r.name }]));

    for (const userId of userIds) {
      const info = userMap.get(userId) ?? { username: '', name: '' };
      await this.pool.query(
        `INSERT INTO pending_follow (user_id, username, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, info.username, info.name],
      );
    }
  }

  async upsertPendingUnfollow(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const res = await this.pool.query(
      `SELECT u.id, u.username, u.name FROM users u WHERE u.id = ANY($1)`,
      [userIds],
    );
    const userMap = new Map(res.rows.map((r: any) => [String(r.id), { username: r.username, name: r.name }]));

    for (const userId of userIds) {
      const info = userMap.get(userId) ?? { username: '', name: '' };
      await this.pool.query(
        `INSERT INTO pending_unfollow (user_id, username, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, info.username, info.name],
      );
    }
  }

  async getNextPendingFollow(): Promise<PendingItem | null> {
    const res = await this.pool.query(
      `SELECT * FROM pending_follow WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    );
    if (res.rows.length === 0) return null;
    return mapPendingRow(res.rows[0]);
  }

  async getNextPendingUnfollow(): Promise<PendingItem | null> {
    const res = await this.pool.query(
      `SELECT * FROM pending_unfollow WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    );
    if (res.rows.length === 0) return null;
    return mapPendingRow(res.rows[0]);
  }

  async markPendingFollowStatus(userId: string, status: string, errorMessage?: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_follow SET status = $2, error_message = $3, completed_at = NOW() WHERE user_id = $1`,
      [userId, status, errorMessage ?? null],
    );
  }

  async markPendingUnfollowStatus(userId: string, status: string, errorMessage?: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_unfollow SET status = $2, error_message = $3, completed_at = NOW() WHERE user_id = $1`,
      [userId, status, errorMessage ?? null],
    );
  }

  async getPendingStats(): Promise<PendingStats> {
    const [followRes, unfollowRes] = await Promise.all([
      this.pool.query(`SELECT status, COUNT(*)::int AS count FROM pending_follow GROUP BY status`),
      this.pool.query(`SELECT status, COUNT(*)::int AS count FROM pending_unfollow GROUP BY status`),
    ]);

    const countByStatus = (rows: any[], status: string) =>
      rows.find((r: any) => r.status === status)?.count ?? 0;

    return {
      followPending: countByStatus(followRes.rows, 'pending'),
      followCompleted: countByStatus(followRes.rows, 'completed'),
      followFailed: countByStatus(followRes.rows, 'failed'),
      unfollowPending: countByStatus(unfollowRes.rows, 'pending'),
      unfollowCompleted: countByStatus(unfollowRes.rows, 'completed'),
      unfollowFailed: countByStatus(unfollowRes.rows, 'failed'),
    };
  }

  async removePendingFollowByUserIds(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.pool.query(`DELETE FROM pending_follow WHERE user_id = ANY($1)`, [userIds]);
  }

  async removePendingUnfollowByUserIds(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.pool.query(`DELETE FROM pending_unfollow WHERE user_id = ANY($1)`, [userIds]);
  }
}

function mapPendingRow(row: any): PendingItem {
  return {
    userId: String(row.user_id),
    username: row.username ?? '',
    name: row.name ?? '',
    status: row.status,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
  };
}
