/**
 * Preemptive rate budgets aligned with X API v2 docs:
 * https://docs.x.com/x-api/fundamentals/rate-limits
 *
 * Relevant per-user (OAuth user context) limits (per 15 min unless noted):
 * - GET  /2/users/me                 → 75
 * - GET  /2/users/:id/followers      → 300
 * - GET  /2/users/:id/following      → 300
 * - POST /2/users/:id/following      → 50
 * - DELETE .../following/:target     → 50
 *
 * Strategy (avoid 429, not just recover):
 * 1. Sliding window counter per endpoint family
 * 2. Min spacing = window / limit * safetyFactor
 * 3. If response headers present, sync remaining/reset (authoritative)
 * 4. On 429, hard-block until reset and surface to UI
 */

export type RateBucket =
  | "getMe"
  | "followers"
  | "following"
  | "follow"
  | "unfollow";

export type RateBucketSnapshot = {
  bucket: RateBucket;
  limit: number;
  remaining: number;
  usedInWindow: number;
  windowMs: number;
  resetAt: string | null;
  blockedUntil: string | null;
  minIntervalMs: number;
  lastWaitMs: number;
  lastRequestAt: string | null;
};

export type RateEvent = {
  type: "wait" | "acquire" | "header_sync" | "blocked_429" | "release";
  bucket: RateBucket;
  message: string;
  waitMs?: number;
  snapshot: RateBucketSnapshot;
  at: string;
};

type BucketState = {
  limit: number;
  windowMs: number;
  /** timestamps of requests in window */
  hits: number[];
  /** authoritative from headers */
  headerRemaining: number | null;
  headerLimit: number | null;
  headerResetMs: number | null;
  /** hard block after 429 */
  blockedUntilMs: number | null;
  lastRequestAt: number | null;
  lastWaitMs: number;
  minIntervalMs: number;
};

/** Official table (per user / 15 min). Use 85% as soft cap. */
const OFFICIAL: Record<RateBucket, { limit: number; windowMs: number }> = {
  getMe: { limit: 75, windowMs: 15 * 60_000 },
  followers: { limit: 300, windowMs: 15 * 60_000 },
  following: { limit: 300, windowMs: 15 * 60_000 },
  follow: { limit: 50, windowMs: 15 * 60_000 },
  unfollow: { limit: 50, windowMs: 15 * 60_000 },
};

const SAFETY = Number(process.env.X_RATE_SAFETY ?? 0.85);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class RateBudget {
  private buckets = new Map<RateBucket, BucketState>();
  private listeners: Array<(e: RateEvent) => void> = [];

  constructor() {
    for (const [k, v] of Object.entries(OFFICIAL) as [RateBucket, { limit: number; windowMs: number }][]) {
      const soft = Math.max(1, Math.floor(v.limit * SAFETY));
      const minIntervalMs = Math.ceil(v.windowMs / soft);
      this.buckets.set(k, {
        limit: soft,
        windowMs: v.windowMs,
        hits: [],
        headerRemaining: null,
        headerLimit: null,
        headerResetMs: null,
        blockedUntilMs: null,
        lastRequestAt: null,
        lastWaitMs: 0,
        minIntervalMs,
      });
    }
  }

  onEvent(fn: (e: RateEvent) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  }

  private emit(e: Omit<RateEvent, "at" | "snapshot"> & { snapshot?: RateBucketSnapshot }) {
    const full: RateEvent = {
      ...e,
      at: new Date().toISOString(),
      snapshot: e.snapshot ?? this.snapshot(e.bucket),
    };
    for (const l of this.listeners) {
      try {
        l(full);
      } catch {
        /* ignore */
      }
    }
  }

  snapshot(bucket: RateBucket): RateBucketSnapshot {
    const b = this.buckets.get(bucket)!;
    this.prune(b);
    const used = b.hits.length;
    const remaining =
      b.headerRemaining != null ? b.headerRemaining : Math.max(0, b.limit - used);
    return {
      bucket,
      limit: b.headerLimit ?? b.limit,
      remaining,
      usedInWindow: used,
      windowMs: b.windowMs,
      resetAt: b.headerResetMs ? new Date(b.headerResetMs).toISOString() : null,
      blockedUntil: b.blockedUntilMs ? new Date(b.blockedUntilMs).toISOString() : null,
      minIntervalMs: b.minIntervalMs,
      lastWaitMs: b.lastWaitMs,
      lastRequestAt: b.lastRequestAt ? new Date(b.lastRequestAt).toISOString() : null,
    };
  }

  allSnapshots(): RateBucketSnapshot[] {
    return ([...this.buckets.keys()] as RateBucket[]).map((k) => this.snapshot(k));
  }

  private prune(b: BucketState) {
    const cut = Date.now() - b.windowMs;
    b.hits = b.hits.filter((t) => t > cut);
  }

  /** Wait until a request on this bucket is allowed. */
  async acquire(bucket: RateBucket): Promise<void> {
    const b = this.buckets.get(bucket)!;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      this.prune(b);

      // hard block after 429
      if (b.blockedUntilMs && now < b.blockedUntilMs) {
        const waitMs = b.blockedUntilMs - now;
        b.lastWaitMs = waitMs;
        this.emit({
          type: "wait",
          bucket,
          message: `限流冷却中：${bucket}，约 ${Math.ceil(waitMs / 1000)}s 后可继续`,
          waitMs,
        });
        await sleep(Math.min(waitMs, 30_000));
        continue;
      }

      // min spacing between calls
      if (b.lastRequestAt != null) {
        const since = now - b.lastRequestAt;
        if (since < b.minIntervalMs) {
          const waitMs = b.minIntervalMs - since;
          b.lastWaitMs = waitMs;
          this.emit({
            type: "wait",
            bucket,
            message: `节奏控制：${bucket} 最小间隔 ${b.minIntervalMs}ms，等待 ${waitMs}ms（官方 15min 窗口内均摊）`,
            waitMs,
          });
          await sleep(waitMs);
          continue;
        }
      }

      // sliding window count
      if (b.hits.length >= b.limit) {
        const oldest = b.hits[0]!;
        const waitMs = Math.max(1000, oldest + b.windowMs - now);
        b.lastWaitMs = waitMs;
        this.emit({
          type: "wait",
          bucket,
          message: `窗口配额将满：${bucket} 已用 ${b.hits.length}/${b.limit}（15min），等待 ${Math.ceil(waitMs / 1000)}s`,
          waitMs,
        });
        await sleep(Math.min(waitMs, 60_000));
        continue;
      }

      // header remaining exhausted
      if (b.headerRemaining != null && b.headerRemaining <= 0 && b.headerResetMs) {
        const waitMs = Math.max(1000, b.headerResetMs - now);
        b.lastWaitMs = waitMs;
        this.emit({
          type: "wait",
          bucket,
          message: `响应头显示剩余 0：${bucket}，等到 reset ${new Date(b.headerResetMs).toISOString()}`,
          waitMs,
        });
        await sleep(Math.min(waitMs, 60_000));
        continue;
      }

      // acquire
      b.hits.push(Date.now());
      b.lastRequestAt = Date.now();
      b.lastWaitMs = 0;
      if (b.headerRemaining != null && b.headerRemaining > 0) {
        b.headerRemaining -= 1;
      }
      this.emit({
        type: "acquire",
        bucket,
        message: `发起请求：${bucket}（窗口内 ${b.hits.length}/${b.limit}）`,
      });
      return;
    }
  }

  /** Sync from X response headers when available. */
  noteHeaders(
    bucket: RateBucket,
    headers: { limit?: number; remaining?: number; resetUnix?: number } | null | undefined,
  ) {
    if (!headers) return;
    const b = this.buckets.get(bucket)!;
    if (headers.limit != null) b.headerLimit = headers.limit;
    if (headers.remaining != null) b.headerRemaining = headers.remaining;
    if (headers.resetUnix != null) b.headerResetMs = headers.resetUnix * 1000;
    this.emit({
      type: "header_sync",
      bucket,
      message: `同步限流头：${bucket} remaining=${headers.remaining ?? "?"} limit=${headers.limit ?? "?"} reset=${headers.resetUnix ?? "?"}`,
    });
  }

  /** After HTTP 429 — block until reset. */
  note429(bucket: RateBucket, retryAfterMs?: number) {
    const b = this.buckets.get(bucket)!;
    const until =
      retryAfterMs != null
        ? Date.now() + retryAfterMs
        : b.headerResetMs ?? Date.now() + 60_000;
    b.blockedUntilMs = until;
    b.headerRemaining = 0;
    this.emit({
      type: "blocked_429",
      bucket,
      message: `收到 429：${bucket} 暂停至 ${new Date(until).toISOString()}`,
      waitMs: until - Date.now(),
    });
  }
}

/** Singleton shared by LiveXClient in-process */
let shared: RateBudget | null = null;
export function getRateBudget(): RateBudget {
  if (!shared) shared = new RateBudget();
  return shared;
}
