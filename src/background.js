/**
 * Standalone background — decision engine + action executor.
 * Works in both Service Worker (Chrome) and Background Page (Firefox).
 */
if (typeof importScripts === "function") {
  // Service Worker context: load dependencies
  importScripts("./lib/store.js");
}
// In background page context (Firefox), store.js is loaded via manifest scripts

const store = self.autoxStore;
const VERSION = "0.2.1";

let connectedTabId = null;
let data = null;
let activeAction = null;
let stopping = false;

const DEFAULT_SETTINGS = {
  followBackEnabled: true,
  minIntervalSec: 60,
  maxFollowsPerDay: 50,
};

async function getSettings() {
  const cfg = await chrome.storage.local.get("autox_settings");
  return { ...DEFAULT_SETTINGS, ...(cfg.autox_settings || {}) };
}

async function loadData() {
  data = await store.load();
  store.checkDateRollover(data);
  return data;
}

async function persistData() {
  await store.save(data);
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
  const settings = await getSettings();
  if (!settings.followBackEnabled) return [];
  const candidates = store.getNonMutualFollowers(data);
  const remaining = Math.max(0, settings.maxFollowsPerDay - data.stats.dailyFollows);
  return candidates.slice(0, Math.min(remaining, 5));
}

async function executeAction(userId, username) {
  if (activeAction || !connectedTabId) return;
  const settings = await getSettings();
  if (data.stats.lastActionAt) {
    const elapsed = (Date.now() - new Date(data.stats.lastActionAt).getTime()) / 1000;
    if (elapsed < settings.minIntervalSec) return;
  }
  if (data.stats.dailyFollows >= settings.maxFollowsPerDay) return;
  activeAction = { userId, username };
  try {
    await chrome.tabs.sendMessage(connectedTabId, {
      type: "EXECUTE_ACTION",
      actionId: "follow-" + userId,
      actionType: "follow",
      targetUserId: userId,
    });
  } catch (e) {
    console.error("[auto-x] execute error:", e);
    activeAction = null;
  }
}

async function onActionResult(msg) {
  if (!activeAction) return;
  var uid = activeAction.userId, uname = activeAction.username;
  activeAction = null;
  if (msg.ok) {
    if (data.followers[uid]) {
      data.following[uid] = { ...data.followers[uid], _followedAt: new Date().toISOString() };
      data.syncStatus.following.count = Object.keys(data.following).length;
    }
    data.pendingActions = data.pendingActions.filter(function (a) { return a.userId !== uid; });
    data.stats.dailyFollows++;
    data.stats.lastActionAt = new Date().toISOString();
    store.addToLog(data, { type: "follow", targetUser: "@" + uname, result: "ok" });
  } else {
    store.addToLog(data, { type: "follow", targetUser: "@" + uname, result: "fail: " + (msg.error || "unknown") });
  }
  await persistData();
  var interval = (await getSettings()).minIntervalSec * 1000;
  setTimeout(function () { processQueue(); }, interval);
}

async function processQueue() {
  if (stopping || activeAction) return;
  await loadData();
  var candidates = await computeFollowBacks();
  if (!candidates.length) return;
  var next = candidates[0];
  data.pendingActions.push({ userId: next.id, queuedAt: new Date().toISOString() });
  await persistData();
  await executeAction(next.id, next.username);
}

async function startSync(stream) {
  if (!connectedTabId) return { ok: false, error: "请先打开 X.com" };
  var username = "i";
  try {
    var resp = await chrome.tabs.sendMessage(connectedTabId, { type: "GET_SESSION" });
    if (resp?.user?.username) username = resp.user.username;
  } catch (e) {}
  await chrome.tabs.update(connectedTabId, { url: "https://x.com/" + username + "/" + stream, active: true });
  try { await chrome.tabs.sendMessage(connectedTabId, { type: "START_WALK", stream: stream }); } catch (e) {}
  return { ok: true };
}

// ── Message router ──

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    try {
      switch (msg.type) {
        case "HEARTBEAT":
          connectedTabId = sender.tab?.id ?? connectedTabId;
          sendResponse({ ok: true });
          processQueue();
          break;
        case "SESSION_USER":
          await loadData();
          sendResponse({ ok: true });
          break;
        case "INGEST_BATCH":
          if (msg.users?.length) ingestUsers(msg.users, msg.walk?.stream || "followers");
          sendResponse({ ok: true });
          if (msg.walk?.stream === "followers") setTimeout(function () { processQueue(); }, 3000);
          break;
        case "WALK_ENDED":
          if (msg.walk?.stream) {
            data.syncStatus[msg.walk.stream].lastSync = new Date().toISOString();
            await persistData();
          }
          sendResponse({ ok: true });
          setTimeout(function () { processQueue(); }, 3000);
          break;
        case "ACTION_COMPLETED":
          await onActionResult(msg);
          sendResponse({ ok: true });
          break;
        case "QUERY_LEARNED":
          var queries = (await chrome.storage.local.get("knownQueries")).knownQueries || {};
          queries[msg.endpoint] = { hash: msg.hash, seenAt: Date.now() };
          await chrome.storage.local.set({ knownQueries: queries });
          sendResponse({ ok: true });
          break;
        case "START_SYNC":
          sendResponse(await startSync(msg.stream));
          break;
        case "GET_STATUS":
          await loadData();
          sendResponse({
            version: VERSION,
            followers: data.syncStatus.followers,
            following: data.syncStatus.following,
            dailyFollows: data.stats.dailyFollows,
            pendingActions: data.pendingActions.length,
            lastActionAt: data.stats.lastActionAt,
            recentLog: data.actionLog.slice(0, 10),
          });
          break;
        case "GET_SETTINGS":
          sendResponse(await getSettings());
          break;
        case "SAVE_SETTINGS":
          await chrome.storage.local.set({ autox_settings: msg.settings });
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: true });
      }
    } catch (e) {
      console.error("[auto-x]", e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ── Tab tracking ──

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (tabId === connectedTabId) connectedTabId = null;
});

// ── Periodic tick ──

chrome.alarms.create("tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async function (alarm) {
  if (alarm.name !== "tick") return;
  await loadData();
  processQueue();
});

// ── Init ──

(async function () {
  await loadData();
  console.log("[auto-x] v" + VERSION + " standalone — followers:" + Object.keys(data.followers).length + " following:" + Object.keys(data.following).length);
  processQueue();
})();
