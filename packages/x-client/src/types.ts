export type XUser = {
  id: string;
  username: string;
  name?: string;
  verified?: boolean;
  protected?: boolean;
  followers_count?: number;
  following_count?: number;
  tweet_count?: number;
};

export type Page<T> = {
  data: T[];
  nextToken?: string | null;
};

export type FollowResult = {
  pendingFollow: boolean;
  alreadyFollowing?: boolean;
};

export interface XClient {
  getMe(): Promise<XUser>;
  getFollowers(userId: string, token?: string | null, maxResults?: number): Promise<Page<XUser>>;
  getFollowing(userId: string, token?: string | null, maxResults?: number): Promise<Page<XUser>>;
  follow(sourceUserId: string, targetUserId: string): Promise<FollowResult>;
  unfollow(sourceUserId: string, targetUserId: string): Promise<void>;
}
