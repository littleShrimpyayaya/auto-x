/**
 * ISOLATED world content script — bridge injector ↔ background.
 * Auto-scroll ONLY on explicit list sync, and ONLY while URL is the list page.
 * Auto-follow is API-only and never scrolls the page.
 */
(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  let sessionUser = null;
  let loggedIn = null; // null = unknown, true/false once probed
  let activeWalk = null;
  let batchBuffer = [];
  let batchTimer = null;
  let scrollTimer = null;
  let pathWatchTimer = null;

  const BATCH_INTERVAL = 1200;
  const HEARTBEAT_INTERVAL = 8000;
  const BATCH_MAX = 100;

  function sendToBg(msg) {
    try {
      const p = api.runtime.sendMessage(msg);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* extension context invalidated */
    }
  }

  // ── Login / session detection ──────────────────────────────────

  function looksLoggedOut() {
    const path = location.pathname || "";
    if (
      path.startsWith("/i/flow/login") ||
      path.startsWith("/login") ||
      path.startsWith("/i/flow/signup") ||
      path === "/logout"
    ) {
      return true;
    }
    if (document.querySelector('[data-testid="loginButton"], a[href="/login"]')) {
      if (
        !document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') &&
        !document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')
      ) {
        return true;
      }
    }
    return false;
  }

  function extractAvatar(root) {
    try {
      const img =
        root?.querySelector?.('img[src*="profile_images"]') ||
        document.querySelector(
          '[data-testid="SideNav_AccountSwitcher_Button"] img[src*="profile_images"]',
        );
      return img?.src || null;
    } catch {
      return null;
    }
  }

  function detectSessionUser() {
    try {
      const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (btn) {
        const label = btn.getAttribute("aria-label") || btn.textContent || "";
        const m = label.match(/@(\w+)/);
        const nameMatch = label.match(/^([^@]+)/);
        if (m) {
          return {
            username: m[1],
            id: null,
            name: nameMatch ? nameMatch[1].trim() || null : null,
            avatar: extractAvatar(btn),
          };
        }
      }
    } catch {
      /* ignore */
    }

    try {
      const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (profileLink?.href) {
        const m = profileLink.href.match(/(?:x|twitter)\.com\/([^/?#]+)/i);
        if (
          m &&
          m[1] &&
          !["home", "explore", "search", "i", "settings", "notifications", "messages"].includes(
            m[1].toLowerCase(),
          )
        ) {
          return {
            username: m[1],
            id: null,
            name: null,
            avatar: extractAvatar(profileLink),
          };
        }
      }
    } catch {
      /* ignore */
    }

    try {
      const scripts = document.querySelectorAll("script[type='application/json']");
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent);
          const viewer = data?.viewer || data?.user || data?.currentUser;
          if (viewer?.screen_name || viewer?.username) {
            return {
              id: viewer.id != null ? String(viewer.id) : null,
              username: viewer.screen_name || viewer.username,
              name: viewer.name ?? null,
              avatar: viewer.profile_image_url_https || viewer.avatar || null,
            };
          }
        } catch {
          /* next */
        }
      }
    } catch {
      /* ignore */
    }

    try {
      if (document.cookie.includes("ct0=")) {
        return null;
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  function evaluateLogin() {
    if (looksLoggedOut()) {
      loggedIn = false;
      sessionUser = null;
      return { loggedIn: false, user: null };
    }
    const found = detectSessionUser();
    if (found?.username) {
      sessionUser = {
        id: found.id || sessionUser?.id || null,
        username: found.username,
        name: found.name || sessionUser?.name || null,
        avatar: found.avatar || sessionUser?.avatar || null,
      };
      loggedIn = true;
      return { loggedIn: true, user: sessionUser };
    }
    const hasApp =
      !!document.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
      !!document.querySelector('[data-testid="primaryColumn"]');
    if (hasApp && document.cookie.includes("ct0=")) {
      loggedIn = true;
      return { loggedIn: true, user: sessionUser };
    }
    if (looksLoggedOut()) {
      loggedIn = false;
      return { loggedIn: false, user: null };
    }
    return { loggedIn: loggedIn, user: sessionUser };
  }

  let detectTries = 0;
  function tryDetect() {
    const state = evaluateLogin();
    detectTries++;
    if (state.loggedIn && state.user?.username) {
      sendToBg({ type: "SESSION_USER", user: state.user, loggedIn: true });
      return;
    }
    if (state.loggedIn === false) {
      sendToBg({ type: "SESSION_USER", user: null, loggedIn: false });
      return;
    }
    if (detectTries < 20) setTimeout(tryDetect, 1000);
  }
  setTimeout(tryDetect, 800);

  // ── Path helpers ───────────────────────────────────────────────

  function currentPathStream() {
    const path = location.pathname || "";
    // Prefer more specific segment at end: /user/followers, /user/following
    if (/\/followers(?:\/|$)/.test(path)) return "followers";
    if (/\/following(?:\/|$)/.test(path)) return "following";
    return null;
  }

  function isOnListPageFor(stream) {
    if (!stream) return false;
    return currentPathStream() === stream;
  }

  // ── Batch ingest ───────────────────────────────────────────────

  function flushBatch() {
    if (!batchBuffer.length) return;
    const stream = activeWalk?.stream || currentPathStream();
    if (!stream) {
      // Not on a list page and not walking — hold buffer briefly, do not drop yet
      return;
    }

    while (batchBuffer.length) {
      const batch = batchBuffer.splice(0, BATCH_MAX);
      sendToBg({
        type: "INGEST_BATCH",
        walk: { stream },
        users: batch.map((u) => ({
          id: u.id,
          username: u.username,
          name: u.name ?? null,
          verified: u.verified ?? false,
          protected: u.protected ?? false,
          unavailable: !!u.unavailable,
          followers_count: u.followers_count ?? null,
          following_count: u.following_count ?? null,
          tweet_count: u.tweet_count ?? null,
        })),
      });
    }
  }

  function scheduleFlush() {
    if (batchTimer) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flushBatch();
    }, BATCH_INTERVAL);
  }

  function addToBatch(users) {
    const existing = new Set(batchBuffer.map((u) => u.id));
    for (const u of users) {
      if (!u?.id || existing.has(u.id)) continue;
      // Username may be stub "id:123" — still ingest so we never drop rest_id
      if (!u.username) u.username = "id:" + u.id;
      batchBuffer.push(u);
      existing.add(u.id);
    }
    if (batchBuffer.length >= BATCH_MAX) {
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      flushBatch();
    } else {
      scheduleFlush();
    }
  }

  /**
   * DOM backup: scrape visible UserCells so virtualized-list gaps still get usernames.
   * IDs often appear in avatar URLs or data attributes when GraphQL skipped a row.
   */
  function scrapeVisibleListUsers() {
    const out = [];
    const seen = new Set();
    try {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      for (const cell of cells) {
        let username = null;
        let id = null;
        let name = null;

        const links = cell.querySelectorAll('a[href^="/"]');
        for (const a of links) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
          if (!m) continue;
          const handle = m[1];
          if (
            [
              "home",
              "explore",
              "search",
              "i",
              "settings",
              "notifications",
              "messages",
              "compose",
              "intent",
            ].includes(handle.toLowerCase())
          ) {
            continue;
          }
          username = handle;
          break;
        }

        const img =
          cell.querySelector('img[src*="profile_images"]') ||
          cell.querySelector('img[src*="twimg"]');
        if (img?.src) {
          // .../profile_images/1234567890/xxx.jpg  — not always user id
          const idm = img.src.match(/\/profile_images\/(\d+)\//);
          // Sometimes srcset / data-user-id
        }
        const anyId =
          cell.querySelector("[data-user-id]")?.getAttribute("data-user-id") ||
          cell.getAttribute("data-user-id");
        if (anyId) id = String(anyId);

        // name from first strong/span text
        const nameEl =
          cell.querySelector('[dir="ltr"] > span > span') ||
          cell.querySelector("span span");
        if (nameEl?.textContent) name = nameEl.textContent.trim() || null;

        if (!username && !id) continue;
        // Without GraphQL id we cannot key storage reliably — skip id-less for now
        // unless we already have this username in buffer from graphql
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          username: username || "id:" + id,
          name,
          verified: false,
          protected: false,
          unavailable: false,
          _fromDom: true,
        });
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  function clearBatchTimer() {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
  }

  // ── Messages from injector (MAIN world) ────────────────────────

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "autox-hook") return;
    const msg = event.data;

    if (msg.type === "PROFILE_META") {
      if (msg.meta) sendToBg({ type: "PROFILE_META", meta: msg.meta });
      return;
    }

    if (msg.type === "GRAPHQL_DATA") {
      if (!sessionUser?.username) tryDetect();

      if (msg.profileMeta) {
        sendToBg({ type: "PROFILE_META", meta: msg.profileMeta });
      }

      const pathStream = currentPathStream();
      const walkStream = activeWalk?.stream || null;

      // Only accept list data when walking that stream OR user is on that list page.
      // Never ingest / scroll from Home / Explore noise.
      if (!walkStream && !pathStream) {
        return;
      }

      // If walking, ignore wrong-stream endpoints (e.g. Following while on Followers walk)
      if (walkStream && msg.endpoint) {
        const ep = String(msg.endpoint);
        if (walkStream === "followers" && !/Follower/i.test(ep)) return;
        if (walkStream === "following" && !/Following/i.test(ep)) return;
      }

      if (msg.users?.length) {
        addToBatch(msg.users);
        // First page must land quickly — flush immediately when we have a stream
        if (activeWalk || pathStream) {
          clearBatchTimer();
          flushBatch();
        }
      }

      if (activeWalk) {
        let newCount = 0;
        if (msg.users?.length) {
          if (!activeWalk.seenIds) activeWalk.seenIds = new Set();
          for (const u of msg.users) {
            if (u?.id && !activeWalk.seenIds.has(u.id)) {
              activeWalk.seenIds.add(u.id);
              newCount++;
            }
          }
        }

        if (newCount > 0) {
          activeWalk.idlePages = 0;
          activeWalk.consecutiveNoNew = 0;
          activeWalk.lastUsersAt = Date.now();
          activeWalk.gotUsers = true;
          activeWalk.noMore = false;
          if (activeWalk.endTimer) {
            clearTimeout(activeWalk.endTimer);
            activeWalk.endTimer = null;
          }
        } else {
          activeWalk.idlePages = (activeWalk.idlePages || 0) + 1;
          activeWalk.consecutiveNoNew = (activeWalk.consecutiveNoNew || 0) + 1;
        }

        // API says no more pages (ignore briefly after start — REPLAY may include stale last-page)
        const canTrustEnd = Date.now() >= (activeWalk.ignoreEndUntil || 0);
        if (msg.hasMore === false && canTrustEnd) {
          // Last page: scrape DOM, flush, then wait a bit so we don't drop trailing rows
          const domUsers = scrapeVisibleListUsers();
          if (domUsers.length) addToBatch(domUsers);
          clearBatchTimer();
          flushBatch();
          activeWalk.noMore = true;
          activeWalk.apiEndedAt = Date.now();
          if (activeWalk.endTimer) clearTimeout(activeWalk.endTimer);
          // Give list time to paint last cells + one more DOM scrape
          activeWalk.endTimer = setTimeout(() => {
            if (!activeWalk?.noMore) return;
            const extra = scrapeVisibleListUsers();
            if (extra.length) {
              addToBatch(extra);
              flushBatch();
            }
            endWalkNatural(
              !msg.users?.length || newCount === 0 ? "api-end" : "api-end-last-page",
            );
          }, newCount > 0 ? 2500 : 1500);
        } else if (msg.hasMore === true) {
          activeWalk.noMore = false;
          activeWalk.apiEndedAt = null;
          if (activeWalk.endTimer) {
            clearTimeout(activeWalk.endTimer);
            activeWalk.endTimer = null;
          }
        }
      }
    }

    if (msg.type === "ACTION_RESULT") {
      const line =
        (msg.ok ? "[auto-x] ✓ ACTION ok " : "[auto-x] ✗ ACTION fail ") +
        (msg.actionId || "") +
        (msg.error ? " " + msg.error : "");
      console.log(line);
      sendToBg({
        type: "ACTION_COMPLETED",
        actionId: msg.actionId,
        ok: msg.ok,
        error: msg.error,
        alreadyFollowing: msg.alreadyFollowing,
        pendingFollow: msg.pendingFollow,
      });
    }
    if (msg.type === "LEARNED_QUERY") {
      sendToBg({ type: "QUERY_LEARNED", endpoint: msg.endpoint, hash: msg.hash });
    }
  });

  // ── Walk / scroll control ──────────────────────────────────────

  function stopAutoScroll() {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
  }

  function stopPathWatch() {
    if (pathWatchTimer) {
      clearInterval(pathWatchTimer);
      pathWatchTimer = null;
    }
  }

  function hardStopWalk(reason, notifyBg) {
    stopAutoScroll();
    stopPathWatch();
    clearBatchTimer();
    if (activeWalk?.endTimer) {
      clearTimeout(activeWalk.endTimer);
      activeWalk.endTimer = null;
    }
    flushBatch();
    const stream = activeWalk?.stream || null;
    const seen = activeWalk?.seenIds?.size || 0;
    if (notifyBg && stream) {
      sendToBg({
        type: "WALK_ENDED",
        walk: { stream },
        reason: reason || "stop",
        seenCount: seen,
      });
    }
    activeWalk = null;
    // Drop orphan buffer that has no stream target (e.g. left list page)
    if (!currentPathStream()) batchBuffer = [];
    console.log("[auto-x] walk hard-stop:", reason || "", stream || "", "seen=", seen);
  }

  function endWalkNatural(reason) {
    if (!activeWalk) return;
    console.log(
      "[auto-x] walk finished:",
      activeWalk.stream,
      reason || "",
      "users=",
      activeWalk.seenIds?.size || 0,
    );
    hardStopWalk(reason || "done", true);
  }

  /** DOM fallback: "You've reached the end" / empty list after scroll */
  function looksLikeListEnd() {
    try {
      const text = (document.body?.innerText || "").slice(-2500);
      if (/You.ve reached the end|已经到底|没有更多|Nothing to see here|暂无内容/i.test(text)) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function ensurePathWatch() {
    stopPathWatch();
    pathWatchTimer = setInterval(() => {
      if (!activeWalk) {
        stopPathWatch();
        return;
      }
      if (!isOnListPageFor(activeWalk.stream)) {
        // User left followers/following — NEVER keep scrolling Home tweets
        console.warn(
          "[auto-x] left list page during walk, stopping scroll. path=",
          location.pathname,
        );
        hardStopWalk("left-list-page", true);
      }
    }, 800);
  }

  function autoScroll() {
    if (!activeWalk) return;

    // Hard guard: never scroll unless on the correct list URL
    if (!isOnListPageFor(activeWalk.stream)) {
      hardStopWalk("wrong-page-scroll-guard", true);
      return;
    }

    // DOM backup every few scrolls — catch rows GraphQL extraction missed
    activeWalk.scrollTicks = (activeWalk.scrollTicks || 0) + 1;
    if (activeWalk.scrollTicks % 2 === 0) {
      const domUsers = scrapeVisibleListUsers();
      if (domUsers.length) {
        const before = activeWalk.seenIds?.size || 0;
        addToBatch(domUsers);
        for (const u of domUsers) {
          if (u.id && activeWalk.seenIds && !activeWalk.seenIds.has(u.id)) {
            activeWalk.seenIds.add(u.id);
            activeWalk.lastUsersAt = Date.now();
            activeWalk.gotUsers = true;
            activeWalk.consecutiveNoNew = 0;
          }
        }
        if ((activeWalk.seenIds?.size || 0) > before) {
          clearBatchTimer();
          flushBatch();
        }
      }
    }

    // API already said end — let endTimer finish; keep light scroll once more
    if (activeWalk.noMore) {
      const domUsers = scrapeVisibleListUsers();
      if (domUsers.length) {
        addToBatch(domUsers);
        flushBatch();
      }
      // endTimer handles stop; don't force-end here and drop trailing users
      if (!activeWalk.endTimer) {
        clearBatchTimer();
        flushBatch();
        endWalkNatural("api-end-scroll");
      }
      return;
    }

    const h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    const nearBottom = y + window.innerHeight >= h - 120;

    if (activeWalk.lastHeight && h <= activeWalk.lastHeight + 4) {
      activeWalk.stuckScrolls = (activeWalk.stuckScrolls || 0) + 1;
    } else {
      activeWalk.stuckScrolls = 0;
      activeWalk.lastHeight = h;
    }

    const idleMs = Date.now() - (activeWalk.lastUsersAt || activeWalk.startedAt || Date.now());
    const gotUsers = !!activeWalk.gotUsers;
    const noNew = activeWalk.consecutiveNoNew || 0;
    // Don't stop too early: need solid idle + stable bottom after we already got users
    const minWalkMs = 8000;
    const walkedLongEnough = Date.now() - (activeWalk.startedAt || 0) > minWalkMs;

    if (
      gotUsers &&
      walkedLongEnough &&
      nearBottom &&
      activeWalk.stuckScrolls >= 4 &&
      idleMs > 9000
    ) {
      const extra = scrapeVisibleListUsers();
      if (extra.length) {
        addToBatch(extra);
        flushBatch();
      }
      endWalkNatural("scroll-bottom-stable");
      return;
    }
    if (gotUsers && walkedLongEnough && activeWalk.stuckScrolls >= 5 && idleMs > 12000) {
      endWalkNatural("scroll-stable");
      return;
    }
    if (gotUsers && walkedLongEnough && noNew >= 4 && activeWalk.stuckScrolls >= 3 && idleMs > 10000) {
      endWalkNatural("no-new-users");
      return;
    }
    if (
      gotUsers &&
      walkedLongEnough &&
      looksLikeListEnd() &&
      activeWalk.stuckScrolls >= 2 &&
      idleMs > 6000
    ) {
      endWalkNatural("dom-end-marker");
      return;
    }
    // Empty list edge case
    if (!gotUsers && idleMs > 25000 && activeWalk.stuckScrolls >= 5) {
      endWalkNatural("empty-or-stuck");
      return;
    }

    window.scrollTo(0, h);
    try {
      window.scrollBy(0, 350);
    } catch {
      /* ignore */
    }
    scrollTimer = setTimeout(autoScroll, 2400);
  }

  function startAutoScroll() {
    stopAutoScroll();
    // Delay a bit so first-page GraphQL + replay can flush before scrolling
    scrollTimer = setTimeout(autoScroll, 2000);
  }

  function beginWalk(stream) {
    activeWalk = {
      stream,
      idlePages: 0,
      noMore: false,
      stuckScrolls: 0,
      lastHeight: 0,
      lastUsersAt: Date.now(),
      startedAt: Date.now(),
      gotUsers: false,
      consecutiveNoNew: 0,
      seenIds: new Set(),
      endTimer: null,
      // Don't treat REPLAY of a previous "last page" as end-of-list
      ignoreEndUntil: Date.now() + 4500,
    };
    console.log("[auto-x] walk started:", stream, "path=", location.pathname);

    // Replay first-page GraphQL that arrived before walk (or before content was ready)
    window.postMessage(
      { source: "autox-content", type: "REPLAY_GRAPHQL", stream },
      "*",
    );

    // Force flush first page ASAP (replay is sync postMessage)
    clearBatchTimer();
    flushBatch();
    setTimeout(() => {
      if (activeWalk?.stream === stream) flushBatch();
    }, 300);
    setTimeout(() => {
      if (activeWalk?.stream === stream) flushBatch();
    }, 1200);

    ensurePathWatch();
    startAutoScroll();
  }

  // If user scrolls manually during walk, delay next auto-scroll
  window.addEventListener(
    "scroll",
    () => {
      if (!activeWalk) return;
      if (!isOnListPageFor(activeWalk.stream)) {
        hardStopWalk("scroll-on-wrong-page", true);
        return;
      }
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(autoScroll, 5000);
    },
    { passive: true },
  );

  // SPA navigations (pushState) — stop if leaving list
  const _pushState = history.pushState;
  const _replaceState = history.replaceState;
  function onUrlMaybeChanged() {
    if (!activeWalk) return;
    if (!isOnListPageFor(activeWalk.stream)) {
      hardStopWalk("spa-navigation-away", true);
    }
  }
  history.pushState = function (...args) {
    const r = _pushState.apply(this, args);
    setTimeout(onUrlMaybeChanged, 0);
    return r;
  };
  history.replaceState = function (...args) {
    const r = _replaceState.apply(this, args);
    setTimeout(onUrlMaybeChanged, 0);
    return r;
  };
  window.addEventListener("popstate", () => setTimeout(onUrlMaybeChanged, 0));

  // ── Messages from background ───────────────────────────────────

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "START_WALK") {
      const stream = msg.stream;
      if (stream !== "followers" && stream !== "following") {
        sendResponse({ ok: false, error: "bad stream" });
        return true;
      }

      // Refuse to scroll on Home / Explore / tweets — only list pages
      if (!isOnListPageFor(stream)) {
        console.warn(
          "[auto-x] START_WALK refused — not on list page:",
          location.pathname,
          "want",
          stream,
        );
        // Make sure we are not scrolling from a previous walk
        if (activeWalk) hardStopWalk("start-refused-wrong-page", true);
        else stopAutoScroll();
        sendResponse({
          ok: false,
          wrongPage: true,
          path: location.pathname,
          stream,
        });
        return true;
      }

      // Heartbeat re-dispatch: keep walk, do not reset first-page progress
      if (activeWalk && activeWalk.stream === stream) {
        if (!scrollTimer) startAutoScroll();
        ensurePathWatch();
        flushBatch();
        sendResponse({ ok: true, already: true });
        return true;
      }

      if (activeWalk && activeWalk.stream !== stream) {
        hardStopWalk("switch-stream", true);
      }

      beginWalk(stream);
      sendResponse({ ok: true });
    } else if (msg.type === "STOP_WALK") {
      // User/background stop — flush then end (notify bg only if walk was active;
      // bg often already cleared pendingWalk)
      stopAutoScroll();
      stopPathWatch();
      clearBatchTimer();
      flushBatch();
      const stream = activeWalk?.stream || null;
      activeWalk = null;
      if (!currentPathStream()) batchBuffer = [];
      console.log("[auto-x] STOP_WALK", stream || "(idle)");
      sendResponse({ ok: true, stream });
    } else if (msg.type === "EXECUTE_ACTION") {
      // API-level follow — never scrolls or clicks DOM
      window.postMessage(
        {
          source: "autox-content",
          type: msg.actionType === "follow" ? "EXECUTE_FOLLOW" : "EXECUTE_UNFOLLOW",
          targetUserId: msg.targetUserId,
          actionId: msg.actionId,
        },
        "*",
      );
      sendResponse({ ok: true });
    } else if (msg.type === "GET_SESSION") {
      const state = evaluateLogin();
      sendResponse({
        loggedIn: state.loggedIn === true,
        user: state.user,
        path: location.pathname,
        pathStream: currentPathStream(),
        walkActive: !!activeWalk,
        walkStream: activeWalk?.stream || null,
      });
    } else if (msg.type === "SEED_QUERIES") {
      window.postMessage(
        {
          source: "autox-content",
          type: "SEED_QUERIES",
          queries: msg.queries || {},
        },
        "*",
      );
      sendResponse({ ok: true });
    } else if (msg.type === "PING_WALK_STATE") {
      sendResponse({
        ok: true,
        walkActive: !!activeWalk,
        walkStream: activeWalk?.stream || null,
        path: location.pathname,
        pathStream: currentPathStream(),
        scrolling: !!scrollTimer,
      });
    } else {
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── Heartbeat (session only — never starts scroll by itself) ───

  function heartbeat() {
    const state = evaluateLogin();
    // Self-heal: if somehow scrolling without a walk or off list page, stop
    if (scrollTimer && (!activeWalk || !isOnListPageFor(activeWalk.stream))) {
      stopAutoScroll();
      if (activeWalk) hardStopWalk("heartbeat-guard", true);
    }
    sendToBg({
      type: "HEARTBEAT",
      tabUrl: window.location.href,
      loggedIn: state.loggedIn === true,
      user: state.user,
      walkActive: !!activeWalk,
      walkStream: activeWalk?.stream || null,
      pathStream: currentPathStream(),
    });
  }
  setInterval(heartbeat, HEARTBEAT_INTERVAL);
  setTimeout(heartbeat, 500);

  console.log("[auto-x] content script ready");
})();
