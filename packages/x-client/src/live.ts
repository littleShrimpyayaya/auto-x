import { TwitterApi, ApiResponseError } from "twitter-api-v2";
import { classifyXError, XApiError } from "./errors.js";
import type { FollowResult, Page, XCapabilities, XClient, XUser } from "./types.js";

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
    u.verified === true || (!!u.verified_type && u.verified_type !== "none");
  return {
    id: String(u.id),
    username: (u.username ?? String(u.id)).replace(/^@+/, ""),
    name: u.name,
    verified,
    protected: u.protected,
    followers_count: u.public_metrics?.followers_count,
    following_count: u.public_metrics?.following_count,
    tweet_count: u.public_metrics?.tweet_count,
  };
}

const USER_FIELDS = [
  "username",
  "name",
  "verified",
  "protected",
  "public_metrics",
  "verified_type",
] as const;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Live X API v2 client (OAuth 1.0a user context).
 * Retries rate limits; surfaces capability-related failures for the worker gate.
 */
export class LiveXClient implements XClient {
  readonly mode = "live" as const;
  private rw: ReturnType<TwitterApi["readWrite"]>;
  private maxRetries: number;

  constructor() {
    const appKey = process.env.X_API_KEY?.trim();
    const appSecret = process.env.X_API_SECRET?.trim();
    const accessToken = process.env.X_ACCESS_TOKEN?.trim();
    const accessSecret = process.env.X_ACCESS_SECRET?.trim();
    if (!appKey || !appSecret || !accessToken || !accessSecret) {
      throw new Error(
        "Live X client requires X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET",
      );
    }
    const client = new TwitterApi({
      appKey,
      appSecret,
      accessToken,
      accessSecret,
    });
    this.rw = client.readWrite;
    this.maxRetries = Number(process.env.X_API_MAX_RETRIES ?? 5);
  }

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (err) {
        const xe = err instanceof ApiResponseError || err instanceof Error
          ? classifyXError(err)
          : classifyXError(err);
        if (xe.kind === "rate_limit" && attempt < this.maxRetries) {
          const wait = xe.retryAfterMs ?? Math.min(300_000, 15_000 * 2 ** attempt);
          console.warn(`[x-live] ${label} rate limited; sleep ${Math.round(wait / 1000)}s (attempt ${attempt + 1})`);
          await sleep(wait);
          attempt += 1;
          continue;
        }
        if (xe.kind === "network" && attempt < this.maxRetries) {
          const wait = Math.min(60_000, 2000 * 2 ** attempt);
          console.warn(`[x-live] ${label} network error; retry in ${wait}ms`);
          await sleep(wait);
          attempt += 1;
          continue;
        }
        throw xe;
      }
    }
  }

  async getMe(): Promise<XUser> {
    return this.withRetry("getMe", async () => {
      const me = await this.rw.v2.me({ "user.fields": [...USER_FIELDS] });
      return mapUser(me.data as never);
    });
  }

  async getFollowers(userId: string, token?: string | null, maxResults = 100): Promise<Page<XUser>> {
    const max = Math.min(100, Math.max(1, maxResults));
    return this.withRetry("getFollowers", async () => {
      const res = await this.rw.v2.followers(userId, {
        max_results: max,
        pagination_token: token || undefined,
        "user.fields": [...USER_FIELDS],
      });
      const data = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
      return {
        data: data.map((u) => mapUser(u as never)),
        nextToken: res.meta?.next_token ?? null,
      };
    });
  }

  async getFollowing(userId: string, token?: string | null, maxResults = 100): Promise<Page<XUser>> {
    const max = Math.min(100, Math.max(1, maxResults));
    return this.withRetry("getFollowing", async () => {
      const res = await this.rw.v2.following(userId, {
        max_results: max,
        pagination_token: token || undefined,
        "user.fields": [...USER_FIELDS],
      });
      const data = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
      return {
        data: data.map((u) => mapUser(u as never)),
        nextToken: res.meta?.next_token ?? null,
      };
    });
  }

  async follow(sourceUserId: string, targetUserId: string): Promise<FollowResult> {
    return this.withRetry("follow", async () => {
      try {
        const res = await this.rw.v2.follow(sourceUserId, targetUserId);
        const d = res.data as { following?: boolean; pending_follow?: boolean };
        return {
          pendingFollow: !!d?.pending_follow,
          alreadyFollowing: d?.following === true && !d?.pending_follow ? undefined : undefined,
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
    await this.withRetry("unfollow", async () => {
      try {
        await this.rw.v2.unfollow(sourceUserId, targetUserId);
      } catch (err) {
        const xe = classifyXError(err);
        // not following anymore — treat as success for idempotency
        if (xe.kind === "not_found" || /not\s*following|does not follow/i.test(xe.message)) {
          return;
        }
        throw xe;
      }
    });
  }

  /**
   * Probe real API access. Does NOT perform follow/unfollow writes.
   * writeFollow/writeUnfollow are inferred as true only if reads succeed and
   * X_ASSUME_WRITE=1 or a successful optional dry check — default: optimistic true
   * when me works and env X_ENABLE_WRITES is not "0".
   */
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

    // Writes: only enable if explicitly allowed (default true for live with working me)
    const writesEnabled = (process.env.X_ENABLE_WRITES ?? "1") !== "0";
    if (writesEnabled && caps.me) {
      // Cannot safely probe follow without mutating; gate on read success + env
      caps.writeFollow = caps.readFollowing || caps.readFollowers || caps.me;
      caps.writeUnfollow = caps.writeFollow;
      // If reads forbidden, still may have write-only — keep write flags if me ok
      if (!caps.readFollowers && !caps.readFollowing) {
        caps.writeFollow = writesEnabled;
        caps.writeUnfollow = writesEnabled;
        errors.readFollowers = errors.readFollowers || "followers lookup may be restricted on this tier";
      }
    }

    return caps;
  }
}
