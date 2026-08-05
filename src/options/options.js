/**
 * Options page — rate limits only (start/stop lives in popup).
 */
const api =
  (typeof autoxBrowser !== "undefined" && autoxBrowser) ||
  (typeof browser !== "undefined" ? browser : chrome);

const minIntervalEl = document.getElementById("minIntervalSec");
const maxFollowsEl = document.getElementById("maxFollowsPerDay");
const statusEl = document.getElementById("status");

async function load() {
  try {
    const s = await api.runtime.sendMessage({ type: "GET_SETTINGS" });
    minIntervalEl.value = s.minIntervalSec || 5;
    maxFollowsEl.value = s.maxFollowsPerDay || 50;
  } catch {
    statusEl.textContent = "无法读取设置";
    statusEl.className = "status";
  }
}

document.getElementById("btn-save").addEventListener("click", async () => {
  const settings = {
    minIntervalSec: Math.max(5, parseInt(minIntervalEl.value, 10) || 5),
    maxFollowsPerDay: Math.min(200, Math.max(1, parseInt(maxFollowsEl.value, 10) || 50)),
  };
  try {
    await api.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    statusEl.textContent = "已保存 ✓";
    statusEl.className = "status ok";
  } catch (e) {
    statusEl.textContent = "保存失败: " + (e.message || e);
    statusEl.className = "status";
  }
});

load();
