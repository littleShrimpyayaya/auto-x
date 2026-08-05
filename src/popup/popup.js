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
          "账户已成功绑定。可同步图谱或开始自动关注。右下「解除绑定」才会断开（不会退出 X 网站登录）。";
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
      syncStatus.innerHTML =
        `粉丝 <b>${fl}</b> · 关注 <b>${fg}</b>` +
        `<div class="hint" style="margin-top:4px">` +
        `粉丝: ${fmtTime(status.followers?.lastSync)} · 关注: ${fmtTime(status.following?.lastSync)}` +
        (status.walkActive ? `<br>正在同步 ${status.walkStream || ""}…` : "") +
        `</div>`;

      show(controlsCard, true);
      if (running) {
        btnAuto.textContent = "🛑 停止自动关注";
        btnAuto.className = "btn stop btn-lg";
        autoHint.textContent = "这是停止自动任务，不是断开账户连接。";
      } else {
        btnAuto.textContent = "开始自动关注";
        btnAuto.className = "btn primary btn-lg";
        autoHint.textContent =
          fl === 0
            ? "建议先「同步粉丝 / 关注」建立名单，再开始自动关注。"
            : "关闭弹窗不会停止；仅通过 API 关注，不抢夺你当前操作。";
      }

      show(usageCard, true);
      usageDetail.innerHTML =
        `今日回关: <b>${status.dailyFollows}</b> / ${settings.maxFollowsPerDay}<br>` +
        `间隔: ${settings.minIntervalSec}s` +
        (status.lastActionAt ? `<br>上次: ${fmtTime(status.lastActionAt)}` : "");
      pendingLine.textContent =
        (status.pendingActions || 0) > 0
          ? `队列中 ${status.pendingActions} 人`
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
      }
    }
  } finally {
    btnAuto.disabled = false;
    await refresh();
  }
});

$("btn-sync-followers").addEventListener("click", async () => {
  const r = await send("START_SYNC", { stream: "followers" });
  if (r && r.ok === false) {
    gateHint.textContent = r.error || "同步失败";
    return;
  }
  // Keep popup open so user sees status; walk continues in background
  await refresh();
});

$("btn-sync-following").addEventListener("click", async () => {
  const r = await send("START_SYNC", { stream: "following" });
  if (r && r.ok === false) {
    gateHint.textContent = r.error || "同步失败";
    return;
  }
  await refresh();
});

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

refresh();
setInterval(refresh, 2500);
