/**
 * Background decision engine — Chrome / Edge (service worker) + Firefox (scripts).
 * Popup close does NOT stop auto-follow; work continues via alarms + content heartbeat.
 */
if (typeof importScripts === "function") {
  importScripts("./lib/browser.js", "./lib/store.js");
}

const api = self.autoxBrowser || (typeof browser !== "undefined" ? browser : chrome);
const store = self.autoxStore;
const VERSION = "0.3.0";

let connectedTabId = null;
let data = null;
let activeAction = null;
let pendingWalk = null;
let saveChain = Promise.resolve();
/** Live probe from content: { loggedIn, user, tabId, at } */
let liveSession = null;

const DEFAULT_SETTINGS = {
  minIntervalSec: 60,
  maxFollowsPerDay: 50,
};

async function getSettings() {
  const cfg = await api.storage.local.get("autox_settings");
  const s = { ...DEFAULT_SETTINGS, ...(cfg.autox_settings || {}) };
  // migrate legacy followBackEnabled into autoFollowRunning only on first load — ignore here
  return s;
}

async function loadData() {
  data = await store.load();
  store.checkDateRollover(data);
  return data;
}

function persistData() {
  saveChain = saveChain
    .then(async () => {
      if (data) await store.save(data);
    })
    .catch((e) => console.error("[auto-x] save error:", e));
  return saveChain;
}

function isXUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === "x.com" || u.hostname === "twitter.com" || u.hostname.endsWith(".x.com");
  } catch {
    return false;
  }
}

function ingestUsers(users, stream) {
  if (!users?.length) return 0;
  let count = 0;
  const target = stream === "followers" ? data.followers : data.following;
  for (const u of users) {
    if (!u.id || !u.username) continue;
    target[u.id] = { ...(target[u.id] || {}), ...u, _seenAt: new Date().toISOString() };
    count++;
  }
  data.syncStatus[stream].lastSync = new Date().toISOString();
  data.syncStatus[stream].count = Object.keys(target).length;
  persistData();
  return count;
}

async function computeFollowBacks() {
  if (!data?.autoFollowRunning) return [];
  if (!data?.connection?.connected) return [];
  const settings = await getSettings();
  const candidates = store.getNonMutualFollowers(data);
  const remaining = Math.max(0, settings.maxFollowsPerDay - (data.stats.dailyFollows || 0));
  return candidates.slice(0, Math.min(remaining, 5));
}

async function executeAction(userId, username, name) {
  if (activeAction || !connectedTabId) return;
  if (!data?.autoFollowRunning) return;
  const settings = await getSettings();
  if (data.stats.lastActionAt) {
    const elapsed = (Date.now() - new Date(data.stats.lastActionAt).getTime()) / 1000;
    if (elapsed < settings.minIntervalSec) return;
  }
  if ((data.stats.dailyFollows || 0) >= settings.maxFollowsPerDay) {
    console.log("[auto-x] daily limit reached, auto-follow paused");
    return;
  }
  activeAction = { userId, username, name: name || null };
  try {
    await api.tabs.sendMessage(connectedTabId, {
      type: "EXECUTE_ACTION",
      actionId: "follow-" + userId,
      actionType: "follow",
      targetUserId: userId,
    });
  } catch (e) {
    console.error("[auto-x] execute error:", e);
    data.pendingActions = data.pendingActions.filter((a) => a.userId !== userId);
    store.recordFollowResult(data, {
      ok: false,
      username,
      name,
      error: "标签页不可达: " + (e.message || String(e)),
    });
    store.addToLog(data, {
      type: "follow",
      targetUser: "@" + username,
      result: "fail: tab unreachable",
    });
    console.log("[auto-x] ✗ follow @" + username + " — tab unreachable");
    await persistData();
    activeAction = null;
  }
}

async function onActionResult(msg) {
  if (!activeAction) return;
  const uid = activeAction.userId;
  const uname = activeAction.username;
  const name = activeAction.name;
  activeAction = null;

  data.pendingActions = data.pendingActions.filter((a) => a.userId !== uid);

  if (msg.ok) {
    if (data.followers[uid]) {
      data.following[uid] = {
        ...data.followers[uid],
        _followedAt: new Date().toISOString(),
      };
      data.syncStatus.following.count = Object.keys(data.following).length;
    } else {
      data.following[uid] = {
        id: uid,
        username: uname,
        name: name || null,
        _followedAt: new Date().toISOString(),
      };
      data.syncStatus.following.count = Object.keys(data.following).length;
    }
    data.stats.dailyFollows = (data.stats.dailyFollows || 0) + 1;
    data.stats.lastActionAt = new Date().toISOString();
    store.recordFollowResult(data, { ok: true, username: uname, name });
    store.addToLog(data, { type: "follow", targetUser: "@" + uname, result: "ok" });
    console.log(
      "[auto-x] ✓ 成功关注 @" + uname + (name ? " (" + name + ")" : "") +
        " | 今日成功 " + data.stats.dailyFollows,
    );
  } else {
    data.stats.lastActionAt = new Date().toISOString();
    const err = msg.error || "unknown";
    store.recordFollowResult(data, { ok: false, username: uname, name, error: err });
    store.addToLog(data, {
      type: "follow",
      targetUser: "@" + uname,
      result: "fail: " + err,
    });
    console.log("[auto-x] ✗ 关注失败 @" + uname + " — " + err);
  }
  await persistData();

  if (!data.autoFollowRunning) return;
  const interval = (await getSettings()).minIntervalSec * 1000;
  setTimeout(() => {
    processQueue();
  }, interval);
}

async function processQueue() {
  if (activeAction) return;
  await loadData();
  if (!data.autoFollowRunning || !data.connection?.connected) return;
  if (!connectedTabId) {
    // try restore from connection.tabId
    if (data.connection.tabId) connectedTabId = data.connection.tabId;
  }
  if (!connectedTabId) return;

  const candidates = await computeFollowBacks();
  if (!candidates.length) return;
  const next = candidates[0];
  if (!data.pendingActions.some((a) => a.userId === next.id)) {
    data.pendingActions.push({ userId: next.id, queuedAt: new Date().toISOString() });
    await persistData();
  }
  await executeAction(next.id, next.username, next.name);
}

async function findXTabs() {
  try {
    const tabs = await api.tabs.query({
      url: ["https://x.com/*", "https://twitter.com/*"],
    });
    return tabs || [];
  } catch {
    // Firefox may need broader query + filter
    try {
      const all = await api.tabs.query({});
      return (all || []).filter((t) => isXUrl(t.url));
    } catch {
      return [];
    }
  }
}

async function probeTabSession(tabId) {
  try {
    const resp = await api.tabs.sendMessage(tabId, { type: "GET_SESSION" });
    return resp || null;
  } catch {
    return null;
  }
}

/**
 * Scan open X tabs for a logged-in session.
 * Does not force navigation or steal focus.
 */
async function detectLoginState() {
  const tabs = await findXTabs();
  let anyXTab = tabs.length > 0;
  let best = null;

  for (const tab of tabs) {
    const resp = await probeTabSession(tab.id);
    if (!resp) continue;
    if (resp.loggedIn && resp.user?.username) {
      best = { tabId: tab.id, loggedIn: true, user: resp.user, url: tab.url };
      break;
    }
    if (resp.loggedIn === false && !best) {
      best = { tabId: tab.id, loggedIn: false, user: null, url: tab.url };
    }
  }

  // Prefer heartbeat liveSession if fresher
  if (liveSession && Date.now() - (liveSession.at || 0) < 30_000) {
    if (liveSession.loggedIn && liveSession.user?.username) {
      best = {
        tabId: liveSession.tabId || best?.tabId,
        loggedIn: true,
        user: liveSession.user,
        url: liveSession.tabUrl,
      };
      anyXTab = true;
    } else if (!best) {
      best = {
        tabId: liveSession.tabId,
        loggedIn: !!liveSession.loggedIn,
        user: liveSession.user,
        url: liveSession.tabUrl,
      };
      anyXTab = true;
    }
  }

  return {
    hasXTab: anyXTab,
    loggedIn: !!(best && best.loggedIn && best.user?.username),
    user: best?.user || null,
    tabId: best?.tabId ?? null,
  };
}

async function openLoginPage() {
  const url = "https://x.com/i/flow/login";
  const tab = await api.tabs.create({ url, active: true });
  return { ok: true, tabId: tab?.id };
}

async function openOrFocusX() {
  const tabs = await findXTabs();
  if (tabs.length) {
    const t = tabs[0];
    await api.tabs.update(t.id, { active: true });
    if (t.windowId != null) {
      try {
        await api.windows.update(t.windowId, { focused: true });
      } catch {
        /* some browsers restrict */
      }
    }
    return { ok: true, tabId: t.id };
  }
  const tab = await api.tabs.create({ url: "https://x.com/home", active: true });
  return { ok: true, tabId: tab?.id };
}

/**
 * Explicit "连接" — verify logged-in X session and bind tab.
 * Does not navigate away from current page content if already on X.
 */
async function connectAccount() {
  await loadData();
  let detection = await detectLoginState();

  if (!detection.hasXTab) {
    await openOrFocusX();
    // wait briefly for content script
    await new Promise((r) => setTimeout(r, 2000));
    detection = await detectLoginState();
  }

  if (!detection.loggedIn || !detection.user?.username) {
    data.connection = { connected: false, connectedAt: null, tabId: null };
    await persistData();
    return {
      ok: false,
      error: "未检测到已登录的 X 账户",
      needLogin: true,
      loggedIn: false,
    };
  }

  connectedTabId = detection.tabId;
  data.sessionUser = {
    id: detection.user.id ?? null,
    username: detection.user.username,
    name: detection.user.name ?? null,
    avatar: detection.user.avatar ?? null,
  };
  data.connection = {
    connected: true,
    connectedAt: new Date().toISOString(),
    tabId: detection.tabId,
  };
  await persistData();

  if (detection.tabId) {
    await pushKnownQueries(detection.tabId);
  }

  console.log(
    "[auto-x] connected as @" + data.sessionUser.username +
      (data.sessionUser.name ? " (" + data.sessionUser.name + ")" : ""),
  );

  return {
    ok: true,
    user: data.sessionUser,
    connected: true,
  };
}

async function disconnectAccount() {
  await loadData();
  data.autoFollowRunning = false;
  data.connection = { connected: false, connectedAt: null, tabId: null };
  await persistData();
  activeAction = null;
  return { ok: true };
}

async function startAutoFollow() {
  await loadData();
  if (!data.connection?.connected) {
    return { ok: false, error: "请先连接账户" };
  }
  if (!connectedTabId && data.connection.tabId) {
    connectedTabId = data.connection.tabId;
  }
  // Re-verify live session without navigating
  const det = await detectLoginState();
  if (det.loggedIn && det.user?.username) {
    data.sessionUser = {
      id: det.user.id ?? data.sessionUser?.id ?? null,
      username: det.user.username,
      name: det.user.name ?? data.sessionUser?.name ?? null,
      avatar: det.user.avatar ?? data.sessionUser?.avatar ?? null,
    };
    if (det.tabId) {
      connectedTabId = det.tabId;
      data.connection.tabId = det.tabId;
    }
  }

  data.autoFollowRunning = true;
  await persistData();
  console.log("[auto-x] 自动关注已启动");
  processQueue();
  return { ok: true, running: true };
}

async function stopAutoFollow() {
  await loadData();
  data.autoFollowRunning = false;
  activeAction = null;
  await persistData();
  console.log("[auto-x] 自动关注已停止 🛑");
  return { ok: true, running: false };
}

async function startSync(stream) {
  await loadData();
  if (!data.connection?.connected) {
    return { ok: false, error: "请先连接账户" };
  }
  if (!connectedTabId) {
    if (data.connection.tabId) connectedTabId = data.connection.tabId;
  }
  if (!connectedTabId) {
    const det = await detectLoginState();
    if (det.tabId) connectedTabId = det.tabId;
  }
  if (!connectedTabId) return { ok: false, error: "请先打开 X.com 标签页" };

  let username = data.sessionUser?.username;
  if (!username) {
    try {
      const resp = await api.tabs.sendMessage(connectedTabId, { type: "GET_SESSION" });
      if (resp?.user?.username) username = resp.user.username;
    } catch {
      /* ignore */
    }
  }
  if (!username) return { ok: false, error: "无法识别用户名，请重新连接" };

  pendingWalk = { stream, tabId: connectedTabId };
  await api.storage.local.set({
    pendingWalk: { stream, tabId: connectedTabId, at: Date.now() },
  });

  // Navigating for sync is explicit user action from popup
  const targetUrl = "https://x.com/" + username + "/" + stream;
  try {
    await api.tabs.update(connectedTabId, { url: targetUrl, active: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

async function tryDispatchWalk(tabId) {
  if (!pendingWalk || pendingWalk.tabId !== tabId) return false;
  try {
    await api.tabs.sendMessage(tabId, {
      type: "START_WALK",
      stream: pendingWalk.stream,
    });
    console.log("[auto-x] walk dispatched:", pendingWalk.stream);
    return true;
  } catch {
    return false;
  }
}

async function pushKnownQueries(tabId) {
  try {
    const stored = (await api.storage.local.get("knownQueries")).knownQueries || {};
    if (Object.keys(stored).length) {
      await api.tabs.sendMessage(tabId, { type: "SEED_QUERIES", queries: stored });
    }
  } catch {
    /* content not ready */
  }
}

function buildStatus() {
  const successList = data.stats?.successList || [];
  const failList = data.stats?.failList || [];
  return {
    version: VERSION,
    connection: data.connection || { connected: false },
    connected: !!(data.connection && data.connection.connected),
    autoFollowRunning: !!data.autoFollowRunning,
    sessionUser: data.sessionUser || null,
    liveLoggedIn: !!(liveSession && liveSession.loggedIn),
    liveUser: liveSession?.user || null,
    followers: data.syncStatus.followers,
    following: data.syncStatus.following,
    dailyFollows: data.stats.dailyFollows || 0,
    pendingActions: (data.pendingActions || []).length,
    lastActionAt: data.stats.lastActionAt,
    recentLog: (data.actionLog || []).slice(0, 20),
    successCount: successList.length,
    failCount: failList.length,
    successList: successList.slice(0, 30),
    failList: failList.slice(0, 30),
    walkActive: !!pendingWalk,
    walkStream: pendingWalk?.stream || null,
    hasConnectedTab: !!connectedTabId,
  };
}

// ── Message router ──

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "HEARTBEAT": {
          const tabId = sender.tab?.id ?? connectedTabId;
          if (tabId) connectedTabId = tabId;
          if (tabId) await pushKnownQueries(tabId);

          liveSession = {
            loggedIn: !!msg.loggedIn,
            user: msg.user || null,
            tabId,
            tabUrl: msg.tabUrl || null,
            at: Date.now(),
          };

          // Keep sessionUser fresh while connected
          if (msg.loggedIn && msg.user?.username && data) {
            await loadData();
            data.sessionUser = {
              id: msg.user.id ?? data.sessionUser?.id ?? null,
              username: msg.user.username,
              name: msg.user.name ?? data.sessionUser?.name ?? null,
              avatar: msg.user.avatar ?? data.sessionUser?.avatar ?? null,
            };
            if (data.connection?.connected && tabId) {
              data.connection.tabId = tabId;
            }
            await persistData();
          }

          if (tabId && pendingWalk?.tabId === tabId) {
            await tryDispatchWalk(tabId);
          }
          sendResponse({ ok: true });
          processQueue();
          break;
        }
        case "SESSION_USER": {
          await loadData();
          if (msg.user?.username) {
            data.sessionUser = {
              id: msg.user.id ?? null,
              username: msg.user.username,
              name: msg.user.name ?? null,
              avatar: msg.user.avatar ?? null,
            };
            liveSession = {
              loggedIn: true,
              user: data.sessionUser,
              tabId: sender.tab?.id ?? null,
              at: Date.now(),
            };
            await persistData();
          } else if (msg.loggedIn === false) {
            liveSession = {
              loggedIn: false,
              user: null,
              tabId: sender.tab?.id ?? null,
              at: Date.now(),
            };
          }
          sendResponse({ ok: true });
          break;
        }
        case "INGEST_BATCH": {
          await loadData();
          if (msg.users?.length) {
            const n = ingestUsers(msg.users, msg.walk?.stream || "followers");
            console.log("[auto-x] ingested", n, "users from", msg.walk?.stream);
          }
          sendResponse({ ok: true });
          if (msg.walk?.stream === "followers") {
            setTimeout(() => processQueue(), 3000);
          }
          break;
        }
        case "WALK_ENDED": {
          await loadData();
          if (msg.walk?.stream) {
            data.syncStatus[msg.walk.stream].lastSync = new Date().toISOString();
            await persistData();
          }
          if (pendingWalk && msg.walk?.stream === pendingWalk.stream) {
            pendingWalk = null;
            await api.storage.local.remove("pendingWalk");
          }
          sendResponse({ ok: true });
          setTimeout(() => processQueue(), 3000);
          break;
        }
        case "ACTION_COMPLETED":
          await loadData();
          await onActionResult(msg);
          sendResponse({ ok: true });
          break;
        case "QUERY_LEARNED": {
          const queries = (await api.storage.local.get("knownQueries")).knownQueries || {};
          queries[msg.endpoint] = { hash: msg.hash, seenAt: Date.now() };
          await api.storage.local.set({ knownQueries: queries });
          sendResponse({ ok: true });
          break;
        }
        case "DETECT_LOGIN":
          sendResponse(await detectLoginState());
          break;
        case "OPEN_LOGIN":
          sendResponse(await openLoginPage());
          break;
        case "OPEN_X":
          sendResponse(await openOrFocusX());
          break;
        case "CONNECT":
          sendResponse(await connectAccount());
          break;
        case "DISCONNECT":
          sendResponse(await disconnectAccount());
          break;
        case "START_AUTO_FOLLOW":
          sendResponse(await startAutoFollow());
          break;
        case "STOP_AUTO_FOLLOW":
          sendResponse(await stopAutoFollow());
          break;
        case "START_SYNC":
          sendResponse(await startSync(msg.stream));
          break;
        case "STOP_SYNC": {
          pendingWalk = null;
          await api.storage.local.remove("pendingWalk");
          if (connectedTabId) {
            try {
              await api.tabs.sendMessage(connectedTabId, { type: "STOP_WALK" });
            } catch {
              /* ignore */
            }
          }
          sendResponse({ ok: true });
          break;
        }
        case "CLEAR_RESULTS": {
          await loadData();
          data.stats.successList = [];
          data.stats.failList = [];
          await persistData();
          sendResponse({ ok: true });
          break;
        }
        case "GET_STATUS": {
          await loadData();
          const det = await detectLoginState();
          const status = buildStatus();
          status.liveLoggedIn = det.loggedIn;
          status.liveUser = det.user;
          status.hasXTab = det.hasXTab;
          // If connected but live says logged out, surface warning
          status.sessionMismatch =
            status.connected && det.hasXTab && det.loggedIn === false;
          sendResponse(status);
          break;
        }
        case "GET_SETTINGS":
          sendResponse(await getSettings());
          break;
        case "SAVE_SETTINGS": {
          const next = {
            minIntervalSec: Math.max(30, Number(msg.settings?.minIntervalSec) || 60),
            maxFollowsPerDay: Math.min(
              200,
              Math.max(1, Number(msg.settings?.maxFollowsPerDay) || 50),
            ),
          };
          await api.storage.local.set({ autox_settings: next });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: true });
      }
    } catch (e) {
      console.error("[auto-x]", e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // async response — Chrome + Firefox
});

// ── Tab tracking ──

api.tabs.onRemoved.addListener((tabId) => {
  if (tabId === connectedTabId) connectedTabId = null;
  if (pendingWalk?.tabId === tabId) pendingWalk = null;
  if (liveSession?.tabId === tabId) liveSession = null;
});

api.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  if (!pendingWalk || pendingWalk.tabId !== tabId) return;
  setTimeout(async () => {
    await pushKnownQueries(tabId);
    await tryDispatchWalk(tabId);
  }, 1500);
});

// ── Periodic tick (works with popup closed) ──

try {
  api.alarms.create("tick", { periodInMinutes: 1 });
  api.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== "tick") return;
    await loadData();
    processQueue();
  });
} catch (e) {
  console.warn("[auto-x] alarms unavailable", e);
  // Fallback interval for environments without alarms
  setInterval(async () => {
    await loadData();
    processQueue();
  }, 60_000);
}

// ── Init ──

(async function () {
  await loadData();
  if (data.connection?.tabId) connectedTabId = data.connection.tabId;
  const pw = (await api.storage.local.get("pendingWalk")).pendingWalk;
  if (pw?.stream && pw?.tabId && Date.now() - (pw.at || 0) < 10 * 60 * 1000) {
    pendingWalk = { stream: pw.stream, tabId: pw.tabId };
  }
  console.log(
    "[auto-x] v" + VERSION +
      " | connected=" + !!data.connection?.connected +
      " | autoFollow=" + !!data.autoFollowRunning +
      " | followers=" + Object.keys(data.followers).length +
      " | following=" + Object.keys(data.following).length,
  );
  processQueue();
})();
