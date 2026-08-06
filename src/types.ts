export interface XUser {
  id: string;
  name: string;
  username: string;
  description?: string;
  createdAt?: string;
  profileImageUrl?: string;
  verified?: boolean;
  publicMetrics?: {
    followersCount: number;
    followingCount: number;
    postCount: number;
    listedCount: number;
  };
}

export interface DBUser {
  id: string;
  username: string;
  name: string;
  description: string | null;
  followers_count: number;
  following_count: number;
  tweet_count: number;
  created_at: Date | null;
  updated_at: Date;
}

export interface SyncState {
  userId: string;
  followersCursor: string | null;
  followingCursor: string | null;
  lastSyncedAt: Date;
}

export interface PaginatedUsers {
  users: XUser[];
  nextToken?: string;
}

export interface FollowResult {
  following: boolean;
  pending: boolean;
}

export interface UnfollowResult {
  following: boolean;
}

export interface SyncResult {
  total: number;
  newCount: number;
}

export interface AutoFollowResult {
  followed: string[];
  alreadyFollowing: number;
}
