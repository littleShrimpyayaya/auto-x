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
      profile: {
        followersCount: null,
        followingCount: null,
        id: null,
        username: null,
        updatedAt: null,
      },
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
        profile: {
          ...DEFAULTS.syncStatus.profile,
          ...(data.syncStatus?.profile || {}),
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

  /**
   * Build following lookup by id AND username (ids can mismatch across partial syncs).
   */
  function buildFollowingIndex(data) {
    const byId = new Set();
    const byName = new Set();
    for (const [id, u] of Object.entries(data.following || {})) {
      byId.add(String(id));
      const name = u?.username ? String(u.username).toLowerCase() : "";
      if (name && !name.startsWith("id:")) byName.add(name);
    }
    return { byId, byName };
  }

  function isFollowingUser(index, id, username) {
    if (index.byId.has(String(id))) return true;
    const name = username ? String(username).toLowerCase() : "";
    if (name && !name.startsWith("id:") && index.byName.has(name)) return true;
    return false;
  }

  function getNonMutualFollowers(data) {
    const toFollow = [];
    const pending = new Set((data.pendingActions || []).map((a) => String(a.userId)));
    const selfId = data.sessionUser?.id ? String(data.sessionUser.id) : null;
    const selfName = data.sessionUser?.username
      ? String(data.sessionUser.username).toLowerCase()
      : null;
    const followingIdx = buildFollowingIndex(data);
    const seenNames = new Set();

    for (const [id, user] of Object.entries(data.followers || {})) {
      const sid = String(id);
      if (selfId && sid === selfId) continue;
      const uname = user?.username ? String(user.username) : "id:" + sid;
      const unameL = uname.toLowerCase();
      if (selfName && unameL === selfName) continue;
      if (user?.unavailable) continue; // suspended / gone — cannot follow
      if (isFollowingUser(followingIdx, sid, uname)) continue;
      if (pending.has(sid)) continue;
      // Dedupe same handle under different keys
      if (!unameL.startsWith("id:")) {
        if (seenNames.has(unameL)) continue;
        seenNames.add(unameL);
      }
      toFollow.push({ ...user, id: sid, username: uname });
    }
    toFollow.sort((a, b) => {
      const ta = a._seenAt || "";
      const tb = b._seenAt || "";
      return tb.localeCompare(ta);
    });
    return toFollow;
  }

  function getNonMutualStats(data) {
    const list = getNonMutualFollowers(data);
    const fl = Object.keys(data.followers || {}).length;
    const fg = Object.keys(data.following || {}).length;
    const unavailable = Object.values(data.followers || {}).filter((u) => u?.unavailable).length;
    return {
      count: list.length,
      followers: fl,
      following: fg,
      unavailable,
      // Rough mutual estimate: followers that appear in following (by id or name)
      mutualEstimate: Math.max(0, fl - unavailable - list.length),
    };
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
    getNonMutualStats,
    addToLog,
    recordFollowResult,
    checkDateRollover,
    DEFAULTS,
  };
})();
