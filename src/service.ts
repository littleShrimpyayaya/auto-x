import { XClient } from './x-client.js';
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
