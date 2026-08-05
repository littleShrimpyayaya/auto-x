/**
 * Options page — configure extension behavior.
 */
const toggleEl = document.getElementById("toggle-followBack");
const toggleLabel = document.getElementById("toggle-label");
const minIntervalEl = document.getElementById("minIntervalSec");
const maxFollowsEl = document.getElementById("maxFollowsPerDay");
const statusEl = document.getElementById("status");

async function load() {
  try {
    const s = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (s.followBackEnabled) {
      toggleEl.classList.add("on");
      toggleLabel.textContent = "已启用";
    } else {
      toggleEl.classList.remove("on");
      toggleLabel.textContent = "已暂停";
    }
    minIntervalEl.value = s.minIntervalSec || 60;
    maxFollowsEl.value = s.maxFollowsPerDay || 50;
  } catch {
    statusEl.textContent = "无法读取设置";
    statusEl.className = "status";
  }
}

toggleEl.addEventListener("click", () => {
  toggleEl.classList.toggle("on");
  toggleLabel.textContent = toggleEl.classList.contains("on") ? "已启用" : "已暂停";
});

document.getElementById("btn-save").addEventListener("click", async () => {
  const settings = {
    followBackEnabled: toggleEl.classList.contains("on"),
    minIntervalSec: Math.max(30, parseInt(minIntervalEl.value) || 60),
    maxFollowsPerDay: Math.min(200, Math.max(1, parseInt(maxFollowsEl.value) || 50)),
  };
  try {
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    statusEl.textContent = "已保存 ✓";
    statusEl.className = "status ok";
  } catch (e) {
    statusEl.textContent = "保存失败: " + e.message;
    statusEl.className = "status";
  }
});

load();
