/**
 * Popup UI — login / connect / auto-follow / results.
 * Closing this popup does NOT stop background auto-follow.
 */
const api = (typeof autoxBrowser !== "undefined" && autoxBrowser) ||
  (typeof browser !== "undefined" ? browser : chrome);

const $ = (id) => document.getElementById(id);

const statusDot = $("status-dot");
const connBadge = $("conn-badge");
const connBadgeText = $("conn-badge-text");
const gateStatus = $("gate-status");
const gateHint = $("gate-hint");
const gateError = $("gate-error");
const btnLogin = $("btn-login");
const btnConnect = $("btn-connect");
const btnOpenX = $("btn-open-x");
const accountCard = $("account");
const accountName = $("account-name");
const accountHandle = $("account-handle");
const accountAvatar = $("account-avatar");
const accountExtra = $("account-extra");
const btnDisconnect = $("btn-disconnect");
const syncCard = $("sync");
const syncStatus = $("sync-status");
const controlsCard = $("controls");
const btnAuto = $("btn-auto");
const autoHint = $("auto-hint");
const usageCard = $("usage");
const usageDetail = $("usage-detail");
const pendingLine = $("pending-line");
const resultsCard = $("results");
const successCountEl = $("success-count");
const failCountEl = $("fail-count");
const successListEl = $("success-list");
const failListEl = $("fail-list");
const versionInfo = $("version-info");

/** Last connect failure message — kept until next success / clear */
let lastConnectError = "";

function setDot(state) {
  statusDot.className = "dot " + state;
}

/**
 * Primary connection status signal for the user.
 * @param {"connected"|"disconnected"|"need-login"|"checking"|"running"} kind
 * @param {string} label
 */
function setConnBadge(kind, label) {
  if (!connBadge) return;
  connBadge.className = "conn-badge " + kind;
  connBadgeText.textContent = label;
  // Mirror on header dot
  if (kind === "connected") setDot("online");
  else if (kind === "running") setDot("running");
  else if (kind === "need-login") setDot("offline");
  else if (kind === "checking") setDot("warning");
  else setDot("offline");
}

function show(el, on) {
  if (!el) return;
  el.classList.toggle("hidden", !on);
}

function setError(msg) {
  if (!gateError) return;
  if (msg) {
    gateError.textContent = "原因：" + msg;
    show(gateError, true);
  } else {
    gateError.textContent = "";
    show(gateError, false);
  }
}

function fmtTime(iso) {
  if (!iso) return "从未";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return "";
  }
}

function renderUserList(ul, items, mode) {
  ul.innerHTML = "";
  if (!items?.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = mode === "ok" ? "暂无成功记录" : "暂无失败记录";
    ul.appendChild(li);
    return;
  }
  for (const it of items) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = it.name
      ? `${it.name} (@${it.username})`
      : `@${it.username || "?"}`;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent =
      mode === "ok"
        ? fmtShort(it.ts)
        : (it.error ? String(it.error).slice(0, 28) : fmtShort(it.ts));
    meta.title = it.error || it.ts || "";
    li.appendChild(who);
    li.appendChild(meta);
    ul.appendChild(li);
  }
}

async function send(type, extra = {}) {
  return api.runtime.sendMessage({ type, ...extra });
}

async function refresh() {
  try {
    const [status, settings] = await Promise.all([
      send("GET_STATUS"),
      send("GET_SETTINGS"),
    ]);
    if (!status || status.ok === false) {
      throw new Error(status?.error || "扩展未就绪");
    }

    versionInfo.textContent = "v" + (status.version || "?");

    const connected = !!status.connected;
    const liveIn = !!status.liveLoggedIn;
    const liveUser = status.liveUser;
    const running = !!status.autoFollowRunning;

    // ── Gate / connection (badge = source of truth for user) ──
    if (connected && status.sessionUser?.username) {
      lastConnectError = "";
      setError("");

      if (running) {
        setConnBadge("running", "已连接 · 自动关注中");
        gateStatus.textContent = "状态：已连接，自动关注运行中";
        gateHint.textContent =
          "关闭此窗口不影响后台。点下方「停止自动关注」可结束任务；右下「解除绑定」才会断开账户。";
      } else {
        setConnBadge("connected", "已连接");
        gateStatus.textContent = "状态：已连接";
        gateHint.textContent =
          "账户已绑定。连接后会自动同步粉丝与关注；可开始自动回关。右下「解除绑定」才会断开（不会退出 X 登录）。";
      }

      show(btnLogin, false);
      show(btnConnect, false);
      show(btnOpenX, false);

      show(accountCard, true);
      const u = status.sessionUser;
      accountName.textContent = u.name || u.username;
      accountHandle.textContent = "@" + u.username;
      if (u.avatar) {
        accountAvatar.src = u.avatar;
        show(accountAvatar, true);
      } else {
        show(accountAvatar, false);
      }
      accountExtra.textContent =
        "绑定时间 " + fmtTime(status.connection?.connectedAt) +
        (status.sessionMismatch ? " · ⚠ X 标签页可能已登出，请刷新 x.com 后重连" : "");

      show(syncCard, true);
      const fl = status.followers?.count || 0;
      const fg = status.following?.count || 0;
      const walkActive = !!status.walkActive;
      const walkStream = status.walkStream || null;
      const streamLabel =
        walkStream === "followers" ? "粉丝" : walkStream === "following" ? "关注" : walkStream || "";
      const nonMutual = status.nonMutualCount ?? 0;
      const autoSync = status.autoSync || {};
      const profile = status.profileCounts || {};
      const pf = profile.followersCount;
      const pg = profile.followingCount;
      const autoRunning = autoSync.phase === "running" || walkActive;

      let syncLine = "";
      if (autoSync.phase === "running" || walkActive) {
        const step =
          autoSync.current === "followers" || walkStream === "followers"
            ? "粉丝"
            : autoSync.current === "following" || walkStream === "following"
              ? "关注"
              : streamLabel || "…";
        const stepN = (autoSync.idx || 0) + 1;
        const stepT = autoSync.total || 2;
        syncLine =
          `<b style="color:#1d9bf0">自动同步中：${step}</b>（步骤 ${Math.min(stepN, stepT)}/${stepT}）` +
          `<br>请稍候，到底后会自动进入下一步，无需手动操作。`;
      } else if (autoSync.phase === "done") {
        syncLine = `<span style="color:#00ba7c">✓ 自动同步已完成</span>`;
      } else if (autoSync.phase === "error") {
        syncLine = `<span style="color:#f4212e">同步出错：${autoSync.error || "未知"}</span> · 可点「重新同步」`;
      } else if (!status.followers?.lastSync && !status.following?.lastSync) {
        syncLine = `连接后将自动同步粉丝与关注…`;
      } else {
        syncLine = `图谱已就绪 · 需要时可点「重新同步」`;
      }

      const flHint =
        pf != null ? `本地 <b>${fl}</b>${pf !== fl ? ` / 主页约 ${pf}` : ""}` : `<b>${fl}</b>`;
      const fgHint =
        pg != null ? `本地 <b>${fg}</b>${pg !== fg ? ` / 主页约 ${pg}` : ""}` : `<b>${fg}</b>`;

      syncStatus.innerHTML =
        `粉丝 ${flHint} · 关注 ${fgHint}` +
        `<div class="hint" style="margin-top:4px">` +
        `待回关: <b style="color:#1d9bf0">${nonMutual}</b>` +
        (status.nonMutualDetail?.unavailable
          ? ` · 不可用粉丝 ${status.nonMutualDetail.unavailable}`
          : "") +
        `<br>粉丝同步: ${fmtTime(status.followers?.lastSync)} · 关注同步: ${fmtTime(status.following?.lastSync)}` +
        `<br>${syncLine}` +
        `</div>`;
      updateResyncButton(autoRunning);

      show(controlsCard, true);
      if (running) {
        btnAuto.textContent = "🛑 停止自动关注";
        btnAuto.className = "btn stop btn-lg";
        const cur = status.activeFollow?.username
          ? `当前: @${status.activeFollow.username}。`
          : "";
        autoHint.textContent =
          cur +
          `待回关 ${nonMutual} 人。` +
          (status.graphSyncBusy || autoRunning
            ? "图谱同步与回关并行：同步不中断回关；回关只更新「已关注」，不改粉丝名单。"
            : "停止只结束回关队列，不影响图谱同步。");
      } else {
        btnAuto.textContent = "开始自动关注";
        btnAuto.className = "btn primary btn-lg";
        if (autoRunning || status.graphSyncBusy) {
          autoHint.textContent =
            "图谱同步进行中也可直接开始回关：两者并行，互不中断；回关不会改动粉丝/关注同步名单数量逻辑。";
        } else if (fl === 0) {
          autoHint.textContent = "粉丝名单尚未同步完成，请稍候自动同步，或点「重新同步」。";
        } else if (nonMutual === 0) {
          autoHint.textContent = "当前没有待回关用户（可能都已互关）。可「重新同步」刷新名单。";
        } else {
          autoHint.textContent = `待回关 ${nonMutual} 人。关闭面板不会停止；与图谱同步互不干扰。`;
        }
      }

      show(usageCard, true);
      usageDetail.innerHTML =
        `今日回关: <b>${status.dailyFollows}</b> / ${settings.maxFollowsPerDay}<br>` +
        `待回关: <b>${nonMutual}</b> · 间隔: ${settings.minIntervalSec}s` +
        (status.lastActionAt ? `<br>上次: ${fmtTime(status.lastActionAt)}` : "");
      pendingLine.textContent = status.activeFollow?.username
        ? `正在关注 @${status.activeFollow.username}`
        : (status.pendingActions || 0) > 0
          ? `队列中 ${status.pendingActions} 人`
          : running
            ? nonMutual > 0
              ? "排队等待间隔…"
              : "无待回关用户"
            : "队列空闲";

      show(resultsCard, true);
      successCountEl.textContent = String(status.successCount || 0);
      failCountEl.textContent = String(status.failCount || 0);
      renderUserList(successListEl, status.successList || [], "ok");
      renderUserList(failListEl, status.failList || [], "fail");
    } else {
      // Not connected — always make that obvious
      show(accountCard, false);
      show(syncCard, false);
      show(controlsCard, false);
      show(usageCard, false);
      show(resultsCard, false);

      if (liveIn && liveUser?.username) {
        setConnBadge("disconnected", "未连接");
        gateStatus.textContent = "状态：未连接（X 已登录）";
        gateHint.textContent =
          `已检测到 @${liveUser.username}` +
          (liveUser.name ? `（${liveUser.name}）` : "") +
          "。点击下方「连接账户」完成绑定。";
        show(btnLogin, false);
        show(btnConnect, true);
        show(btnOpenX, false);
      } else if (status.hasXTab && liveIn === false) {
        setConnBadge("need-login", "未连接 · 未登录");
        gateStatus.textContent = "状态：未连接";
        gateHint.textContent = "X 标签页未登录。请先登录，再回来点「连接账户」。";
        show(btnLogin, true);
        show(btnConnect, true); // still allow try-connect with clear error
        show(btnOpenX, false);
      } else if (!status.hasXTab) {
        setConnBadge("disconnected", "未连接");
        gateStatus.textContent = "状态：未连接（未打开 X）";
        gateHint.textContent = "请先打开并登录 X.com，再点击「连接账户」。";
        show(btnLogin, true);
        show(btnConnect, true);
        show(btnOpenX, true);
      } else {
        setConnBadge("checking", "检测中…");
        gateStatus.textContent = "状态：检测登录中";
        gateHint.textContent = "若你已登录 X，可直接点「连接账户」；失败会显示原因。";
        show(btnLogin, true);
        show(btnConnect, true);
        show(btnOpenX, false);
      }

      // Surface previous connect failure if any
      setError(lastConnectError || "");
    }
  } catch (e) {
    setConnBadge("need-login", "未连接");
    gateStatus.textContent = "状态：扩展通信失败";
    gateHint.textContent = "请重新加载扩展后重试。";
    setError(e.message || String(e));
    show(btnLogin, false);
    show(btnConnect, true);
    show(btnOpenX, true);
  }
}

btnLogin.addEventListener("click", async () => {
  btnLogin.disabled = true;
  try {
    await send("OPEN_LOGIN");
    gateHint.textContent = "已打开登录页，登录完成后回到此弹窗点「连接」。";
  } catch (e) {
    gateHint.textContent = e.message || "无法打开登录页";
  } finally {
    btnLogin.disabled = false;
  }
});

btnOpenX.addEventListener("click", async () => {
  await send("OPEN_X");
  setTimeout(refresh, 1500);
});

btnConnect.addEventListener("click", async () => {
  btnConnect.disabled = true;
  const prevLabel = btnConnect.textContent;
  btnConnect.textContent = "连接中…";
  setConnBadge("checking", "连接中…");
  setError("");
  try {
    const r = await send("CONNECT");
    if (!r?.ok) {
      lastConnectError = r?.error || "连接失败（未知原因）";
      setConnBadge("disconnected", "未连接");
      gateStatus.textContent = "状态：未连接";
      gateHint.textContent = "连接未成功，请根据下方原因处理后重试。";
      setError(lastConnectError);
      if (r?.needLogin) show(btnLogin, true);
      show(btnConnect, true);
    } else {
      lastConnectError = "";
      setError("");
    }
  } catch (e) {
    lastConnectError = e.message || "连接失败";
    setConnBadge("disconnected", "未连接");
    gateStatus.textContent = "状态：未连接";
    setError(lastConnectError);
  } finally {
    btnConnect.disabled = false;
    btnConnect.textContent = prevLabel || "连接账户";
    await refresh();
  }
});

btnDisconnect.addEventListener("click", async () => {
  const ok = confirm(
    "确定解除绑定？\n\n" +
      "• 会断开插件与账户的连接，并停止自动关注\n" +
      "• 不会退出你在 X 网站上的登录\n" +
      "• 本地已同步的数据仍会保留",
  );
  if (!ok) return;
  await send("STOP_AUTO_FOLLOW");
  await send("DISCONNECT");
  lastConnectError = "";
  setConnBadge("disconnected", "未连接");
  gateStatus.textContent = "状态：未连接";
  gateHint.textContent = "已解除绑定。需要时再次点击「连接账户」。";
  await refresh();
});

btnAuto.addEventListener("click", async () => {
  btnAuto.disabled = true;
  try {
    const status = await send("GET_STATUS");
    if (status?.autoFollowRunning) {
      await send("STOP_AUTO_FOLLOW");
    } else {
      const r = await send("START_AUTO_FOLLOW");
      if (!r?.ok) {
        autoHint.textContent = r?.error || "启动失败";
        if (gateHint && r?.error) gateHint.textContent = r.error;
      } else {
        autoHint.textContent =
          `已启动：待回关 ${r.nonMutual ?? "?"} 人，按间隔自动关注。` +
          "请保持 x.com 标签页打开（不要求停在粉丝页）。";
      }
    }
  } finally {
    btnAuto.disabled = false;
    await refresh();
  }
});

const btnResync = $("btn-resync");

function updateResyncButton(autoRunning) {
  if (!btnResync) return;
  if (autoRunning) {
    btnResync.textContent = "同步进行中…";
    btnResync.disabled = true;
    btnResync.className = "btn";
    btnResync.title = "正在自动同步粉丝/关注，请稍候";
  } else {
    btnResync.textContent = "重新同步";
    btnResync.disabled = false;
    btnResync.className = "btn";
    btnResync.title = "重新自动同步粉丝与关注";
  }
}

if (btnResync) {
  btnResync.addEventListener("click", async () => {
    btnResync.disabled = true;
    btnResync.textContent = "启动中…";
    try {
      // Cancel any stuck walk then restart full auto pipeline
      await send("STOP_SYNC");
      await new Promise((r) => setTimeout(r, 400));
      const r = await send("START_AUTO_SYNC", { reason: "manual-resync" });
      if (r && r.ok === false && gateHint) {
        gateHint.textContent = r.error || "无法开始同步";
      }
    } finally {
      await refresh();
    }
  });
}

$("btn-clear-results").addEventListener("click", async () => {
  await send("CLEAR_RESULTS");
  await refresh();
});

$("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  if (api.runtime.openOptionsPage) {
    api.runtime.openOptionsPage();
  } else {
    window.open(api.runtime.getURL("src/options/options.html"));
  }
});

// ── Fixed console: side panel / pin-able tab ──
const pinTip = $("pin-tip");
const btnPinDismiss = $("btn-pin-dismiss");
const btnOpenSide = $("btn-open-side");
const btnOpenTab = $("btn-open-tab");
const panelActions = $("panel-actions");
const isPanelPage = document.body.classList.contains("panel-mode");

async function openSidePanel() {
  const r = await send("OPEN_SIDE_PANEL");
  if (r && r.ok === false) {
    // Fallback: open tab if side panel unavailable
    await send("OPEN_PANEL_TAB");
    if (gateHint) gateHint.textContent = r.error || "已改用标签页打开控制台";
  } else if (!isPanelPage) {
    // Closing popup after opening side panel is fine
    try {
      window.close();
    } catch {
      /* ignore */
    }
  }
}

async function openPanelTab() {
  await send("OPEN_PANEL_TAB");
  if (!isPanelPage) {
    try {
      window.close();
    } catch {
      /* ignore */
    }
  }
}

if (btnOpenSide) {
  btnOpenSide.addEventListener("click", () => {
    openSidePanel();
  });
}
if (btnOpenTab) {
  btnOpenTab.addEventListener("click", () => {
    openPanelTab();
  });
}

// On dedicated panel page, hide redundant "open side" if already in side panel-ish UI
if (isPanelPage && panelActions) {
  // Keep both options available so user can still open a pin-able tab
  show(panelActions, true);
}

async function initPinTip() {
  // Always show open-fixed-panel buttons in popup; dismiss only hides tip card text area on panel
  try {
    const stored = await api.storage.local.get("autox_pin_tip_dismissed");
    if (stored.autox_pin_tip_dismissed && pinTip) {
      // In popup: still show a compact open-panel card if buttons exist outside tip
      if (isPanelPage) show(pinTip, false);
      else show(pinTip, true); // keep entry points visible in small popup
    } else if (pinTip) {
      show(pinTip, true);
    }
  } catch {
    if (pinTip) show(pinTip, true);
  }
}

if (btnPinDismiss) {
  btnPinDismiss.addEventListener("click", async () => {
    show(pinTip, false);
    try {
      await api.storage.local.set({ autox_pin_tip_dismissed: true });
    } catch {
      /* ignore */
    }
  });
}

initPinTip();
refresh();
setInterval(refresh, 2500);
