/**
 * Background decision engine — Chrome / Edge (service worker) + Firefox (scripts).
 * Popup close does NOT stop auto-follow; work continues via alarms + content heartbeat.
 */
if (typeof importScripts === "function") {
  importScripts("./lib/browser.js", "./lib/store.js");
}

const api = self.autoxBrowser || (typeof browser !== "undefined" ? browser : chrome);
const store = self.autoxStore;
const VERSION = "0.3.15";
const PANEL_PATH = "src/panel/panel.html";

let connectedTabId = null;
let data = null;
let activeAction = null;
let pendingWalk = null;
let saveChain = Promise.resolve();
let processQueueTimer = null;
let activeActionTimer = null;
/** Live probe from content: { loggedIn, user, tabId, at } */
let liveSession = null;
/** Follow-back on /followers list (not profile pages) */
let followBackWalk = null; // { tabId, active, startedAt }
/**
 * Auto graph sync after connect: followers → following, no manual start needed.
 * { queue, idx, phase: 'running'|'done'|'error'|'idle', error, startedAt, finishedAt }
 */
let autoSyncPlan = null;

const DEFAULT_SETTINGS = {
  minIntervalSec: 5,
  maxFollowsPerDay: 50,
};

async function getSettings() {
  const cfg = await api.storage.local.get("autox_settings");
  const raw = cfg.autox_settings || {};
  let minIntervalSec = Number(raw.minIntervalSec);
  // Migrate old default 60s (and prior min floor 30s) → 5s
  if (!minIntervalSec || minIntervalSec === 60 || (minIntervalSec >= 30 && !raw._v37)) {
    minIntervalSec = 5;
    try {
      await api.storage.local.set({
        autox_settings: {
          minIntervalSec: 5,
          maxFollowsPerDay: Math.min(
            200,
            Math.max(1, Number(raw.maxFollowsPerDay) || DEFAULT_SETTINGS.maxFollowsPerDay),
          ),
          _v37: true,
        },
      });
    } catch {
      /* ignore */
    }
  }
  minIntervalSec = Math.max(5, Math.min(600, minIntervalSec || 5));
  const maxFollowsPerDay = Math.min(
    200,
    Math.max(1, Number(raw.maxFollowsPerDay) || DEFAULT_SETTINGS.maxFollowsPerDay),
  );
  return { minIntervalSec, maxFollowsPerDay };
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

function recountSync(stream) {
  if (!data) return 0;
  const target = stream === "followers" ? data.followers : data.following;
  const n = Object.keys(target || {}).length;
  if (!data.syncStatus[stream]) data.syncStatus[stream] = { lastSync: null, count: 0 };
  data.syncStatus[stream].count = n;
  return n;
}

/**
 * After a full list walk: count = only users seen this run.
 * Fixes "following 540 vs 主页 536" (stale + false positives) and
 * keeps followers aligned with what the list actually returned.
 */
function reconcileStreamAfterWalk(stream, sessionSeen) {
  if (!data || !stream) return 0;
  const seen = sessionSeen instanceof Set ? sessionSeen : new Set(sessionSeen || []);
  if (seen.size === 0) {
    console.warn("[auto-x] reconcile skipped — empty sessionSeen for", stream);
    return recountSync(stream);
  }

  const prev = stream === "followers" ? data.followers : data.following;
  const next = {};
  let kept = 0;
  for (const id of seen) {
    const sid = String(id);
    if (prev[sid]) {
      next[sid] = prev[sid];
      kept++;
    }
  }
  // Preserve very recent auto-follows not yet on the following list API
  if (stream === "following") {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, u] of Object.entries(prev || {})) {
      if (next[id]) continue;
      if (!u?._fromAutoFollow || !u._followedAt) continue;
      const t = new Date(u._followedAt).getTime();
      if (t >= cutoff) next[id] = u;
    }
  }

  const before = Object.keys(prev || {}).length;
  if (stream === "followers") data.followers = next;
  else data.following = next;
  const after = recountSync(stream);
  console.log(
    "[auto-x] reconcile",
    stream,
    "before=",
    before,
    "sessionSeen=",
    seen.size,
    "after=",
    after,
    "dropped=",
    before - after,
  );
  return after;
}

function trackSessionSeen(stream, userIds) {
  if (!pendingWalk || pendingWalk.stream !== stream) return;
  if (!pendingWalk.sessionSeen) pendingWalk.sessionSeen = new Set();
  for (const id of userIds || []) {
    if (id != null) pendingWalk.sessionSeen.add(String(id));
  }
}

function ingestUsers(users, stream) {
  if (!users?.length) return 0;
  let count = 0;
  const target = stream === "followers" ? data.followers : data.following;
  const selfId =
    (data.sessionUser?.id && String(data.sessionUser.id)) ||
    (data.syncStatus?.profile?.id && String(data.syncStatus.profile.id)) ||
    null;
  const selfName = data.sessionUser?.username
    ? String(data.sessionUser.username).toLowerCase()
    : data.syncStatus?.profile?.username
      ? String(data.syncStatus.profile.username).toLowerCase()
      : null;
  const acceptedIds = [];
  for (const u of users) {
    if (!u?.id) continue;
    const id = String(u.id);
    let username = u.username ? String(u.username) : "id:" + id;
    // Never store self as a follower/following entry (timeline root user appears in GraphQL)
    if (selfId && id === selfId) continue;
    if (
      selfName &&
      username.toLowerCase() === selfName &&
      !username.startsWith("id:")
    ) {
      continue;
    }
    const prev = target[id] || {};
    // Prefer real username over stub
    if (prev.username && !prev.username.startsWith("id:") && username.startsWith("id:")) {
      username = prev.username;
    }
    const unavailable =
      typeof u.unavailable === "boolean" ? u.unavailable : !!prev.unavailable;
    target[id] = {
      ...prev,
      ...u,
      id,
      username,
      unavailable,
      _seenAt: new Date().toISOString(),
      _seenInWalk: true,
    };
    acceptedIds.push(id);
    count++;
  }
  trackSessionSeen(stream, acceptedIds);
  data.syncStatus[stream].lastSync = new Date().toISOString();
  // During walk show session progress when available (more honest than stale total)
  if (pendingWalk?.stream === stream && pendingWalk.sessionSeen) {
    data.syncStatus[stream].count = pendingWalk.sessionSeen.size;
    data.syncStatus[stream].walkProgress = pendingWalk.sessionSeen.size;
  } else {
    recountSync(stream);
  }
  persistData();
  return count;
}

function applyProfileMeta(meta) {
  if (!data || !meta) return;
  if (!data.syncStatus.profile) data.syncStatus.profile = {};
  if (meta.followers_count != null) {
    data.syncStatus.profile.followersCount = Number(meta.followers_count);
  }
  if (meta.following_count != null) {
    data.syncStatus.profile.followingCount = Number(meta.following_count);
  }
  if (meta.id) data.syncStatus.profile.id = String(meta.id);
  if (meta.username) data.syncStatus.profile.username = meta.username;
  data.syncStatus.profile.updatedAt = new Date().toISOString();
  // Keep session id if missing
  if (meta.id && data.sessionUser && !data.sessionUser.id) {
    data.sessionUser.id = String(meta.id);
  }
  persistData();
}

function scheduleProcessQueue(delayMs) {
  if (processQueueTimer) clearTimeout(processQueueTimer);
  processQueueTimer = setTimeout(() => {
    processQueueTimer = null;
    processQueue();
  }, Math.max(500, delayMs || 1000));
}

function clearActiveActionWatch() {
  if (activeActionTimer) {
    clearTimeout(activeActionTimer);
    activeActionTimer = null;
  }
}

/** Graph list sync running (followers/following walk or auto pipeline) */
function isGraphSyncBusy() {
  return !!(pendingWalk || (autoSyncPlan && autoSyncPlan.phase === "running"));
}

/** Tab may be mid-navigation for list sync — content script briefly unavailable */
function isSyncNavigating() {
  if (!pendingWalk?.navAt) return false;
  return Date.now() - pendingWalk.navAt < 4500;
}

/**
 * Soft-release a follow attempt without counting as failure.
 * Used when list sync reloads the tab — auto-follow must not be "interrupted" as failed.
 */
function softReleaseFollow(userId, reason) {
  clearActiveActionWatch();
  if (activeAction && String(activeAction.userId) === String(userId)) {
    activeAction = null;
  } else if (activeAction && !userId) {
    activeAction = null;
  }
  if (data && userId != null) {
    data.pendingActions = (data.pendingActions || []).filter(
      (a) => String(a.userId) !== String(userId),
    );
  }
  console.log("[auto-x] follow soft-retry:", reason || "", userId || "");
  if (data?.autoFollowRunning) scheduleProcessQueue(2500);
}

async function computeFollowBacks() {
  if (!data?.autoFollowRunning) return [];
  if (!data?.connection?.connected) return [];
  const settings = await getSettings();
  const candidates = store.getNonMutualFollowers(data);
  const remaining = Math.max(0, settings.maxFollowsPerDay - (data.stats.dailyFollows || 0));
  return candidates.slice(0, Math.min(remaining, 5));
}

async function ensureConnectedTab() {
  if (connectedTabId) {
    try {
      const t = await api.tabs.get(connectedTabId);
      if (t && isXUrl(t.url)) return connectedTabId;
    } catch {
      connectedTabId = null;
    }
  }
  if (data?.connection?.tabId) {
    connectedTabId = data.connection.tabId;
    try {
      const t = await api.tabs.get(connectedTabId);
      if (t && isXUrl(t.url)) return connectedTabId;
    } catch {
      connectedTabId = null;
    }
  }
  const tabs = await findXTabs();
  const tab = (tabs || []).find((t) => t.id != null);
  if (tab?.id != null) {
    connectedTabId = tab.id;
    if (data?.connection?.connected) {
      data.connection.tabId = tab.id;
      await persistData();
    }
    return connectedTabId;
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForTabPath(tabId, pathTest, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        api.tabs.onUpdated.removeListener(onUpd);
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const okUrl = (url) => {
      try {
        return pathTest(new URL(url).pathname || "");
      } catch {
        return false;
      }
    };
    const onUpd = (id, info, tab) => {
      if (id !== tabId) return;
      const url = info.url || tab?.url;
      if (url && okUrl(url) && (info.status === "complete" || tab?.status === "complete")) {
        finish(true);
      }
    };
    api.tabs.onUpdated.addListener(onUpd);
    api.tabs
      .get(tabId)
      .then((t) => {
        if (t?.url && okUrl(t.url) && t.status === "complete") finish(true);
      })
      .catch(() => {});
    const tick = () => {
      if (done) return;
      if (Date.now() >= deadline) return finish(false);
      api.tabs
        .get(tabId)
        .then((t) => {
          if (t?.url && okUrl(t.url) && t.status === "complete") finish(true);
          else setTimeout(tick, 400);
        })
        .catch(() => setTimeout(tick, 400));
    };
    setTimeout(tick, 400);
  });
}

/**
 * Auto follow-back: stay on /followers (关注者) and click every
 * 「回关 / Follow / Follow back」 button in the list. Never open profiles.
 */
async function startFollowBackList() {
  await loadData();
  if (!data?.autoFollowRunning) return { ok: false, error: "auto-follow off" };
  if (isGraphSyncBusy()) {
    console.log("[auto-x] follow-back list waits for graph sync");
    scheduleProcessQueue(8000);
    return { ok: false, deferred: true, reason: "sync-busy" };
  }
  if (followBackWalk?.active) {
    return { ok: true, already: true };
  }

  const tabId = await ensureConnectedTab();
  if (!tabId) {
    scheduleProcessQueue(5000);
    return { ok: false, error: "no-tab" };
  }

  let username = data.sessionUser?.username;
  if (!username) {
    try {
      const r = await api.tabs.sendMessage(tabId, { type: "GET_SESSION" });
      username = r?.user?.username;
    } catch {
      /* ignore */
    }
  }
  if (!username) return { ok: false, error: "无法识别用户名" };

  const settings = await getSettings();
  const remaining = Math.max(
    0,
    settings.maxFollowsPerDay - (data.stats.dailyFollows || 0),
  );
  if (remaining <= 0) {
    console.log("[auto-x] daily limit reached");
    return { ok: false, error: "今日回关已达上限" };
  }

  const listUrl = "https://x.com/" + username + "/followers";
  followBackWalk = { tabId, active: true, startedAt: Date.now(), username };
  try {
    console.log("[auto-x] open 关注者列表 for follow-back →", listUrl);
    await api.tabs.update(tabId, { url: listUrl, active: true });
  } catch (e) {
    followBackWalk = null;
    return { ok: false, error: e.message };
  }

  await waitForTabPath(
    tabId,
    (p) => /\/followers(?:\/|$)/.test(p),
    30000,
  );
  await sleep(2500);

  try {
    await api.tabs.sendMessage(tabId, {
      type: "START_FOLLOW_BACK_LIST",
      intervalSec: settings.minIntervalSec || 5,
      maxClicks: remaining,
      selfUsername: username,
    });
    console.log(
      "[auto-x] follow-back list started | interval=" +
        settings.minIntervalSec +
        "s | max=" +
        remaining,
    );
    return { ok: true };
  } catch (e) {
    console.warn("[auto-x] START_FOLLOW_BACK_LIST failed, retry", e.message || e);
    await sleep(2000);
    try {
      await api.tabs.sendMessage(tabId, {
        type: "START_FOLLOW_BACK_LIST",
        intervalSec: settings.minIntervalSec || 5,
        maxClicks: remaining,
        selfUsername: username,
      });
      return { ok: true };
    } catch (e2) {
      followBackWalk = null;
      return { ok: false, error: e2.message };
    }
  }
}

async function stopFollowBackList() {
  const tabId = followBackWalk?.tabId || connectedTabId;
  followBackWalk = null;
  if (tabId) {
    try {
      await api.tabs.sendMessage(tabId, { type: "STOP_FOLLOW_BACK_LIST" });
    } catch {
      /* ignore */
    }
  }
}

/** @deprecated profile-by-profile removed — kept name for any callers */
async function executeAction() {
  return startFollowBackList();
}

async function onActionResult(msg) {
  // List-page follow-back sends results without activeAction (profile path removed)
  clearActiveActionWatch();
  activeAction = null;

  const uid = msg.targetUserId != null ? String(msg.targetUserId) : null;
  const uname = msg.username || "unknown";
  const name = msg.name || null;

  if (uid) {
    data.pendingActions = (data.pendingActions || []).filter(
      (a) => String(a.userId) !== uid,
    );
  }

  const isSuccess =
    !!msg.ok &&
    (msg.following === true ||
      msg.verified === true ||
      msg.alreadyFollowing === true ||
      msg.error == null);

  if (isSuccess) {
    const base =
      (uid && (data.followers[uid] || data.followers[String(uid)])) || {};
    const finalName = uname || base.username || null;
    if (uid) {
      data.following[uid] = {
        id: uid,
        username: finalName,
        name: name || base.name || null,
        verified: base.verified,
        protected: base.protected,
        _followedAt: new Date().toISOString(),
        _fromAutoFollow: true,
      };
      if (data.syncStatus?.following) {
        data.syncStatus.following.count = Object.keys(data.following).length;
      }
    }
    if (!msg.alreadyFollowing) {
      data.stats.dailyFollows = (data.stats.dailyFollows || 0) + 1;
    }
    data.stats.lastActionAt = new Date().toISOString();
    store.recordFollowResult(data, {
      ok: true,
      username: finalName || uname,
      name,
    });
    store.addToLog(data, {
      type: "follow",
      targetUser: "@" + (finalName || uname),
      result: msg.alreadyFollowing
        ? "ok: already"
        : msg.pendingFollow
          ? "ok: pending"
          : "ok:list-click",
    });
    console.log(
      "[auto-x] ✓ 列表回关 @" +
        (finalName || uname) +
        " | 今日 " +
        data.stats.dailyFollows +
        (msg.method ? " via " + msg.method : ""),
    );

    // Daily cap: stop list walk
    const settings = await getSettings();
    if ((data.stats.dailyFollows || 0) >= settings.maxFollowsPerDay) {
      console.log("[auto-x] daily limit — stop follow-back list");
      await stopFollowBackList();
      data.autoFollowRunning = false;
      await persistData();
      return;
    }
  } else {
    data.stats.lastActionAt = new Date().toISOString();
    const err = msg.error || "unknown";
    // Failures are skipped on the list (no profile loop). Just record once.
    store.recordFollowResult(data, { ok: false, username: uname, name, error: err });
    store.addToLog(data, {
      type: "follow",
      targetUser: "@" + uname,
      result: "fail: " + err,
    });
    console.log("[auto-x] ✗ 列表回关失败 @" + uname + " — " + err + "（已跳过，不重试主页）");
  }
  await persistData();
  // Content list walk continues on its own timer — no processQueue re-entry per user
}

async function processQueue() {
  await loadData();
  if (!data.autoFollowRunning || !data.connection?.connected) {
    return;
  }
  if (isGraphSyncBusy()) {
    console.log("[auto-x] processQueue: wait graph sync before 关注者列表回关");
    scheduleProcessQueue(8000);
    return;
  }
  if (followBackWalk?.active) {
    // List walk already clicking 回关 buttons
    return;
  }
  const settings = await getSettings();
  const remaining = Math.max(
    0,
    settings.maxFollowsPerDay - (data.stats.dailyFollows || 0),
  );
  if (remaining <= 0) {
    console.log("[auto-x] processQueue: daily limit");
    return;
  }
  await startFollowBackList();
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

  // Connect success → auto sync followers then following in background
  setTimeout(() => {
    startAutoGraphSync({ reason: "connect" }).catch((e) =>
      console.warn("[auto-x] auto sync start failed", e),
    );
  }, 800);

  return {
    ok: true,
    user: data.sessionUser,
    connected: true,
    autoSync: true,
  };
}

async function disconnectAccount() {
  await loadData();
  data.autoFollowRunning = false;
  data.connection = { connected: false, connectedAt: null, tabId: null };
  data.pendingActions = [];
  await persistData();
  activeAction = null;
  autoSyncPlan = null;
  await stopSync({ clearPlan: true });
  return { ok: true };
}

/**
 * Queue: followers → following. Runs after connect; UI shows progress only.
 */
async function startAutoGraphSync(opts = {}) {
  await loadData();
  if (!data.connection?.connected) {
    return { ok: false, error: "请先连接账户" };
  }
  if (autoSyncPlan?.phase === "running" || pendingWalk) {
    return {
      ok: true,
      already: true,
      phase: autoSyncPlan?.phase || "running",
      stream: pendingWalk?.stream || autoSyncPlan?.queue?.[autoSyncPlan.idx] || null,
    };
  }

  autoSyncPlan = {
    queue: ["followers", "following"],
    idx: 0,
    phase: "running",
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    reason: opts.reason || "manual",
  };
  console.log("[auto-x] auto graph sync started (" + autoSyncPlan.reason + ")");
  return runAutoSyncStep();
}

async function runAutoSyncStep() {
  if (!autoSyncPlan || autoSyncPlan.phase !== "running") {
    return { ok: false, error: "no auto sync plan" };
  }
  if (autoSyncPlan.idx >= autoSyncPlan.queue.length) {
    autoSyncPlan.phase = "done";
    autoSyncPlan.finishedAt = Date.now();
    await loadData();
    recountSync("followers");
    recountSync("following");
    await persistData();
    const fl = Object.keys(data.followers || {}).length;
    const fg = Object.keys(data.following || {}).length;
    const nm = store.getNonMutualFollowers(data).length;
    console.log(
      "[auto-x] auto graph sync done | followers=" +
        fl +
        " following=" +
        fg +
        " nonMutual=" +
        nm,
    );
    if (data.autoFollowRunning) scheduleProcessQueue(1500);
    return { ok: true, done: true, followers: fl, following: fg, nonMutual: nm };
  }

  const stream = autoSyncPlan.queue[autoSyncPlan.idx];
  const r = await startSync(stream, { auto: true, background: true });
  if (!r.ok) {
    // If busy with same stream, treat as ok
    if (r.busy && r.walkStream === stream) return { ok: true, stream };
    autoSyncPlan.error = r.error || "同步启动失败";
    autoSyncPlan.phase = "error";
    console.warn("[auto-x] auto sync step failed", stream, r.error);
    return r;
  }
  return { ok: true, stream, auto: true };
}

async function advanceAutoSyncAfterWalk(stream) {
  if (!autoSyncPlan || autoSyncPlan.phase !== "running") return;
  const current = autoSyncPlan.queue[autoSyncPlan.idx];
  // Only advance when the ended stream matches the current step (ignore dup/stale ends)
  if (stream && current && stream !== current) {
    console.log(
      "[auto-x] ignore WALK_ENDED for",
      stream,
      "(current step is",
      current + ")",
    );
    return;
  }
  if (
    autoSyncPlan.lastEnded === (stream || current) &&
    Date.now() - (autoSyncPlan.lastEndedAt || 0) < 4000
  ) {
    return;
  }
  autoSyncPlan.lastEnded = stream || current;
  autoSyncPlan.lastEndedAt = Date.now();
  autoSyncPlan.idx += 1;
  // Brief pause so page can settle before navigating to next list
  setTimeout(() => {
    runAutoSyncStep().catch((e) => console.warn("[auto-x] auto sync advance", e));
  }, 1800);
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

  const tabId = await ensureConnectedTab();
  if (!tabId) {
    return { ok: false, error: "请先打开并登录 x.com 标签页" };
  }

  // Seed learned queries into page (Follow hash optional — REST fallback exists)
  await pushKnownQueries(tabId);

  const nonMutual = store.getNonMutualFollowers(data);
  const settings = await getSettings();
  const followerCount = Object.keys(data.followers || {}).length;
  if (followerCount === 0) {
    if (!autoSyncPlan || autoSyncPlan.phase !== "running") {
      startAutoGraphSync({ reason: "pre-follow" }).catch(() => {});
    }
    // still allow list walk — 关注者页按钮不依赖本地名单
  }

  data.autoFollowRunning = true;
  data.pendingActions = [];
  await persistData();
  console.log(
    "[auto-x] 自动回关已启动（关注者列表点「回关」）| 本地待回关约 " +
      nonMutual.length +
      " | 每日上限 " +
      settings.maxFollowsPerDay +
      " | 间隔 " +
      settings.minIntervalSec +
      "s",
  );
  // Open /followers and click list buttons — not profile pages
  scheduleProcessQueue(400);
  return {
    ok: true,
    running: true,
    nonMutual: nonMutual.length,
    followers: followerCount,
    following: Object.keys(data.following || {}).length,
    mode: "followers-list-click",
  };
}

async function stopAutoFollow() {
  await loadData();
  data.autoFollowRunning = false;
  activeAction = null;
  clearActiveActionWatch();
  data.pendingActions = [];
  await persistData();
  await stopFollowBackList();
  console.log("[auto-x] 自动回关已停止 🛑");
  return { ok: true, running: false };
}

function listUrlMatchesStream(url, stream) {
  if (!url || !stream) return false;
  try {
    const path = new URL(url).pathname || "";
    if (stream === "followers") return /\/followers(?:\/|$)/.test(path);
    if (stream === "following") return /\/following(?:\/|$)/.test(path);
  } catch {
    /* ignore */
  }
  return false;
}

async function stopSync(opts = {}) {
  // Never touches autoFollowRunning / activeAction — sync stop ≠ follow stop
  const stream = pendingWalk?.stream || null;
  const tabId = pendingWalk?.tabId || connectedTabId;
  pendingWalk = null;
  await api.storage.local.remove("pendingWalk");
  if (opts.clearPlan !== false && autoSyncPlan?.phase === "running") {
    autoSyncPlan.phase = "idle";
    autoSyncPlan.error = opts.reason || "stopped";
  }
  // Stop scroll on every X tab we can reach (content self-guards too)
  const targets = new Set();
  if (tabId) targets.add(tabId);
  if (connectedTabId) targets.add(connectedTabId);
  try {
    const tabs = await findXTabs();
    for (const t of tabs || []) {
      if (t?.id != null) targets.add(t.id);
    }
  } catch {
    /* ignore */
  }
  for (const id of targets) {
    try {
      await api.tabs.sendMessage(id, { type: "STOP_WALK" });
    } catch {
      /* tab may be gone */
    }
  }
  console.log("[auto-x] sync stopped", stream || "");
  return { ok: true, stopped: true, stream };
}

async function startSync(stream, opts = {}) {
  await loadData();
  if (stream !== "followers" && stream !== "following") {
    return { ok: false, error: "未知同步类型" };
  }
  if (!data.connection?.connected) {
    return { ok: false, error: "请先连接账户" };
  }

  // Only one list walk at a time (same tab navigation + scroll)
  if (pendingWalk) {
    if (pendingWalk.stream === stream) {
      return {
        ok: false,
        error: "该列表正在同步中",
        busy: true,
        walkStream: pendingWalk.stream,
      };
    }
    return {
      ok: false,
      error:
        "当前正在同步「" +
        (pendingWalk.stream === "followers" ? "粉丝" : "关注") +
        "」",
      busy: true,
      walkStream: pendingWalk.stream,
    };
  }

  const tabId = await ensureConnectedTab();
  if (!tabId) return { ok: false, error: "请先打开 X.com 标签页" };

  let username = data.sessionUser?.username;
  if (!username) {
    try {
      const resp = await api.tabs.sendMessage(tabId, { type: "GET_SESSION" });
      if (resp?.user?.username) username = resp.user.username;
    } catch {
      /* ignore */
    }
  }
  if (!username) return { ok: false, error: "无法识别用户名，请重新连接" };

  const targetUrl = "https://x.com/" + username + "/" + stream;
  const expectedCount =
    stream === "followers"
      ? data.syncStatus?.profile?.followersCount
      : data.syncStatus?.profile?.followingCount;
  pendingWalk = {
    stream,
    tabId,
    username,
    targetUrl,
    navAt: Date.now(),
    dispatchOk: false,
    auto: !!opts.auto,
    sessionSeen: new Set(),
    expectedCount: expectedCount != null ? Number(expectedCount) : null,
  };
  await api.storage.local.set({
    pendingWalk: {
      stream,
      tabId,
      username,
      targetUrl,
      at: Date.now(),
      navAt: Date.now(),
      auto: !!opts.auto,
      expectedCount: pendingWalk.expectedCount,
    },
  });

  // background:true keeps focus on current tab (auto sync after connect)
  const activate = opts.background ? false : true;
  try {
    await api.tabs.update(tabId, { url: targetUrl, active: activate });
  } catch (e) {
    pendingWalk = null;
    await api.storage.local.remove("pendingWalk");
    return { ok: false, error: e.message };
  }
  return { ok: true, walkStream: stream, auto: !!opts.auto };
}

async function tryDispatchWalk(tabId, tabUrlFromHeartbeat) {
  if (!pendingWalk || pendingWalk.tabId !== tabId) return false;

  let url = tabUrlFromHeartbeat || null;
  if (!url) {
    try {
      const tab = await api.tabs.get(tabId);
      url = tab?.url || null;
    } catch {
      return false;
    }
  }

  // Never start auto-scroll on Home / tweets / other pages
  if (!listUrlMatchesStream(url, pendingWalk.stream)) {
    const now = Date.now();
    const lastNav = pendingWalk.navAt || 0;
    // Re-navigate to the list page at most every 12s while sync is pending
    if (now - lastNav > 12000 && pendingWalk.username) {
      pendingWalk.navAt = now;
      const target =
        pendingWalk.targetUrl ||
        "https://x.com/" + pendingWalk.username + "/" + pendingWalk.stream;
      try {
        console.log("[auto-x] re-nav to list for walk:", target);
        await api.tabs.update(tabId, { url: target });
      } catch (e) {
        console.warn("[auto-x] re-nav failed", e);
      }
    }
    return false;
  }

  try {
    const expected =
      pendingWalk.expectedCount ??
      (pendingWalk.stream === "followers"
        ? data?.syncStatus?.profile?.followersCount
        : data?.syncStatus?.profile?.followingCount);
    const resp = await api.tabs.sendMessage(tabId, {
      type: "START_WALK",
      stream: pendingWalk.stream,
      expectedCount: expected != null ? Number(expected) : null,
    });
    if (resp?.wrongPage) {
      console.warn("[auto-x] walk refused wrong page:", resp.path);
      return false;
    }
    if (resp?.ok) {
      pendingWalk.dispatchOk = true;
      if (!resp.already) {
        console.log(
          "[auto-x] walk dispatched:",
          pendingWalk.stream,
          "on",
          url,
          expected != null ? "expected≈" + expected : "",
        );
      }
      return true;
    }
    return false;
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
  // Always derive live counts from maps (avoids stale syncStatus)
  const flLive = Object.keys(data.followers || {}).length;
  const fgLive = Object.keys(data.following || {}).length;
  if (data.syncStatus?.followers) data.syncStatus.followers.count = flLive;
  if (data.syncStatus?.following) data.syncStatus.following.count = fgLive;
  const nonMutual = store.getNonMutualStats
    ? store.getNonMutualStats(data)
    : { count: store.getNonMutualFollowers(data).length };

  const autoPhase = autoSyncPlan?.phase || "idle";
  const autoIdx = autoSyncPlan?.idx ?? 0;
  const autoQueue = autoSyncPlan?.queue || ["followers", "following"];
  const autoCurrent =
    autoPhase === "running"
      ? pendingWalk?.stream || autoQueue[autoIdx] || null
      : null;

  return {
    version: VERSION,
    connection: data.connection || { connected: false },
    connected: !!(data.connection && data.connection.connected),
    autoFollowRunning: !!data.autoFollowRunning,
    sessionUser: data.sessionUser || null,
    liveLoggedIn: !!(liveSession && liveSession.loggedIn),
    liveUser: liveSession?.user || null,
    followers: {
      ...(data.syncStatus.followers || {}),
      count: flLive,
    },
    following: {
      ...(data.syncStatus.following || {}),
      count: fgLive,
    },
    profileCounts: data.syncStatus?.profile || null,
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
    walkAuto: !!(pendingWalk && pendingWalk.auto),
    hasConnectedTab: !!connectedTabId,
    nonMutualCount: nonMutual.count ?? 0,
    nonMutualDetail: nonMutual,
    graphSyncBusy: isGraphSyncBusy(),
    followBackListActive: !!(followBackWalk && followBackWalk.active),
    activeFollow: activeAction
      ? { username: activeAction.username, userId: activeAction.userId }
      : null,
    autoSync: {
      phase: autoPhase,
      current: autoCurrent,
      idx: autoIdx,
      total: autoQueue.length,
      queue: autoQueue,
      error: autoSyncPlan?.error || null,
      startedAt: autoSyncPlan?.startedAt || null,
      finishedAt: autoSyncPlan?.finishedAt || null,
    },
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

          // Only dispatch walk when tab is already on the list URL.
          // Heartbeat must never cause Home timeline scrolling.
          if (tabId && pendingWalk?.tabId === tabId) {
            await tryDispatchWalk(tabId, msg.tabUrl || null);
          } else if (tabId && pendingWalk && pendingWalk.tabId !== tabId) {
            // Content reports walk but bg thinks another tab — stop stray scroll
            if (msg.walkActive) {
              try {
                await api.tabs.sendMessage(tabId, { type: "STOP_WALK" });
              } catch {
                /* ignore */
              }
            }
          } else if (!pendingWalk && msg.walkActive) {
            // Orphan walk in content (e.g. after SW restart) — stop it
            try {
              await api.tabs.sendMessage(tabId, { type: "STOP_WALK" });
            } catch {
              /* ignore */
            }
          }
          sendResponse({ ok: true });
          // Auto-follow queue is API-only; never coupled to page scroll
          if (data?.autoFollowRunning) processQueue();
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
            const stream = msg.walk?.stream || "followers";
            const n = ingestUsers(msg.users, stream);
            const progress =
              pendingWalk?.stream === stream && pendingWalk.sessionSeen
                ? pendingWalk.sessionSeen.size
                : stream === "following"
                  ? Object.keys(data.following).length
                  : Object.keys(data.followers).length;
            console.log(
              "[auto-x] ingested",
              n,
              "users from",
              stream,
              "| walkSeen=",
              progress,
            );
          }
          if (msg.profileMeta) {
            applyProfileMeta(msg.profileMeta);
            // Refresh expected count on active walk
            if (pendingWalk && msg.profileMeta) {
              if (
                pendingWalk.stream === "followers" &&
                msg.profileMeta.followers_count != null
              ) {
                pendingWalk.expectedCount = Number(msg.profileMeta.followers_count);
              }
              if (
                pendingWalk.stream === "following" &&
                msg.profileMeta.following_count != null
              ) {
                pendingWalk.expectedCount = Number(msg.profileMeta.following_count);
              }
            }
          }
          sendResponse({ ok: true });
          if (msg.walk?.stream === "followers" && data?.autoFollowRunning) {
            setTimeout(() => processQueue(), 3000);
          }
          break;
        }
        case "PROFILE_META": {
          await loadData();
          applyProfileMeta(msg.meta || msg);
          sendResponse({ ok: true });
          break;
        }
        case "WALK_ENDED": {
          await loadData();
          const endedStream = msg.walk?.stream || null;
          const sessionSeen =
            pendingWalk && (!endedStream || endedStream === pendingWalk.stream)
              ? pendingWalk.sessionSeen
              : null;
          if (endedStream) {
            if (!data.syncStatus[endedStream]) {
              data.syncStatus[endedStream] = { lastSync: null, count: 0 };
            }
            data.syncStatus[endedStream].lastSync = new Date().toISOString();
            // Full-list reconcile: drop stale / false-positive ids not in this walk
            if (sessionSeen && sessionSeen.size > 0) {
              reconcileStreamAfterWalk(endedStream, sessionSeen);
            } else if (msg.seenIds?.length) {
              reconcileStreamAfterWalk(endedStream, new Set(msg.seenIds.map(String)));
            } else {
              recountSync(endedStream);
            }
            await persistData();
          }
          if (pendingWalk && (!endedStream || endedStream === pendingWalk.stream)) {
            pendingWalk = null;
            await api.storage.local.remove("pendingWalk");
          }
          // Never clear activeAction / autoFollowRunning here — independent of walk
          console.log(
            "[auto-x] WALK_ENDED",
            endedStream,
            msg.reason || "",
            "contentSeen=",
            msg.seenCount ?? "?",
            "final=",
            endedStream === "following"
              ? Object.keys(data.following || {}).length
              : Object.keys(data.followers || {}).length,
            "| autoFollow=",
            !!data.autoFollowRunning,
          );
          sendResponse({ ok: true });
          // Chain next auto-sync step (followers → following)
          if (autoSyncPlan?.phase === "running") {
            advanceAutoSyncAfterWalk(endedStream);
          }
          // After graph sync, start 关注者列表回关 if user enabled auto-follow
          if (data?.autoFollowRunning) scheduleProcessQueue(2500);
          break;
        }
        case "ACTION_COMPLETED":
          await loadData();
          await onActionResult(msg);
          sendResponse({ ok: true });
          break;
        case "FOLLOW_BACK_LIST_DONE": {
          console.log(
            "[auto-x] follow-back list done",
            msg.reason || "",
            "clicked=",
            msg.clicked || 0,
          );
          if (followBackWalk) followBackWalk.active = false;
          followBackWalk = null;
          // Do not auto-restart into a loop of failures
          if (data?.autoFollowRunning && msg.reason === "need-restart") {
            scheduleProcessQueue(5000);
          } else if (data?.autoFollowRunning && msg.reason === "complete") {
            data.autoFollowRunning = false;
            await persistData();
            console.log("[auto-x] 关注者列表回关结束，自动关注已关闭");
          }
          sendResponse({ ok: true });
          break;
        }
        case "FOLLOW_BACK_LIST_PROGRESS": {
          // optional heartbeat from content
          if (followBackWalk) followBackWalk.lastProgressAt = Date.now();
          sendResponse({ ok: true });
          break;
        }
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
        case "OPEN_SIDE_PANEL":
          sendResponse(await openSidePanelForSender(sender));
          break;
        case "OPEN_PANEL_TAB":
          sendResponse(await openPanelTab());
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
          // Manual single-stream: cancel auto plan chaining for this session
          if (autoSyncPlan?.phase === "running") {
            autoSyncPlan.phase = "idle";
          }
          sendResponse(await startSync(msg.stream, { auto: false, background: false }));
          break;
        case "START_AUTO_SYNC":
          sendResponse(await startAutoGraphSync({ reason: msg.reason || "manual" }));
          break;
        case "STOP_SYNC":
          sendResponse(await stopSync({ clearPlan: true, reason: "user-stop" }));
          break;
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
            minIntervalSec: Math.max(5, Math.min(600, Number(msg.settings?.minIntervalSec) || 5)),
            maxFollowsPerDay: Math.min(
              200,
              Math.max(1, Number(msg.settings?.maxFollowsPerDay) || 50),
            ),
            _v37: true,
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

api.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" && !info.url) return;
  if (!pendingWalk || pendingWalk.tabId !== tabId) return;
  const url = info.url || tab?.url || null;
  // If user navigates away from list during sync, stop pending walk (don't chase to Home)
  if (url && isXUrl(url) && !listUrlMatchesStream(url, pendingWalk.stream)) {
    // Allow brief redirects during initial navigation to list
    const sinceNav = Date.now() - (pendingWalk.navAt || 0);
    if (sinceNav > 8000) {
      console.warn("[auto-x] tab left list page during sync, cancelling walk", url);
      await stopSync();
      return;
    }
  }
  if (info.status === "complete") {
    setTimeout(async () => {
      await pushKnownQueries(tabId);
      await tryDispatchWalk(tabId, url);
    }, 1200);
  }
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

// ── Toolbar / fixed panel (side panel stays open while browsing) ──

function setupActionIcon() {
  try {
    if (api.action?.setTitle) {
      api.action.setTitle({ title: "auto-x — 打开固定控制台" });
    }
    if (api.action?.setIcon) {
      api.action.setIcon({
        path: {
          16: "icons/icon-16.png",
          32: "icons/icon-32.png",
          48: "icons/icon-48.png",
          128: "icons/icon-128.png",
        },
      });
    }
  } catch (e) {
    console.warn("[auto-x] action icon setup", e);
  }
}

/**
 * Chrome / Edge: click extension icon → open side panel (stays docked).
 * Firefox: sidebar_action in manifest; action click opens panel tab as fallback.
 */
async function setupSidePanelBehavior() {
  try {
    if (api.sidePanel?.setPanelBehavior) {
      await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      console.log("[auto-x] side panel opens on action click");
      return true;
    }
  } catch (e) {
    console.warn("[auto-x] sidePanel behavior:", e);
  }
  return false;
}

async function openSidePanelForSender(sender) {
  if (!api.sidePanel?.open) {
    return { ok: false, error: "当前浏览器不支持侧边栏，已可用「新标签页」代替" };
  }
  try {
    const winId =
      sender?.tab?.windowId ??
      (await api.windows?.getCurrent?.().then((w) => w?.id).catch(() => null));
    if (winId != null) {
      await api.sidePanel.open({ windowId: winId });
    } else {
      // Some builds accept open() without args
      await api.sidePanel.open({});
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function openPanelTab() {
  const url = api.runtime.getURL(PANEL_PATH);
  // Reuse existing panel tab if present
  try {
    const tabs = await api.tabs.query({});
    const existing = (tabs || []).find(
      (t) => t.url && (t.url === url || t.url.startsWith(url)),
    );
    if (existing?.id != null) {
      await api.tabs.update(existing.id, { active: true });
      if (existing.windowId != null && api.windows?.update) {
        try {
          await api.windows.update(existing.windowId, { focused: true });
        } catch {
          /* ignore */
        }
      }
      return { ok: true, tabId: existing.id, reused: true };
    }
  } catch {
    /* fall through */
  }
  const tab = await api.tabs.create({ url, active: true });
  return { ok: true, tabId: tab?.id, reused: false };
}

// Fallback when side panel API missing: open panel tab on icon click
let sidePanelReady = false;

if (api.action?.onClicked) {
  api.action.onClicked.addListener(async () => {
    if (sidePanelReady) return; // Chrome handles open via setPanelBehavior
    await openPanelTab();
  });
}

if (api.runtime?.onInstalled) {
  api.runtime.onInstalled.addListener(async (details) => {
    setupActionIcon();
    sidePanelReady = await setupSidePanelBehavior();
    if (details.reason === "install") {
      try {
        await api.storage.local.remove("autox_pin_tip_dismissed");
      } catch {
        /* ignore */
      }
      console.log("[auto-x] installed — open side panel or pin the control tab");
    }
  });
}

// ── Init ──

(async function () {
  setupActionIcon();
  sidePanelReady = await setupSidePanelBehavior();
  // If no side panel: ensure icon click still opens fixed console as tab
  // (requires NO default_popup — already removed from manifest)
  await loadData();
  if (data.connection?.tabId) connectedTabId = data.connection.tabId;
  // Do NOT auto-resume list scrolling after SW restart — stale walks were
  // restarting scroll on whatever page the tab was on (including Home tweets).
  try {
    await api.storage.local.remove("pendingWalk");
  } catch {
    /* ignore */
  }
  pendingWalk = null;
  console.log(
    "[auto-x] v" + VERSION +
      " | sidePanel=" + sidePanelReady +
      " | connected=" + !!data.connection?.connected +
      " | autoFollow=" + !!data.autoFollowRunning +
      " | followers=" + Object.keys(data.followers).length +
      " | following=" + Object.keys(data.following).length,
  );
  processQueue();
})();
