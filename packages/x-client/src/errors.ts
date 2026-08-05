/** Normalize twitter-api-v2 / HTTP errors for worker control flow. */

export type XErrorKind =
  | "rate_limit"
  | "auth"
  | "forbidden"
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

export function classifyXError(err: unknown): XApiError {
  if (err instanceof XApiError) return err;

  const e = err as {
    message?: string;
    code?: number | string;
    status?: number;
    data?: { title?: string; detail?: string; status?: number; errors?: { message?: string; code?: number }[] };
    rateLimit?: { reset?: number };
    rateLimitError?: boolean;
    headers?: Record<string, string>;
  };

  const status = e.status ?? e.data?.status;
  const msg =
    e.data?.detail ||
    e.data?.title ||
    e.data?.errors?.[0]?.message ||
    e.message ||
    String(err);
  const code = e.code ?? e.data?.errors?.[0]?.code;

  // twitter-api-v2 rate limit
  if (e.rateLimitError || status === 429 || /rate.?limit/i.test(msg)) {
    let retryAfterMs = 60_000;
    if (e.rateLimit?.reset) {
      retryAfterMs = Math.max(5_000, e.rateLimit.reset * 1000 - Date.now());
    }
    const ra = e.headers?.["retry-after"] || e.headers?.["Retry-After"];
    if (ra) retryAfterMs = Math.max(5_000, Number(ra) * 1000);
    return new XApiError("rate_limit", msg, { status: 429, code, retryAfterMs, raw: err });
  }

  if (status === 401 || status === 403) {
    // already following / blocked etc often 403 with specific text
    if (/already\s*follow/i.test(msg) || code === 160 || code === 108) {
      return new XApiError("already_following", msg, { status, code, raw: err });
    }
    if (/blocked|cannot find|not found|protected/i.test(msg)) {
      return new XApiError("cannot_follow", msg, { status, code, raw: err });
    }
    return new XApiError(status === 401 ? "auth" : "forbidden", msg, { status, code, raw: err });
  }

  if (status === 404) {
    return new XApiError("not_found", msg, { status, code, raw: err });
  }

  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(msg)) {
    return new XApiError("network", msg, { status, code, raw: err });
  }

  return new XApiError("unknown", msg, { status, code, raw: err });
}
