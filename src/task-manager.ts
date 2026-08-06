import { Service } from './service.js';
import { UserRepository } from './user-repository.js';
import { XClient } from './x-client.js';
import { BrowserClient } from './browser-client.js';
import type { XUser, PendingStats } from './types.js';
import { loadPostConfig, savePostConfig, type PostConfig } from './auto-config.js';

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
    this.postTimer = setInterval(async () => {
      if (this.service['xClient'] instanceof BrowserClient) {
        console.log('[Post] 定时发帖...');
        await (this.service['xClient'] as BrowserClient).postTweet(templateText);
      }
    }, intervalMs);

    console.log(`[Post] 定时发帖已启动，间隔 ${intervalMinutes} 分钟`);
  }

  stopPostSchedule(): void {
    if (this.postTimer) {
      clearInterval(this.postTimer);
      this.postTimer = null;
    }
    this.postInterval = 0;
    this.postTemplateText = '';
    console.log('[Post] 定时发帖已停止');
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
      },
      connected: this.connected,
    };
  }
}
