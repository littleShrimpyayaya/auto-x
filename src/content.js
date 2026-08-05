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
   * Count people on the CURRENT list page by each user row (UserCell).
   *
   * - /followers  → 关注者 = 粉丝（关注我的人）→ 每人一行/一个关注按钮
   * - /following  → 正在关注 = 我关注的人 → 每人一行/一个关注状态按钮
   *
   * Primary key: data-testid="{userId}-follow|unfollow" on that row's button.
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

        // 1) Button on this row → official user id (most reliable)
        const followBtn = cell.querySelector(
          '[data-testid$="-follow"], [data-testid$="-unfollow"]',
        );
        if (followBtn) {
          const tid = followBtn.getAttribute("data-testid") || "";
          const bm = tid.match(/^(\d+)-(follow|unfollow)$/i);
          if (bm) id = bm[1];
        }
        if (!id) {
          const anyId =
            cell.querySelector("[data-user-id]")?.getAttribute("data-user-id") ||
            cell.getAttribute("data-user-id");
          if (anyId) id = String(anyId);
        }

        // 2) @handle from profile link in the cell
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

        const nameEl =
          cell.querySelector('[dir="ltr"] > span > span') ||
          cell.querySelector("span span");
        if (nameEl?.textContent) name = nameEl.textContent.trim() || null;

        // Need at least id or username to count this row as one person
        if (!id && !username) continue;
        // Prefer id as key; fall back to username-stable key so we still count the row
        const key = id || "u:" + String(username).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          id: id || key,
          username: username || (id ? "id:" + id : key),
          name,
          verified: false,
          protected: false,
          unavailable: false,
          _fromDom: true,
          _listRow: true,
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
        // Update walk expected count from list payload owner stats
        if (activeWalk) {
          if (
            activeWalk.stream === "followers" &&
            msg.profileMeta.followers_count != null
          ) {
            activeWalk.expectedCount = Number(msg.profileMeta.followers_count);
          }
          if (
            activeWalk.stream === "following" &&
            msg.profileMeta.following_count != null
          ) {
            activeWalk.expectedCount = Number(msg.profileMeta.following_count);
          }
        }
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
        (msg.error ? " " + msg.error : "") +
        (msg.verified ? " [verified]" : "") +
        (msg.method ? " via " + msg.method : "");
      console.log(line);
      // Forward full result — missing following/verified was treating success as fail
      sendToBg({
        type: "ACTION_COMPLETED",
        actionId: msg.actionId,
        ok: !!msg.ok,
        error: msg.error || null,
        following: msg.following === true,
        verified: msg.verified === true,
        alreadyFollowing: !!msg.alreadyFollowing,
        pendingFollow: !!msg.pendingFollow,
        method: msg.method || null,
        username: msg.username || null,
        warning: msg.warning || null,
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
    const seenIds = activeWalk?.seenIds ? [...activeWalk.seenIds] : [];
    const seen = seenIds.length;
    if (notifyBg && stream) {
      sendToBg({
        type: "WALK_ENDED",
        walk: { stream },
        reason: reason || "stop",
        seenCount: seen,
        seenIds,
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

    // Every scroll: count visible list rows (UserCell / follow buttons) — source of truth for "how many people on this page"
    activeWalk.scrollTicks = (activeWalk.scrollTicks || 0) + 1;
    {
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
    const minWalkMs = 12000;
    const walkedLongEnough = Date.now() - (activeWalk.startedAt || 0) > minWalkMs;
    const seenN = activeWalk.seenIds?.size || 0;
    const expected = activeWalk.expectedCount > 0 ? activeWalk.expectedCount : null;
    // If we know profile count, don't soft-stop while clearly short (e.g. 297/330)
    const shortOfExpected =
      expected != null && seenN > 0 && seenN < Math.floor(expected * 0.97);
    const nearExpected =
      expected == null || seenN >= Math.floor(expected * 0.97);

    // Prefer API noMore; soft end only when near expected or expected unknown + long idle
    if (
      gotUsers &&
      walkedLongEnough &&
      nearBottom &&
      activeWalk.stuckScrolls >= 6 &&
      idleMs > 14000 &&
      nearExpected
    ) {
      const extra = scrapeVisibleListUsers();
      if (extra.length) {
        addToBatch(extra);
        flushBatch();
      }
      endWalkNatural("scroll-bottom-stable");
      return;
    }
    if (
      gotUsers &&
      walkedLongEnough &&
      activeWalk.stuckScrolls >= 8 &&
      idleMs > 20000 &&
      nearExpected
    ) {
      endWalkNatural("scroll-stable");
      return;
    }
    // Still short of profile count: keep trying harder (don't stop at 297/330)
    if (gotUsers && shortOfExpected && activeWalk.stuckScrolls >= 3) {
      // nudge harder: jump further / small up-down to re-trigger virtual list
      try {
        window.scrollBy(0, -200);
        setTimeout(() => {
          window.scrollTo(0, document.documentElement.scrollHeight || 0);
        }, 200);
      } catch {
        /* ignore */
      }
      activeWalk.stuckScrolls = Math.max(0, (activeWalk.stuckScrolls || 0) - 2);
      scrollTimer = setTimeout(autoScroll, 2000);
      return;
    }
    if (
      gotUsers &&
      walkedLongEnough &&
      noNew >= 6 &&
      activeWalk.stuckScrolls >= 5 &&
      idleMs > 16000 &&
      nearExpected
    ) {
      endWalkNatural("no-new-users");
      return;
    }
    if (
      gotUsers &&
      walkedLongEnough &&
      looksLikeListEnd() &&
      activeWalk.stuckScrolls >= 3 &&
      idleMs > 10000 &&
      nearExpected
    ) {
      endWalkNatural("dom-end-marker");
      return;
    }
    // Absolute give-up if stuck forever even when short (list won't load more)
    if (gotUsers && shortOfExpected && idleMs > 45000 && activeWalk.stuckScrolls >= 12) {
      console.warn(
        "[auto-x] giving up short of expected",
        seenN,
        "/",
        expected,
      );
      endWalkNatural("short-stuck-giveup");
      return;
    }
    // Empty list edge case
    if (!gotUsers && idleMs > 25000 && activeWalk.stuckScrolls >= 5) {
      endWalkNatural("empty-or-stuck");
      return;
    }

    window.scrollTo(0, h);
    try {
      window.scrollBy(0, 400);
    } catch {
      /* ignore */
    }
    scrollTimer = setTimeout(autoScroll, 2200);
  }

  function startAutoScroll() {
    stopAutoScroll();
    // Delay a bit so first-page GraphQL + replay can flush before scrolling
    scrollTimer = setTimeout(autoScroll, 2000);
  }

  function beginWalk(stream, expectedCount) {
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
      expectedCount:
        expectedCount != null && Number(expectedCount) > 0
          ? Number(expectedCount)
          : null,
      // Don't treat REPLAY of a previous "last page" as end-of-list
      ignoreEndUntil: Date.now() + 4500,
    };
    console.log(
      "[auto-x] walk started:",
      stream,
      "path=",
      location.pathname,
      activeWalk.expectedCount != null ? "expected≈" + activeWalk.expectedCount : "",
    );

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

  // ── Follow-back on 关注者 list (NOT profile pages) ─────────────
  // Stay on /followers, click each row's 回关/Follow button, skip failures.

  let followBackList = null; // { intervalSec, maxClicks, clicked, skipped, stuckScrolls, lastHeight }

  function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function parseFollowTestIdSimple(tid) {
    if (!tid) return null;
    const m = String(tid).match(/^(\d+)-(follow|unfollow)$/i);
    if (!m) return null;
    return {
      id: m[1],
      kind: m[2].toLowerCase() === "unfollow" ? "following" : "follow",
    };
  }

  function usernameFromUserCell(cell) {
    const links = cell.querySelectorAll('a[href^="/"]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
      if (!m) continue;
      const h = m[1];
      if (
        ["home", "explore", "search", "i", "settings", "notifications", "messages"].includes(
          h.toLowerCase(),
        )
      ) {
        continue;
      }
      return h;
    }
    return null;
  }

  /**
   * On 关注者 page: each UserCell may show Follow / Follow back / 回关 / 关注.
   * Those are people who follow you but you don't follow (or not yet).
   */
  function findListFollowBackTargets(alreadyTried) {
    const tried = alreadyTried || new Set();
    const out = [];
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    for (const cell of cells) {
      let userId = null;
      let followBtn = null;
      let kind = null;

      for (const el of cell.querySelectorAll("[data-testid]")) {
        const p = parseFollowTestIdSimple(el.getAttribute("data-testid"));
        if (!p) continue;
        userId = p.id;
        if (p.kind === "follow") {
          followBtn = el;
          kind = "follow";
        } else if (p.kind === "following") {
          followBtn = null;
          kind = "following";
        }
      }

      // Text/aria fallback on the cell
      if (!followBtn && kind !== "following") {
        for (const b of cell.querySelectorAll('[role="button"], button')) {
          const al = (b.getAttribute("aria-label") || "").trim();
          const tx = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
          if (
            /^(Following|Unfollow|正在关注|取消关注)/i.test(al) ||
            /^(Following|正在关注)$/i.test(tx)
          ) {
            kind = "following";
            followBtn = null;
            break;
          }
          if (
            /^(Follow|Follow back|关注|回关)\b/i.test(al) ||
            /^(Follow|Follow back|关注|回关)$/i.test(tx) ||
            /^Follow @/i.test(al) ||
            /^关注/.test(al)
          ) {
            if (/^Following/i.test(al) || /^Following/i.test(tx)) continue;
            followBtn = b;
            kind = "follow";
            break;
          }
        }
      }

      if (!followBtn || kind !== "follow") continue;
      const un = usernameFromUserCell(cell);
      const key = userId
        ? String(userId)
        : un
          ? "name:" + un.toLowerCase()
          : null;
      if (!key || tried.has(key)) continue;

      out.push({
        el: followBtn,
        userId: userId ? String(userId) : null,
        key,
        username: un,
      });
    }
    return out;
  }

  function stopFollowBackListLocal(reason) {
    if (followBackList?.timer) {
      clearTimeout(followBackList.timer);
      followBackList.timer = null;
    }
    const clicked = followBackList?.clicked || 0;
    followBackList = null;
    console.log("[auto-x] follow-back list stopped:", reason || "", "clicked=", clicked);
    sendToBg({
      type: "FOLLOW_BACK_LIST_DONE",
      reason: reason || "stop",
      clicked,
    });
  }

  async function followBackListTick() {
    if (!followBackList) return;

    // Must stay on 关注者 page
    if (currentPathStream() !== "followers") {
      stopFollowBackListLocal("left-followers-page");
      return;
    }

    if (followBackList.clicked >= followBackList.maxClicks) {
      stopFollowBackListLocal("daily-or-max");
      return;
    }

    const targets = findListFollowBackTargets(followBackList.tried);
    if (targets.length > 0) {
      const t = targets[0];
      followBackList.tried.add(t.key);
      followBackList.stuckScrolls = 0;

      try {
        t.el.scrollIntoView({ block: "center", inline: "nearest" });
      } catch {
        /* ignore */
      }
      await sleepMs(250);

      try {
        const r = t.el.getBoundingClientRect();
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: r.left + 4,
          clientY: r.top + 4,
        };
        t.el.dispatchEvent(new MouseEvent("pointerdown", opts));
        t.el.dispatchEvent(new MouseEvent("mousedown", opts));
        t.el.dispatchEvent(new MouseEvent("pointerup", opts));
        t.el.dispatchEvent(new MouseEvent("mouseup", opts));
        t.el.dispatchEvent(new MouseEvent("click", opts));
        if (typeof t.el.click === "function") t.el.click();
      } catch (e) {
        sendToBg({
          type: "ACTION_COMPLETED",
          actionId: "list-follow-" + t.key,
          ok: false,
          error: "点击失败: " + (e.message || e),
          username: t.username,
          targetUserId: t.userId,
          method: "list-click",
        });
        followBackList.timer = setTimeout(followBackListTick, 800);
        return;
      }

      console.log("[auto-x] list 回关 clicked", t.username || t.key);

      // Wait briefly for button to become Following/unfollow
      let ok = false;
      let pending = false;
      for (let i = 0; i < 12; i++) {
        await sleepMs(350);
        const cellStill = t.el.isConnected
          ? t.el.closest('[data-testid="UserCell"]')
          : null;
        const root = cellStill || document;
        let state = null;
        if (t.userId) {
          if (root.querySelector?.(`[data-testid="${t.userId}-unfollow"]`) ||
              document.querySelector(`[data-testid="${t.userId}-unfollow"]`)) {
            state = "following";
          } else if (
            document.querySelector(`[data-testid="${t.userId}-follow"]`)
          ) {
            state = "follow";
          }
        }
        if (!state && cellStill) {
          for (const b of cellStill.querySelectorAll('[role="button"], button')) {
            const al = (b.getAttribute("aria-label") || "") + " " + (b.innerText || "");
            if (/Following|Unfollow|正在关注|取消关注/i.test(al)) {
              state = "following";
              break;
            }
            if (/Pending|Requested|已请求/i.test(al)) {
              state = "pending";
              break;
            }
          }
        }
        if (state === "following" || state === "pending") {
          ok = true;
          pending = state === "pending";
          break;
        }
        // button gone often means UI updated
        if (!t.el.isConnected) {
          ok = true;
          break;
        }
      }

      followBackList.clicked += ok ? 1 : 0;
      sendToBg({
        type: "ACTION_COMPLETED",
        actionId: "list-follow-" + t.key,
        ok,
        following: ok,
        pendingFollow: pending,
        verified: ok,
        username: t.username || t.key,
        targetUserId: t.userId,
        method: "list-click",
        error: ok ? null : "列表点击后未确认已关注（已跳过，不进主页）",
      });

      const waitMs = Math.max(3000, (followBackList.intervalSec || 5) * 1000);
      followBackList.timer = setTimeout(followBackListTick, waitMs);
      return;
    }

    // No visible 回关 buttons — scroll for more
    const h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
    if (followBackList.lastHeight && h <= followBackList.lastHeight + 4) {
      followBackList.stuckScrolls = (followBackList.stuckScrolls || 0) + 1;
    } else {
      followBackList.stuckScrolls = 0;
      followBackList.lastHeight = h;
    }

    if (followBackList.stuckScrolls >= 6) {
      stopFollowBackListLocal("complete");
      return;
    }

    window.scrollTo(0, h);
    try {
      window.scrollBy(0, 500);
    } catch {
      /* ignore */
    }
    followBackList.timer = setTimeout(followBackListTick, 2000);
  }

  function startFollowBackListLocal(opts) {
    if (followBackList?.timer) {
      clearTimeout(followBackList.timer);
      followBackList.timer = null;
    }
    followBackList = {
      intervalSec: Math.max(3, Number(opts.intervalSec) || 5),
      maxClicks: Math.max(1, Number(opts.maxClicks) || 50),
      clicked: 0,
      tried: new Set(),
      stuckScrolls: 0,
      lastHeight: 0,
      timer: null,
      selfUsername: opts.selfUsername || null,
    };
    console.log(
      "[auto-x] follow-back list ON (关注者页点回关) | interval=",
      followBackList.intervalSec,
      "s max=",
      followBackList.maxClicks,
    );
    followBackList.timer = setTimeout(followBackListTick, 1500);
  }

  // ── Profile click helpers (optional) ───────────────────────────

  function primaryCol() {
    return (
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector('main[role="main"]') ||
      document.body
    );
  }

  function profilePageState(username) {
    const text = (document.body && document.body.innerText) || "";
    if (/This account doesn.?t exist|账号不存在|该账号不存在|Account suspended|账号已被冻结|已被冻结/i.test(text)) {
      return "unavailable";
    }
    if (/These posts are protected|这些帖子受到保护|This account.?s posts are protected/i.test(text)) {
      // protected still has Follow
      return "protected";
    }
    const path = (location.pathname || "").toLowerCase();
    const u = (username || "").toLowerCase();
    if (u && path.indexOf("/" + u) === 0) return "profile";
    return "unknown";
  }

  /** true follow testid: "123-follow" — NOT "123-unfollow" (ends with -follow too!) */
  function parseFollowTestId(tid) {
    if (!tid) return null;
    const m = String(tid).match(/^(\d+)-(follow|unfollow)$/i);
    if (!m) return null;
    return { id: m[1], kind: m[2].toLowerCase() === "unfollow" ? "following" : "follow" };
  }

  function classifyButton(el, username) {
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return null;
    const tid = el.getAttribute("data-testid") || "";
    const parsed = parseFollowTestId(tid);
    if (parsed) return { el, kind: parsed.kind, via: "testid" };

    const al = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    // Visible label: take direct text, not all descendants spam
    let text = "";
    try {
      text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      // Profile CTA is usually a short word
      if (text.length > 40) text = text.slice(0, 40);
    } catch {
      text = "";
    }

    if (
      /^(Following|Unfollow|正在关注|取消关注)\b/i.test(al) ||
      /^(Following|Unfollow|正在关注|取消关注)$/i.test(text)
    ) {
      return { el, kind: "following", via: "label" };
    }
    if (
      /^(Pending|Requested|已请求|等待中)\b/i.test(al) ||
      /^(Pending|Requested|已请求)$/i.test(text)
    ) {
      return { el, kind: "pending", via: "label" };
    }
    // Follow / Follow @user / Follow back / 关注 / 回关
    if (
      /^(Follow|Follow back|关注|回关)\b/i.test(al) ||
      /^(Follow|Follow back|关注|回关)$/i.test(text) ||
      /^Follow @/i.test(al) ||
      /^关注\s*@/i.test(al)
    ) {
      // Skip "Following" false positive already handled
      if (/^Following/i.test(al) || /^Following/i.test(text)) {
        return { el, kind: "following", via: "label" };
      }
      return { el, kind: "follow", via: "label" };
    }
    return null;
  }

  /**
   * Locate profile Follow / Following / Pending in the main column.
   */
  function findProfileFollowControl(userId, username) {
    const root = primaryCol();
    const uid = userId != null ? String(userId) : null;
    const uname = username ? String(username).replace(/^@/, "") : null;

    // 1) Exact testids
    if (uid) {
      const f = root.querySelector(`[data-testid="${uid}-follow"]`);
      if (f) return { el: f, kind: "follow", via: "id-follow" };
      const u = root.querySelector(`[data-testid="${uid}-unfollow"]`);
      if (u) return { el: u, kind: "following", via: "id-unfollow" };
    }

    // 2) Any *-follow / *-unfollow in primary column (parse carefully)
    const testNodes = root.querySelectorAll("[data-testid]");
    for (const el of testNodes) {
      const parsed = parseFollowTestId(el.getAttribute("data-testid"));
      if (!parsed) continue;
      // Prefer matching userId when we have it
      if (uid && parsed.id !== uid) continue;
      return { el, kind: parsed.kind, via: "scan-testid" };
    }
    // If userId mismatch (stale id), accept first follow/unfollow in header area
    for (const el of testNodes) {
      const parsed = parseFollowTestId(el.getAttribute("data-testid"));
      if (!parsed) continue;
      if (el.closest('[data-testid="UserCell"]')) continue; // skip list cells if any
      return { el, kind: parsed.kind, via: "scan-testid-any" };
    }

    // 3) placementTracking / userActions (profile CTA zone)
    const zones = root.querySelectorAll(
      '[data-testid="placementTracking"], [data-testid="userActions"], [data-testid="placementTracking"] *',
    );
    for (const zone of zones) {
      const btns = zone.querySelectorAll
        ? zone.querySelectorAll('[role="button"], button')
        : [];
      for (const b of btns) {
        const c = classifyButton(b, uname);
        if (c) return c;
      }
      // zone itself may be the button
      if (zone.getAttribute && zone.getAttribute("role") === "button") {
        const c = classifyButton(zone, uname);
        if (c) return c;
      }
    }

    // 4) All role=button in primary column — prefer top half of profile header
    const buttons = root.querySelectorAll('[role="button"], button');
    const candidates = [];
    for (const b of buttons) {
      if (b.closest('[data-testid="UserCell"]')) continue;
      if (b.closest('[aria-label="Timeline:"]') || b.closest('[aria-label*="Timeline"]')) continue;
      const c = classifyButton(b, uname);
      if (!c) continue;
      // Score: prefer buttons whose label mentions the username
      let score = 0;
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      if (uname && al.includes(uname.toLowerCase())) score += 5;
      if (b.closest('[data-testid="placementTracking"]')) score += 3;
      if (b.closest('[data-testid="userActions"]')) score += 3;
      candidates.push({ ...c, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length) return candidates[0];

    return null;
  }

  function debugDumpFollowCandidates() {
    try {
      const root = primaryCol();
      const bits = [];
      root.querySelectorAll('[role="button"], button, [data-testid]').forEach((el, i) => {
        if (i > 80) return;
        const tid = el.getAttribute("data-testid") || "";
        const al = el.getAttribute("aria-label") || "";
        const tx = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 30);
        if (/follow|关注|unfollow|pending|请求/i.test(tid + al + tx)) {
          bits.push({ tid, al: al.slice(0, 60), tx });
        }
      });
      console.log("[auto-x] follow candidates dump", bits.slice(0, 20));
      return bits.slice(0, 12);
    } catch {
      return [];
    }
  }

  async function performClickFollow({ username, userId, actionId }) {
    const uid = userId != null ? String(userId) : null;
    const uname = username ? String(username).replace(/^@/, "") : null;
    console.log("[auto-x] click-follow start", uname, uid, "path=", location.pathname);

    // Ensure we're near top (sticky header can hide CTA briefly)
    try {
      window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }

    // Wait for profile shell + button (up to ~30s)
    let ctrl = null;
    for (let i = 0; i < 60; i++) {
      const st = profilePageState(uname);
      if (st === "unavailable") {
        const err = "账号不存在或已冻结，无法关注";
        sendToBg({ type: "ACTION_COMPLETED", actionId, ok: false, error: err, method: "click" });
        return { ok: false, error: err };
      }
      ctrl = findProfileFollowControl(uid, uname);
      if (ctrl) break;
      // nudge scroll once mid-wait (some layouts lazy-render CTA)
      if (i === 15 || i === 30) {
        try {
          window.scrollTo(0, 200);
          await sleepMs(200);
          window.scrollTo(0, 0);
        } catch {
          /* ignore */
        }
      }
      await sleepMs(500);
    }

    if (!ctrl) {
      const dump = debugDumpFollowCandidates();
      const err =
        "未找到关注按钮（主页可能未加载完或选择器不匹配） path=" +
        location.pathname +
        (dump.length ? " dump=" + JSON.stringify(dump).slice(0, 220) : "");
      console.warn("[auto-x]", err);
      sendToBg({
        type: "ACTION_COMPLETED",
        actionId,
        ok: false,
        error: "未找到关注按钮（主页可能未加载完或账号不可用）",
        method: "click",
        debug: dump,
      });
      return { ok: false, error: err };
    }

    console.log("[auto-x] found follow control", ctrl.kind, ctrl.via || "");

    if (ctrl.kind === "following") {
      sendToBg({
        type: "ACTION_COMPLETED",
        actionId,
        ok: true,
        following: true,
        alreadyFollowing: true,
        verified: true,
        method: "click",
      });
      return { ok: true, alreadyFollowing: true };
    }
    if (ctrl.kind === "pending") {
      sendToBg({
        type: "ACTION_COMPLETED",
        actionId,
        ok: true,
        following: true,
        pendingFollow: true,
        verified: true,
        method: "click",
      });
      return { ok: true, pendingFollow: true };
    }

    try {
      ctrl.el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      /* ignore */
    }
    await sleepMs(300);

    // Prefer pointer events like a real user
    try {
      const r = ctrl.el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + 5, clientY: r.top + 5 };
      ctrl.el.dispatchEvent(new MouseEvent("pointerdown", opts));
      ctrl.el.dispatchEvent(new MouseEvent("mousedown", opts));
      ctrl.el.dispatchEvent(new MouseEvent("pointerup", opts));
      ctrl.el.dispatchEvent(new MouseEvent("mouseup", opts));
      ctrl.el.dispatchEvent(new MouseEvent("click", opts));
      if (typeof ctrl.el.click === "function") ctrl.el.click();
    } catch (e) {
      const err = "点击关注按钮失败: " + (e.message || e);
      sendToBg({ type: "ACTION_COMPLETED", actionId, ok: false, error: err, method: "click" });
      return { ok: false, error: err };
    }
    console.log("[auto-x] Follow button clicked");

    for (let i = 0; i < 30; i++) {
      await sleepMs(400);
      const after = findProfileFollowControl(uid, uname);
      if (after && (after.kind === "following" || after.kind === "pending")) {
        console.log("[auto-x] click-follow confirmed:", after.kind);
        sendToBg({
          type: "ACTION_COMPLETED",
          actionId,
          ok: true,
          following: true,
          pendingFollow: after.kind === "pending",
          verified: true,
          method: "click",
        });
        return { ok: true, kind: after.kind };
      }
    }

    const err = "已点击关注，但未确认按钮变为 Following（可能被限流或需验证）";
    console.warn("[auto-x]", err);
    sendToBg({ type: "ACTION_COMPLETED", actionId, ok: false, error: err, method: "click" });
    return { ok: false, error: err };
  }

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
        if (msg.expectedCount != null && Number(msg.expectedCount) > 0) {
          activeWalk.expectedCount = Number(msg.expectedCount);
        }
        if (!scrollTimer) startAutoScroll();
        ensurePathWatch();
        flushBatch();
        sendResponse({ ok: true, already: true });
        return true;
      }

      if (activeWalk && activeWalk.stream !== stream) {
        hardStopWalk("switch-stream", true);
      }

      beginWalk(stream, msg.expectedCount);
      sendResponse({ ok: true });
    } else if (msg.type === "STOP_WALK") {
      // User/background stop — flush then end
      stopAutoScroll();
      stopPathWatch();
      clearBatchTimer();
      flushBatch();
      const stoppedStream = activeWalk?.stream || null;
      activeWalk = null;
      if (!currentPathStream()) batchBuffer = [];
      console.log("[auto-x] STOP_WALK", stoppedStream || "(idle)");
      sendResponse({ ok: true, stream: stoppedStream });
    } else if (msg.type === "START_FOLLOW_BACK_LIST") {
      if (currentPathStream() !== "followers") {
        sendResponse({
          ok: false,
          error: "not on followers page",
          path: location.pathname,
        });
        return true;
      }
      // Don't scroll-walk for sync at the same time
      if (activeWalk) {
        hardStopWalk("follow-back-takes-over", true);
      }
      startFollowBackListLocal({
        intervalSec: msg.intervalSec,
        maxClicks: msg.maxClicks,
        selfUsername: msg.selfUsername,
      });
      sendResponse({ ok: true });
    } else if (msg.type === "STOP_FOLLOW_BACK_LIST") {
      if (followBackList) stopFollowBackListLocal("user-stop");
      else followBackList = null;
      sendResponse({ ok: true });
    } else if (msg.type === "EXECUTE_ACTION") {
      // Deprecated profile path — ignore follow (use list mode)
      sendResponse({ ok: false, error: "use list follow-back" });
    } else if (msg.type === "CLICK_FOLLOW") {
      sendResponse({
        ok: false,
        error: "已改为关注者列表回关，不再进个人主页",
      });
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
