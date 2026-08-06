import { Client, type ClientConfig } from '@xdevplatform/xdk';
import type { XUser, PaginatedUsers, FollowResult, UnfollowResult } from './types.js';

const DEFAULT_USER_FIELDS = [
  'id', 'name', 'username', 'description', 'created_at',
  'public_metrics', 'profile_image_url', 'verified', 'connection_status',
] as const;

export class XClient {
  private client: Client;

  constructor(config: ClientConfig) {
    this.client = new Client(config);
  }

  async getMyUser(): Promise<XUser> {
    const res = await this.client.users.getMe({
      userFields: [...DEFAULT_USER_FIELDS],
    });
    if (!res.data?.id) throw new Error('Failed to get my user: no data returned');
    return mapUser(res.data);
  }

  async getUserById(id: string): Promise<XUser> {
    const res = await this.client.users.getById(id, {
      userFields: [...DEFAULT_USER_FIELDS],
    });
    if (!res.data?.id) throw new Error(`User not found: ${id}`);
    return mapUser(res.data);
  }

  async getUsersByIds(ids: string[]): Promise<XUser[]> {
    if (ids.length === 0) return [];
    const res = await this.client.users.getByIds(ids, {
      userFields: [...DEFAULT_USER_FIELDS],
    });
    return (res.data ?? []).map(mapUser);
  }

  async getUserByUsername(username: string): Promise<XUser> {
    const res = await this.client.users.getByUsername(username, {
      userFields: [...DEFAULT_USER_FIELDS],
    });
    if (!res.data?.id) throw new Error(`User not found: @${username}`);
    return mapUser(res.data);
  }

  async getUsersByUsernames(usernames: string[]): Promise<XUser[]> {
    if (usernames.length === 0) return [];
    const res = await this.client.users.getByUsernames(usernames, {
      userFields: [...DEFAULT_USER_FIELDS],
    });
    return (res.data ?? []).map(mapUser);
  }

  async getFollowers(userId: string, opts?: { maxResults?: number; paginationToken?: string }): Promise<PaginatedUsers> {
    const res = await this.client.users.getFollowers(userId, {
      maxResults: opts?.maxResults ?? 100,
      paginationToken: opts?.paginationToken,
      userFields: [...DEFAULT_USER_FIELDS],
    });
    return {
      users: (res.data ?? []).map(mapUser),
      nextToken: res.meta?.nextToken,
    };
  }

  async getFollowing(userId: string, opts?: { maxResults?: number; paginationToken?: string }): Promise<PaginatedUsers> {
    const res = await this.client.users.getFollowing(userId, {
      maxResults: opts?.maxResults ?? 100,
      paginationToken: opts?.paginationToken,
      userFields: [...DEFAULT_USER_FIELDS],
    });
    return {
      users: (res.data ?? []).map(mapUser),
      nextToken: res.meta?.nextToken,
    };
  }

  async follow(myUserId: string, targetUserId: string): Promise<FollowResult> {
    const res = await this.client.users.followUser(myUserId, { targetUserId });
    if (!res.data) throw new Error(`Follow failed: ${targetUserId}`);
    return { following: res.data.following, pending: res.data.pendingFollow };
  }

  async unfollow(myUserId: string, targetUserId: string): Promise<UnfollowResult> {
    const res = await this.client.users.unfollowUser(myUserId, targetUserId);
    if (!res.data) throw new Error(`Unfollow failed: ${targetUserId}`);
    return { following: res.data.following };
  }

  async *iterateFollowers(userId: string): AsyncGenerator<XUser> {
    let token: string | undefined;
    do {
      const page = await this.getFollowers(userId, { paginationToken: token });
      for (const user of page.users) yield user;
      token = page.nextToken;
    } while (token);
  }

  async *iterateFollowing(userId: string): AsyncGenerator<XUser> {
    let token: string | undefined;
    do {
      const page = await this.getFollowing(userId, { paginationToken: token });
      for (const user of page.users) yield user;
      token = page.nextToken;
    } while (token);
  }
}

function mapUser(u: Record<string, any>): XUser {
  return {
    id: u.id,
    name: u.name ?? '',
    username: u.username ?? '',
    description: u.description,
    createdAt: u.created_at ?? u.createdAt,
    profileImageUrl: u.profile_image_url ?? u.profileImageUrl,
    verified: u.verified,
    connectionStatus: u.connection_status ?? u.connectionStatus,
    publicMetrics: u.public_metrics ?? u.publicMetrics
      ? {
          followersCount: (u.public_metrics ?? u.publicMetrics)?.followers_count ?? (u.public_metrics ?? u.publicMetrics)?.followersCount ?? 0,
          followingCount: (u.public_metrics ?? u.publicMetrics)?.following_count ?? (u.public_metrics ?? u.publicMetrics)?.followingCount ?? 0,
          postCount: (u.public_metrics ?? u.publicMetrics)?.post_count ?? (u.public_metrics ?? u.publicMetrics)?.postCount ?? 0,
          listedCount: (u.public_metrics ?? u.publicMetrics)?.listed_count ?? (u.public_metrics ?? u.publicMetrics)?.listedCount ?? 0,
        }
      : undefined,
  };
}
