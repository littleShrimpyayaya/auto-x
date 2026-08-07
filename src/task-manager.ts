import { Service } from './service.js';
import { UserRepository } from './user-repository.js';
import { XClient } from './x-client.js';
import { BrowserClient } from './browser-client.js';
import type { XUser, PendingStats } from './types.js';
import {
  loadPostConfig,
  savePostConfig,
  saveAutomationConfig,
  loadAutomationConfig,
  formatInTimezone,
  DEFAULT_TIMEZONE,
  MIN_FOLLOW_BACK_AUTO_INTERVAL,
  type PostConfig,
} from './auto-config.js';

export type TaskType = 'sync-followers' | 'sync-following' | 'auto-follow' | 'process-follow' | 'process-unfollow';
export type TaskStatusType = 'idle' | 'running' | 'completed' | 'error' | 'cancelled';

export interface TaskState {
  type: TaskType | null;
  status: TaskStatusType;
  startedAt: string | null;
  finishedAt: string | null;
  message: string;
}

export interface StatusInfo {
  me: XUser | null;
  followerCount: number;
  followingCount: number;
  task: TaskState;
  autoFollow: {
    enabled: boolean;
    intervalSeconds: number;
    lastRunAt: string | null;
    totalFollowed: number;
  };
  pending: PendingStats | null;
  processFollow: {
    enabled: boolean;
    intervalSeconds: number;
  };
  processUnfollow: {
    enabled: boolean;
    intervalSeconds: number;
  };
  postSchedule: {
    enabled: boolean;
    intervalSeconds: number;
    templatePreview: string;
    nextRunAt: string | null;
  };
  /** 自动扫描回关（服务端定时，持久化） */
  followBackAuto: {
    enabled: boolean;
    intervalMinutes: number;
    nextRunAt: string | null;
    lastRunAt: string | null;
    running: boolean;
    lastResult: string | null;
    /** idle | scanning | following */
    phase: 'idle' | 'scanning' | 'following';
    /** 本轮正在/即将回关的用户（前端勾选同步） */
    processingUsers: Array<{ userId: string; username: string; name: string; profileImageUrl?: string }>;
    /** 回关进度文案，如 3/10 @user */
    progress: { current: number; total: number; label: string } | null;
    /** 本进程会话内成功回关的用户（前端成功列表增量同步） */
    sessionSucceeded: Array<{
      userId: string;
      username: string;
      name: string;
      profileImageUrl?: string;
      at: string;
    }>;
  };
  connected: boolean;
  computedFollowBack: {
    status: string;
    users: Array<{ userId: string; username: string; name: string; profileImageUrl?: string }> | null;
    count: number;
    error: string | null;
  };
}

type FollowBackUserBrief = {
  userId: string;
  username: string;
  name: string;
  profileImageUrl?: string;
};

export class TaskManager {
  private currentController: AbortController | null = null;
  private currentTaskType: TaskType | null = null;
  private taskStatus: TaskStatusType = 'idle';
  private taskMessage = '';
  private taskStartedAt: string | null = null;
  private taskFinishedAt: string | null = null;

  // 后台扫描结果
  private followBackScanResults: Array<{
    userId: string;
    username: string;
    name: string;
    profileImageUrl?: string;
  }> | null = null;
  private followBackScanStatus: 'idle' | 'scanning' | 'done' | 'error' = 'idle';
  private followBackScanError: string | null = null;

  private autoFollowTimer: ReturnType<typeof setInterval> | null = null;
  private autoFollowInterval = 0;
  private autoFollowLastRunAt: string | null = null;
  private autoFollowTotalFollowed = 0;

  private processFollowTimer: ReturnType<typeof setInterval> | null = null;
  private processFollowInterval = 0;
  private processUnfollowTimer: ReturnType<typeof setInterval> | null = null;
  private processUnfollowInterval = 0;
  private totalProcessedFollow = 0;
  private totalProcessedUnfollow = 0;

  // 发帖定时器
  private postTimer: ReturnType<typeof setInterval> | null = null;
  private postInterval = 0;
  private postTemplateText = '';
  private postNextRunAt: string | null = null;
  private postAutoIndex = 0;  // 自动发帖序号，防 X.com 重复内容静默拒绝

  // 自动扫描回关（服务端定时，关 UI 也继续）
  private followBackAutoTimer: ReturnType<typeof setTimeout> | null = null;
  private followBackAutoIntervalMin = 30;
  private followBackAutoNextRunAt: string | null = null;
  private followBackAutoLastRunAt: string | null = null;
  private followBackAutoRunning = false;
  private followBackAutoEnabled = false;
  private followBackAutoLastResult: string | null = null;
  private followBackAutoPhase: 'idle' | 'scanning' | 'following' = 'idle';
  /** 本轮自动回关目标（扫描后、逐个回关前设置；回关成功后逐个剔除） */
  private followBackAutoProcessing: FollowBackUserBrief[] = [];
  private followBackAutoProgress: { current: number; total: number; label: string } | null = null;
  /** 本进程会话成功回关（供前端「已回关」列表同步，最多保留 200） */
  private followBackSessionSucceeded: Array<FollowBackUserBrief & { at: string }> = [];

  private me: XUser | null = null;
  private connected = false;

  private service: Service;
  private xClient: XClient;

  constructor(
    xClient: XClient,
    service: Service,
    private repo: UserRepository,
  ) {
    this.xClient = xClient;
    this.service = service;
  }

  setMe(user: XUser): void {
    this.me = user;
    this.connected = true;
  }

  async reconnectBrowser(authToken: string, ct0: string): Promise<{ ok: boolean; username?: string; error?: string }> {
    if (!(this.service['xClient'] instanceof BrowserClient)) {
      return { ok: false, error: 'Not in browser mode' };
    }

    // 保存配置
    const cfg = loadAutomationConfig();
    cfg.authToken = authToken;
    cfg.ct0 = ct0;
    saveAutomationConfig(cfg);

    try {
      const browserClient = this.service['xClient'] as BrowserClient;
      await browserClient.reconnect(authToken, ct0);
      const me = await browserClient.getMyUser();
      this.setMe(me);
      return { ok: true, username: me.username };
    } catch (err: any) {
      this.connected = false;
      this.me = null;
      return { ok: false, error: err.message };
    }
  }

  async reconnect(newXClient: XClient, newService: Service): Promise<XUser> {
    this.stopAutoFollowSchedule();
    this.stopProcessFollowSchedule();
    this.stopProcessUnfollowSchedule();
    this.stopCurrentTask();

    this.xClient = newXClient;
    this.service = newService;

    const me = await newXClient.getMyUser();
    this.setMe(me);
    return me;
  }

  private get userId(): string {
    if (!this.me?.id) throw new Error('Not authenticated');
    return this.me.id;
  }

  private async runTask(type: TaskType, fn: (signal: AbortSignal) => Promise<any>): Promise<void> {
    if (this.currentController) throw new Error('A task is already running');

    const controller = new AbortController();
    this.currentController = controller;
    this.currentTaskType = type;
    this.taskStatus = 'running';
    this.taskStartedAt = new Date().toISOString();
    this.taskFinishedAt = null;
    this.taskMessage = `Running ${type}...`;

    try {
      await fn(controller.signal);
      if (controller.signal.aborted) {
        this.taskStatus = 'cancelled';
        this.taskMessage = `${type} cancelled`;
      } else {
        this.taskStatus = 'completed';
        this.taskMessage = `${type} completed`;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.taskStatus = 'cancelled';
        this.taskMessage = `${type} cancelled`;
      } else {
        this.taskStatus = 'error';
        this.taskMessage = `${type} failed: ${err.message}`;
        console.error(`Task ${type} error:`, err);
      }
    } finally {
      this.taskFinishedAt = new Date().toISOString();
      this.currentController = null;
      this.currentTaskType = null;
    }
  }

  startSyncFollowers(): void {
    this.runTask('sync-followers', (signal) => this.service.syncFollowers(this.userId, signal));
  }

  startSyncFollowing(): void {
    this.runTask('sync-following', (signal) => this.service.syncFollowing(this.userId, signal));
  }

  startAutoFollow(): void {
    this.runTask('auto-follow', (signal) => this.service.autoFollowBack(this.userId, signal));
  }

  stopCurrentTask(): void {
    if (this.currentController) {
      this.currentController.abort();
    }
  }

  startAutoFollowSchedule(intervalSeconds: number): void {
    this.stopAutoFollowSchedule();
    this.autoFollowInterval = intervalSeconds;

    this.autoFollowTimer = setInterval(() => {
      if (!this.currentController) {
        this.autoFollowLastRunAt = new Date().toISOString();
        this.runTask('auto-follow', (signal) =>
          this.service.autoFollowBack(this.userId, signal).then((result) => {
            this.autoFollowTotalFollowed += result.followed.length;
          }),
        );
      }
    }, intervalSeconds * 1000);

    this.autoFollowLastRunAt = new Date().toISOString();
    this.runTask('auto-follow', (signal) =>
      this.service.autoFollowBack(this.userId, signal).then((result) => {
        this.autoFollowTotalFollowed += result.followed.length;
      }),
    );
  }

  stopAutoFollowSchedule(): void {
    if (this.autoFollowTimer) {
      clearInterval(this.autoFollowTimer);
      this.autoFollowTimer = null;
    }
    this.autoFollowInterval = 0;
  }

  startProcessFollowOnce(): void {
    this.runTask('process-follow', async (_signal) => {
      const result = await this.service.processOnePendingFollow(this.userId);
      if (result.processed && result.status === 'completed') {
        this.totalProcessedFollow++;
      }
    });
  }

  startProcessUnfollowOnce(): void {
    this.runTask('process-unfollow', async (_signal) => {
      const result = await this.service.processOnePendingUnfollow(this.userId);
      if (result.processed && result.status === 'completed') {
        this.totalProcessedUnfollow++;
      }
    });
  }

  startProcessFollowSchedule(intervalSeconds: number): void {
    this.stopProcessFollowSchedule();
    this.processFollowInterval = intervalSeconds;

    this.processFollowTimer = setInterval(() => {
      if (!this.currentController) {
        this.runTask('process-follow', async (signal) => {
          const result = await this.service.processOnePendingFollow(this.userId);
          if (result.processed && result.status === 'completed') {
            this.totalProcessedFollow++;
          }
        });
      }
    }, intervalSeconds * 1000);
  }

  stopProcessFollowSchedule(): void {
    if (this.processFollowTimer) {
      clearInterval(this.processFollowTimer);
      this.processFollowTimer = null;
    }
    this.processFollowInterval = 0;
  }

  startProcessUnfollowSchedule(intervalSeconds: number): void {
    this.stopProcessUnfollowSchedule();
    this.processUnfollowInterval = intervalSeconds;

    this.processUnfollowTimer = setInterval(() => {
      if (!this.currentController) {
        this.runTask('process-unfollow', async (signal) => {
          const result = await this.service.processOnePendingUnfollow(this.userId);
          if (result.processed && result.status === 'completed') {
            this.totalProcessedUnfollow++;
          }
        });
      }
    }, intervalSeconds * 1000);
  }

  stopProcessUnfollowSchedule(): void {
    if (this.processUnfollowTimer) {
      clearInterval(this.processUnfollowTimer);
      this.processUnfollowTimer = null;
    }
    this.processUnfollowInterval = 0;
  }

  // ── 发帖 ─────────────────────────────────────────────

  /** 手动发帖：不受活跃时段限制 */
  async postNow(text: string): Promise<{ ok: boolean; skipped?: boolean }> {
    if (this.service['xClient'] instanceof BrowserClient) {
      return (this.service['xClient'] as BrowserClient).postTweet(text, { force: true });
    }
    // X API 模式暂不支持发帖
    return { ok: false };
  }

  /** 配置保存后立即刷新 BrowserClient 内存中的活跃时段等 */
  reloadAutomationConfig(): void {
    if (this.service['xClient'] instanceof BrowserClient) {
      (this.service['xClient'] as BrowserClient).reloadConfig();
    }
  }

  startPostSchedule(intervalMinutes: number, templateText: string, firstDelayMs?: number): void {
    this.stopPostSchedule();
    this.postInterval = intervalMinutes;
    this.postTemplateText = templateText;

    const intervalMs = intervalMinutes * 60 * 1000;
    // firstDelayMs: 首次触发的延迟（用于恢复定时时对齐周期）；未指定则用完整周期
    const firstDelay = typeof firstDelayMs === 'number' ? Math.max(0, firstDelayMs) : intervalMs;

    let isFirst = true;

    const doPost = async () => {
      if (this.service['xClient'] instanceof BrowserClient) {
        this.postAutoIndex++;
        // 自动发帖末尾加时间戳，防 X.com 重复检测（完全相同的推文会被静默拒绝）
        // 时间戳用北京时间，与活跃时段一致
        const ts = formatInTimezone(new Date(), DEFAULT_TIMEZONE, { compact: true });
        const postText = templateText + `\n\n${ts} ⏳`;
        console.log(`[Post] 定时发帖 #${this.postAutoIndex} @ ${ts} (北京时间)...`);
        try {
          const result = await (this.service['xClient'] as BrowserClient).postTweet(postText);
          if (result.ok) {
            const cfg = loadPostConfig();
            cfg.lastPostAt = new Date().toISOString();
            cfg.postAutoIndex = this.postAutoIndex;
            savePostConfig(cfg);
          } else if (result.skipped) {
            // 非活跃时段跳过，不算失败（等下一个周期到了自然会重试）
            console.log(`[Post] 定时发帖 #${this.postAutoIndex} 非活跃时段跳过，等待下个周期`);
          } else {
            console.warn(`[Post] 定时发帖 #${this.postAutoIndex} 发送失败，将重试`);
          }
        } catch (err) {
          console.error('[Post] 定时发帖失败:', err);
        }
      }
      if (isFirst) {
        // 首次 setTimeout 之后，切换到 setInterval
        isFirst = false;
        if (this.postTimer) clearTimeout(this.postTimer);
        this.postNextRunAt = new Date(Date.now() + intervalMs).toISOString();
        this.postTimer = setInterval(doPost, intervalMs);
      } else {
        this.postNextRunAt = new Date(Date.now() + intervalMs).toISOString();
      }
    };

    this.postNextRunAt = new Date(Date.now() + firstDelay).toISOString();

    // 用 setTimeout 处理首次触发，支持非完整周期间隔
    this.postTimer = setTimeout(doPost, firstDelay);

    const firstLocal = formatInTimezone(this.postNextRunAt, DEFAULT_TIMEZONE);
    console.log(
      `[Post] 定时发帖已启动，间隔 ${intervalMinutes} 分钟，首次 ${firstLocal} (北京时间)`,
    );
  }

  stopPostSchedule(): void {
    if (this.postTimer) {
      clearInterval(this.postTimer);
      this.postTimer = null;
    }
    this.postInterval = 0;
    this.postTemplateText = '';
    this.postNextRunAt = null;
    console.log('[Post] 定时发帖已停止');
  }

  /** 进程启动时按已保存配置恢复定时（根据上次发推时间计算剩余等待） */
  restorePostScheduleFromConfig(): void {
    const cfg = loadPostConfig();
    if (!cfg.autoPostEnabled) return;
    const interval = cfg.autoPostIntervalMinutes || 60;
    if (interval < 5) return;
    const text = cfg.templates?.[cfg.autoPostTemplateIndex ?? 0] || cfg.templates?.[0];
    if (!text) {
      console.warn('[Post] 配置开启了自动发推，但没有模板文案，跳过恢复');
      return;
    }

    // 恢复序号
    this.postAutoIndex = cfg.postAutoIndex || 0;

    const intervalMs = interval * 60 * 1000;
    let firstDelay = intervalMs;

    if (cfg.lastPostAt) {
      const lastTime = new Date(cfg.lastPostAt).getTime();
      const elapsed = Date.now() - lastTime;
      if (elapsed >= intervalMs) {
        // 已经过了下一个发推时间 → 立即发
        console.log('[Post] 上次发推已超过周期，立即补发');
        firstDelay = 1000; // 1 秒后立刻发
      } else {
        // 还没到 → 等剩余时间
        firstDelay = intervalMs - elapsed;
        console.log(`[Post] 距下次发推还有 ${Math.round(firstDelay / 60000)} 分钟`);
      }
    } else {
      // 无历史记录：以当前时间为基准写入，避免每次重启都重置倒计时
      console.log('[Post] 无历史发帖记录，以当前时间为基准，等一个完整周期');
      cfg.lastPostAt = new Date().toISOString();
      savePostConfig(cfg);
    }

    this.startPostSchedule(interval, text, firstDelay);
    console.log(`[Post] 已从配置恢复自动发推，每 ${interval} 分钟`);
  }

  /** 启动后台扫描待回关（不阻塞请求；结果仅内存，经 /api/status 给前端，不持久化） */
  startComputeFollowBack(): void {
    if (this.followBackAutoEnabled) {
      throw new Error('自动扫描回关已开启，请先关闭自动化后再手动扫描');
    }
    if (this.followBackScanStatus === 'scanning' || this.followBackAutoRunning) {
      throw new Error('扫描进行中，请等待完成后再试');
    }
    // 每次新扫描先丢掉上一轮内存结果
    this.followBackScanStatus = 'scanning';
    this.followBackScanResults = null;
    this.followBackScanError = null;

    // 后台启动，不用 runTask 占住主任务槽
    this.service.computeFollowBackWithDetails(this.userId)
      .then((results) => {
        this.followBackScanResults = results;
        this.followBackScanStatus = 'done';
        console.log(`[TaskManager] 后台扫描完成: ${results.length} 个待回关（仅内存，未落库）`);
      })
      .catch((err) => {
        this.followBackScanStatus = 'error';
        this.followBackScanError = err.message;
        console.error('[TaskManager] 后台扫描失败:', err);
      });
  }

  // ── 自动扫描回关（持久化，关 UI 仍运行）────────────────

  /**
   * 开启/刷新自动扫描回关。
   * @param intervalMinutes 周期分钟，最低 10
   * @param firstDelayMs 首次触发延迟；未指定则按 lastRunAt 对齐或短暂延迟后跑一轮
   */
  startFollowBackAuto(intervalMinutes: number, firstDelayMs?: number): void {
    const interval = Math.max(MIN_FOLLOW_BACK_AUTO_INTERVAL, Math.floor(intervalMinutes || 30));
    this.stopFollowBackAuto(false);

    this.followBackAutoEnabled = true;
    this.followBackAutoIntervalMin = interval;

    const cfg = loadAutomationConfig();
    cfg.followBackAutoEnabled = true;
    cfg.followBackAutoIntervalMinutes = interval;
    saveAutomationConfig(cfg);

    const intervalMs = interval * 60_000;
    let delay = typeof firstDelayMs === 'number' ? Math.max(0, firstDelayMs) : 5_000;

    if (typeof firstDelayMs !== 'number' && cfg.lastFollowBackAutoAt) {
      const elapsed = Date.now() - new Date(cfg.lastFollowBackAutoAt).getTime();
      if (elapsed < intervalMs) {
        delay = intervalMs - elapsed;
      } else {
        delay = 3_000; // 已过周期，尽快跑一轮
      }
    }

    this.followBackAutoLastRunAt = cfg.lastFollowBackAutoAt;
    this.scheduleFollowBackAutoNext(delay);

    console.log(
      `[AutoFollowBack] 已开启，周期 ${interval} 分钟，下次 ` +
      `${formatInTimezone(this.followBackAutoNextRunAt || Date.now(), DEFAULT_TIMEZONE)} (北京时间)`,
    );
  }

  /** 停止自动扫描回关；persist=true 时写入配置 */
  stopFollowBackAuto(persist = true): void {
    if (this.followBackAutoTimer) {
      clearTimeout(this.followBackAutoTimer);
      this.followBackAutoTimer = null;
    }
    this.followBackAutoEnabled = false;
    this.followBackAutoNextRunAt = null;
    if (persist) {
      const cfg = loadAutomationConfig();
      cfg.followBackAutoEnabled = false;
      saveAutomationConfig(cfg);
      console.log('[AutoFollowBack] 已关闭');
    }
  }

  private scheduleFollowBackAutoNext(delayMs: number): void {
    if (this.followBackAutoTimer) {
      clearTimeout(this.followBackAutoTimer);
      this.followBackAutoTimer = null;
    }
    this.followBackAutoNextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.followBackAutoTimer = setTimeout(() => {
      void this.runFollowBackAutoCycle().finally(() => {
        if (!this.followBackAutoEnabled) return;
        const ms = this.followBackAutoIntervalMin * 60_000;
        this.scheduleFollowBackAutoNext(ms);
      });
    }, delayMs);
  }

  private pushSessionSucceeded(u: FollowBackUserBrief): void {
    const id = String(u.userId || '');
    if (!id) return;
    // 去重：同一用户只保留最新一条在顶部
    this.followBackSessionSucceeded = this.followBackSessionSucceeded.filter(
      (x) => String(x.userId) !== id,
    );
    this.followBackSessionSucceeded.unshift({
      userId: u.userId,
      username: u.username,
      name: u.name || u.username,
      profileImageUrl: u.profileImageUrl,
      at: new Date().toISOString(),
    });
    if (this.followBackSessionSucceeded.length > 200) {
      this.followBackSessionSucceeded = this.followBackSessionSucceeded.slice(0, 200);
    }
  }

  /** 一轮：扫描待回关 → 自动逐个回关（不受活跃时段限制；仅受 batchSize 约束；进度可被 UI 轮询） */
  private async runFollowBackAutoCycle(): Promise<void> {
    if (this.followBackAutoRunning) {
      console.warn('[AutoFollowBack] 上一轮仍在进行，跳过');
      return;
    }
    if (this.followBackScanStatus === 'scanning') {
      console.warn('[AutoFollowBack] 手动扫描进行中，跳过本轮');
      return;
    }

    this.followBackAutoRunning = true;
    this.followBackAutoPhase = 'idle';
    this.followBackAutoProcessing = [];
    this.followBackAutoProgress = null;
    const cfg = loadAutomationConfig();

    try {
      // 刷新 batchSize / 操作间隔等配置（回关不看活跃时段）
      try {
        if (this.service['xClient'] instanceof BrowserClient) {
          (this.service['xClient'] as BrowserClient).reloadConfig();
        }
      } catch { /* ignore */ }

      console.log('[AutoFollowBack] 开始自动扫描待回关…');
      this.followBackAutoPhase = 'scanning';
      this.followBackScanStatus = 'scanning';
      this.followBackScanResults = null;
      this.followBackScanError = null;

      const results = await this.service.computeFollowBackWithDetails(this.userId);
      this.followBackScanResults = results;
      this.followBackScanStatus = 'done';
      console.log(`[AutoFollowBack] 扫描完成: ${results.length} 个待回关`);

      if (results.length === 0) {
        this.followBackAutoLastResult = '扫描完成：0 个待回关';
      } else {
        const maxBatch = Math.max(1, cfg.batchSizeMax || 18);
        // 保留完整用户信息，便于 UI 勾选同步与成功列表
        const targets: FollowBackUserBrief[] = results.slice(0, maxBatch).map((u) => ({
          userId: u.userId,
          username: u.username,
          name: u.name || u.username,
          profileImageUrl: u.profileImageUrl,
        }));
        this.followBackAutoPhase = 'following';
        this.followBackAutoProcessing = [...targets];
        this.followBackAutoProgress = {
          current: 0,
          total: targets.length,
          label: '准备回关…',
        };
        console.log(`[AutoFollowBack] 开始自动回关 ${targets.length}/${results.length} 人…`);

        let done = 0;
        let failed = 0;
        // 逐个回关：每成功一人立刻从待回关队列剔除并记入会话成功列表，前端轮询可同步
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const label = t.username ? `@${t.username}` : t.userId;
          this.followBackAutoProgress = {
            current: i + 1,
            total: targets.length,
            label,
          };
          try {
            const r = await this.service.batchFollow(this.userId, [
              { userId: t.userId, username: t.username },
            ]);
            const ok =
              r.done > 0 ||
              (r.results || []).some((x) => x.ok && String(x.userId) === String(t.userId));
            if (ok) {
              done++;
              this.removeFromFollowBackScan([t.userId]);
              this.pushSessionSucceeded(t);
              // 处理中列表同步去掉已成功的
              this.followBackAutoProcessing = this.followBackAutoProcessing.filter(
                (u) => String(u.userId) !== String(t.userId),
              );
              console.log(`[AutoFollowBack] ✓ ${label} (${done + failed}/${targets.length})`);
            } else {
              failed++;
              console.warn(`[AutoFollowBack] ✗ ${label}`);
            }
          } catch (err) {
            failed++;
            console.warn(
              `[AutoFollowBack] ✗ ${label}:`,
              (err as Error).message,
            );
          }
        }

        this.followBackAutoLastResult =
          `扫描 ${results.length}，回关成功 ${done}，失败 ${failed}`;
        console.log(`[AutoFollowBack] ${this.followBackAutoLastResult}`);

        // 有成功回关时刷新账号粉丝/关注数（等同 UI Refresh Stats）
        if (done > 0) {
          try {
            await this.refreshMe();
            console.log('[AutoFollowBack] 已刷新 Account stats');
          } catch (err) {
            console.warn('[AutoFollowBack] 刷新 Account 失败:', (err as Error).message);
          }
        }
      }

      const now = new Date().toISOString();
      this.followBackAutoLastRunAt = now;
      const updated = loadAutomationConfig();
      updated.lastFollowBackAutoAt = now;
      updated.followBackAutoEnabled = true;
      updated.followBackAutoIntervalMinutes = this.followBackAutoIntervalMin;
      saveAutomationConfig(updated);
    } catch (err) {
      this.followBackScanStatus = 'error';
      this.followBackScanError = (err as Error).message;
      this.followBackAutoLastResult = '失败: ' + (err as Error).message;
      console.error('[AutoFollowBack] 本轮失败:', err);
    } finally {
      this.followBackAutoRunning = false;
      this.followBackAutoPhase = 'idle';
      this.followBackAutoProcessing = [];
      this.followBackAutoProgress = null;
    }
  }

  /** 进程启动时按配置恢复自动扫描回关 */
  restoreFollowBackAutoFromConfig(): void {
    const cfg = loadAutomationConfig();
    if (!cfg.followBackAutoEnabled) return;
    const interval = Math.max(
      MIN_FOLLOW_BACK_AUTO_INTERVAL,
      cfg.followBackAutoIntervalMinutes || 30,
    );
    console.log(`[AutoFollowBack] 从配置恢复，周期 ${interval} 分钟`);
    this.startFollowBackAuto(interval);
  }

  async computeFollowBack(): Promise<Array<{
    userId: string;
    username: string;
    name: string;
    profileImageUrl?: string;
  }>> {
    return this.service.computeFollowBackWithDetails(this.userId);
  }

  async computeUnfollow(): Promise<Array<{ userId: string; username: string; name: string }>> {
    return this.service.computeUnfollowWithDetails(this.userId);
  }

  async batchFollow(
    targets: Array<string | { userId: string; username?: string }>,
  ): Promise<{ done: number; failed: number; results: Array<{ userId: string; username?: string; ok: boolean }> }> {
    // 自动周期内跑的 batch 不拦；仅拦前端手动触发（由 server 在 auto 开启时拒绝）
    return this.service.batchFollow(this.userId, targets);
  }

  isFollowBackAutoEnabled(): boolean {
    return this.followBackAutoEnabled;
  }

  isFollowBackAutoRunning(): boolean {
    return this.followBackAutoRunning;
  }

  /** 批量回关成功后，从内存扫描结果中剔除，避免 UI 仍显示已回关用户 */
  removeFromFollowBackScan(userIds: string[]): void {
    if (!this.followBackScanResults || userIds.length === 0) return;
    const drop = new Set(userIds.map(String));
    this.followBackScanResults = this.followBackScanResults.filter((u) => !drop.has(String(u.userId)));
  }

  /** 手动/自动回关成功后写入会话成功列表（供 /api/status 给前端成功区） */
  recordFollowBackSuccesses(
    users: Array<{ userId: string; username?: string; name?: string; profileImageUrl?: string }>,
  ): void {
    for (const u of users) {
      if (!u?.userId) continue;
      // 尽量从扫描结果补全 name / 头像
      const fromScan = this.followBackScanResults?.find(
        (x) => String(x.userId) === String(u.userId),
      );
      this.pushSessionSucceeded({
        userId: u.userId,
        username: u.username || fromScan?.username || u.userId,
        name: u.name || fromScan?.name || u.username || u.userId,
        profileImageUrl: u.profileImageUrl || fromScan?.profileImageUrl,
      });
    }
  }

  async batchUnfollow(targetUserIds: string[]): Promise<{ done: number; failed: number }> {
    return this.service.batchUnfollow(this.userId, targetUserIds);
  }

  async refreshMe(): Promise<XUser | null> {
    if (this.service['xClient'] instanceof BrowserClient) {
      const me = await (this.service['xClient'] as BrowserClient).getMyUser();
      if (me) this.setMe(me);
      return me;
    }
    return null;
  }

  async getStatus(): Promise<StatusInfo> {
    let followerCount = 0;
    let followingCount = 0;
    let pending: PendingStats | null = null;

    if (this.me) {
      const [f1, f2, stats] = await Promise.all([
        this.repo.getRelationshipIds(this.me.id, 'follower'),
        this.repo.getRelationshipIds(this.me.id, 'following'),
        this.repo.getPendingStats(),
      ]);
      followerCount = f1.length;
      followingCount = f2.length;
      pending = stats;
    }

    return {
      me: this.me,
      followerCount,
      followingCount,
      task: {
        type: this.currentTaskType,
        status: this.taskStatus,
        startedAt: this.taskStartedAt,
        finishedAt: this.taskFinishedAt,
        message: this.taskMessage,
      },
      autoFollow: {
        enabled: this.autoFollowTimer !== null,
        intervalSeconds: this.autoFollowInterval,
        lastRunAt: this.autoFollowLastRunAt,
        totalFollowed: this.autoFollowTotalFollowed,
      },
      pending,
      processFollow: {
        enabled: this.processFollowTimer !== null,
        intervalSeconds: this.processFollowInterval,
      },
      processUnfollow: {
        enabled: this.processUnfollowTimer !== null,
        intervalSeconds: this.processUnfollowInterval,
      },
      postSchedule: {
        enabled: this.postTimer !== null,
        intervalSeconds: this.postInterval * 60,
        templatePreview: this.postTemplateText.substring(0, 50),
        nextRunAt: this.postNextRunAt,
      },
      followBackAuto: {
        enabled: this.followBackAutoEnabled,
        intervalMinutes: this.followBackAutoIntervalMin,
        nextRunAt: this.followBackAutoNextRunAt,
        lastRunAt: this.followBackAutoLastRunAt,
        running: this.followBackAutoRunning,
        lastResult: this.followBackAutoLastResult,
        phase: this.followBackAutoPhase,
        processingUsers: this.followBackAutoProcessing,
        progress: this.followBackAutoProgress,
        sessionSucceeded: this.followBackSessionSucceeded,
      },
      connected: this.connected,
      computedFollowBack: {
        status: this.followBackScanStatus,
        users: this.followBackScanResults,
        count: this.followBackScanResults?.length ?? 0,
        error: this.followBackScanError,
      },
    };
  }
}
