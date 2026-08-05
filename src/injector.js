/**
 * MAIN world injector — runs at document_start before the X.com SPA loads.
 * Hooks fetch/XHR to intercept X's internal GraphQL API responses.
 * Also executes follow/unfollow mutations on behalf of the content script.
 */
(() => {
  const SOURCE = "autox-hook";
  const GRAPHQL_RE = /\/graphql\/([^/]+)\/(\w+)$/;

  // Track seen graphql queries for hash self-learning
  const seenQueries = new Map();

  function postToContent(data) {
    try {
      window.postMessage({ source: SOURCE, ...data }, "*");
    } catch {
      // ignore
    }
  }

  // ── Parse user objects from GraphQL responses ──────────────────

  function extractUsersFromResponse(json, endpointType) {
    if (!json?.data) return [];
    const users = [];

    try {
      // Common path: data.user.result.timeline.timeline.instructions[]
      const instructions =
        json.data.user?.result?.timeline?.timeline?.instructions ??
        json.data.user?.result?.timeline_response?.timeline?.instructions ??
        [];

      for (const instr of instructions) {
        if (instr.type !== "TimelineAddEntries" && instr.type !== "TimelineReplaceEntry") continue;
        const entries = instr.entries ?? [];
        for (const entry of entries) {
          const result =
            entry.content?.itemContent?.user_results?.result ??
            entry.content?.itemContent?.user?.result ??
            entry.itemContent?.user_results?.result ??
            entry.itemContent?.user?.result;

          if (!result || result.__typename === "UserUnavailable") continue;

          const legacy = result.legacy ?? {};
          const restId = result.rest_id;
          if (!restId || !legacy.screen_name) continue;

          users.push({
            id: restId,
            username: legacy.screen_name,
            name: legacy.name ?? null,
            verified: result.is_blue_verified || legacy.verified || false,
            protected: legacy.protected ?? false,
            followers_count: legacy.followers_count ?? null,
            following_count: legacy.friends_count ?? null,
            tweet_count: legacy.statuses_count ?? null,
          });
        }
      }

      // Also check for single-user responses (UserByScreenName)
      if (!users.length) {
        const userResult = json.data.user?.result;
        if (userResult?.rest_id && userResult?.legacy?.screen_name) {
          const l = userResult.legacy;
          users.push({
            id: userResult.rest_id,
            username: l.screen_name,
            name: l.name ?? null,
            verified: userResult.is_blue_verified || l.verified || false,
            protected: l.protected ?? false,
            followers_count: l.followers_count ?? null,
            following_count: l.friends_count ?? null,
            tweet_count: l.statuses_count ?? null,
          });
        }
      }

      // Check for viewer (self) info
      const viewerId = json.data.viewer?.user_results?.result?.rest_id;
      if (viewerId && !users.find((u) => u.id === viewerId)) {
        const vr = json.data.viewer.user_results.result;
        const vl = vr.legacy ?? {};
        users.push({
          id: viewerId,
          username: vl.screen_name ?? "unknown",
          name: vl.name ?? null,
          verified: vr.is_blue_verified || vl.verified || false,
          protected: vl.protected ?? false,
          followers_count: vl.followers_count ?? null,
          following_count: vl.friends_count ?? null,
          tweet_count: vl.statuses_count ?? null,
        });
      }
    } catch (e) {
      // defensive — never throw into page context
      console.warn("[auto-x] user extraction error:", e);
    }

    return users;
  }

  function extractCursorFromResponse(json) {
    try {
      const instructions =
        json.data?.user?.result?.timeline?.timeline?.instructions ??
        json.data?.user?.result?.timeline_response?.timeline?.instructions ??
        [];
      for (const instr of instructions) {
        if (instr.type !== "TimelineAddEntries") continue;
        for (const entry of instr.entries ?? []) {
          if (entry.content?.type === "TimelineTimelineCursor") {
            const cursorType = entry.content.cursorType;
            if (cursorType === "Bottom") {
              return entry.content.value ?? null;
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  // ── Learn GraphQL query IDs from observed requests ─────────────

  function learnQueryId(url, endpointType) {
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
    }
    return m ? { hash: m[1], endpoint: m[2] } : null;
  }

  // ── Hook fetch ─────────────────────────────────────────────────

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    // Track mutations for hash learning
    if (url.includes("/graphql/") && (method === "POST" || method === "GET")) {
      const match = url.match(GRAPHQL_RE);
      if (match) {
        const endpoint = match[2];
        learnQueryId(url, endpoint);

        // Intercept Follow/Unfollow mutations to learn hashes
        if (endpoint === "Follow" || endpoint === "Unfollow") {
          seenQueries.set(endpoint, { hash: match[1], seenAt: Date.now() });
        }
      }
    }

    const response = await origFetch.call(this, input, init);

    // Only intercept GET requests for data endpoints
    if (method === "GET" && url.includes("/graphql/")) {
      const match = url.match(GRAPHQL_RE);
      if (match) {
        const endpoint = match[2];
        learnQueryId(url, endpoint);

        if (endpoint === "Followers" || endpoint === "Following") {
          try {
            const clone = response.clone();
            const json = await clone.json();
            const users = extractUsersFromResponse(json, endpoint);
            const cursor = extractCursorFromResponse(json);

            if (users.length) {
              postToContent({
                type: "GRAPHQL_DATA",
                endpoint,
                users,
                cursor,
                hasMore: cursor != null,
              });
            }
          } catch (e) {
            // ignore parse errors on cloned responses
          }
        }
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
      _method = method.toUpperCase();
      _url = typeof url === "string" ? url : String(url);
      return origOpen.call(this, method, url, ...args);
    };

    xhr.send = function (...args) {
      if (_url.includes("/graphql/")) {
        const match = _url.match(GRAPHQL_RE);
        if (match) {
          learnQueryId(_url, match[2]);
        }

        xhr.addEventListener("load", () => {
          if (_method !== "GET") return;
          const match2 = _url.match(GRAPHQL_RE);
          if (!match2) return;
          const endpoint = match2[2];
          if (endpoint !== "Followers" && endpoint !== "Following") return;

          try {
            const json = JSON.parse(xhr.responseText);
            const users = extractUsersFromResponse(json, endpoint);
            const cursor = extractCursorFromResponse(json);

            if (users.length) {
              postToContent({
                type: "GRAPHQL_DATA",
                endpoint,
                users,
                cursor,
                hasMore: cursor != null,
              });
            }
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

  // ── Execute actions (follow/unfollow) on behalf of content ─────

  async function executeFollow(targetUserId) {
    const q = seenQueries.get("Follow");
    if (!q) throw new Error("Follow mutation hash not learned yet — perform a manual follow first");

    const body = JSON.stringify({
      variables: { user_id: targetUserId },
      queryId: q.hash,
    });

    const resp = await origFetch.call(
      window,
      `https://x.com/i/api/graphql/${q.hash}/Follow`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Twitter-Active-User": "yes",
          "X-Twitter-Auth-Type": "OAuth2Session",
        },
        body,
        credentials: "include",
      },
    );

    const json = await resp.json();
    if (resp.ok && json.data?.follow) {
      return { following: true, pendingFollow: json.data.follow.following === false };
    }
    // Check for already-following
    if (!resp.ok && resp.status === 403) {
      return { following: true, alreadyFollowing: true };
    }
    throw new Error(`Follow failed: ${resp.status} ${JSON.stringify(json)}`);
  }

  async function executeUnfollow(targetUserId) {
    const q = seenQueries.get("Unfollow");
    if (!q) throw new Error("Unfollow mutation hash not learned yet — perform a manual unfollow first");

    const body = JSON.stringify({
      variables: { user_id: targetUserId },
      queryId: q.hash,
    });

    const resp = await origFetch.call(
      window,
      `https://x.com/i/api/graphql/${q.hash}/Unfollow`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Twitter-Active-User": "yes",
          "X-Twitter-Auth-Type": "OAuth2Session",
        },
        body,
        credentials: "include",
      },
    );

    if (resp.ok) return { following: false };
    throw new Error(`Unfollow failed: ${resp.status}`);
  }

  // ── Listen for content script commands ─────────────────────────

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "autox-content") return;

    const msg = event.data;

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
