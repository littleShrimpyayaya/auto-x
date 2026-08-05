/**
 * Standalone background service worker — decision engine + action executor.
 * All data is stored in chrome.storage.local. No backend needed.
 */
import * as store from "./lib/store.js";

const VERSION = "0.2.0";

let connectedTabId = null;
let data = null;
let activeAction = null;
let stopping = false;

// ── Settings ──────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  followBackEnabled: true,
  minIntervalSec: 60,
  maxFollowsPerDay: 50,
};

async function getSettings() {
  const cfg = await chrome.storage.local.get("autox_settings");
  return { ...DEFAULT_SETTINGS, ...(cfg.autox_settings || {}) };
}

// ── Data management ───────────────────────────────────────────────

async function loadData() {
  data = await store.load();
  store.checkDateRollover(data);
  return data;
}

async function persistData() {
  await store.save(data);
}

// ── Ingest ────────────────────────────────────────────────────────

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

// ── Decision ──────────────────────────────────────────────────────

async function computeFollowBacks() {
  const settings = await getSettings();
  if (!settings.followBackEnabled) return [];

  const candidates = store.getNonMutualFollowers(data);
  const remaining = Math.max(0, settings.maxFollowsPerDay - data.stats.dailyFollows);
  return candidates.slice(0, Math.min(remaining, 5));
}

// ── Execution ─────────────────────────────────────────────────────

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
      actionId: `follow-${userId}`,
      actionType: "follow",
      targetUserId: userId,
    });
  } catch (e) {
    console.error("[auto-x] execute error:", e);
    activeAction = null;
  }
}

// ── Result handling ───────────────────────────────────────────────

async function onActionResult(msg) {
  if (!activeAction) return;
  const { userId, username } = activeAction;
  activeAction = null;

  if (msg.ok) {
    if (data.followers[userId]) {
      data.following[userId] = { ...data.followers[userId], _followedAt: new Date().toISOString() };
      data.syncStatus.following.count = Object.keys(data.following).length;
    }
    data.pendingActions = data.pendingActions.filter((a) => a.userId !== userId);
    data.stats.dailyFollows++;
    data.stats.lastActionAt = new Date().toISOString();
    store.addToLog(data, { type: "follow", targetUser: `@${username}`, result: "ok" });
  } else {
    store.addToLog(data, {
      type: "follow", targetUser: `@${username}`,
      result: `fail: ${msg.error || "unknown"}`,
    });
  }
  await persistData();
  setTimeout(() => processQueue(), (await getSettings()).minIntervalSec * 1000);
}

// ── Queue processing ──────────────────────────────────────────────

async function processQueue() {
  if (stopping || activeAction) return;
  await loadData();
  const candidates = await computeFollowBacks();
  if (!candidates.length) return;

  const next = candidates[0];
  data.pendingActions.push({ userId: next.id, queuedAt: new Date().toISOString() });
  await persistData();
  await executeAction(next.id, next.username);
}

// ── Sync ──────────────────────────────────────────────────────────

async function startSync(stream) {
  if (!connectedTabId) return { ok: false, error: "请先打开 X.com" };
  let username = "i";
  try {
    const resp = await chrome.tabs.sendMessage(connectedTabId, { type: "GET_SESSION" });
    if (resp?.user?.username) username = resp.user.username;
  } catch {}

  await chrome.tabs.update(connectedTabId, {
    url: `https://x.com/${username}/${stream}`,
    active: true,
  });
  try {
    await chrome.tabs.sendMessage(connectedTabId, { type: "START_WALK", stream });
  } catch {}
  return { ok: true };
}

// ── Message router ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "HEARTBEAT") {
        connectedTabId = sender.tab?.id ?? connectedTabId;
        sendResponse({ ok: true });
        processQueue();
      } else if (msg.type === "SESSION_USER") {
        await loadData();
        sendResponse({ ok: true });
      } else if (msg.type === "INGEST_BATCH") {
        if (msg.users?.length) {
          ingestUsers(msg.users, msg.walk?.stream || "followers");
        }
        sendResponse({ ok: true });
        if (msg.walk?.stream === "followers") setTimeout(() => processQueue(), 3000);
      } else if (msg.type === "WALK_ENDED") {
        if (msg.walk?.stream) {
          data.syncStatus[msg.walk.stream].lastSync = new Date().toISOString();
          await persistData();
        }
        sendResponse({ ok: true });
        setTimeout(() => processQueue(), 3000);
      } else if (msg.type === "ACTION_COMPLETED") {
        await onActionResult(msg);
        sendResponse({ ok: true });
      } else if (msg.type === "QUERY_LEARNED") {
        const queries = (await chrome.storage.local.get("knownQueries")).knownQueries || {};
        queries[msg.endpoint] = { hash: msg.hash, seenAt: Date.now() };
        await chrome.storage.local.set({ knownQueries: queries });
        sendResponse({ ok: true });
      } else if (msg.type === "START_SYNC") {
        sendResponse(await startSync(msg.stream));
      } else if (msg.type === "GET_STATUS") {
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
      } else if (msg.type === "GET_SETTINGS") {
        sendResponse(await getSettings());
      } else if (msg.type === "SAVE_SETTINGS") {
        await chrome.storage.local.set({ autox_settings: msg.settings });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: true });
      }
    } catch (e) {
      console.error("[auto-x]", e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ── Tab tracking ──────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === connectedTabId) connectedTabId = null;
});

// ── Periodic tick ─────────────────────────────────────────────────

chrome.alarms.create("tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tick") return;
  await loadData();
  processQueue();
});

// ── Init ──────────────────────────────────────────────────────────

(async () => {
  await loadData();
  console.log(`[auto-x] v${VERSION} standalone — followers:${Object.keys(data.followers).length} following:${Object.keys(data.following).length}`);
  processQueue();
})();
