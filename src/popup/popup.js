/**
 * Popup UI — login / connect / auto-follow / results.
 * Closing this popup does NOT stop background auto-follow.
 */
const api = (typeof autoxBrowser !== "undefined" && autoxBrowser) ||
  (typeof browser !== "undefined" ? browser : chrome);

const $ = (id) => document.getElementById(id);

const statusDot = $("status-dot");
const gateStatus = $("gate-status");
const gateHint = $("gate-hint");
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

function setDot(state) {
  statusDot.className = "dot " + state;
}

function show(el, on) {
  if (!el) return;
  el.classList.toggle("hidden", !on);
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

    // ── Gate / connection ──
    if (connected && status.sessionUser?.username) {
      setDot(running ? "running" : "online");
      gateStatus.textContent = running ? "自动关注运行中…" : "已连接";
      gateHint.textContent = running
        ? "关闭此窗口不影响后台工作。点击下方停止可结束。"
        : "账户已连通，可同步图谱或开始自动关注。";
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
        "连接于 " + fmtTime(status.connection?.connectedAt) +
        (status.sessionMismatch ? " · ⚠ 当前标签可能已登出" : "");

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
        btnAuto.textContent = "🛑 停止";
        btnAuto.className = "btn stop btn-lg";
        autoHint.textContent = "自动关注进行中 · 后台持续运行";
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
      // Not connected — guide login / connect
      show(accountCard, false);
      show(syncCard, false);
      show(controlsCard, false);
      show(usageCard, false);
      show(resultsCard, false);

      if (liveIn && liveUser?.username) {
        setDot("warning");
        gateStatus.textContent = "已登录，待连接";
        gateHint.textContent =
          `检测到 @${liveUser.username}` +
          (liveUser.name ? `（${liveUser.name}）` : "") +
          "，点击连接以绑定此账户。";
        show(btnLogin, false);
        show(btnConnect, true);
        show(btnOpenX, false);
      } else if (status.hasXTab && liveIn === false) {
        setDot("offline");
        gateStatus.textContent = "未登录 X 账户";
        gateHint.textContent = "请先登录 X，登录成功后回到此弹窗点击连接。";
        show(btnLogin, true);
        show(btnConnect, false);
        show(btnOpenX, false);
      } else if (!status.hasXTab) {
        setDot("offline");
        gateStatus.textContent = "未打开 X.com";
        gateHint.textContent = "打开 X 并登录后，即可连接账户。";
        show(btnLogin, true);
        show(btnConnect, false);
        show(btnOpenX, true);
      } else {
        setDot("warning");
        gateStatus.textContent = "检测登录状态中…";
        gateHint.textContent = "若已登录，请稍等或点击连接重试。";
        show(btnLogin, true);
        show(btnConnect, true);
        show(btnOpenX, false);
      }
    }
  } catch (e) {
    setDot("offline");
    gateStatus.textContent = "扩展通信失败";
    gateHint.textContent = e.message || String(e);
    show(btnLogin, false);
    show(btnConnect, false);
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
  btnConnect.textContent = "连接中…";
  try {
    const r = await send("CONNECT");
    if (!r?.ok) {
      gateHint.textContent = r?.error || "连接失败";
      if (r?.needLogin) {
        show(btnLogin, true);
      }
    }
  } catch (e) {
    gateHint.textContent = e.message || "连接失败";
  } finally {
    btnConnect.disabled = false;
    btnConnect.textContent = "连接";
    await refresh();
  }
});

btnDisconnect.addEventListener("click", async () => {
  await send("STOP_AUTO_FOLLOW");
  await send("DISCONNECT");
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
