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
};

export function settingsFromEnv(): AppSettings {
  const n = (k: string, d: number) => Number(process.env[k] ?? d);
  const b = (k: string, d: boolean) => {
    const v = process.env[k];
    if (v === undefined) return d;
    return v === "1" || v.toLowerCase() === "true";
  };
  const mock = (process.env.X_CLIENT_MODE ?? "mock").toLowerCase() === "mock";
  return {
    observationDays: n("OBSERVATION_DAYS", 7),
    maxFollowsPerDay: n("MAX_FOLLOWS_PER_DAY", 50),
    maxUnfollowsPerDay: n("MAX_UNFOLLOWS_PER_DAY", 50),
    maxFollowsPerHour: n("MAX_FOLLOWS_PER_HOUR", 8),
    maxUnfollowsPerHour: n("MAX_UNFOLLOWS_PER_HOUR", 8),
    // mock defaults faster for demo
    writeMinIntervalMs: n("WRITE_MIN_INTERVAL_MS", mock ? 200 : 45000),
    followBackEnabled: b("FOLLOW_BACK_ENABLED", true),
    mutualExpandEnabled: b("MUTUAL_EXPAND_ENABLED", false),
    candidateManualApproval: b("CANDIDATE_MANUAL_APPROVAL", true),
    unfollowCooldownDays: n("UNFOLLOW_COOLDOWN_DAYS", 30),
    leaseTtlSec: n("LEASE_TTL_SEC", 120),
    expandPreferVerified: b("EXPAND_PREFER_VERIFIED", true),
  };
}
