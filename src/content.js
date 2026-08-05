/**
 * ISOLATED world content script — bridge injector ↔ background.
 * Does not hijack the page unless user explicitly starts a list sync walk.
 */
(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  let sessionUser = null;
  let loggedIn = null; // null = unknown, true/false once probed
  let activeWalk = null;
  let batchBuffer = [];
  let batchTimer = null;

  const BATCH_INTERVAL = 2000;
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
    // Login CTA in chrome
    if (document.querySelector('[data-testid="loginButton"], a[href="/login"]')) {
      // Guest top bar often shows login — but also appears for logged-out only
      if (!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') &&
          !document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')) {
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
    // Strong signal: account switcher
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

    // Profile tab link
    try {
      const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (profileLink?.href) {
        const m =
          profileLink.href.match(/(?:x|twitter)\.com\/([^/?#]+)/i);
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

    // Embedded JSON (variable structure)
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

    // Cookie hint: ct0 present usually means logged-in session cookie set
    try {
      if (document.cookie.includes("ct0=")) {
        // Logged in but username unknown yet
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
    // Has main app chrome without login CTAs?
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

  // ── Batch ingest (passive — only stores data when lists load) ──

  function flushBatch() {
    if (!batchBuffer.length) return;
    const stream =
      activeWalk?.stream ||
      (location.pathname.includes("/followers")
        ? "followers"
        : location.pathname.includes("/following")
          ? "following"
          : null);
    if (!stream) return;

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
        followers_count: u.followers_count ?? null,
        following_count: u.following_count ?? null,
        tweet_count: u.tweet_count ?? null,
      })),
    });
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

  // ── Messages from injector (MAIN world) ────────────────────────

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "autox-hook") return;
    const msg = event.data;

    if (msg.type === "GRAPHQL_DATA") {
      if (!sessionUser?.username) tryDetect();
      addToBatch(msg.users || []);
      if (msg.cursor !== undefined) {
        sendToBg({
          type: "CURSOR_UPDATE",
          walk: activeWalk || {
            stream: location.pathname.includes("/following") ? "following" : "followers",
          },
          cursor: msg.cursor,
          hasMore: msg.hasMore,
        });
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

  // ── Messages from background ───────────────────────────────────

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "START_WALK") {
      // Explicit sync only — auto-scroll here is intentional and user-triggered
      activeWalk = { stream: msg.stream };
      batchBuffer = [];
      console.log("[auto-x] walk started:", msg.stream);
      startAutoScroll();
      sendResponse({ ok: true });
    } else if (msg.type === "STOP_WALK") {
      if (activeWalk) sendToBg({ type: "WALK_ENDED", walk: activeWalk });
      activeWalk = null;
      batchBuffer = [];
      stopAutoScroll();
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      sendResponse({ ok: true });
    } else if (msg.type === "EXECUTE_ACTION") {
      // API-level follow via MAIN world — does not click DOM buttons
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
    } else {
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── Heartbeat (keeps background alive / session fresh; no UI impact) ──

  function heartbeat() {
    const state = evaluateLogin();
    sendToBg({
      type: "HEARTBEAT",
      tabUrl: window.location.href,
      loggedIn: state.loggedIn === true,
      user: state.user,
    });
  }
  setInterval(heartbeat, HEARTBEAT_INTERVAL);
  setTimeout(heartbeat, 500);

  // ── Auto-scroll ONLY during explicit walk ──────────────────────

  let scrollTimer = null;

  function autoScroll() {
    if (!activeWalk) return;
    window.scrollTo(
      0,
      document.documentElement.scrollHeight || document.body.scrollHeight,
    );
    scrollTimer = setTimeout(autoScroll, 3000);
  }

  function startAutoScroll() {
    stopAutoScroll();
    scrollTimer = setTimeout(autoScroll, 2000);
  }

  function stopAutoScroll() {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
  }

  // If user scrolls manually during walk, delay next auto-scroll (don't fight them hard)
  window.addEventListener(
    "scroll",
    () => {
      if (!activeWalk) return;
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(autoScroll, 6000);
    },
    { passive: true },
  );

  // Passive ingest when user opens lists themselves — NO auto-scroll (don't steal control)
  // GraphQL hook still captures users as the user scrolls.

  console.log("[auto-x] content script ready");
})();
