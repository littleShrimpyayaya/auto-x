/**
 * MAIN world injector — runs at document_start before the X.com SPA loads.
 * Hooks fetch/XHR to intercept X's internal GraphQL API responses.
 * Also executes follow/unfollow mutations on behalf of the content script.
 */
(() => {
  const SOURCE = "autox-hook";
  const GRAPHQL_RE = /\/graphql\/([^/]+)\/(\w+)/;

  // Public web client bearer used by x.com (not a secret — shipped in the SPA)
  const WEB_BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  // Track seen graphql queries for hash self-learning
  const seenQueries = new Map();

  function postToContent(data) {
    try {
      window.postMessage({ source: SOURCE, ...data }, "*");
    } catch {
      // ignore
    }
  }

  function getCookie(name) {
    try {
      const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&") + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch {
      return null;
    }
  }

  function mutationHeaders() {
    const csrf = getCookie("ct0");
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + decodeURIComponent(WEB_BEARER),
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Client-Language": "en",
    };
    if (csrf) {
      headers["X-Csrf-Token"] = csrf;
      headers["x-csrf-token"] = csrf;
    }
    return headers;
  }

  // ── Parse user objects from GraphQL responses ──────────────────

  function getTimelineInstructions(json) {
    return (
      json?.data?.user?.result?.timeline?.timeline?.instructions ??
      json?.data?.user?.result?.timeline_response?.timeline?.instructions ??
      json?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
      json?.data?.user?.result?.timeline?.instructions ??
      []
    );
  }

  function extractUsersFromResponse(json) {
    if (!json?.data) return [];
    const users = [];
    const seen = new Set();

    function pushUser(result) {
      if (!result || result.__typename === "UserUnavailable") return;
      // Nested wrapper sometimes seen in newer schemas
      if (result.result && (result.result.rest_id || result.result.legacy || result.result.core)) {
        result = result.result;
      }
      if (!result || result.__typename === "UserUnavailable") return;
      const legacy = result.legacy ?? {};
      const restId = result.rest_id || result.id_str || result.id;
      const screen =
        legacy.screen_name ||
        result.core?.screen_name ||
        result.core?.screenName ||
        result.screen_name;
      if (!restId || !screen || seen.has(String(restId))) return;
      // Skip non-user objects that happen to have ids
      if (result.__typename && result.__typename !== "User" && !legacy.screen_name && !result.core) {
        return;
      }
      seen.add(String(restId));
      users.push({
        id: String(restId),
        username: screen,
        name: legacy.name ?? result.core?.name ?? result.name ?? null,
        verified: !!(result.is_blue_verified || legacy.verified),
        protected: legacy.protected ?? false,
        followers_count: legacy.followers_count ?? null,
        following_count: legacy.friends_count ?? null,
        tweet_count: legacy.statuses_count ?? null,
      });
    }

    function walk(node, depth) {
      if (!node || depth > 14) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (typeof node !== "object") return;

      // User result shapes used by timeline + user modules
      if (
        (node.__typename === "User" || node.rest_id || node.legacy?.screen_name) &&
        (node.legacy?.screen_name || node.core?.screen_name || node.core?.screenName)
      ) {
        pushUser(node);
      }

      if (node.user_results?.result) pushUser(node.user_results.result);
      if (node.userResult?.result) pushUser(node.userResult.result);
      if (node.user?.result) pushUser(node.user.result);
      if (node.result && (node.result.rest_id || node.result.legacy || node.result.core)) {
        pushUser(node.result);
      }

      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === "object") walk(v, depth + 1);
      }
    }

    function processEntry(entry) {
      if (!entry) return;
      const result =
        entry.content?.itemContent?.user_results?.result ??
        entry.content?.itemContent?.user_results ??
        entry.content?.itemContent?.user?.result ??
        entry.itemContent?.user_results?.result ??
        entry.itemContent?.user?.result ??
        entry.content?.content?.userResult?.result ??
        entry.item?.itemContent?.user_results?.result;

      if (result) pushUser(result);

      // TimelineTimelineModule / nested items
      const items =
        entry.content?.items ??
        entry.content?.moduleItems ??
        entry.items ??
        entry.moduleItems ??
        [];
      for (const it of items) {
        const r =
          it?.item?.itemContent?.user_results?.result ??
          it?.itemContent?.user_results?.result ??
          it?.user_results?.result;
        if (r) pushUser(r);
        else walk(it, 0);
      }

      // Always walk entry to catch schema variants
      walk(entry, 0);
    }

    try {
      const instructions = getTimelineInstructions(json);

      for (const instr of instructions) {
        // TimelineAddEntries / ReplaceEntry
        const entries = instr.entries ?? (instr.entry ? [instr.entry] : []);
        for (const entry of entries) processEntry(entry);

        // TimelineAddToModule — subsequent pages often use this (was previously skipped)
        const moduleItems = instr.moduleItems ?? instr.items ?? [];
        for (const it of moduleItems) {
          const r =
            it?.item?.itemContent?.user_results?.result ??
            it?.itemContent?.user_results?.result ??
            it?.user_results?.result;
          if (r) pushUser(r);
          else walk(it, 0);
        }
      }

      // Always deep-walk the payload so we never miss users after partial preferred-path hits
      walk(json.data, 0);
    } catch (e) {
      console.warn("[auto-x] user extraction error:", e);
    }

    return users;
  }

  function extractCursorFromResponse(json) {
    try {
      const instructions = getTimelineInstructions(json);
      let bottom = undefined;
      for (const instr of instructions) {
        for (const entry of instr.entries ?? []) {
          const c = entry.content || entry;
          const entryType = c?.entryType || c?.__typename || c?.type;
          const cursorType = c?.cursorType || entry.content?.cursorType;
          if (
            entryType === "TimelineTimelineCursor" ||
            cursorType === "Bottom" ||
            cursorType === "ShowMore" ||
            entry.content?.cursorType
          ) {
            if (cursorType === "Bottom" || cursorType === "ShowMore" || !cursorType) {
              const val = c.value ?? entry.content?.value ?? null;
              if (val != null) bottom = val;
            }
          }
        }
        // Some payloads put cursors on the instruction itself
        if (instr.cursor?.value && (instr.cursor.cursorType === "Bottom" || !instr.cursor.cursorType)) {
          bottom = instr.cursor.value;
        }
      }
      // Deep fallback for cursor
      if (bottom === undefined) {
        const walkCursor = (node, depth) => {
          if (!node || depth > 12 || bottom !== undefined) return;
          if (Array.isArray(node)) {
            for (const n of node) walkCursor(n, depth + 1);
            return;
          }
          if (typeof node !== "object") return;
          if (
            (node.cursorType === "Bottom" || node.cursorType === "ShowMore") &&
            typeof node.value === "string"
          ) {
            bottom = node.value;
            return;
          }
          for (const k of Object.keys(node)) walkCursor(node[k], depth + 1);
        };
        walkCursor(json.data, 0);
      }
      return bottom;
    } catch {
      // ignore
    }
    return undefined;
  }

  /** Recent GraphQL batches — replay if content script was not yet listening */
  const recentGraphqlBatches = [];
  const RECENT_BATCH_TTL_MS = 3 * 60 * 1000;
  const RECENT_BATCH_MAX = 40;

  function rememberGraphqlBatch(payload) {
    recentGraphqlBatches.push({ ...payload, _at: Date.now() });
    while (recentGraphqlBatches.length > RECENT_BATCH_MAX) recentGraphqlBatches.shift();
    const cutoff = Date.now() - RECENT_BATCH_TTL_MS;
    while (recentGraphqlBatches.length && recentGraphqlBatches[0]._at < cutoff) {
      recentGraphqlBatches.shift();
    }
  }

  function endpointMatchesStream(endpoint, stream) {
    if (!stream) return true;
    const ep = String(endpoint || "");
    if (stream === "followers") {
      // Followers* but not Following
      return /Follower/i.test(ep) && !/^Following$/i.test(ep);
    }
    if (stream === "following") {
      return /Following/i.test(ep);
    }
    return true;
  }

  function replayGraphqlBatches(stream) {
    const cutoff = Date.now() - RECENT_BATCH_TTL_MS;
    let n = 0;
    for (const b of recentGraphqlBatches) {
      if (b._at < cutoff) continue;
      if (!endpointMatchesStream(b.endpoint, stream)) continue;
      const { _at, ...rest } = b;
      postToContent(rest);
      n++;
    }
    return n;
  }

  // ── Learn GraphQL query IDs from observed requests ─────────────

  function learnQueryId(url) {
    const m = url.match(GRAPHQL_RE);
    if (m) {
      const hash = m[1];
      const ep = m[2];
      seenQueries.set(ep, { hash, seenAt: Date.now() });
      postToContent({
        type: "LEARNED_QUERY",
        endpoint: ep,
        hash,
      });
      return { hash, endpoint: ep };
    }
    return null;
  }

  function isFollowersEndpoint(endpoint) {
    return (
      endpoint === "Followers" ||
      endpoint === "Following" ||
      endpoint === "BlueVerifiedFollowers" ||
      endpoint === "FollowersYouKnow" ||
      /Followers|Following/.test(endpoint)
    );
  }

  function handleGraphqlResponse(url, method, json) {
    if (method !== "GET" && method !== "POST") return;
    const match = url.match(GRAPHQL_RE);
    if (!match) return;
    const endpoint = match[2];
    learnQueryId(url);

    if (!isFollowersEndpoint(endpoint)) return;

    try {
      const users = extractUsersFromResponse(json);
      const cursor = extractCursorFromResponse(json);
      // Always forward list responses (even empty) so walk can detect end-of-list
      const payload = {
        type: "GRAPHQL_DATA",
        endpoint,
        users,
        cursor: cursor === undefined ? null : cursor,
        hasMore: cursor != null,
      };
      rememberGraphqlBatch(payload);
      if (users.length || cursor != null) {
        postToContent(payload);
      }
    } catch {
      // ignore parse errors
    }
  }

  // ── Hook fetch ─────────────────────────────────────────────────

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    const method = (init?.method || (typeof input !== "string" && input?.method) || "GET").toUpperCase();

    if (url.includes("/graphql/")) {
      learnQueryId(url);
    }

    const response = await origFetch.call(this, input, init);

    if (url.includes("/graphql/")) {
      try {
        const clone = response.clone();
        const json = await clone.json();
        handleGraphqlResponse(url, method, json);
      } catch {
        // ignore non-json or aborted
      }
    }

    return response;
  };

  // ── Hook XMLHttpRequest ────────────────────────────────────────

  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    const origSend = xhr.send;
    let _url = "";
    let _method = "GET";

    xhr.open = function (method, url, ...args) {
      _method = String(method).toUpperCase();
      _url = typeof url === "string" ? url : String(url);
      return origOpen.call(this, method, url, ...args);
    };

    xhr.send = function (...args) {
      if (_url.includes("/graphql/")) {
        learnQueryId(_url);
        xhr.addEventListener("load", () => {
          try {
            const json = JSON.parse(xhr.responseText);
            handleGraphqlResponse(_url, _method, json);
          } catch {
            // ignore
          }
        });
      }
      return origSend.call(this, ...args);
    };

    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;
  // Copy static props
  for (const key of Object.keys(OrigXHR)) {
    try {
      window.XMLHttpRequest[key] = OrigXHR[key];
    } catch {
      /* ignore */
    }
  }

  // ── Execute actions (follow/unfollow) ──────────────────────────

  async function executeFollow(targetUserId) {
    const q = seenQueries.get("Follow");
    if (!q) {
      throw new Error("Follow mutation hash not learned yet — perform a manual follow first");
    }

    const body = JSON.stringify({
      variables: { user_id: String(targetUserId) },
      queryId: q.hash,
    });

    const resp = await origFetch.call(window, `https://x.com/i/api/graphql/${q.hash}/Follow`, {
      method: "POST",
      headers: mutationHeaders(),
      body,
      credentials: "include",
    });

    let json = {};
    try {
      json = await resp.json();
    } catch {
      /* empty */
    }

    if (resp.ok) {
      const following = json?.data?.user?.result?.timeline || json?.data?.follow;
      // Treat 200 as success; X payloads vary
      return {
        following: true,
        pendingFollow: json?.data?.follow?.following === false,
      };
    }
    if (resp.status === 403 || resp.status === 404) {
      // Often already following / protected / gone
      return { following: true, alreadyFollowing: true };
    }
    throw new Error(`Follow failed: ${resp.status} ${JSON.stringify(json).slice(0, 200)}`);
  }

  async function executeUnfollow(targetUserId) {
    const q = seenQueries.get("Unfollow");
    if (!q) {
      throw new Error("Unfollow mutation hash not learned yet — perform a manual unfollow first");
    }

    const body = JSON.stringify({
      variables: { user_id: String(targetUserId) },
      queryId: q.hash,
    });

    const resp = await origFetch.call(window, `https://x.com/i/api/graphql/${q.hash}/Unfollow`, {
      method: "POST",
      headers: mutationHeaders(),
      body,
      credentials: "include",
    });

    if (resp.ok) return { following: false };
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* empty */
    }
    throw new Error(`Unfollow failed: ${resp.status} ${text.slice(0, 200)}`);
  }

  // ── Listen for content script commands ─────────────────────────

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "autox-content") return;

    const msg = event.data;

    if (msg.type === "SEED_QUERIES") {
      const q = msg.queries || {};
      for (const [endpoint, info] of Object.entries(q)) {
        if (info?.hash) {
          seenQueries.set(endpoint, { hash: info.hash, seenAt: info.seenAt || Date.now() });
        }
      }
      console.log("[auto-x] seeded queries:", [...seenQueries.keys()]);
      return;
    }

    if (msg.type === "REPLAY_GRAPHQL") {
      const n = replayGraphqlBatches(msg.stream || null);
      console.log("[auto-x] replayed graphql batches:", n, msg.stream || "all");
      return;
    }

    if (msg.type === "EXECUTE_FOLLOW") {
      try {
        const result = await executeFollow(msg.targetUserId);
        postToContent({ type: "ACTION_RESULT", actionId: msg.actionId, ok: true, ...result });
      } catch (e) {
        postToContent({
          type: "ACTION_RESULT",
          actionId: msg.actionId,
          ok: false,
          error: e.message,
        });
      }
    }

    if (msg.type === "EXECUTE_UNFOLLOW") {
      try {
        const result = await executeUnfollow(msg.targetUserId);
        postToContent({ type: "ACTION_RESULT", actionId: msg.actionId, ok: true, ...result });
      } catch (e) {
        postToContent({
          type: "ACTION_RESULT",
          actionId: msg.actionId,
          ok: false,
          error: e.message,
        });
      }
    }

    if (msg.type === "GET_QUERIES") {
      postToContent({
        type: "KNOWN_QUERIES",
        queries: Object.fromEntries(seenQueries),
      });
    }
  });

  console.log("[auto-x] injector active — intercepting X.com GraphQL API");
})();
