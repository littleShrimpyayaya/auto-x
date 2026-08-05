/**
 * Local storage wrapper — chrome.storage.local, cross-browser via global chrome/browser.
 */
(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const STORE_KEY = "autox_data";

  const DEFAULTS = {
    followers: {},
    following: {},
    pendingActions: [],
    sessionUser: null,
    /** Explicit user "连接" state — survives popup close */
    connection: {
      connected: false,
      connectedAt: null,
      tabId: null,
    },
    /** Explicit auto-follow run flag — independent of popup */
    autoFollowRunning: false,
    stats: {
      date: "",
      dailyFollows: 0,
      lastActionAt: null,
      successList: [], // { username, name, ts }
      failList: [], // { username, name, ts, error }
    },
    syncStatus: {
      followers: { lastSync: null, count: 0 },
      following: { lastSync: null, count: 0 },
    },
    actionLog: [],
  };

  function deepDefaults(data) {
    return {
      ...DEFAULTS,
      ...data,
      connection: { ...DEFAULTS.connection, ...(data.connection || {}) },
      stats: {
        ...DEFAULTS.stats,
        ...(data.stats || {}),
        successList: Array.isArray(data.stats?.successList)
          ? data.stats.successList
          : [],
        failList: Array.isArray(data.stats?.failList) ? data.stats.failList : [],
      },
      syncStatus: {
        followers: {
          ...DEFAULTS.syncStatus.followers,
          ...(data.syncStatus?.followers || {}),
        },
        following: {
          ...DEFAULTS.syncStatus.following,
          ...(data.syncStatus?.following || {}),
        },
      },
      pendingActions: Array.isArray(data.pendingActions) ? data.pendingActions : [],
      actionLog: Array.isArray(data.actionLog) ? data.actionLog : [],
      followers: data.followers && typeof data.followers === "object" ? data.followers : {},
      following: data.following && typeof data.following === "object" ? data.following : {},
      autoFollowRunning: !!data.autoFollowRunning,
    };
  }

  async function load() {
    const stored = await api.storage.local.get(STORE_KEY);
    const data = stored[STORE_KEY];
    if (data) return deepDefaults(data);
    return deepDefaults({});
  }

  async function save(data) {
    await api.storage.local.set({ [STORE_KEY]: data });
  }

  function getNonMutualFollowers(data) {
    const toFollow = [];
    const pending = new Set((data.pendingActions || []).map((a) => String(a.userId)));
    const selfId = data.sessionUser?.id ? String(data.sessionUser.id) : null;
    const selfName = data.sessionUser?.username
      ? String(data.sessionUser.username).toLowerCase()
      : null;
    for (const [id, user] of Object.entries(data.followers || {})) {
      const sid = String(id);
      if (selfId && sid === selfId) continue;
      if (selfName && String(user?.username || "").toLowerCase() === selfName) continue;
      if (user?.unavailable) continue; // suspended / gone — cannot follow
      if (data.following?.[sid] || data.following?.[id]) continue;
      if (pending.has(sid)) continue;
      toFollow.push({ ...user, id: sid, username: user?.username || "id:" + sid });
    }
    toFollow.sort((a, b) => {
      const ta = a._seenAt || "";
      const tb = b._seenAt || "";
      return tb.localeCompare(ta);
    });
    return toFollow;
  }

  function addToLog(data, entry) {
    if (!Array.isArray(data.actionLog)) data.actionLog = [];
    data.actionLog.unshift({ ts: new Date().toISOString(), ...entry });
    if (data.actionLog.length > 200) data.actionLog.length = 200;
  }

  function recordFollowResult(data, { ok, username, name, error }) {
    if (!data.stats) data.stats = { ...DEFAULTS.stats };
    const item = {
      username: username || "unknown",
      name: name || null,
      ts: new Date().toISOString(),
    };
    if (ok) {
      if (!Array.isArray(data.stats.successList)) data.stats.successList = [];
      data.stats.successList.unshift(item);
      if (data.stats.successList.length > 100) data.stats.successList.length = 100;
    } else {
      if (!Array.isArray(data.stats.failList)) data.stats.failList = [];
      data.stats.failList.unshift({ ...item, error: error || "unknown" });
      if (data.stats.failList.length > 100) data.stats.failList.length = 100;
    }
  }

  function checkDateRollover(data) {
    const today = new Date().toISOString().slice(0, 10);
    if (!data.stats) data.stats = { ...DEFAULTS.stats };
    if (data.stats.date !== today) {
      data.stats.date = today;
      data.stats.dailyFollows = 0;
      // Keep history but reset daily counters; lists stay for session visibility
    }
  }

  self.autoxStore = {
    load,
    save,
    getNonMutualFollowers,
    addToLog,
    recordFollowResult,
    checkDateRollover,
    DEFAULTS,
  };
})();
