/**
 * Local chrome.storage wrapper — replaces the backend database.
 * All data is stored in chrome.storage.local.
 */
const STORE_KEY = "autox_data";

const DEFAULTS = {
  followers: {},    // { [userId]: XUser }
  following: {},    // { [userId]: XUser }
  pendingActions: [], // [{ userId, queuedAt }]
  stats: {
    date: "",       // YYYY-MM-DD
    dailyFollows: 0,
    lastActionAt: null,
  },
  syncStatus: {
    followers: { lastSync: null, count: 0 },
    following: { lastSync: null, count: 0 },
  },
  actionLog: [],    // [{ ts, type, targetUser, result }], capped at 200
};

export async function load() {
  const stored = await chrome.storage.local.get(STORE_KEY);
  const data = stored[STORE_KEY];
  if (data) {
    // Merge with defaults for forward compatibility
    return { ...DEFAULTS, ...data, stats: { ...DEFAULTS.stats, ...(data.stats || {}) }, syncStatus: { ...DEFAULTS.syncStatus, ...(data.syncStatus || {}) } };
  }
  return { ...DEFAULTS };
}

export async function save(data) {
  await chrome.storage.local.set({ [STORE_KEY]: data });
}

// ── Helpers ────────────────────────────────────────────────────────

export function getNonMutualFollowers(data) {
  const toFollow = [];
  for (const [id, user] of Object.entries(data.followers)) {
    if (!data.following[id]) {
      // Check not already pending
      if (!data.pendingActions.some((a) => a.userId === id)) {
        toFollow.push({ id, ...user });
      }
    }
  }
  return toFollow;
}

export function addToLog(data, entry) {
  data.actionLog.unshift({ ts: new Date().toISOString(), ...entry });
  if (data.actionLog.length > 200) data.actionLog.length = 200;
}

/** Reset daily counter if date changed */
export function checkDateRollover(data) {
  const today = new Date().toISOString().slice(0, 10);
  if (data.stats.date !== today) {
    data.stats.date = today;
    data.stats.dailyFollows = 0;
  }
}
