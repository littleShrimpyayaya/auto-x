import { Service } from './service.js';
import { UserRepository } from './user-repository.js';
import { XClient } from './x-client.js';
import { BrowserClient } from './browser-client.js';
import type { XUser, PendingStats } from './types.js';
import {
  loadPostConfig,
  updatePostConfig,
  ensureComposerTask,
  getComposerTask,
  antiDupeSuffix,
  clampTweetBody,
  saveAutomationConfig,
  loadAutomationConfig,
  formatInTimezone,
  DEFAULT_TIMEZONE,
  MIN_FOLLOW_BACK_AUTO_INTERVAL,
  COMPOSER_TASK_ID,
  MIN_POST_INTERVAL_MINUTES,
  MAX_POST_TASKS,
  type PostTaskConfig,
  type PostTaskPhase,
} from './auto-config.js';
import { randomUUID } from 'crypto';

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
  /** Always derived from composer-linked task only (legacy UI) */
  postSchedule: {
    enabled: boolean;
    intervalSeconds: number;
    templatePreview: string;
    nextRunAt: string | null;
  };
  /** Multi-task post status */
  postTasks: Array<{
    id: string;
    name: string;
    enabled: boolean;
    intervalMinutes: number;
    contentMode: string;
    contentPreview: string;
    phase: PostTaskPhase;
    nextRunAt: string | null;
    lastPostAt: string | null;
    lastResult: string | null;
    lastError: string | null;
    postCount: number;
  }>;
  pageQueue: {
    depth: number;
    currentLabel: string | null;
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

  // 发帖：每任务独立 timer（composer = COMPOSER_TASK_ID）
  private postTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private postTaskRuntime = new Map<
    string,
    { phase: PostTaskPhase; nextRunAt: string | null; consecutiveErrors: number }
  >();

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

  // ── 发帖（multi-task; composer = COMPOSER_TASK_ID）────────

  private getPostRuntime(taskId: string) {
    let r = this.postTaskRuntime.get(taskId);
    if (!r) {
      r = { phase: 'idle', nextRunAt: null, consecutiveErrors: 0 };
      this.postTaskRuntime.set(taskId, r);
    }
    return r;
  }

  /** 手动发帖（force/priority，无时段限制） */
  async postNow(text: string): Promise<{ ok: boolean; skipped?: boolean }> {
    if (this.service['xClient'] instanceof BrowserClient) {
      return (this.service['xClient'] as BrowserClient).postTweet(text, {
        force: true,
        priority: true,
      });
    }
    return { ok: false };
  }

  /** 配置保存后立即刷新 BrowserClient 内存配置 */
  reloadAutomationConfig(): void {
    if (this.service['xClient'] instanceof BrowserClient) {
      (this.service['xClient'] as BrowserClient).reloadConfig();
    }
  }

  /**
   * 启动/刷新 **composer** 任务定时（兼容旧 API）。
   * 不会 stop-all；仅动 COMPOSER_TASK_ID。
   */
  async startPostSchedule(
    intervalMinutes: number,
    templateText: string,
    firstDelayMs?: number,
  ): Promise<void> {
    const interval = Math.max(MIN_POST_INTERVAL_MINUTES, Math.floor(intervalMinutes || 60));
    await updatePostConfig((cfg) =>
      ensureComposerTask(cfg, {
        content: templateText,
        enabled: true,
        intervalMinutes: interval,
      }),
    );
    this.armPostTask(COMPOSER_TASK_ID, firstDelayMs);
  }

  /** 停止 **composer** 定时 only（兼容旧 API；绝不 stop-all） */
  async stopPostSchedule(): Promise<void> {
    this.stopPostTaskSchedule(COMPOSER_TASK_ID);
    await updatePostConfig((cfg) => {
      const t = getComposerTask(cfg);
      if (t) {
        t.enabled = false;
        t.updatedAt = new Date().toISOString();
      }
    });
    console.log('[Post] composer 定时发帖已停止');
  }

  stopPostTaskSchedule(taskId: string): void {
    const timer = this.postTaskTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.postTaskTimers.delete(taskId);
    }
    const rt = this.getPostRuntime(taskId);
    rt.phase = 'idle';
    rt.nextRunAt = null;
  }

  stopAllPostTaskSchedules(): void {
    for (const id of [...this.postTaskTimers.keys()]) {
      this.stopPostTaskSchedule(id);
    }
  }

  /** Arm one task timer from current config (does not rewrite enabled). */
  armPostTask(taskId: string, firstDelayMs?: number): void {
    const cfg = loadPostConfig();
    const task = cfg.tasks.find((t) => t.id === taskId);
    if (!task || !task.enabled || !String(task.content || '').trim()) {
      this.stopPostTaskSchedule(taskId);
      return;
    }
    // AI mode not implemented yet — skip with lastError, keep waiting next cycle after interval
    const intervalMs = Math.max(MIN_POST_INTERVAL_MINUTES, task.intervalMinutes) * 60_000;
    let delay: number;
    if (typeof firstDelayMs === 'number') {
      delay = Math.max(0, firstDelayMs);
    } else if (task.lastPostAt) {
      const elapsed = Date.now() - new Date(task.lastPostAt).getTime();
      delay = elapsed >= intervalMs ? 1000 : intervalMs - elapsed;
    } else {
      delay = intervalMs;
      // 无历史：写入 lastPostAt 避免每次重启都立刻发
      void updatePostConfig((c) => {
        const t = c.tasks.find((x) => x.id === taskId);
        if (t && !t.lastPostAt) {
          t.lastPostAt = new Date().toISOString();
          t.updatedAt = new Date().toISOString();
        }
      });
    }

    this.stopPostTaskSchedule(taskId);
    const rt = this.getPostRuntime(taskId);
    rt.phase = 'waiting';
    rt.nextRunAt = new Date(Date.now() + delay).toISOString();

    const timer = setTimeout(() => {
      void this.runPostTaskCycle(taskId).finally(() => {
        // re-arm if still enabled
        const latest = loadPostConfig().tasks.find((t) => t.id === taskId);
        if (latest?.enabled) this.armPostTask(taskId);
        else {
          const r = this.getPostRuntime(taskId);
          r.phase = 'idle';
          r.nextRunAt = null;
        }
      });
    }, delay);
    this.postTaskTimers.set(taskId, timer);

    const label = taskId === COMPOSER_TASK_ID ? 'composer' : taskId;
    console.log(
      `[Post] 任务 ${label} 已调度，间隔 ${task.intervalMinutes} 分钟，下次 ` +
        `${formatInTimezone(rt.nextRunAt, DEFAULT_TIMEZONE)} (北京时间)`,
    );
  }

  private async runPostTaskCycle(taskId: string): Promise<void> {
    const rt = this.getPostRuntime(taskId);
    const cfg = loadPostConfig();
    const task = cfg.tasks.find((t) => t.id === taskId);
    if (!task || !task.enabled) {
      rt.phase = 'idle';
      return;
    }

    // 用户确认：回关占用浏览器时跳过本轮定时发推
    if (this.followBackAutoRunning || this.followBackScanStatus === 'scanning') {
      console.log(`[Post] 任务 ${taskId} 跳过：自动回关/扫描进行中`);
      await updatePostConfig((c) => {
        const t = c.tasks.find((x) => x.id === taskId);
        if (t) {
          t.lastResult = 'skipped: follow-back busy';
          t.updatedAt = new Date().toISOString();
        }
      });
      rt.phase = 'waiting';
      return;
    }

    if (task.contentMode === 'ai') {
      // PR3 之前：记错误并保持调度
      console.warn(`[Post] 任务 ${taskId} contentMode=ai 尚未启用，跳过`);
      await updatePostConfig((c) => {
        const t = c.tasks.find((x) => x.id === taskId);
        if (t) {
          t.lastError = 'AI mode not enabled yet';
          t.lastResult = 'skipped: ai not implemented';
          t.updatedAt = new Date().toISOString();
        }
      });
      rt.phase = 'waiting';
      return;
    }

    if (!(this.service['xClient'] instanceof BrowserClient)) {
      console.warn('[Post] 非浏览器模式，无法发帖');
      return;
    }

    // 递增 postAutoIndex（与旧行为一致：每次 attempt 都加）
    let attemptIndex = 0;
    await updatePostConfig((c) => {
      const t = c.tasks.find((x) => x.id === taskId);
      if (t) {
        t.postAutoIndex = (t.postAutoIndex || 0) + 1;
        attemptIndex = t.postAutoIndex;
        t.updatedAt = new Date().toISOString();
      }
    });

    const suffix = antiDupeSuffix(new Date(), DEFAULT_TIMEZONE);
    const body = clampTweetBody(task.content || '', suffix);
    const postText = body + suffix;

    rt.phase = 'queued';
    console.log(`[Post] 定时发帖 #${attemptIndex} task=${taskId} …`);

    try {
      rt.phase = 'posting';
      const result = await (this.service['xClient'] as BrowserClient).postTweet(postText);
      if (result.ok) {
        const now = new Date().toISOString();
        await updatePostConfig((c) => {
          const t = c.tasks.find((x) => x.id === taskId);
          if (t) {
            t.lastPostAt = now;
            t.postCount = (t.postCount || 0) + 1;
            t.lastResult = 'ok';
            t.lastError = null;
            t.updatedAt = now;
          }
        });
        rt.consecutiveErrors = 0;
        console.log(`[Post] 定时发帖 #${attemptIndex} 成功`);
      } else if (result.skipped) {
        await updatePostConfig((c) => {
          const t = c.tasks.find((x) => x.id === taskId);
          if (t) {
            t.lastResult = 'skipped: inactive hours';
            t.updatedAt = new Date().toISOString();
          }
        });
        console.log(`[Post] 定时发帖 #${attemptIndex} 非活跃时段跳过`);
      } else {
        rt.consecutiveErrors++;
        await updatePostConfig((c) => {
          const t = c.tasks.find((x) => x.id === taskId);
          if (t) {
            t.lastError = 'post failed';
            t.lastResult = 'failed';
            t.updatedAt = new Date().toISOString();
          }
        });
        console.warn(`[Post] 定时发帖 #${attemptIndex} 发送失败`);
      }
    } catch (err) {
      rt.consecutiveErrors++;
      const msg = (err as Error).message || String(err);
      await updatePostConfig((c) => {
        const t = c.tasks.find((x) => x.id === taskId);
        if (t) {
          t.lastError = msg;
          t.lastResult = 'error';
          t.updatedAt = new Date().toISOString();
        }
      });
      console.error('[Post] 定时发帖失败:', err);
    } finally {
      rt.phase = 'waiting';
    }
  }

  /** 进程启动：恢复所有 enabled 任务 */
  restorePostScheduleFromConfig(): void {
    const cfg = loadPostConfig();
    const enabled = cfg.tasks.filter((t) => t.enabled && String(t.content || '').trim());
    if (enabled.length === 0) {
      // 兼容：若仅有 legacy 开关（迁移后应已 dual-write）
      if (cfg.autoPostEnabled) {
        const text = cfg.templates?.[0];
        if (text) {
          void updatePostConfig((c) =>
            ensureComposerTask(c, {
              content: text,
              enabled: true,
              intervalMinutes: cfg.autoPostIntervalMinutes,
            }),
          ).then(() => this.armPostTask(COMPOSER_TASK_ID));
        }
      }
      return;
    }
    for (const t of enabled) {
      this.armPostTask(t.id);
    }
    console.log(`[Post] 已从配置恢复 ${enabled.length} 个自动发推任务`);
  }

  // ── 多任务 CRUD（不影响 composer Post Now 路径）────────

  listPostTasks(): PostTaskConfig[] {
    return loadPostConfig().tasks || [];
  }

  getPostTask(taskId: string): PostTaskConfig | null {
    return loadPostConfig().tasks.find((t) => t.id === taskId) || null;
  }

  async createPostTask(input: {
    name?: string;
    content?: string;
    intervalMinutes?: number;
    enabled?: boolean;
    contentMode?: 'static' | 'ai';
  }): Promise<PostTaskConfig> {
    const now = new Date().toISOString();
    const content = String(input.content || '').trim();
    const interval = Math.max(
      MIN_POST_INTERVAL_MINUTES,
      Math.floor(Number(input.intervalMinutes) || 60),
    );
    const contentMode = input.contentMode === 'ai' ? 'ai' : 'static';
    const wantEnabled = !!input.enabled;
    if (wantEnabled && !content) {
      throw new Error('启用任务时内容不能为空');
    }
    if (contentMode === 'ai') {
      // PR3 前允许创建但启用时提示；创建时允许保存草稿
    }
    let created!: PostTaskConfig;
    await updatePostConfig((cfg) => {
      if ((cfg.tasks || []).length >= MAX_POST_TASKS) {
        throw new Error(`最多 ${MAX_POST_TASKS} 个发帖任务`);
      }
      created = {
        id: `task-${randomUUID()}`,
        name: String(input.name || '任务').slice(0, 64) || '任务',
        enabled: wantEnabled && !!content,
        intervalMinutes: interval,
        contentMode,
        content,
        model: null,
        lastPostAt: null,
        postAutoIndex: 0,
        postCount: 0,
        lastResult: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      cfg.tasks = [...(cfg.tasks || []), created];
    });
    if (created.enabled) this.armPostTask(created.id);
    return created;
  }

  async updatePostTask(
    taskId: string,
    patch: {
      name?: string;
      content?: string;
      intervalMinutes?: number;
      enabled?: boolean;
      contentMode?: 'static' | 'ai';
    },
  ): Promise<PostTaskConfig> {
    const before = this.getPostTask(taskId);
    if (!before) throw new Error('任务不存在');
    const wasEnabled = !!before.enabled;
    const prevInterval = before.intervalMinutes;

    const cfgAfter = await updatePostConfig((cfg) => {
      const t = cfg.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error('任务不存在');
      if (patch.name !== undefined) t.name = String(patch.name).slice(0, 64) || t.name;
      // 文案可随时更新；定时发推每次执行前都会重新 load 配置，立即生效于下一次发送
      if (patch.content !== undefined) t.content = String(patch.content);
      if (patch.intervalMinutes !== undefined) {
        t.intervalMinutes = Math.max(
          MIN_POST_INTERVAL_MINUTES,
          Math.floor(Number(patch.intervalMinutes) || t.intervalMinutes),
        );
      }
      if (patch.contentMode !== undefined) {
        t.contentMode = patch.contentMode === 'ai' ? 'ai' : 'static';
      }
      if (patch.enabled !== undefined) {
        if (patch.enabled && !String(t.content || '').trim()) {
          throw new Error('启用任务时内容不能为空');
        }
        t.enabled = !!patch.enabled;
      }
      t.updatedAt = new Date().toISOString();
    });
    const updated = cfgAfter.tasks.find((x) => x.id === taskId);
    if (!updated) throw new Error('任务不存在');

    if (!updated.enabled) {
      this.stopPostTaskSchedule(taskId);
    } else {
      // 仅改文案/名称：保留已有倒计时（下次发送会用新文案）
      // 开关或周期变化 / 之前未在跑：重新调度
      const scheduleChanged =
        !wasEnabled ||
        patch.enabled === true ||
        (patch.intervalMinutes !== undefined &&
          Number(patch.intervalMinutes) !== prevInterval) ||
        !this.postTaskTimers.has(taskId);
      if (scheduleChanged) {
        this.armPostTask(taskId);
      } else {
        console.log(
          `[Post] 任务 ${taskId} 配置已更新（文案等），下次发送将使用新内容`,
        );
      }
    }
    return { ...updated };
  }

  async deletePostTask(taskId: string): Promise<void> {
    this.stopPostTaskSchedule(taskId);
    await updatePostConfig((cfg) => {
      const before = cfg.tasks.length;
      cfg.tasks = cfg.tasks.filter((t) => t.id !== taskId);
      if (cfg.tasks.length === before) throw new Error('任务不存在');
    });
    this.postTaskRuntime.delete(taskId);
  }

  async setPostTaskEnabled(taskId: string, enabled: boolean): Promise<PostTaskConfig> {
    return this.updatePostTask(taskId, { enabled });
  }

  /** 立即执行一次（force，无 anti-dupe 后缀）；不改 lastPostAt 周期对齐逻辑以外的 enabled */
  async runPostTaskOnce(taskId: string): Promise<{ ok: boolean; skipped?: boolean; text?: string }> {
    const task = this.getPostTask(taskId);
    if (!task) throw new Error('任务不存在');
    const content = String(task.content || '').trim();
    if (!content) throw new Error('内容为空');
    if (task.contentMode === 'ai') {
      throw new Error('AI 模式尚未启用，请使用 static 文案或等待 AI 功能');
    }
    if (content.length > 280) throw new Error('超过 280 字符限制');
    const result = await this.postNow(content);
    if (result.ok) {
      const now = new Date().toISOString();
      await updatePostConfig((cfg) => {
        const t = cfg.tasks.find((x) => x.id === taskId);
        if (t) {
          t.lastPostAt = now;
          t.postCount = (t.postCount || 0) + 1;
          t.lastResult = 'ok (run-once)';
          t.lastError = null;
          t.updatedAt = now;
        }
      });
    }
    return { ...result, text: content };
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
      postSchedule: (() => {
        const cfg = loadPostConfig();
        const composer = getComposerTask(cfg);
        const rt = this.getPostRuntime(COMPOSER_TASK_ID);
        return {
          enabled: !!(composer?.enabled && this.postTaskTimers.has(COMPOSER_TASK_ID)),
          intervalSeconds: (composer?.intervalMinutes || cfg.autoPostIntervalMinutes || 60) * 60,
          templatePreview: (composer?.content || cfg.templates?.[0] || '').substring(0, 50),
          nextRunAt: rt.nextRunAt,
        };
      })(),
      postTasks: (() => {
        const cfg = loadPostConfig();
        return (cfg.tasks || []).map((t) => {
          const rt = this.getPostRuntime(t.id);
          return {
            id: t.id,
            name: t.name,
            enabled: !!t.enabled,
            intervalMinutes: t.intervalMinutes,
            contentMode: t.contentMode,
            contentPreview: (t.content || '').substring(0, 80),
            phase: t.enabled ? rt.phase : 'idle',
            nextRunAt: rt.nextRunAt,
            lastPostAt: t.lastPostAt,
            lastResult: t.lastResult,
            lastError: t.lastError,
            postCount: t.postCount || 0,
          };
        });
      })(),
      pageQueue: (() => {
        if (this.service['xClient'] instanceof BrowserClient) {
          return (this.service['xClient'] as BrowserClient).getPageQueueStatus();
        }
        return { depth: 0, currentLabel: null };
      })(),
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
