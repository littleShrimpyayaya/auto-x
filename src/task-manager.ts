import { Service } from './service.js';
import { UserRepository } from './user-repository.js';
import { XClient } from './x-client.js';
import { BrowserClient } from './browser-client.js';
import type { XUser, PendingStats } from './types.js';
import { loadPostConfig, savePostConfig, saveAutomationConfig, loadAutomationConfig, type PostConfig } from './auto-config.js';

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
  connected: boolean;
}

export class TaskManager {
  private currentController: AbortController | null = null;
  private currentTaskType: TaskType | null = null;
  private taskStatus: TaskStatusType = 'idle';
  private taskMessage = '';
  private taskStartedAt: string | null = null;
  private taskFinishedAt: string | null = null;

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

  async postNow(text: string): Promise<{ ok: boolean }> {
    if (this.service['xClient'] instanceof BrowserClient) {
      return (this.service['xClient'] as BrowserClient).postTweet(text);
    }
    // X API 模式暂不支持发帖
    return { ok: false };
  }

  startPostSchedule(intervalMinutes: number, templateText: string): void {
    this.stopPostSchedule();
    this.postInterval = intervalMinutes;
    this.postTemplateText = templateText;

    const intervalMs = intervalMinutes * 60 * 1000;
    this.postNextRunAt = new Date(Date.now() + intervalMs).toISOString();

    this.postTimer = setInterval(async () => {
      if (this.service['xClient'] instanceof BrowserClient) {
        console.log('[Post] 定时发帖...');
        try {
          await (this.service['xClient'] as BrowserClient).postTweet(templateText);
        } catch (err) {
          console.error('[Post] 定时发帖失败:', err);
        }
      }
      this.postNextRunAt = new Date(Date.now() + intervalMs).toISOString();
    }, intervalMs);

    console.log(`[Post] 定时发帖已启动，间隔 ${intervalMinutes} 分钟，下次 ${this.postNextRunAt}`);
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

  /** 进程启动时按已保存配置恢复定时（不立刻发，只等周期） */
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
    this.startPostSchedule(interval, text);
    console.log(`[Post] 已从配置恢复自动发推，每 ${interval} 分钟`);
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

  async batchFollow(targetUserIds: string[]): Promise<{ done: number; failed: number }> {
    return this.service.batchFollow(this.userId, targetUserIds);
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
      connected: this.connected,
    };
  }
}
