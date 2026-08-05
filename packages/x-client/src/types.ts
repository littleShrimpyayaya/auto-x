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

/** What this credential set can actually do (from live probe). */
export type XCapabilities = {
  mode: "live" | "mock";
  me: boolean;
  readFollowers: boolean;
  readFollowing: boolean;
  writeFollow: boolean;
  writeUnfollow: boolean;
  probedAt: string;
  errors: Partial<Record<keyof Omit<XCapabilities, "mode" | "probedAt" | "errors">, string>>;
  meUser?: XUser;
};

export interface XClient {
  readonly mode: "live" | "mock";
  getMe(): Promise<XUser>;
  getFollowers(userId: string, token?: string | null, maxResults?: number): Promise<Page<XUser>>;
  getFollowing(userId: string, token?: string | null, maxResults?: number): Promise<Page<XUser>>;
  follow(sourceUserId: string, targetUserId: string): Promise<FollowResult>;
  unfollow(sourceUserId: string, targetUserId: string): Promise<void>;
  /** Non-destructive capability probe (live hits real API; mock returns all true). */
  probeCapabilities(): Promise<XCapabilities>;
  /** Optional: rate-budget events for UI progress */
  onRateEvent?(fn: (e: import("./rate-budget.js").RateEvent) => void): () => void;
  rateSnapshots?(): import("./rate-budget.js").RateBucketSnapshot[];
}
