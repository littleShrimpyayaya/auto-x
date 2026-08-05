/** Normalize @xdevplatform/xdk / HTTP errors for worker control flow. */

export type XErrorKind =
  | "rate_limit"
  | "auth"
  | "forbidden"
  | "payment_required"
  | "not_found"
  | "already_following"
  | "cannot_follow"
  | "network"
  | "unknown";

export class XApiError extends Error {
  kind: XErrorKind;
  status?: number;
  code?: number | string;
  retryAfterMs?: number;
  raw?: unknown;

  constructor(
    kind: XErrorKind,
    message: string,
    opts: { status?: number; code?: number | string; retryAfterMs?: number; raw?: unknown } = {},
  ) {
    super(message);
    this.name = "XApiError";
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterMs = opts.retryAfterMs;
    this.raw = opts.raw;
  }
}

function digMessage(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const e = err as Error & {
      status?: number;
      statusCode?: number;
      body?: { detail?: string; title?: string; errors?: { message?: string; code?: number }[] };
      response?: { status?: number; headers?: Headers | Record<string, string> };
      errors?: { message?: string; code?: number }[];
    };
    const fromBody =
      e.body?.detail ||
      e.body?.title ||
      e.body?.errors?.[0]?.message ||
      e.errors?.[0]?.message;
    return fromBody || e.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function classifyXError(err: unknown): XApiError {
  if (err instanceof XApiError) return err;

  const e = err as {
    message?: string;
    code?: number | string;
    status?: number;
    statusCode?: number;
    rateLimited?: boolean;
    rateLimit?: { reset?: number };
    headers?: Record<string, string>;
    response?: { status?: number; headers?: { get?: (k: string) => string | null } & Record<string, string> };
    body?: { status?: number; title?: string; detail?: string };
  };

  const status = e.status ?? e.statusCode ?? e.response?.status ?? e.body?.status;
  const msg = digMessage(err);

  // XDK Client has rateLimited flag on some paths
  const clientRate =
    typeof (err as { rateLimited?: boolean }).rateLimited === "boolean" &&
    (err as { rateLimited?: boolean }).rateLimited;

  if (clientRate || status === 429 || /rate.?limit/i.test(msg)) {
    let retryAfterMs = 60_000;
    if (e.rateLimit?.reset) {
      retryAfterMs = Math.max(5_000, e.rateLimit.reset * 1000 - Date.now());
    }
    const h = e.response?.headers;
    const ra =
      (typeof h?.get === "function" ? h.get("retry-after") : null) ||
      e.headers?.["retry-after"] ||
      e.headers?.["Retry-After"];
    if (ra) retryAfterMs = Math.max(5_000, Number(ra) * 1000);
    return new XApiError("rate_limit", msg, { status: 429, code: e.code, retryAfterMs, raw: err });
  }

  if (status === 402 || /payment required|credits|enrolled account.*credits/i.test(msg)) {
    return new XApiError("payment_required", msg, { status: status ?? 402, code: e.code, raw: err });
  }

  if (status === 401 || status === 403) {
    if (/already\s*follow/i.test(msg) || e.code === 160 || e.code === 108) {
      return new XApiError("already_following", msg, { status, code: e.code, raw: err });
    }
    if (/blocked|cannot find|not found|protected/i.test(msg)) {
      return new XApiError("cannot_follow", msg, { status, code: e.code, raw: err });
    }
    return new XApiError(status === 401 ? "auth" : "forbidden", msg, {
      status,
      code: e.code,
      raw: err,
    });
  }

  if (status === 404) {
    return new XApiError("not_found", msg, { status, code: e.code, raw: err });
  }

  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket/i.test(msg)) {
    return new XApiError("network", msg, { status, code: e.code, raw: err });
  }

  return new XApiError("unknown", msg, { status, code: e.code, raw: err });
}
