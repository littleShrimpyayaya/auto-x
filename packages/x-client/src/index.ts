import { LiveXClient } from "./live.js";
import { MockXClient } from "./mock.js";
import type { XClient } from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export { MockXClient } from "./mock.js";
export { LiveXClient } from "./live.js";

let singleton: XClient | null = null;

export function hasLiveCredentials(): boolean {
  return !!(
    process.env.X_API_KEY?.trim() &&
    process.env.X_API_SECRET?.trim() &&
    process.env.X_ACCESS_TOKEN?.trim() &&
    process.env.X_ACCESS_SECRET?.trim()
  );
}

/**
 * Resolve client mode:
 * - X_CLIENT_MODE=live  → Live (fails if credentials missing)
 * - X_CLIENT_MODE=mock  → Mock only
 * - X_CLIENT_MODE=auto or unset → Live if all 4 OAuth secrets set, else mock
 */
export function resolveXClientMode(): "live" | "mock" {
  const raw = (process.env.X_CLIENT_MODE ?? "auto").toLowerCase().trim();
  if (raw === "mock") return "mock";
  if (raw === "live") return "live";
  // auto
  return hasLiveCredentials() ? "live" : "mock";
}

export function createXClient(): XClient {
  if (singleton) return singleton;
  const mode = resolveXClientMode();
  if (mode === "live") {
    if (!hasLiveCredentials()) {
      throw new Error(
        "X_CLIENT_MODE=live but OAuth credentials incomplete. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET.",
      );
    }
    singleton = new LiveXClient();
  } else {
    singleton = new MockXClient();
    if ((process.env.X_CLIENT_MODE ?? "auto") !== "mock") {
      console.warn(
        "[x-client] No complete X OAuth credentials — using MOCK. Set four X_* secrets for real API.",
      );
    }
  }
  console.log(`XClient mode=${singleton.mode}`);
  return singleton;
}

export function resetXClientForTests() {
  singleton = null;
}
