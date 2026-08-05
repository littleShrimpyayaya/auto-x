/**
 * Local chrome.storage wrapper — uses global self.autoxStore for Firefox compat.
 * Data is stored in chrome.storage.local (no ES modules needed).
 */
(function () {
  const STORE_KEY = "autox_data";

  const DEFAULTS = {
    followers: {},
    following: {},
    pendingActions: [],
    stats: { date: "", dailyFollows: 0, lastActionAt: null },
    syncStatus: {
      followers: { lastSync: null, count: 0 },
      following: { lastSync: null, count: 0 },
    },
    actionLog: [],
  };

  async function load() {
    const stored = await chrome.storage.local.get(STORE_KEY);
    const data = stored[STORE_KEY];
    if (data) {
      return {
        ...DEFAULTS,
        ...data,
        stats: { ...DEFAULTS.stats, ...(data.stats || {}) },
        syncStatus: { ...DEFAULTS.syncStatus, ...(data.syncStatus || {}) },
      };
    }
    return { ...DEFAULTS };
  }

  async function save(data) {
    await chrome.storage.local.set({ [STORE_KEY]: data });
  }

  function getNonMutualFollowers(data) {
    const toFollow = [];
    for (const [id, user] of Object.entries(data.followers)) {
      if (!data.following[id]) {
        if (!data.pendingActions.some((a) => a.userId === id)) {
          toFollow.push({ id, ...user });
        }
      }
    }
    return toFollow;
  }

  function addToLog(data, entry) {
    data.actionLog.unshift({ ts: new Date().toISOString(), ...entry });
    if (data.actionLog.length > 200) data.actionLog.length = 200;
  }

  function checkDateRollover(data) {
    const today = new Date().toISOString().slice(0, 10);
    if (data.stats.date !== today) {
      data.stats.date = today;
      data.stats.dailyFollows = 0;
    }
  }

  self.autoxStore = { load, save, getNonMutualFollowers, addToLog, checkDateRollover };
})();
