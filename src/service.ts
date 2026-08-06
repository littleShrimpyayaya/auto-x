import { XClient } from './x-client.js';
import { BrowserClient } from './browser-client.js';
import { UserRepository } from './user-repository.js';
import type { XUser, SyncResult, AutoFollowResult, ProcessResult } from './types.js';

export class Service {
  constructor(
    private xClient: XClient,
    private repo: UserRepository,
  ) {}

  async syncFollowers(userId: string, signal?: AbortSignal): Promise<SyncResult> {
    let total = 0;
    let newCount = 0;
    const existingIds = new Set(await this.repo.getRelationshipIds(userId, 'follower'));

    const users: XUser[] = [];
    const needFollowBack: string[] = [];

    for await (const user of this.xClient.iterateFollowers(userId)) {
      if (signal?.aborted) throw new DOMException('Task cancelled', 'AbortError');

      users.push(user);
      total++;
      if (!existingIds.has(user.id)) newCount++;

      const isFollowing = user.connectionStatus?.includes('following');
      if (!isFollowing) {
        needFollowBack.push(user.id);
      }

      if (users.length >= 100) {
        await this.repo.upsertUsers(users);
        await this.repo.upsertRelationships(userId, users, 'follower');
        users.length = 0;
      }
    }

    if (users.length > 0) {
      await this.repo.upsertUsers(users);
      await this.repo.upsertRelationships(userId, users, 'follower');
    }

    await this.repo.clearSyncCursor(userId, 'followers');
    await this.computePendingFollow(needFollowBack);
    return { total, newCount };
  }

  async syncFollowing(userId: string, signal?: AbortSignal): Promise<SyncResult> {
    let total = 0;
    let newCount = 0;
    const existingIds = new Set(await this.repo.getRelationshipIds(userId, 'following'));

    const users: XUser[] = [];
    const needUnfollow: string[] = [];

    for await (const user of this.xClient.iterateFollowing(userId)) {
      if (signal?.aborted) throw new DOMException('Task cancelled', 'AbortError');

      users.push(user);
      total++;
      if (!existingIds.has(user.id)) newCount++;

      const isFollowedBy = user.connectionStatus?.includes('followed_by');
      if (!isFollowedBy) {
        needUnfollow.push(user.id);
      }

      if (users.length >= 100) {
        await this.repo.upsertUsers(users);
        await this.repo.upsertRelationships(userId, users, 'following');
        users.length = 0;
      }
    }

    if (users.length > 0) {
      await this.repo.upsertUsers(users);
      await this.repo.upsertRelationships(userId, users, 'following');
    }

    await this.repo.clearSyncCursor(userId, 'following');
    await this.computePendingUnfollow(needUnfollow);
    return { total, newCount };
  }

  async autoFollowBack(userId: string, signal?: AbortSignal): Promise<AutoFollowResult> {
    const followerIds = await this.repo.getRelationshipIds(userId, 'follower');
    const followingIds = new Set(await this.repo.getRelationshipIds(userId, 'following'));

    const followed: string[] = [];
    let alreadyFollowing = 0;

    for (const followerId of followerIds) {
      if (signal?.aborted) throw new DOMException('Task cancelled', 'AbortError');

      if (followingIds.has(followerId)) {
        alreadyFollowing++;
        continue;
      }

      try {
        await this.xClient.follow(userId, followerId);
        followed.push(followerId);
        await this.repo.upsertRelationships(userId, [{ id: followerId, name: '', username: '' }], 'following');
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        console.error(`Failed to follow user ${followerId}:`, err);
      }
    }

    return { followed, alreadyFollowing };
  }

  async computePendingFollow(followerIds: string[]): Promise<void> {
    await this.repo.upsertPendingFollow(followerIds);
  }

  async computePendingUnfollow(followingIds: string[]): Promise<void> {
    await this.repo.upsertPendingUnfollow(followingIds);
  }

  async processOnePendingFollow(userId: string): Promise<ProcessResult> {
    const item = await this.repo.getNextPendingFollow();
    if (!item) return { processed: false };

    try {
      await this.xClient.follow(userId, item.userId);
      await this.repo.markPendingFollowStatus(item.userId, 'completed');
      await this.repo.upsertRelationships(userId, [{ id: item.userId, name: item.name, username: item.username }], 'following');
      return { processed: true, userId: item.userId, status: 'completed' };
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      await this.repo.markPendingFollowStatus(item.userId, 'failed', err.message);
      return { processed: true, userId: item.userId, status: 'failed' };
    }
  }

  async computeFollowBackWithDetails(userId: string): Promise<Array<{ userId: string; username: string; name: string }>> {
    // 直接用浏览器扫描 followers 页面中有 "Follow" 按钮的用户
    if (this.xClient instanceof BrowserClient) {
      const result = await (this.xClient as BrowserClient).scanFollowBack();

      // 同步到 pending_follow 表
      const ids = result.map(u => u.userId).filter(id => id !== '0');
      if (ids.length > 0) {
        await this.repo.upsertPendingFollow(ids);
      }

      return result;
    }

    // API 模式 fallback
    await this.syncFollowers(userId);
    await this.syncFollowing(userId);
    const followerIds = await this.repo.getRelationshipIds(userId, 'follower');
    const followingIds = new Set(await this.repo.getRelationshipIds(userId, 'following'));
    const needFollow: string[] = [];
    for (const fid of followerIds) {
      if (!followingIds.has(fid)) needFollow.push(fid);
    }
    await this.repo.upsertPendingFollow(needFollow);
    const result: Array<{ userId: string; username: string; name: string }> = [];
    for (const id of needFollow) {
      const u = await this.repo.getUser(id);
      result.push({ userId: id, username: u?.username || id, name: u?.name || '' });
    }
    return result;
  }

  async computeUnfollowWithDetails(userId: string): Promise<Array<{ userId: string; username: string; name: string }>> {
    const followingIds = await this.repo.getRelationshipIds(userId, 'following');
    const followerIds = new Set(await this.repo.getRelationshipIds(userId, 'follower'));

    const needUnfollow: string[] = [];
    for (const fid of followingIds) {
      if (!followerIds.has(fid)) needUnfollow.push(fid);
    }

    await this.repo.upsertPendingUnfollow(needUnfollow);

    const result: Array<{ userId: string; username: string; name: string }> = [];
    for (const id of needUnfollow) {
      const u = await this.repo.getUser(id);
      result.push({ userId: id, username: u?.username || id, name: u?.name || '' });
    }
    return result;
  }

  async batchFollow(userId: string, targetUserIds: string[]): Promise<{ done: number; failed: number }> {
    let done = 0;
    let failed = 0;
    for (const tid of targetUserIds) {
      try {
        await this.xClient.follow(userId, tid);
        await this.repo.markPendingFollowStatus(tid, 'completed');
        await this.repo.upsertRelationships(userId, [{ id: tid, name: '', username: '' }], 'following');
        done++;
      } catch {
        failed++;
        await this.repo.markPendingFollowStatus(tid, 'failed', 'Batch follow failed');
      }
    }
    return { done, failed };
  }

  async batchUnfollow(userId: string, targetUserIds: string[]): Promise<{ done: number; failed: number }> {
    let done = 0;
    let failed = 0;
    for (const tid of targetUserIds) {
      try {
        await this.xClient.unfollow(userId, tid);
        await this.repo.markPendingUnfollowStatus(tid, 'completed');
        done++;
      } catch {
        failed++;
        await this.repo.markPendingUnfollowStatus(tid, 'failed', 'Batch unfollow failed');
      }
    }
    return { done, failed };
  }

  async processOnePendingUnfollow(userId: string): Promise<ProcessResult> {
    const item = await this.repo.getNextPendingUnfollow();
    if (!item) return { processed: false };

    try {
      await this.xClient.unfollow(userId, item.userId);
      await this.repo.markPendingUnfollowStatus(item.userId, 'completed');
      await this.repo.removePendingFollowByUserIds([item.userId]);
      return { processed: true, userId: item.userId, status: 'completed' };
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      await this.repo.markPendingUnfollowStatus(item.userId, 'failed', err.message);
      return { processed: true, userId: item.userId, status: 'failed' };
    }
  }
}
