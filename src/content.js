/**
 * ISOLATED world content script — bridge between injector (MAIN world) and
 * background service worker. Runs at document_idle on X.com pages.
 */
(() => {
  let sessionUser = null;
  let activeWalk = null;
  let batchBuffer = [];
  let batchTimer = null;

  const BATCH_INTERVAL = 2000;
  const HEARTBEAT_INTERVAL = 10000;
  const BATCH_MAX = 100;

  function sendToBg(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
  }

  // ── Session detection ──────────────────────────────────────────

  function detectSessionUser() {
    try {
      const scripts = document.querySelectorAll("script[type='application/json']");
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent);
          const viewer = data?.viewer || data?.user || data?.currentUser;
          if (viewer?.id && viewer?.screen_name) {
            return { id: viewer.id, username: viewer.screen_name, name: viewer.name ?? null };
          }
        } catch {}
      }
    } catch {}
    try {
      const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (btn) {
        const label = btn.getAttribute("aria-label") || btn.textContent || "";
        const m = label.match(/@(\w+)/);
        if (m) return { username: m[1], id: null, name: null };
      }
    } catch {}
    return null;
  }

  let detectTries = 0;
  function tryDetect() {
    if (sessionUser?.id) return;
    sessionUser = detectSessionUser();
    detectTries++;
    if (!sessionUser?.id && detectTries < 10) {
      setTimeout(tryDetect, 1000);
    } else if (sessionUser) {
      sendToBg({ type: "SESSION_USER", user: sessionUser });
    }
  }
  setTimeout(tryDetect, 2000);

  // ── Batch ingest ───────────────────────────────────────────────

  function flushBatch() {
    if (!batchBuffer.length || !activeWalk) return;
    const batch = batchBuffer.splice(0, BATCH_MAX);
    sendToBg({
      type: "INGEST_BATCH",
      walk: activeWalk,
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
    batchTimer = setTimeout(() => { batchTimer = null; flushBatch(); }, BATCH_INTERVAL);
  }

  function addToBatch(users) {
    const existing = new Set(batchBuffer.map((u) => u.id));
    for (const u of users) {
      if (!existing.has(u.id)) { batchBuffer.push(u); existing.add(u.id); }
    }
    if (batchBuffer.length >= BATCH_MAX) {
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
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
      if (!sessionUser?.id) tryDetect();
      addToBatch(msg.users);
      if (msg.cursor !== undefined) {
        sendToBg({ type: "CURSOR_UPDATE", walk: activeWalk, cursor: msg.cursor, hasMore: msg.hasMore });
      }
    }
    if (msg.type === "ACTION_RESULT") {
      sendToBg({
        type: "ACTION_COMPLETED",
        actionId: msg.actionId,
        ok: msg.ok,
        error: msg.error,
        alreadyFollowing: msg.alreadyFollowing,
        pendingFollow: msg.pendingFollow,
      });
    }
    if (msg.type === "KNOWN_QUERIES") {
      sendToBg({ type: "QUERIES_UPDATED", queries: msg.queries });
    }
    if (msg.type === "LEARNED_QUERY") {
      sendToBg({ type: "QUERY_LEARNED", endpoint: msg.endpoint, hash: msg.hash });
    }
  });

  // ── Messages from background ───────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "START_WALK") {
      activeWalk = { stream: msg.stream };
      batchBuffer = [];
      console.log("[auto-x] walk started:", msg.stream);
      sendResponse({ ok: true });
    } else if (msg.type === "STOP_WALK") {
      if (activeWalk) sendToBg({ type: "WALK_ENDED", walk: activeWalk });
      activeWalk = null;
      batchBuffer = [];
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
      sendResponse({ ok: true });
    } else if (msg.type === "EXECUTE_ACTION") {
      window.postMessage({
        source: "autox-content",
        type: msg.actionType === "follow" ? "EXECUTE_FOLLOW" : "EXECUTE_UNFOLLOW",
        targetUserId: msg.targetUserId,
        actionId: msg.actionId,
      }, "*");
      sendResponse({ ok: true });
    } else if (msg.type === "GET_SESSION") {
      sendResponse({ user: sessionUser });
    } else {
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── Heartbeat ──────────────────────────────────────────────────

  function heartbeat() {
    sendToBg({ type: "HEARTBEAT", tabUrl: window.location.href });
  }
  setInterval(heartbeat, HEARTBEAT_INTERVAL);
  heartbeat();

  // ── Auto-scroll ────────────────────────────────────────────────

  let scrollTimer = null;
  function autoScroll() {
    if (!activeWalk) return;
    window.scrollTo(0, document.body.scrollHeight);
    scrollTimer = setTimeout(autoScroll, 3000);
  }
  window.addEventListener("scroll", () => {
    if (!activeWalk) return;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(autoScroll, 5000);
  });

  console.log("[auto-x] content script ready");
})();
