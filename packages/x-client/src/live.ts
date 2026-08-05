/**
 * Live X API client via official TypeScript XDK:
 * https://docs.x.com/xdks/typescript/overview
 *
 * Auth: OAuth 1.0a User Context (required for follow/unfollow).
 * Package: @xdevplatform/xdk
 */
import { Client, OAuth1 } from "@xdevplatform/xdk";
import { classifyXError, XApiError } from "./errors.js";
import type { FollowResult, Page, XCapabilities, XClient, XUser } from "./types.js";

const USER_FIELDS = [
  "id",
  "username",
  "name",
  "verified",
  "protected",
  "public_metrics",
  "verified_type",
] as const;

type SdkUser = {
  id?: string;
  username?: string;
  name?: string;
  verified?: boolean;
  protected?: boolean;
  verifiedType?: string;
  publicMetrics?: {
    followersCount?: number;
    followingCount?: number;
    tweetCount?: number;
  };
};

function mapUser(u: SdkUser): XUser {
  const verified =
    u.verified === true || (!!u.verifiedType && u.verifiedType !== "none");
  return {
    id: String(u.id ?? ""),
    username: (u.username ?? String(u.id ?? "unknown")).replace(/^@+/, ""),
    name: u.name,
    verified,
    protected: u.protected,
    followers_count: u.publicMetrics?.followersCount,
    following_count: u.publicMetrics?.followingCount,
    tweet_count: u.publicMetrics?.tweetCount,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Normalize either plain response or SDK paginator. */
async function pageFromFollowersResult(
  res: unknown,
): Promise<{ data: SdkUser[]; nextToken: string | null }> {
  const r = res as {
    data?: SdkUser[];
    meta?: { nextToken?: string };
    items?: SdkUser[];
    done?: boolean;
    fetchNext?: () => Promise<void>;
  };

  // Paginator style (docs): await fetchNext then read items
  if (typeof r.fetchNext === "function") {
    if (!r.items?.length) {
      await r.fetchNext();
    }
    return {
      data: r.items ?? [],
      nextToken: r.meta?.nextToken ?? (r.done === false ? r.meta?.nextToken ?? null : null),
    };
  }

  return {
    data: r.data ?? [],
    nextToken: r.meta?.nextToken ?? null,
  };
}

export class LiveXClient implements XClient {
  readonly mode = "live" as const;
  private client: Client;
  private maxRetries: number;

  constructor() {
    const apiKey = process.env.X_API_KEY?.trim();
    const apiSecret = process.env.X_API_SECRET?.trim();
    const accessToken = process.env.X_ACCESS_TOKEN?.trim();
    const accessTokenSecret = process.env.X_ACCESS_SECRET?.trim();
    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      throw new Error(
        "Live X client requires X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET (OAuth 1.0a)",
      );
    }

    // https://docs.x.com/xdks/typescript/authentication#oauth-10a-user-context
    const oauth1 = new OAuth1({
      apiKey,
      apiSecret,
      accessToken,
      accessTokenSecret,
    });
    this.client = new Client({ oauth1 });
    this.maxRetries = Number(process.env.X_API_MAX_RETRIES ?? 5);
  }

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (err) {
        const xe = classifyXError(err);
        if (xe.kind === "rate_limit" && attempt < this.maxRetries) {
          const wait = xe.retryAfterMs ?? Math.min(300_000, 15_000 * 2 ** attempt);
          console.warn(
            `[xdk] ${label} rate limited; sleep ${Math.round(wait / 1000)}s (attempt ${attempt + 1})`,
          );
          await sleep(wait);
          attempt += 1;
          continue;
        }
        if (xe.kind === "network" && attempt < this.maxRetries) {
          const wait = Math.min(60_000, 2000 * 2 ** attempt);
          console.warn(`[xdk] ${label} network error; retry in ${wait}ms`);
          await sleep(wait);
          attempt += 1;
          continue;
        }
        throw xe;
      }
    }
  }

  async getMe(): Promise<XUser> {
    return this.withRetry("users.getMe", async () => {
      const res = await this.client.users.getMe({
        userFields: [...USER_FIELDS] as never,
      });
      if (!res.data?.id) {
        throw new XApiError("unknown", "getMe returned empty data", { raw: res });
      }
      return mapUser(res.data as SdkUser);
    });
  }

  async getFollowers(userId: string, token?: string | null, maxResults = 100): Promise<Page<XUser>> {
    const max = Math.min(100, Math.max(1, maxResults));
    return this.withRetry("users.getFollowers", async () => {
      const res = await this.client.users.getFollowers(userId, {
        maxResults: max,
        paginationToken: token || undefined,
        userFields: [...USER_FIELDS] as never,
      });
      const page = await pageFromFollowersResult(res);
      return {
        data: page.data.filter((u) => u.id).map(mapUser),
        nextToken: page.nextToken,
      };
    });
  }

  async getFollowing(userId: string, token?: string | null, maxResults = 100): Promise<Page<XUser>> {
    const max = Math.min(100, Math.max(1, maxResults));
    return this.withRetry("users.getFollowing", async () => {
      const res = await this.client.users.getFollowing(userId, {
        maxResults: max,
        paginationToken: token || undefined,
        userFields: [...USER_FIELDS] as never,
      });
      const page = await pageFromFollowersResult(res);
      return {
        data: page.data.filter((u) => u.id).map(mapUser),
        nextToken: page.nextToken,
      };
    });
  }

  async follow(sourceUserId: string, targetUserId: string): Promise<FollowResult> {
    return this.withRetry("users.followUser", async () => {
      try {
        const res = await this.client.users.followUser(sourceUserId, {
          targetUserId,
        });
        return {
          pendingFollow: !!res.data?.pendingFollow,
          alreadyFollowing: res.data?.following === true && !res.data?.pendingFollow,
        };
      } catch (err) {
        const xe = classifyXError(err);
        if (xe.kind === "already_following") {
          return { pendingFollow: false, alreadyFollowing: true };
        }
        throw xe;
      }
    });
  }

  async unfollow(sourceUserId: string, targetUserId: string): Promise<void> {
    await this.withRetry("users.unfollowUser", async () => {
      try {
        await this.client.users.unfollowUser(sourceUserId, targetUserId);
      } catch (err) {
        const xe = classifyXError(err);
        if (xe.kind === "not_found" || /not\s*following|does not follow/i.test(xe.message)) {
          return;
        }
        throw xe;
      }
    });
  }

  async probeCapabilities(): Promise<XCapabilities> {
    const errors: XCapabilities["errors"] = {};
    const caps: XCapabilities = {
      mode: "live",
      me: false,
      readFollowers: false,
      readFollowing: false,
      writeFollow: false,
      writeUnfollow: false,
      probedAt: new Date().toISOString(),
      errors,
    };

    let me: XUser | undefined;
    try {
      me = await this.getMe();
      caps.me = true;
      caps.meUser = me;
    } catch (e) {
      const xe = e instanceof XApiError ? e : classifyXError(e);
      errors.me = xe.message;
      return caps;
    }

    try {
      await this.getFollowers(me.id, null, 10);
      caps.readFollowers = true;
    } catch (e) {
      const xe = e instanceof XApiError ? e : classifyXError(e);
      errors.readFollowers = xe.message;
    }

    try {
      await this.getFollowing(me.id, null, 10);
      caps.readFollowing = true;
    } catch (e) {
      const xe = e instanceof XApiError ? e : classifyXError(e);
      errors.readFollowing = xe.message;
    }

    const writesEnabled = (process.env.X_ENABLE_WRITES ?? "1") !== "0";
    if (writesEnabled && caps.me) {
      caps.writeFollow = true;
      caps.writeUnfollow = true;
    }

    return caps;
  }
}
