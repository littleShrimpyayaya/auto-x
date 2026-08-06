import { Service } from './service.js';
import { UserRepository } from './user-repository.js';
import { XClient } from './x-client.js';
import type { XUser } from './types.js';

export type TaskType = 'sync-followers' | 'sync-following' | 'auto-follow';
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

  async getStatus(): Promise<StatusInfo> {
    let followerCount = 0;
    let followingCount = 0;

    if (this.me) {
      const [f1, f2] = await Promise.all([
        this.repo.getRelationshipIds(this.me.id, 'follower'),
        this.repo.getRelationshipIds(this.me.id, 'following'),
      ]);
      followerCount = f1.length;
      followingCount = f2.length;
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
      connected: this.connected,
    };
  }
}
