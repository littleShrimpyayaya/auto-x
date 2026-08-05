/**
 * Live X API client via official TypeScript XDK:
 * https://docs.x.com/xdks/typescript/overview
 *
 * Rate avoidance: https://docs.x.com/x-api/fundamentals/rate-limits
 * - Follows lookup 300/15min, Manage follows 50/15min, getMe 75/15min
 */
import { Client, OAuth1 } from "@xdevplatform/xdk";
import { classifyXError, XApiError } from "./errors.js";
import { getRateBudget, type RateBucket, type RateEvent } from "./rate-budget.js";
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

function extractRateHeaders(errOrRes: unknown): {
  limit?: number;
  remaining?: number;
  resetUnix?: number;
} | null {
  const e = errOrRes as {
    headers?: Record<string, string> | { get?: (k: string) => string | null };
    response?: { headers?: Record<string, string> | { get?: (k: string) => string | null } };
    rateLimit?: { limit?: number; remaining?: number; reset?: number };
  };
  if (e.rateLimit) {
    return {
      limit: e.rateLimit.limit,
      remaining: e.rateLimit.remaining,
      resetUnix: e.rateLimit.reset,
    };
  }
  const h = e.headers ?? e.response?.headers;
  if (!h) return null;
  const get = (k: string) => {
    if (typeof (h as { get?: (x: string) => string | null }).get === "function") {
      return (h as { get: (x: string) => string | null }).get(k);
    }
    const o = h as Record<string, string>;
    return o[k] ?? o[k.toLowerCase()] ?? null;
  };
  const limit = get("x-rate-limit-limit");
  const remaining = get("x-rate-limit-remaining");
  const reset = get("x-rate-limit-reset");
  if (!limit && !remaining && !reset) return null;
  return {
    limit: limit != null ? Number(limit) : undefined,
    remaining: remaining != null ? Number(remaining) : undefined,
    resetUnix: reset != null ? Number(reset) : undefined,
  };
}

async function pageFromResult(
  res: unknown,
): Promise<{ data: SdkUser[]; nextToken: string | null }> {
  const r = res as {
    data?: SdkUser[];
    meta?: { nextToken?: string };
    items?: SdkUser[];
    done?: boolean;
    fetchNext?: () => Promise<void>;
  };
  if (typeof r.fetchNext === "function") {
    if (!r.items?.length) await r.fetchNext();
    return {
      data: r.items ?? [],
      nextToken: r.meta?.nextToken ?? null,
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
  private budget = getRateBudget();

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
    const oauth1 = new OAuth1({
      apiKey,
      apiSecret,
      accessToken,
      accessTokenSecret,
    });
    this.client = new Client({ oauth1 });
    this.maxRetries = Number(process.env.X_API_MAX_RETRIES ?? 5);
  }

  /** Subscribe to rate-budget events (for UI / event_log). */
  onRateEvent(fn: (e: RateEvent) => void) {
    return this.budget.onEvent(fn);
  }

  rateSnapshots() {
    return this.budget.allSnapshots();
  }

  private async withBudget<T>(bucket: RateBucket, label: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.budget.acquire(bucket);
      try {
        const result = await fn();
        this.budget.noteHeaders(bucket, extractRateHeaders(result));
        return result;
      } catch (err) {
        const headers = extractRateHeaders(err);
        if (headers) this.budget.noteHeaders(bucket, headers);
        const xe = classifyXError(err);
        if (xe.kind === "rate_limit") {
          this.budget.note429(bucket, xe.retryAfterMs);
          if (attempt < this.maxRetries) {
            const wait = xe.retryAfterMs ?? 60_000;
            console.warn(`[xdk] ${label} 429; budget block + sleep ${Math.round(wait / 1000)}s`);
            await sleep(Math.min(wait, 120_000));
            attempt += 1;
            continue;
          }
        }
        if (xe.kind === "network" && attempt < this.maxRetries) {
          await sleep(Math.min(60_000, 2000 * 2 ** attempt));
          attempt += 1;
          continue;
        }
        throw xe;
      }
    }
  }

  async getMe(): Promise<XUser> {
    return this.withBudget("getMe", "users.getMe", async () => {
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
    return this.withBudget("followers", "users.getFollowers", async () => {
      const res = await this.client.users.getFollowers(userId, {
        maxResults: max,
        paginationToken: token || undefined,
        userFields: [...USER_FIELDS] as never,
      });
      const page = await pageFromResult(res);
      return {
        data: page.data.filter((u) => u.id).map(mapUser),
        nextToken: page.nextToken,
      };
    });
  }

  async getFollowing(userId: string, token?: string | null, maxResults = 100): Promise<Page<XUser>> {
    const max = Math.min(100, Math.max(1, maxResults));
    return this.withBudget("following", "users.getFollowing", async () => {
      const res = await this.client.users.getFollowing(userId, {
        maxResults: max,
        paginationToken: token || undefined,
        userFields: [...USER_FIELDS] as never,
      });
      const page = await pageFromResult(res);
      return {
        data: page.data.filter((u) => u.id).map(mapUser),
        nextToken: page.nextToken,
      };
    });
  }

  async follow(sourceUserId: string, targetUserId: string): Promise<FollowResult> {
    return this.withBudget("follow", "users.followUser", async () => {
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
    await this.withBudget("unfollow", "users.unfollowUser", async () => {
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
