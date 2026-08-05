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

  function authHeaders(contentType) {
    const csrf = getCookie("ct0");
    const headers = {
      Authorization: "Bearer " + decodeURIComponent(WEB_BEARER),
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Client-Language": "en",
      Accept: "*/*",
    };
    if (contentType) headers["Content-Type"] = contentType;
    if (csrf) {
      headers["X-Csrf-Token"] = csrf;
      headers["x-csrf-token"] = csrf;
    }
    return headers;
  }

  function mutationHeaders() {
    return authHeaders("application/json");
  }

  function formHeaders() {
    return authHeaders("application/x-www-form-urlencoded");
  }

  function getHeaders() {
    // GET must not send Content-Type: application/json (breaks some 1.1 endpoints)
    return authHeaders(null);
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

    function pushUser(result, meta) {
      if (!result || typeof result !== "object") return;

      // Nested wrapper (Result / user_results)
      if (
        result.result &&
        typeof result.result === "object" &&
        (result.result.rest_id ||
          result.result.legacy ||
          result.result.core ||
          result.result.__typename === "User" ||
          result.result.__typename === "UserUnavailable")
      ) {
        result = result.result;
      }

      const typename = result.__typename || "";
      const unavailable =
        typename === "UserUnavailable" ||
        typename === "UserTombstone" ||
        !!(meta && meta.unavailable);

      const legacy = result.legacy && typeof result.legacy === "object" ? result.legacy : {};
      const core = result.core && typeof result.core === "object" ? result.core : {};
      const restId =
        result.rest_id != null
          ? String(result.rest_id)
          : result.id_str != null
            ? String(result.id_str)
            : result.id != null && typeof result.id !== "object"
              ? String(result.id)
              : null;

      let screen =
        legacy.screen_name ||
        core.screen_name ||
        core.screenName ||
        result.screen_name ||
        result.username ||
        null;

      // Never drop a list entry just because username is missing / account unavailable
      if (!restId) return;
      if (seen.has(restId)) {
        // Upgrade previous stub if we later get a better record
        const prev = users.find((u) => u.id === restId);
        if (prev && screen && (!prev.username || prev.username.startsWith("id:"))) {
          prev.username = screen;
          prev.name = legacy.name ?? core.name ?? result.name ?? prev.name;
          if (!unavailable) prev.unavailable = false;
        }
        return;
      }

      // Skip pure non-user nodes that only have numeric ids (tweets etc.)
      if (
        typename &&
        typename !== "User" &&
        typename !== "UserUnavailable" &&
        typename !== "UserTombstone" &&
        !legacy.screen_name &&
        !core.screen_name &&
        !core.screenName &&
        !unavailable
      ) {
        // Still allow if it looks like a user (has friends_count / followers_count)
        if (legacy.followers_count == null && legacy.friends_count == null) return;
      }

      if (!screen) screen = "id:" + restId;

      seen.add(restId);
      users.push({
        id: restId,
        username: screen,
        name: legacy.name ?? core.name ?? result.name ?? null,
        verified: !!(result.is_blue_verified || legacy.verified),
        protected: legacy.protected ?? false,
        followers_count: legacy.followers_count ?? null,
        following_count: legacy.friends_count ?? null,
        tweet_count: legacy.statuses_count ?? null,
        unavailable: !!unavailable,
      });
    }

    function walk(node, depth) {
      if (!node || depth > 16) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (typeof node !== "object") return;

      if (
        node.__typename === "User" ||
        node.__typename === "UserUnavailable" ||
        node.__typename === "UserTombstone" ||
        ((node.rest_id || node.id_str) &&
          (node.legacy?.screen_name ||
            node.core?.screen_name ||
            node.core?.screenName ||
            node.__typename === "User"))
      ) {
        pushUser(node);
      }

      if (node.user_results?.result) pushUser(node.user_results.result);
      if (node.user_results && node.user_results.rest_id) pushUser(node.user_results);
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
        entry.item?.itemContent?.user_results?.result ??
        entry.content?.user_results?.result;

      if (result) pushUser(result);

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

      walk(entry, 0);
    }

    try {
      const instructions = getTimelineInstructions(json);

      // ONLY extract from timeline instructions / modules — not the whole payload.
      // Deep-walking json.data pulls the profile owner + unrelated users → count inflation
      // (e.g. following 540 vs real 536).
      for (const instr of instructions) {
        const entries = instr.entries ?? (instr.entry ? [instr.entry] : []);
        for (const entry of entries) processEntry(entry);

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

      // If instructions path found nothing, walk timeline node only (not user root)
      if (!users.length) {
        const timeline =
          json.data?.user?.result?.timeline?.timeline ??
          json.data?.user?.result?.timeline_v2?.timeline ??
          json.data?.user?.result?.timeline_response?.timeline ??
          null;
        if (timeline) walk(timeline, 0);
      }
    } catch (e) {
      console.warn("[auto-x] user extraction error:", e);
    }

    return users;
  }

  /**
   * @returns {{ bottom: string|null, sawTimeline: boolean }}
   * bottom: Bottom/ShowMore cursor value, or null if absent
   * sawTimeline: true when we recognized a list timeline payload (can trust hasMore)
   */
  function extractCursorFromResponse(json) {
    let bottom = null;
    let sawTimeline = false;
    let sawAnyCursor = false;
    try {
      const instructions = getTimelineInstructions(json);
      if (instructions.length) sawTimeline = true;

      for (const instr of instructions) {
        for (const entry of instr.entries ?? []) {
          const c = entry.content || entry;
          const entryType = c?.entryType || c?.__typename || c?.type;
          const cursorType = c?.cursorType || entry.content?.cursorType;
          if (
            entryType === "TimelineTimelineCursor" ||
            cursorType === "Bottom" ||
            cursorType === "ShowMore" ||
            cursorType === "Top" ||
            entry.content?.cursorType
          ) {
            sawAnyCursor = true;
            if (cursorType === "Bottom" || cursorType === "ShowMore") {
              const val = c.value ?? entry.content?.value ?? null;
              if (val != null) bottom = val;
            }
          }
          // Module / user entries mean this is a real list timeline
          if (
            entryType === "TimelineTimelineItem" ||
            entryType === "TimelineTimelineModule" ||
            c?.itemContent ||
            c?.items
          ) {
            sawTimeline = true;
          }
        }
        if (instr.moduleItems?.length || instr.items?.length) sawTimeline = true;
        if (instr.cursor?.value) {
          sawAnyCursor = true;
          if (instr.cursor.cursorType === "Bottom" || !instr.cursor.cursorType) {
            bottom = instr.cursor.value;
          }
        }
      }

      // Deep fallback for Bottom cursor if instructions path missed it
      if (bottom == null) {
        const walkCursor = (node, depth) => {
          if (!node || depth > 12) return;
          if (Array.isArray(node)) {
            for (const n of node) walkCursor(n, depth + 1);
            return;
          }
          if (typeof node !== "object") return;
          if (node.cursorType === "Bottom" || node.cursorType === "ShowMore") {
            sawAnyCursor = true;
            sawTimeline = true;
            if (typeof node.value === "string") bottom = node.value;
          } else if (node.cursorType === "Top") {
            sawAnyCursor = true;
            sawTimeline = true;
          }
          for (const k of Object.keys(node)) walkCursor(node[k], depth + 1);
        };
        walkCursor(json.data, 0);
      }

      if (sawAnyCursor) sawTimeline = true;
    } catch {
      // ignore
    }
    return { bottom, sawTimeline };
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
    if (!endpoint) return false;
    // Strict: only real list endpoints (avoid matching random *Following* names on Home)
    if (endpoint === "Following") return true;
    if (endpoint === "BlueVerifiedFollowers") return true;
    if (endpoint === "FollowersYouKnow") return true;
    if (endpoint === "Followers") return true;
    // Newer/variant names still start with Followers…
    if (/^Followers\w*$/i.test(endpoint)) return true;
    return false;
  }

  function extractProfileMeta(json) {
    try {
      const r = json?.data?.user?.result;
      if (!r || r.__typename === "UserUnavailable") return null;
      const legacy = r.legacy || {};
      const core = r.core || {};
      const followers =
        legacy.followers_count ?? r.legacy?.followers_count ?? null;
      const following = legacy.friends_count ?? r.legacy?.friends_count ?? null;
      const username = legacy.screen_name || core.screen_name || core.screenName || null;
      const id = r.rest_id != null ? String(r.rest_id) : null;
      if (followers == null && following == null && !id) return null;
      return {
        id,
        username,
        followers_count: followers != null ? Number(followers) : null,
        following_count: following != null ? Number(following) : null,
      };
    } catch {
      return null;
    }
  }

  function handleGraphqlResponse(url, method, json) {
    if (method !== "GET" && method !== "POST") return;
    const match = url.match(GRAPHQL_RE);
    if (!match) return;
    const endpoint = match[2];
    learnQueryId(url);

    // Profile counts from UserByScreenName / UserByRestId
    if (
      endpoint === "UserByScreenName" ||
      endpoint === "UserByRestId" ||
      endpoint === "UserResultByScreenName" ||
      /^UserBy/i.test(endpoint)
    ) {
      const meta = extractProfileMeta(json);
      if (meta) {
        postToContent({ type: "PROFILE_META", meta });
      }
    }

    if (!isFollowersEndpoint(endpoint)) return;

    try {
      const users = extractUsersFromResponse(json);
      const { bottom, sawTimeline } = extractCursorFromResponse(json);
      // hasMore:
      //  - true  → Bottom cursor present, keep scrolling
      //  - false → recognized timeline and no Bottom cursor (end of list)
      //  - null  → inconclusive (don't stop on this alone)
      let hasMore = null;
      if (bottom != null) hasMore = true;
      else if (sawTimeline) hasMore = false;

      // Owner profile counts often sit on the same Followers/Following payload
      const profileMeta = extractProfileMeta(json);

      const payload = {
        type: "GRAPHQL_DATA",
        endpoint,
        users,
        cursor: bottom,
        hasMore,
        profileMeta,
      };
      rememberGraphqlBatch(payload);
      // Always forward list responses (including empty final page) so walk can auto-stop
      postToContent(payload);
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

  function extractApiErrors(json) {
    if (!json) return [];
    if (Array.isArray(json.errors)) {
      return json.errors.map((e) => e.message || e.code || JSON.stringify(e));
    }
    if (json.error) return [String(json.error)];
    if (json.errors && typeof json.errors === "object") {
      return [JSON.stringify(json.errors)];
    }
    return [];
  }

  /** True only for explicit "already following" style errors — not every 403 */
  function isAlreadyFollowingError(status, json) {
    const blob = JSON.stringify(json || {}).toLowerCase();
    if (/already\s*(follow|requested)|you.?re already|previously followed|已关注|已经关注/.test(blob)) {
      return true;
    }
    // Twitter legacy codes: 160 already requested, 162 blocked, 108 user not found — only 160/34-ish already
    const codes = (json?.errors || []).map((e) => e.code).filter((c) => c != null);
    if (codes.includes(160)) return true; // already requested to follow
    // Some builds return 403 with code 158 (blocked) — NOT success
    return false;
  }

  /**
   * Check relationship via friendships/show.json
   */
  async function verifyFollowing(targetUserId) {
    const urls = [
      "https://x.com/i/api/1.1/friendships/show.json?target_id=" +
        encodeURIComponent(String(targetUserId)),
      "https://api.x.com/1.1/friendships/show.json?target_id=" +
        encodeURIComponent(String(targetUserId)),
    ];
    let lastErr = null;
    for (const url of urls) {
      try {
        const resp = await origFetch.call(window, url, {
          method: "GET",
          headers: getHeaders(),
          credentials: "include",
        });
        let json = {};
        try {
          json = await resp.json();
        } catch {
          /* empty */
        }
        if (!resp.ok) {
          lastErr =
            "verify failed: " +
            resp.status +
            " " +
            (extractApiErrors(json).join("; ") || "");
          continue;
        }
        const src = json?.relationship?.source || {};
        const following = !!(src.following || src.following_requested);
        const pending = !!src.following_requested && !src.following;
        return { following, pendingFollow: pending, raw: json };
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    throw new Error(lastErr || "verify failed");
  }

  /** Stable v1.1 friendships API — works without learning GraphQL hash */
  async function followRest(targetUserId) {
    const endpoints = [
      "https://x.com/i/api/1.1/friendships/create.json",
      "https://api.x.com/1.1/friendships/create.json",
    ];
    let lastErr = null;
    for (const endpoint of endpoints) {
      try {
        const resp = await origFetch.call(window, endpoint, {
          method: "POST",
          headers: formHeaders(),
          body:
            "user_id=" +
            encodeURIComponent(String(targetUserId)) +
            "&skip_status=true",
          credentials: "include",
        });
        let json = {};
        try {
          json = await resp.json();
        } catch {
          /* empty */
        }
        const errs = extractApiErrors(json);
        if (!resp.ok) {
          if (isAlreadyFollowingError(resp.status, json)) {
            return {
              following: true,
              alreadyFollowing: true,
              method: "rest",
              pendingFollow: false,
            };
          }
          lastErr =
            "REST Follow failed: " +
            resp.status +
            " " +
            (errs.join("; ") || JSON.stringify(json).slice(0, 160));
          continue;
        }
        // 200 → user object. following:false is rare right after create (race) — still ok if id present
        const hasUser =
          !!(json && (json.id_str || json.id || json.screen_name || json.rest_id));
        if (!hasUser && errs.length) {
          lastErr = "REST Follow: " + errs.join("; ");
          continue;
        }
        return {
          following: true,
          method: "rest",
          pendingFollow: false,
          username: json.screen_name || null,
          createOk: true,
        };
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    throw new Error(lastErr || "REST Follow failed");
  }

  async function unfollowRest(targetUserId) {
    const resp = await origFetch.call(window, "https://x.com/i/api/1.1/friendships/destroy.json", {
      method: "POST",
      headers: formHeaders(),
      body: "user_id=" + encodeURIComponent(String(targetUserId)) + "&skip_status=true",
      credentials: "include",
    });
    if (resp.ok) return { following: false, method: "rest" };
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* empty */
    }
    throw new Error("REST Unfollow failed: " + resp.status + " " + text.slice(0, 180));
  }

  async function followGraphql(targetUserId, hash) {
    const body = JSON.stringify({
      variables: { user_id: String(targetUserId) },
      queryId: hash,
    });
    const resp = await origFetch.call(window, `https://x.com/i/api/graphql/${hash}/Follow`, {
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
    const errs = extractApiErrors(json);
    if (errs.length) {
      if (isAlreadyFollowingError(resp.status, json)) {
        return { following: true, alreadyFollowing: true, method: "graphql", needsVerify: true };
      }
      throw new Error("GraphQL Follow: " + errs.join("; "));
    }
    if (!resp.ok) {
      if (isAlreadyFollowingError(resp.status, json)) {
        return { following: true, alreadyFollowing: true, method: "graphql", needsVerify: true };
      }
      throw new Error(
        "GraphQL Follow failed: " + resp.status + " " + JSON.stringify(json).slice(0, 200),
      );
    }
    // GraphQL sometimes returns 200 with empty/unrelated data — must verify
    const pendingFollow = json?.data?.follow?.following === false;
    return {
      following: true,
      method: "graphql",
      pendingFollow,
      needsVerify: true,
    };
  }

  async function executeFollow(targetUserId) {
    const q = seenQueries.get("Follow");
    const errors = [];
    let attempt = null;

    // Prefer REST (stable); GraphQL as secondary
    try {
      attempt = await followRest(targetUserId);
    } catch (e) {
      errors.push(e.message || String(e));
    }
    if (!attempt && q?.hash) {
      try {
        attempt = await followGraphql(targetUserId, q.hash);
      } catch (e2) {
        errors.push(e2.message || String(e2));
      }
    }

    if (!attempt) {
      throw new Error(errors.join(" | ") || "Follow failed");
    }

    // Verify with retries; if create/already-following succeeded but verify API flakes, still ok
    let lastVerifyErr = null;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 500 + i * 500));
      try {
        const v = await verifyFollowing(targetUserId);
        if (v.following) {
          return {
            following: true,
            alreadyFollowing: !!attempt.alreadyFollowing,
            pendingFollow: !!v.pendingFollow,
            method: attempt.method || "verified",
            username: attempt.username || null,
            verified: true,
          };
        }
        lastVerifyErr = "friendships/show 仍显示未关注";
      } catch (e) {
        lastVerifyErr = e.message || String(e);
      }
    }

    // create returned 200 / already following — trust that if verify is flaky
    if (attempt.alreadyFollowing || attempt.createOk || attempt.method === "rest" || attempt.method === "graphql") {
      console.warn(
        "[auto-x] follow accepted without hard verify:",
        lastVerifyErr,
        "method=",
        attempt.method,
      );
      return {
        following: true,
        alreadyFollowing: !!attempt.alreadyFollowing,
        pendingFollow: false,
        method: attempt.method,
        username: attempt.username || null,
        verified: false,
        warning: lastVerifyErr || null,
      };
    }

    throw new Error(
      lastVerifyErr
        ? "关注未生效（" + lastVerifyErr + "）"
        : "关注未生效",
    );
  }

  async function executeUnfollow(targetUserId) {
    const q = seenQueries.get("Unfollow");
    const errors = [];
    try {
      return await unfollowRest(targetUserId);
    } catch (e) {
      errors.push(e.message || String(e));
    }
    if (q?.hash) {
      try {
        const body = JSON.stringify({
          variables: { user_id: String(targetUserId) },
          queryId: q.hash,
        });
        const resp = await origFetch.call(
          window,
          `https://x.com/i/api/graphql/${q.hash}/Unfollow`,
          {
            method: "POST",
            headers: mutationHeaders(),
            body,
            credentials: "include",
          },
        );
        if (resp.ok) return { following: false, method: "graphql" };
        let text = "";
        try {
          text = await resp.text();
        } catch {
          /* empty */
        }
        throw new Error("GraphQL Unfollow failed: " + resp.status + " " + text.slice(0, 180));
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    throw new Error(errors.join(" | ") || "Unfollow failed");
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
