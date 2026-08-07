export interface XUser {
  id: string;
  name: string;
  username: string;
  description?: string;
  createdAt?: string;
  profileImageUrl?: string;
  verified?: boolean;
  verifiedType?: string;
  connectionStatus?: string[];
  publicMetrics?: {
    followersCount: number;
    followingCount: number;
    postCount: number;
    listedCount: number;
  };
}

export interface DBUser {
  id: string;
  username: string;
  name: string;
  description: string | null;
  followers_count: number;
  following_count: number;
  tweet_count: number;
  created_at: Date | null;
  updated_at: Date;
}

export interface SyncState {
  userId: string;
  followersCursor: string | null;
  followingCursor: string | null;
  lastSyncedAt: Date;
}

export interface PaginatedUsers {
  users: XUser[];
  nextToken?: string;
}

export interface FollowResult {
  following: boolean;
  pending: boolean;
}

export interface UnfollowResult {
  following: boolean;
}

export interface SyncResult {
  total: number;
  newCount: number;
}

export interface AutoFollowResult {
  followed: string[];
  alreadyFollowing: number;
}

export interface PendingItem {
  userId: string;
  username: string;
  name: string;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ProcessResult {
  processed: boolean;
  userId?: string;
  status?: string;
}

export interface PendingStats {
  followPending: number;
  followCompleted: number;
  followFailed: number;
  unfollowPending: number;
  unfollowCompleted: number;
  unfollowFailed: number;
}

// ── AI 供应商配置 ──────────────────────────────────────

export type AiProviderType = 'openai-compatible' | 'anthropic';

export interface AiProvider {
  id: string;
  name: string;
  type: AiProviderType;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 对外暴露的供应商信息（脱敏） */
export interface AiProviderSafe {
  id: string;
  name: string;
  type: AiProviderType;
  baseUrl: string;
  defaultModel: string;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiGenerateRequest {
  providerId: string;
  model?: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiGenerateResponse {
  ok: boolean;
  text?: string;
  model?: string;
  error?: string;
}
