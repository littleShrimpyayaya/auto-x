/**
 * @autox/config — env / app config helpers. PR1 stub.
 */

export const PACKAGE_NAME = "@autox/config" as const;

/** Weak / placeholder tokens that must never be accepted at boot. */
export const WEAK_ADMIN_TOKENS = new Set(["", "change-me-to-long-random"]);

export function isAdminTokenWeak(token: string | undefined): boolean {
  if (token === undefined || token.trim() === "") return true;
  if (WEAK_ADMIN_TOKENS.has(token)) return true;
  if (token.length < 16) return true;
  return false;
}
