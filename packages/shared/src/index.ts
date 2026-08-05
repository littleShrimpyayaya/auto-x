export type WsEnvelope<T = unknown> = {
  v: 1;
  type: string;
  ts: string;
  payload: T;
  requestId?: string;
};

export function envelope<T>(type: string, payload: T, requestId?: string): WsEnvelope<T> {
  return {
    v: 1,
    type,
    ts: new Date().toISOString(),
    payload,
    requestId,
  };
}

export const WS_CHANNEL = "auto_x_events";

export type AppSettings = {
  observationDays: number;
  maxFollowsPerDay: number;
  maxUnfollowsPerDay: number;
  maxFollowsPerHour: number;
  maxUnfollowsPerHour: number;
  writeMinIntervalMs: number;
  followBackEnabled: boolean;
  mutualExpandEnabled: boolean;
  candidateManualApproval: boolean;
  unfollowCooldownDays: number;
  leaseTtlSec: number;
  expandPreferVerified: boolean;
  syncPageSize: number;
};

export function settingsFromEnv(): AppSettings {
  const n = (k: string, d: number) => {
    const v = process.env[k];
    if (v === undefined || v === "") return d;
    const num = Number(v);
    return Number.isFinite(num) ? num : d;
  };
  const b = (k: string, d: boolean) => {
    const v = process.env[k];
    if (v === undefined) return d;
    return v === "1" || v.toLowerCase() === "true";
  };

  // Live-safe defaults when credentials present / mode=live
  const mode = (process.env.X_CLIENT_MODE ?? "auto").toLowerCase();
  const hasCreds = !!(
    process.env.X_API_KEY?.trim() &&
    process.env.X_API_SECRET?.trim() &&
    process.env.X_ACCESS_TOKEN?.trim() &&
    process.env.X_ACCESS_SECRET?.trim()
  );
  const live = mode === "live" || (mode === "auto" && hasCreds) || (mode !== "mock" && hasCreds);

  return {
    observationDays: n("OBSERVATION_DAYS", 7),
    maxFollowsPerDay: n("MAX_FOLLOWS_PER_DAY", live ? 40 : 50),
    maxUnfollowsPerDay: n("MAX_UNFOLLOWS_PER_DAY", live ? 40 : 50),
    maxFollowsPerHour: n("MAX_FOLLOWS_PER_HOUR", live ? 6 : 8),
    maxUnfollowsPerHour: n("MAX_UNFOLLOWS_PER_HOUR", live ? 6 : 8),
    // Manage follows: 50/15min ≈ 18s min; use 20s+ for safety (headers still authoritative).
    // https://docs.x.com/x-api/fundamentals/rate-limits
    // 50 follow writes / 15min ≈ 18s; default 20s (RateBudget also enforces)
    writeMinIntervalMs: n("WRITE_MIN_INTERVAL_MS", live ? 20_000 : 50),
    followBackEnabled: b("FOLLOW_BACK_ENABLED", true),
    mutualExpandEnabled: b("MUTUAL_EXPAND_ENABLED", false),
    candidateManualApproval: b("CANDIDATE_MANUAL_APPROVAL", true),
    unfollowCooldownDays: n("UNFOLLOW_COOLDOWN_DAYS", 30),
    leaseTtlSec: n("LEASE_TTL_SEC", 120),
    expandPreferVerified: b("EXPAND_PREFER_VERIFIED", true),
    syncPageSize: n("SYNC_PAGE_SIZE", 100),
  };
}
