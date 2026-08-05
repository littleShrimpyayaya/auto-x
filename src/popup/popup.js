/**
 * Popup script — local status display and quick actions.
 */
const statusDot = document.getElementById("status-dot");
const backendStatus = document.getElementById("backend-status");
const accountName = document.getElementById("account-name");
const syncStatus = document.getElementById("sync-status");
const pendingCount = document.getElementById("pending-count");
const usageDetail = document.getElementById("usage-detail");
const btnToggle = document.getElementById("btn-toggle");
const btnSyncFollowers = document.getElementById("btn-sync-followers");
const btnSyncFollowing = document.getElementById("btn-sync-following");

let followBackEnabled = true;

function setDot(state) {
  statusDot.className = `dot ${state}`;
}

function showCard(id) {
  document.getElementById(id)?.classList.remove("hidden");
}

async function refresh() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (!status) throw new Error("扩展未就绪");

    setDot("online");
    backendStatus.textContent = `本地运行 v${status.version}`;

    // Account
    showCard("account");
    accountName.textContent = "已就绪";

    // Sync
    showCard("sync");
    const fl = status.followers?.count || 0;
    const fg = status.following?.count || 0;
    syncStatus.textContent = `粉丝 ${fl} · 关注 ${fg}`;

    // Pending
    showCard("actions-section");
    pendingCount.textContent = String(status.pendingActions || 0);

    // Usage
    showCard("usage");
    const settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    usageDetail.innerHTML = `今日回关: ${status.dailyFollows}/${settings.maxFollowsPerDay}<br>间隔: ${settings.minIntervalSec}s`;

    // Controls
    showCard("controls");
    followBackEnabled = settings.followBackEnabled;
    btnToggle.textContent = followBackEnabled ? "暂停" : "继续";
    btnToggle.className = followBackEnabled ? "btn" : "btn primary";

    // Recent log
    if (status.recentLog?.length) {
      const last = status.recentLog[0];
      document.getElementById("device-info").textContent =
        `${last.ts?.slice(11, 19) || ""} ${last.type} ${last.targetUser} ${last.result}`;
    }
  } catch (e) {
    setDot("offline");
    backendStatus.textContent = "请先打开 X.com";
  }
}

btnToggle.addEventListener("click", async () => {
  const s = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  s.followBackEnabled = !s.followBackEnabled;
  await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: s });
  refresh();
});

btnSyncFollowers.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "START_SYNC", stream: "followers" });
  window.close();
});

btnSyncFollowing.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "START_SYNC", stream: "following" });
  window.close();
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("device-info").textContent = "v0.2.0";

refresh();
