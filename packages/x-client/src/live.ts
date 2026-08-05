import { TwitterApi } from "twitter-api-v2";
import type { FollowResult, Page, XClient, XUser } from "./types.js";

function mapUser(u: {
  id: string;
  username?: string;
  name?: string;
  verified?: boolean;
  protected?: boolean;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
  verified_type?: string | null;
}): XUser {
  const verified =
    u.verified === true ||
    (!!u.verified_type && u.verified_type !== "none");
  return {
    id: u.id,
    username: (u.username ?? u.id).replace(/^@+/, ""),
    name: u.name,
    verified,
    protected: u.protected,
    followers_count: u.public_metrics?.followers_count,
    following_count: u.public_metrics?.following_count,
    tweet_count: u.public_metrics?.tweet_count,
  };
}

export class LiveXClient implements XClient {
  private rw: ReturnType<TwitterApi["readWrite"]>;

  constructor() {
    const appKey = process.env.X_API_KEY;
    const appSecret = process.env.X_API_SECRET;
    const accessToken = process.env.X_ACCESS_TOKEN;
    const accessSecret = process.env.X_ACCESS_SECRET;
    if (!appKey || !appSecret || !accessToken || !accessSecret) {
      throw new Error("Live X client requires X_API_KEY/SECRET and X_ACCESS_TOKEN/SECRET");
    }
    const client = new TwitterApi({
      appKey,
      appSecret,
      accessToken,
      accessSecret,
    });
    this.rw = client.readWrite;
  }

  async getMe(): Promise<XUser> {
    const me = await this.rw.v2.me({
      "user.fields": ["username", "name", "verified", "protected", "public_metrics", "verified_type"],
    });
    return mapUser(me.data as never);
  }

  async getFollowers(userId: string, token?: string | null, maxResults = 100): Promise<Page<XUser>> {
    const res = await this.rw.v2.followers(userId, {
      max_results: maxResults,
      pagination_token: token ?? undefined,
      "user.fields": ["username", "name", "verified", "protected", "public_metrics", "verified_type"],
    });
    return {
      data: (res.data ?? []).map((u) => mapUser(u as never)),
      nextToken: res.meta?.next_token ?? null,
    };
  }

  async getFollowing(userId: string, token?: string | null, maxResults = 100): Promise<Page<XUser>> {
    const res = await this.rw.v2.following(userId, {
      max_results: maxResults,
      pagination_token: token ?? undefined,
      "user.fields": ["username", "name", "verified", "protected", "public_metrics", "verified_type"],
    });
    return {
      data: (res.data ?? []).map((u) => mapUser(u as never)),
      nextToken: res.meta?.next_token ?? null,
    };
  }

  async follow(sourceUserId: string, targetUserId: string): Promise<FollowResult> {
    const res = await this.rw.v2.follow(sourceUserId, targetUserId);
    const pending = !!(res.data as { pending_follow?: boolean })?.pending_follow;
    return { pendingFollow: pending };
  }

  async unfollow(sourceUserId: string, targetUserId: string): Promise<void> {
    await this.rw.v2.unfollow(sourceUserId, targetUserId);
  }
}
