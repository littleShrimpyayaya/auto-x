export const PACKAGE_NAME = "@autox/config" as const;

export const WEAK_ADMIN_TOKENS = new Set(["", "change-me-to-long-random"]);

export function isAdminTokenWeak(token: string | undefined): boolean {
  if (token === undefined) return true;
  const t = token.trim();
  if (t === "") return true;
  if (WEAK_ADMIN_TOKENS.has(t)) return true;
  if (t.length < 16) return true;
  return false;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env ${name}`);
  }
  return v.trim();
}
