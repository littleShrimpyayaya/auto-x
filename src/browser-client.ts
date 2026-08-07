import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { XUser, PaginatedUsers, FollowResult, UnfollowResult } from './types.js';
import {
  loadAutomationConfig,
  actionInterval,
  type AutomationConfig,
} from './auto-config.js';

chromium.use(StealthPlugin());

const USER_PROFILE_DIR = 'data/browser-profile';

/** GraphQL 用户摘要：含关注关系与头像 */
interface GqlUserInfo {
  id: string;
  username: string;
  name: string;
  profileImageUrl?: string;
  /** 我是否已关注对方 */
  following?: boolean;
  /** 对方是否关注我 */
  followedBy?: boolean;
}

// 从 GraphQL 响应中提取用户数据（类似旧插件 injector.js 的逻辑）
function extractGraphQLUsers(json: any): GqlUserInfo[] {
  const users: GqlUserInfo[] = [];
  const seen = new Set<string>();

  function pushUser(result: any) {
    if (!result || typeof result !== 'object') return;
    // 解包嵌套
    if (result.result?.rest_id) result = result.result;
    if (result.user_results?.result) result = result.user_results.result;

    const restId = result.rest_id || result.id_str || result.id;
    const legacy = result.legacy || {};
    const screenName = legacy.screen_name || result.screen_name || result.username;

    if (!restId || !screenName) return;
    const id = String(restId);
    if (seen.has(id)) return;
    seen.add(id);

    const rel = result.relationship_perspectives || result.relationshipPerspectives || {};
    const following =
      typeof rel.following === 'boolean'
        ? rel.following
        : typeof legacy.following === 'boolean'
          ? legacy.following
          : undefined;
    const followedBy =
      typeof rel.followed_by === 'boolean'
        ? rel.followed_by
        : typeof legacy.followed_by === 'boolean'
          ? legacy.followed_by
          : undefined;

    const profileImageUrl =
      legacy.profile_image_url_https ||
      legacy.profile_image_url ||
      result.avatar?.image_url ||
      result.profile_image_url_https ||
      undefined;

    users.push({
      id,
      username: screenName,
      name: legacy.name || result.name || screenName,
      profileImageUrl: profileImageUrl
        ? String(profileImageUrl).replace('_normal', '_400x400')
        : undefined,
      following,
      followedBy,
    });
  }

  function walk(obj: any, depth: number) {
    if (!obj || depth > 15) return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    if (typeof obj !== 'object') return;

    if (obj.__typename === 'User' || (obj.rest_id && obj.legacy)) {
      pushUser(obj);
    }

    // 遍历 timeline instructions 中的 entries
    const instructions =
      obj?.data?.user?.result?.timeline?.timeline?.instructions ||
      obj?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
      [];

    for (const instr of instructions) {
      for (const entry of instr.entries || []) {
        const r =
          entry.content?.itemContent?.user_results?.result ||
          entry.content?.itemContent?.user?.result ||
          entry.itemContent?.user_results?.result;
        if (r) pushUser(r);
      }
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  }

  walk(json, 0);
  return users;
}

/** 待回关用户（粉丝列表中带 Follow/回关 按钮） */
export interface FollowBackCandidate {
  userId: string;
  username: string;
  name: string;
  profileImageUrl?: string;
}

export class BrowserClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private myUsername: string | null = null;
  private myId: string | null = null;
  private usernameCache = new Map<string, string>(); // userId → username
  private idCache = new Map<string, string>();       // username → userId
  private config: AutomationConfig;
  private ready = false;

  /** Browser-wide page mutex: outermost public entries only (non-reentrant). */
  private pageOpActive = false;
  private pageOpLabel: string | null = null;
  private pageOpChain: Promise<void> = Promise.resolve();
  private pageOpDepth = 0;

  constructor(config?: AutomationConfig) {
    this.config = config ?? loadAutomationConfig();
  }

  getPageQueueStatus(): { depth: number; currentLabel: string | null } {
    return { depth: this.pageOpDepth, currentLabel: this.pageOpLabel };
  }

  /**
   * Serialize all Playwright page mutations.
   * Outermost public API only — nested pageOp throws (helpers must use bare page).
   * @param priority if true, still waits for in-flight op but is preferred for labeling; true force posts use this.
   */
  async pageOp<T>(label: string, fn: () => Promise<T>, _opts?: { priority?: boolean }): Promise<T> {
    if (this.pageOpActive) {
      const msg = `pageOp re-entrancy: tried "${label}" while "${this.pageOpLabel}" active`;
      console.error(`[BrowserClient] ${msg}`);
      throw new Error(msg);
    }

    // Simple FIFO queue (priority: jump label only — true preemption of in-flight is forbidden)
    const run = async () => {
      this.pageOpActive = true;
      this.pageOpLabel = label;
      this.pageOpDepth = 1;
      try {
        return await fn();
      } finally {
        this.pageOpActive = false;
        this.pageOpLabel = null;
        this.pageOpDepth = 0;
      }
    };

    // Chain promises; optional priority inserts... for v1 keep FIFO to avoid starvation complexity
    let release!: () => void;
    const prev = this.pageOpChain;
    this.pageOpChain = new Promise<void>((r) => {
      release = r;
    });
    this.pageOpDepth = Math.max(this.pageOpDepth, 1);
    await prev;
    try {
      return await run();
    } finally {
      release();
    }
  }

  /** 从磁盘重新加载自动化配置（操作间隔等），前端保存后立即生效 */
  reloadConfig(): void {
    const fresh = loadAutomationConfig();
    this.config = {
      ...this.config,
      ...fresh,
      // 保留当前会话 cookie（可能刚 reconnect 写入内存，尚未落盘时仍以内存为准）
      authToken: this.config.authToken || fresh.authToken,
      ct0: this.config.ct0 || fresh.ct0,
    };
    console.log(
      `[BrowserClient] 配置已刷新: 操作间隔 ${this.config.actionIntervalMinSeconds}~${this.config.actionIntervalMaxSeconds}s`,
    );
  }

  // ── 生命周期 ──────────────────────────────────────────

  async init(): Promise<void> {
    if (this.ready) return;

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    // 注入 auth cookies
    if (this.config.authToken) {
      await this.context.addCookies([
        {
          name: 'auth_token',
          value: this.config.authToken,
          domain: '.x.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None' as const,
        },
      ]);
    }
    if (this.config.ct0) {
      await this.context.addCookies([
        {
          name: 'ct0',
          value: this.config.ct0,
          domain: '.x.com',
          path: '/',
          secure: true,
          sameSite: 'None' as const,
        },
      ]);
    }

    this.page = await this.context.newPage();

    // 验证登录状态
    if (this.config.authToken) {
      await this.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(2000);

      const loggedIn = await this.page.evaluate(() => {
        return !!(
          document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
          document.querySelector('a[data-testid="AppTabBar_Profile_Link"]') ||
          document.querySelector('[data-testid="primaryColumn"]')
        );
      });

      if (!loggedIn) {
        console.warn('[BrowserClient] Cookie 登录可能已失效，请更新 auth_token');
      }
    }

    this.ready = true;
    console.log('[BrowserClient] 浏览器已启动');
  }

  async reconnect(authToken: string, ct0: string): Promise<void> {
    this.config.authToken = authToken;
    this.config.ct0 = ct0;

    // 关闭现有浏览器
    await this.close();

    // 重新初始化
    await this.init();
  }

  async close(): Promise<void> {
    if (this.page) { await this.page.close().catch(() => {}); this.page = null; }
    if (this.context) { await this.context.close().catch(() => {}); this.context = null; }
    if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
    this.ready = false;
  }

  private ensureReady(): void {
    if (!this.ready || !this.page) throw new Error('BrowserClient 未初始化，请先设置 auth_token');
  }

  // ── 我的信息 ─────────────────────────────────────────

  async getMyUser(): Promise<XUser> {
    this.ensureReady();

    // 先获取自己的用户名
    await this.page!.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(2000);

    const profileInfo = await this.page!.evaluate(() => {
      const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (link) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/\/([^/]+)$/);
        return { username: m ? m[1] : null };
      }
      // 备用：从侧边栏切换按钮获取
      const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (btn) {
        const label = btn.getAttribute('aria-label') || btn.textContent || '';
        const m = label.match(/@(\w+)/);
        return { username: m ? m[1] : null };
      }
      return { username: null };
    });

    if (!profileInfo.username) throw new Error('无法获取当前登录用户');

    this.myUsername = profileInfo.username;

    // 访问自己的 profile 页面获取详细信息
    await this.page!.goto(`https://x.com/${this.myUsername}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(2000);

    const userData = await this.page!.evaluate((username) => {
      // 从页面中提取公开指标
      const metrics: Record<string, number> = {
        followersCount: 0,
        followingCount: 0,
        postCount: 0,
      };

      // 找 followers/following/posts 链接中的数字
      const links = document.querySelectorAll('a[href*="/verified_followers"], a[href$="/followers"], a[href$="/following"]');
      links.forEach((a) => {
        const href = a.getAttribute('href') || '';
        const text = a.textContent || '';
        const numStr = (text.match(/[\d,]+/) || ['0'])[0].replace(/,/g, '');
        const num = parseInt(numStr, 10) || 0;
        if (href.includes('followers') || href.includes('verified_followers')) {
          metrics.followersCount = Math.max(metrics.followersCount, num);
        } else if (href.includes('following')) {
          metrics.followingCount = Math.max(metrics.followingCount, num);
        }
      });

      // Posts 数字：X 主页导航中有 "Posts" 标签带数字
      const navLinks = document.querySelectorAll('a[role="tab"]');
      navLinks.forEach((a) => {
        const href = a.getAttribute('href') || '';
        const text = a.textContent || '';
        const numStr = (text.match(/[\d,]+/) || ['0'])[0].replace(/,/g, '');
        const num = parseInt(numStr, 10) || 0;
        if ((href.endsWith('/posts') || href.includes('/posts?')) && num > 0) {
          metrics.postCount = Math.max(metrics.postCount, num);
        }
      });

      // 备用：从页面任意包含 "post" 或 "tweet" 计数的元素获取
      if (metrics.postCount === 0) {
        const allLinks = document.querySelectorAll('a[href]');
        for (const a of allLinks) {
          const href = a.getAttribute('href') || '';
          if (href.match(/\/(with_replies|posts|media|likes)$/)) {
            const text = a.textContent || '';
            const numStr = (text.match(/[\d,]+/) || ['0'])[0].replace(/,/g, '');
            const num = parseInt(numStr, 10) || 0;
            if (num > 0) {
              metrics.postCount = Math.max(metrics.postCount, num);
              break;
            }
          }
        }
      }

      // 获取名称和描述
      const nameEl = document.querySelector('[data-testid="UserName"]');
      const name = nameEl?.querySelector('span')?.textContent?.trim() || username;
      const descEl = document.querySelector('[data-testid="UserDescription"]');
      const description = descEl?.textContent?.trim() || undefined;

      // 头像（多级 fallback 适配 X.com 可能变化的 DOM）
      let profileImageUrl: string | undefined;
      const avatarSelectors = [
        'img[src*="profile_images"]',
        'a[href*="photo"] img[src*="twimg"]',
        'img[src*="twimg.com"][src*="profile"]',
        'div[data-testid="primaryColumn"] img[src*="twimg"]',
        'a[href*="/photo"] img',
        'img[alt*="profile" i]',
        'img[src*="twimg.com"][alt=""]',
      ];
      for (const sel of avatarSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const src = el.getAttribute('src') || '';
          if (src && !src.includes('default_profile') && !src.includes('tweet_video_thumb')) {
            profileImageUrl = src;
            break;
          }
        }
      }
      // 如果还没找到，遍历所有图片找最可能是头像的（最大的那张）
      if (!profileImageUrl) {
        const imgs = document.querySelectorAll('img[src*="twimg"]');
        let bestSrc = '';
        let bestSize = 0;
        for (const img of imgs) {
          const src = img.getAttribute('src') || '';
          const w = (img as HTMLImageElement).naturalWidth || img.clientWidth || 0;
          // 头像通常是圆形的小图片（48-200px），不是 banner
          if (src.includes('twimg') && w >= 48 && w <= 400 && !src.includes('default')) {
            if (w > bestSize) { bestSize = w; bestSrc = src; }
          }
        }
        if (bestSrc) profileImageUrl = bestSrc;
      }

      // 验证
      const verified = !!document.querySelector('[data-testid="icon-verified"]');

      return { name, description, profileImageUrl, verified, metrics };
    }, this.myUsername);

    // 尝试从页面获取 user ID（多种 fallback）
    let userId = await this.page!.evaluate(() => {
      // 方式 1：从页面 JSON 数据中提取
      const scripts = document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || '');
          const walk = (obj: any, depth: number): string | null => {
            if (!obj || depth > 12) return null;
            if (typeof obj !== 'object') return null;
            if (obj.rest_id && obj.legacy?.screen_name) return String(obj.rest_id);
            if (obj.id_str && obj.screen_name) return String(obj.id_str);
            if (Array.isArray(obj)) {
              for (const item of obj) { const r = walk(item, depth + 1); if (r) return r; }
            } else {
              for (const v of Object.values(obj)) { const r = walk(v, depth + 1); if (r) return r; }
            }
            return null;
          };
          const found = walk(data, 0);
          if (found) return found;
        } catch { /* continue */ }
      }
      return null;
    });

    // 方式 2：如果上面没找到，通过 API 获取
    if (!userId) {
      try {
        const apiResult = await this.page!.evaluate(async () => {
          try {
            const res = await fetch('https://x.com/i/api/1.1/account/verify_credentials.json', {
              credentials: 'include',
            });
            if (res.ok) {
              const json = await res.json();
              return json.id_str || String(json.id);
            }
          } catch { /* ignore */ }
          return null;
        });
        userId = apiResult;
      } catch { /* ignore */ }
    }

    // 方式 3：从 DOM 中的任意 user ID 链接提取
    if (!userId) {
      userId = await this.page!.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/status/"]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          // 不太可靠，跳过
        }
        // 尝试从 window 全局中获取
        const win = window as any;
        if (win.__META_DATA__?.user_id) return String(win.__META_DATA__?.user_id);
        return null;
      });
    }

    if (userId) {
      this.myId = userId;
      this.idCache.set(this.myUsername, userId);
      this.usernameCache.set(userId, this.myUsername);
    }

    return {
      id: userId || '0',
      name: userData.name,
      username: this.myUsername,
      description: userData.description,
      profileImageUrl: userData.profileImageUrl,
      verified: userData.verified,
      publicMetrics: {
        followersCount: userData.metrics.followersCount,
        followingCount: userData.metrics.followingCount,
        postCount: userData.metrics.postCount,
        listedCount: 0,
      },
    };
  }

  // ── 扫描待回关用户 ──────────────────────────────────

  /**
   * 扫描「我的关注者」页面，只收集带「回关 / Follow / Follow back」按钮的用户。
   * 已关注（Following / 正在关注）的粉丝不计入待回关。
   */
  async scanFollowBack(): Promise<FollowBackCandidate[]> {
    return this.pageOp('scan-follow-back', () => this.scanFollowBackImpl());
  }

  private async scanFollowBackImpl(): Promise<FollowBackCandidate[]> {
    this.ensureReady();
    const username = this.myUsername;
    if (!username) throw new Error('未登录');

    const url = `https://x.com/${username}/followers`;
    console.log(`[BrowserClient] 扫描待回关: ${url}`);

    // GraphQL：补全 userId / 头像 / following 状态
    const gqlByUsername = new Map<string, GqlUserInfo>();
    const onResponse = async (response: any) => {
      const reqUrl = response.url();
      if (!reqUrl.includes('/graphql/')) return;
      try {
        const json = await response.json();
        for (const u of extractGraphQLUsers(json)) {
          if (u.id && u.username) {
            gqlByUsername.set(u.username.toLowerCase(), u);
            this.usernameCache.set(u.id, u.username);
            this.idCache.set(u.username, u.id);
          }
        }
      } catch { /* ignore */ }
    };
    this.page!.on('response', onResponse);

    await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(2000);

    try {
      await this.page!.waitForSelector('[data-testid="UserCell"]', { timeout: 8000 });
    } catch {
      this.page!.off('response', onResponse);
      console.warn('[BrowserClient] 粉丝列表未加载');
      return [];
    }

    const needFollow: FollowBackCandidate[] = [];
    const needFollowKeys = new Set<string>(); // username lowercased
    const seenAllUsers = new Set<string>();   // 页面上见过的所有粉丝（含已关注）
    const skippedLogged = new Set<string>();  // 跳过原因只打一次，避免滚动刷屏
    let prevSeenAll = 0;
    let noNewCount = 0;
    const MAX_SCROLLS = 800;
    const MAX_NO_NEW = 6;

    const logSkipOnce = (username: string, reason: string) => {
      const k = username.toLowerCase() + '|' + reason;
      if (skippedLogged.has(k)) return;
      skippedLogged.add(k);
      // 推荐区噪声大且无诊断价值，默认不打日志
      if (reason === 'suggested') return;
      console.log(`[BrowserClient] ⏭ 跳过 @${username} — ${reason}`);
    };

    for (let i = 0; i < MAX_SCROLLS; i++) {
      // 扫描当前视口：只收「需要回关」的 UserCell，同时统计所有出现过的粉丝
      const batch = await this.page!.evaluate(() => {
        const SKIP = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose']);

        /** 从各种 DOM 属性中提取用户数字 ID */
        function extractUserId(cell: Element, btn: Element): string {
          // 方式 1: 按钮 data-testid 如 "123456-follow"
          const testId = ((btn as HTMLElement).getAttribute('data-testid') || '');
          let m = testId.match(/^(\d+)-/);
          if (m) return m[1];
          m = testId.match(/-(\d+)$/);
          if (m) return m[1];

          // 方式 2: 按钮 aria-label 如 "Follow @username"（需要从缓存反查，这里只做提取标记）
          const aria = (btn as HTMLElement).getAttribute('aria-label') || '';
          // aria 里通常是 @username，不是数字 ID，跳过

          // 方式 3: 从 UserCell 中所有链接的 data-user-id 获取
          const links = cell.querySelectorAll('a[href]');
          for (const link of links) {
            const dataId = (link as HTMLElement).getAttribute('data-user-id');
            if (dataId && /^\d+$/.test(dataId)) return dataId;
          }

          // 方式 4: 从链接 href 中提取（某些场景下 link 有 /intent/user?user_id=123 之类）
          // X.com 粉丝页面不带 user_id，但留作备选

          return '';
        }

        /** 从 UserCell 中提取显示名（非 @username 的文字，且看起来像是人名） */
        function extractName(cell: Element, username: string): string {
          // 策略：遍历 cell 中所有 span/div 文本，找不等于 @username 且不是按钮文本的
          const allTextNodes = cell.querySelectorAll('span');
          const candidates: string[] = [];

          for (const span of allTextNodes) {
            const t = (span.textContent || '').trim();
            // 排除空文本、@username、按钮文本、过长的文本（可能是 bio）
            if (!t || t.startsWith('@') || t === username) continue;
            if (t.length > 100) continue;
            // 排除明显的按钮文本
            const lower = t.toLowerCase();
            if (['follow', 'following', 'pending', 'unfollow', '关注', '正在关注', '取消关注', '回关', '已请求'].includes(lower)) continue;

            // 排除纯数字/纯符号
            if (/^[\d,.\s]+$/.test(t)) continue;

            // 如果此 span 的父级是按钮，跳过
            const parent = span.closest('button, [role="button"]');
            if (parent) continue;

            // 同一段文字可能出现在多个嵌套 span 中，选最长的
            const existing = candidates.find(c => t.includes(c) || c.includes(t));
            if (existing) {
              if (t.length > existing.length) {
                candidates[candidates.indexOf(existing)] = t;
              }
            } else {
              candidates.push(t);
            }
          }

          // 优先返回最短的可能人名（名字通常 1-50 字符，bio/描述更长）
          // 排除太长的（很可能不是名字）
          const names = candidates.filter(c => c.length <= 50);
          if (names.length > 0) {
            // 返回最长的（通常名字比单个词更有可能是显示名）
            return names.reduce((a, b) => a.length >= b.length ? a : b);
          }

          return '';
        }

        /**
         * 按钮分类：
         * - follow_back: 「回关 / Follow back」—— 明确是粉丝待回关
         * - follow:      「关注 / Follow」—— 粉丝页也可能出现，但推荐区更常见，需二次确认
         * - none:        已关注 / 无关按钮
         */
        function classifyFollowButton(btn: Element): 'follow_back' | 'follow' | 'none' {
          const rawText = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          const text = rawText.toLowerCase();
          const aria = ((btn as HTMLElement).getAttribute('aria-label') || '').toLowerCase();
          const testId = ((btn as HTMLElement).getAttribute('data-testid') || '').toLowerCase();
          const spanText = (btn.querySelector('span')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

          // 已关注 / 请求中 / 取关
          if (
            text === 'following' ||
            text === 'pending' ||
            text === 'unfollow' ||
            text === '正在关注' ||
            text === '已请求' ||
            text === '取消关注' ||
            spanText === 'following' ||
            spanText === '正在关注' ||
            testId.includes('unfollow') ||
            aria.includes('following @') ||
            aria.includes('unfollow @') ||
            aria.includes('正在关注')
          ) {
            return 'none';
          }

          // 明确「回关」
          if (
            text === 'follow back' ||
            text === '回关' ||
            spanText === 'follow back' ||
            spanText === '回关' ||
            /^follow\s+back\s+@/.test(aria) ||
            aria.startsWith('回关')
          ) {
            return 'follow_back';
          }

          // 普通「关注 / Follow」（可能是推荐）
          if (
            text === 'follow' ||
            text === '关注' ||
            spanText === 'follow' ||
            spanText === '关注' ||
            /^follow\s+@/.test(aria) ||
            aria.startsWith('关注') ||
            /-follow$/.test(testId)
          ) {
            return 'follow';
          }

          return 'none';
        }

        /** 是否落在「推荐关注 / Who to follow」等非粉丝列表区域 */
        function isInSuggestedSection(cell: Element): boolean {
          // 向上找标题文案
          let el: Element | null = cell;
          for (let d = 0; d < 12 && el; d++, el = el.parentElement) {
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            if (
              aria.includes('who to follow') ||
              aria.includes('suggested') ||
              aria.includes('推荐') ||
              aria.includes('你可能喜欢')
            ) {
              return true;
            }
          }
          // 附近的 section 标题
          const section = cell.closest('section') || cell.closest('[role="region"]');
          if (section) {
            const heading = (section.querySelector('h1, h2, span')?.textContent || '').toLowerCase();
            if (
              heading.includes('who to follow') ||
              heading.includes('suggested') ||
              heading.includes('推荐关注') ||
              heading.includes('你可能喜欢') ||
              heading.includes('to follow')
            ) {
              return true;
            }
          }
          return false;
        }

        type CellResult = {
          username: string;
          name: string;
          profileImageUrl?: string;
          needsFollowBack: boolean;
          buttonKind: 'follow_back' | 'follow' | 'none';
          buttonHint: string;
          userId: string;
          suggested: boolean;
        };

        const results: CellResult[] = [];
        const cells = document.querySelectorAll('[data-testid="UserCell"]');

        for (const cell of cells) {
          // 提取 username：遍历所有 role="link" 的 a 标签
          let username = '';
          const links = cell.querySelectorAll('a[role="link"]');
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            const m = href.match(/^\/([A-Za-z0-9_]+)$/);
            if (!m || SKIP.has(m[1].toLowerCase())) continue;
            username = m[1];
            break;
          }
          if (!username) continue;

          // 提取显示名（不再只从第一个 link 取，而是扫描整个 cell）
          const name = extractName(cell, username);

          // 头像
          const img =
            cell.querySelector('img[src*="profile_images"]') ||
            cell.querySelector('img[src*="twimg.com"]');
          const profileImageUrl = img?.getAttribute('src') || undefined;

          const suggested = isInSuggestedSection(cell);

          // 找关注相关按钮，同时提取用户 ID
          const allBtns = cell.querySelectorAll('button, [role="button"], [data-testid*="follow"]');
          let buttonKind: 'follow_back' | 'follow' | 'none' = 'none';
          let buttonHint = '';
          let domUserId = '';
          for (const btn of allBtns) {
            const t = ((btn.textContent || '').replace(/\s+/g, ' ').trim());
            const a = (btn as HTMLElement).getAttribute('aria-label') || '';
            const d = (btn as HTMLElement).getAttribute('data-testid') || '';
            if (t || a || d.includes('follow')) {
              buttonHint = `text="${t}" aria="${a}" testid="${d}"`;
            }
            if (!domUserId) {
              domUserId = extractUserId(cell, btn);
            }
            const kind = classifyFollowButton(btn);
            if (kind !== 'none') {
              buttonKind = kind;
              // 优先记回关按钮
              if (kind === 'follow_back') break;
            }
          }

          // 备用：尝试从链接的 data-user-id 获取
          if (!domUserId) {
            const userLink = cell.querySelector(`a[href="/${username}"]`);
            if (userLink) {
              domUserId = (userLink as HTMLElement).getAttribute('data-user-id') || '';
            }
          }

          // 初步：明确回关 / 普通关注都先标 needs，后面用 GraphQL + suggested 再滤
          const needsFollowBack = buttonKind === 'follow_back' || buttonKind === 'follow';

          results.push({
            username,
            name: name || username,
            profileImageUrl,
            needsFollowBack,
            buttonKind,
            buttonHint,
            userId: domUserId,
            suggested,
          });
        }
        return results;
      });

      for (const user of batch) {
        const key = user.username.toLowerCase();
        seenAllUsers.add(key);

        if (!user.needsFollowBack) continue;
        if (needFollowKeys.has(key)) continue;

        const gql = gqlByUsername.get(key);
        // GraphQL 若明确说已经 following，以 GraphQL 为准跳过（避免误检）
        if (gql?.following === true) {
          logSkipOnce(user.username, 'GraphQL 显示已关注 (following=true)');
          continue;
        }

        // 推荐区直接跳过（不打日志，侧栏常驻会每轮滚动刷屏）
        if (user.suggested) {
          logSkipOnce(user.username, 'suggested');
          continue;
        }

        // 按钮策略：
        // - 「回关 / Follow back」：收入（对方已关注你）
        // - 「关注 / Follow」：仅当 GraphQL 确认 followedBy===true 才收入
        if (user.buttonKind === 'follow') {
          if (gql?.followedBy !== true) {
            logSkipOnce(
              user.username,
              `按钮是「关注/Follow」且无 followedBy 证据 (gql=${gql?.followedBy ?? 'n/a'})`,
            );
            continue;
          }
        } else if (user.buttonKind === 'follow_back') {
          if (gql?.followedBy === false) {
            logSkipOnce(user.username, '回关按钮但 GraphQL followedBy=false');
            continue;
          }
        } else {
          continue;
        }

        needFollowKeys.add(key);

        // ID 优先级：GraphQL → idCache → DOM 提取 → '0'
        const userIdSource = gql?.id ? 'gql' : this.idCache.get(user.username) ? 'cache' : user.userId ? 'dom' : 'none';
        const userId = gql?.id || this.idCache.get(user.username) || user.userId || '0';
        const profileImageUrl =
          user.profileImageUrl ||
          gql?.profileImageUrl ||
          undefined;

        // 关键缓存，后续 batch-follow 必须用 username 打开主页
        if (userId && userId !== '0') {
          this.usernameCache.set(userId, user.username);
          this.idCache.set(user.username, userId);
        }

        console.log(
          `[BrowserClient] ✅ @${user.username}  name="${user.name}"  userId=${userId}(${userIdSource})  ` +
          `kind=${user.buttonKind}  btn=${user.buttonHint}  img=${profileImageUrl ? 'yes' : 'no'}`,
        );

        needFollow.push({
          userId,
          username: user.username,
          name: gql?.name || user.name,
          profileImageUrl,
        });
      }

      // 终止条件：连续多轮没有新的「粉丝」出现（不是没有新待回关）
      if (seenAllUsers.size <= prevSeenAll) {
        noNewCount++;
        if (noNewCount >= MAX_NO_NEW) {
          console.log(`[BrowserClient] 粉丝列表滚动结束（连续 ${MAX_NO_NEW} 轮无新用户）`);
          break;
        }
      } else {
        noNewCount = 0;
      }
      prevSeenAll = seenAllUsers.size;

      // 滚动加载更多粉丝（减少等待加速扫描）
      for (let r = 0; r < 2; r++) {
        await this.scrollUserList();
        await this.page!.waitForTimeout(150);
      }
      await this.page!.waitForTimeout(300 + Math.random() * 200);

      if (i === 0) {
        const sample = batch.slice(0, 5).map((u) =>
          `@${u.username} need=${u.needsFollowBack} ${u.buttonHint}`
        ).join(' | ');
        console.log(`[BrowserClient] 首屏按钮样例: ${sample}`);
      }

      if (i % 10 === 0) {
        console.log(
          `[BrowserClient] 扫描进度: ${needFollow.length} 个待回关 / 已查看 ${seenAllUsers.size} 个粉丝`,
        );
      }
    }

    this.page!.off('response', onResponse);

    // 对仍缺 userId 的，依次尝试：GraphQL 缓存 → idCache → profile 页面抓取
    for (const u of needFollow) {
      if (u.userId !== '0') continue;

      // 1. GraphQL 缓存
      const gql = gqlByUsername.get(u.username.toLowerCase());
      if (gql?.id) {
        u.userId = gql.id;
        if (!u.profileImageUrl && gql.profileImageUrl) u.profileImageUrl = gql.profileImageUrl;
        if (gql.name) u.name = gql.name;
        continue;
      }

      // 2. idCache（扫描过程中由 onResponse 或之前操作填充）
      const cachedId = this.idCache.get(u.username);
      if (cachedId && /^\d+$/.test(cachedId)) {
        u.userId = cachedId;
      }
    }

    // 统计仍缺 ID 的数量
    const missingId = needFollow.filter(u => u.userId === '0').length;
    if (missingId > 0) {
      console.warn(`[BrowserClient] ⚠ ${missingId}/${needFollow.length} 个待回关缺少数字 userId，将无法写入待处理队列`);
    }

    console.log(
      `[BrowserClient] 扫描完成: ${needFollow.length} 个待回关（共查看 ${seenAllUsers.size} 个粉丝）`,
    );
    return needFollow;
  }

  // ── 分页获取粉丝/关注 ────────────────────────────────

  async getFollowers(userId: string, opts?: { maxResults?: number; paginationToken?: string }): Promise<PaginatedUsers> {
    // 对于浏览器方案，我们使用 iterateFollowers 而不是分页
    const users: XUser[] = [];
    let count = 0;
    const max = opts?.maxResults ?? 100;
    for await (const u of this.iterateFollowers(userId)) {
      users.push(u);
      count++;
      if (count >= max) break;
    }
    return { users };
  }

  async getFollowing(userId: string, opts?: { maxResults?: number; paginationToken?: string }): Promise<PaginatedUsers> {
    const users: XUser[] = [];
    let count = 0;
    const max = opts?.maxResults ?? 100;
    for await (const u of this.iterateFollowing(userId)) {
      users.push(u);
      count++;
      if (count >= max) break;
    }
    return { users };
  }

  // ── 迭代器（核心）─────────────────────────────────────

  async *iterateFollowers(userId: string): AsyncGenerator<XUser> {
    this.ensureReady();
    const username = this.resolveUsername(userId);
    yield* this.walkList(username, 'followers');
  }

  async *iterateFollowing(userId: string): AsyncGenerator<XUser> {
    this.ensureReady();
    const username = this.resolveUsername(userId);
    yield* this.walkList(username, 'following');
  }

  private async *walkList(username: string, type: 'followers' | 'following'): AsyncGenerator<XUser> {
    const url = `https://x.com/${username}/${type}`;
    console.log(`[BrowserClient] 开始遍历 ${type}: ${url}`);

    // 网络拦截：捕获 GraphQL 响应获取完整用户数据（含 ID）
    const graphqlUsers = new Map<string, { id: string; username: string; name: string }>();
    const onResponse = async (response: any) => {
      const reqUrl = response.url();
      if (!reqUrl.includes('/graphql/')) return;
      try {
        const json = await response.json();
        const extracted = extractGraphQLUsers(json);
        for (const u of extracted) {
          if (u.id && u.username) {
            graphqlUsers.set(u.username, u);
            graphqlUsers.set(u.id, u);
          }
        }
      } catch { /* ignore non-JSON */ }
    };
    this.page!.on('response', onResponse);

    await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(3000);

    // 等待用户列表渲染
    try {
      await this.page!.waitForSelector('[data-testid="UserCell"]', { timeout: 10000 });
    } catch {
      console.warn(`[BrowserClient] ${type} 页面未找到用户列表`);
      this.page!.off('response', onResponse);
      return;
    }

    const seen = new Set<string>();
    let prevCount = 0;
    let noNewCount = 0;
    const MAX_SCROLLS = 800;
    const MAX_NO_NEW = 8;

    for (let i = 0; i < MAX_SCROLLS; i++) {
      const batch = await this.extractUsersFromPage(type);

      for (const user of batch) {
        // 用 GraphQL 数据补充 ID
        const gql = graphqlUsers.get(user.username) || graphqlUsers.get(user.id);
        if (gql && user.id === '0') {
          user.id = gql.id;
        }

        const key = user.id !== '0' ? user.id : user.username;
        if (!seen.has(key)) {
          seen.add(key);
          if (user.id !== '0' && user.username) {
            this.usernameCache.set(user.id, user.username);
            this.idCache.set(user.username, user.id);
          }
          yield user;
        }
      }

      if (batch.length === 0 || seen.size <= prevCount) {
        noNewCount++;
        if (noNewCount >= MAX_NO_NEW) {
          console.log(`[BrowserClient] ${type} 遍历完成，共 ${seen.size} 个用户`);
          break;
        }
      } else {
        noNewCount = 0;
      }
      prevCount = seen.size;

      // 多次滚动 + 等待，确保 X 懒加载触发
      for (let r = 0; r < 4; r++) {
        await this.scrollUserList();
        await this.page!.waitForTimeout(200);
      }
      await this.page!.waitForTimeout(800 + Math.random() * 500);

      if (i % 10 === 0) {
        console.log(`[BrowserClient] ${type} 进度: ${seen.size} 个用户`);
      }
    }

    this.page!.off('response', onResponse);
  }

  private async extractUsersFromPage(type: 'followers' | 'following'): Promise<XUser[]> {
    if (!this.page) return [];

    return await this.page.evaluate((listType) => {
      const users: any[] = [];
      const cells = document.querySelectorAll('[data-testid="UserCell"]');

      for (const cell of cells) {
        try {
          // 提取链接和用户名
          const links = cell.querySelectorAll('a[role="link"]');
          let username = '';
          let name = '';
          let href = '';

          for (const link of links) {
            href = link.getAttribute('href') || '';
            const m = href.match(/^\/(\w+)$/);
            if (m && !['home', 'explore', 'notifications', 'messages', 'i'].includes(m[1])) {
              // 提取名称和用户名
              const spans = link.querySelectorAll('span');
              for (const span of spans) {
                const text = span.textContent?.trim() || '';
                if (text.startsWith('@')) {
                  username = text.substring(1);
                } else if (text && !text.startsWith('@') && text.length < 100) {
                  // 可能是显示名称（取第一个非空非@的 span）
                  if (!name) name = text;
                }
              }
              if (username) break;
            }
          }

          if (!username) continue;

          // 检测 connection_status
          const connectionStatus: string[] = [];
          if (listType === 'followers') {
            connectionStatus.push('followed_by');
          } else {
            connectionStatus.push('following');
          }

          // 对于 followers 列表：检查是否已关注（Following / 正在关注）
          // 对于 following 列表：检查对方是否关注你（Follows you / 关注了你）
          const btns = cell.querySelectorAll('[role="button"], button, [data-testid*="follow"]');
          let isFollowingThem = false;
          for (const btn of btns) {
            const t = ((btn.textContent || '').replace(/\s+/g, ' ').trim()).toLowerCase();
            const d = ((btn as HTMLElement).getAttribute('data-testid') || '').toLowerCase();
            if (t === 'following' || t === '正在关注' || d.includes('unfollow')) {
              isFollowingThem = true;
              break;
            }
          }
          const cellText = (cell.textContent || '').toLowerCase();

          if (listType === 'followers' && isFollowingThem) {
            connectionStatus.push('following');
          }
          if (
            listType === 'following' &&
            (cellText.includes('follows you') || cellText.includes('关注了你'))
          ) {
            connectionStatus.push('followed_by');
          }

          // 头像
          const img =
            cell.querySelector('img[src*="profile_images"]') ||
            cell.querySelector('img[src*="twimg.com"]');
          const profileImageUrl = img?.getAttribute('src') || undefined;

          // 尝试从 data 属性获取 user ID
          let id = '0';
          const userLink = cell.querySelector(`a[href="/${username}"]`);
          if (userLink) {
            const dataId = userLink.getAttribute('data-user-id') ||
              (userLink as any).dataset?.userId;
            if (dataId) id = dataId;
          }

          users.push({
            id,
            username,
            name: name || username,
            connectionStatus,
            profileImageUrl,
          });
        } catch {
          // 跳过无法解析的 cell
        }
      }

      return users;
    }, type);
  }

  private async scrollUserList(): Promise<void> {
    if (!this.page) return;

    // 将最后一个 UserCell 滚动到视图中，触发 X 的无限加载
    await this.page.evaluate(() => {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      if (cells.length > 0) {
        const last = cells[cells.length - 1];
        last.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
    });

    // 额外滚动一点距离确保触发加载
    await this.page!.mouse.wheel(0, 300);
    await this.page!.waitForTimeout(200);

    // 再次尝试找滚动容器滚到底
    await this.page.evaluate(() => {
      // X.com 的 followers 列表通常在这个区域
      const container =
        document.querySelector('[aria-label*="Timeline"]') ||
        document.querySelector('section[role="region"] div[style*="overflow"]') ||
        document.querySelector('div[data-testid="primaryColumn"] section') ||
        document.querySelector('[role="region"]');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  /** 粉丝列表滚回顶部（扫描结束后页面在底部，不回顶就永远找不到靠前的待回关用户） */
  private async scrollFollowersListToTop(): Promise<void> {
    if (!this.page) return;
    await this.page.evaluate(() => {
      window.scrollTo(0, 0);
      const candidates = [
        document.querySelector('[data-testid="primaryColumn"]'),
        document.querySelector('[aria-label*="Timeline"]'),
        document.querySelector('section[role="region"]'),
        ...Array.from(document.querySelectorAll('div')).filter((el) => {
          const s = getComputedStyle(el);
          return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 100;
        }),
      ].filter(Boolean) as HTMLElement[];
      for (const el of candidates) {
        try {
          el.scrollTop = 0;
        } catch { /* ignore */ }
      }
      // 第一个 UserCell 滚进视口
      const first = document.querySelector('[data-testid="UserCell"]');
      if (first) (first as HTMLElement).scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    await this.page.mouse.wheel(0, -2000);
    await this.page.waitForTimeout(400);
  }

  // ── 关注 / 取关 ─────────────────────────────────────

  /**
   * 批量回关（推荐路径）：
   * 在「我的关注者」列表对每个目标 UserCell 精准点「回关」按钮。
   * 注意：扫描结束后页面在列表底部，必须先回顶再找人，否则永远找不到靠前的用户。
   */
  async batchFollowFromFollowersList(
    targets: Array<{ userId: string; username?: string }>,
  ): Promise<Array<{ userId: string; username?: string; ok: boolean }>> {
    return this.pageOp('batch-follow-list', () => this.batchFollowFromFollowersListImpl(targets));
  }

  private async batchFollowFromFollowersListImpl(
    targets: Array<{ userId: string; username?: string }>,
  ): Promise<Array<{ userId: string; username?: string; ok: boolean }>> {
    this.ensureReady();
    const me = this.myUsername;
    if (!me) throw new Error('未登录');

    const results: Array<{ userId: string; username?: string; ok: boolean }> = [];
    if (targets.length === 0) return results;

    // 每次批量回关都重新打开粉丝列表（保证从顶部开始，DOM 是首屏）
    const followersUrl = `https://x.com/${me}/followers`;
    console.log(`[BrowserClient] 打开粉丝列表做精准回关: ${followersUrl}`);
    await this.page!.goto(followersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(1500);
    try {
      await this.page!.waitForSelector('[data-testid="UserCell"]', { timeout: 8000 });
    } catch {
      console.warn('[BrowserClient] 粉丝列表未加载，回关中止');
      return targets.map((t) => ({ userId: t.userId, username: t.username, ok: false }));
    }
    await this.scrollFollowersListToTop();

    for (const t of targets) {
      const username =
        (t.username && t.username.trim()) ||
        this.resolveUsername(t.userId);

      if (!username || /^\d+$/.test(username)) {
        console.warn(`[BrowserClient] 跳过：无 username (id=${t.userId})`);
        results.push({ userId: t.userId, username: t.username, ok: false });
        continue;
      }

      if (t.userId && /^\d+$/.test(t.userId)) {
        this.usernameCache.set(t.userId, username);
        this.idCache.set(username, t.userId);
      }

      const ok = await this.clickFollowBackInList(username);
      results.push({ userId: t.userId, username, ok });

      // 操作间隔，模拟真人
      const delay = actionInterval(this.config);
      console.log(
        `[BrowserClient] 列表回关 @${username}: ${ok ? '成功' : '失败'}，等待 ${(delay / 1000).toFixed(1)}s`,
      );
      await this.page!.waitForTimeout(delay);
    }

    const done = results.filter((r) => r.ok).length;
    console.log(`[BrowserClient] 列表精准回关完成: ${done}/${results.length} 成功`);
    return results;
  }

  /**
   * 在粉丝列表中定位 @username 的 UserCell，点击回关/关注按钮，
   * 等待按钮变为 Following/正在关注 视为成功（不弹回）。
   */
  private async clickFollowBackInList(username: string): Promise<boolean> {
    const uname = username.replace(/^@/, '');
    console.log(`[BrowserClient] 列表定位并回关 @${uname}`);

    // 每次查找先回顶：扫描后页面在底部，只往下滚找不到顶部的「回关」用户
    await this.scrollFollowersListToTop();
    await this.page!.waitForTimeout(300);

    // 最多滚动若干次寻找该 cell
    const MAX_FIND_SCROLLS = 80;

    for (let attempt = 0; attempt < MAX_FIND_SCROLLS; attempt++) {
      const action = await this.page!.evaluate((u) => {
        const target = u.toLowerCase();
        const cells = document.querySelectorAll('[data-testid="UserCell"]');

        for (const cell of cells) {
          // 匹配 /username 链接（兼容末尾斜杠、大小写）
          let match = false;
          const links = cell.querySelectorAll('a[href]');
          for (const link of links) {
            const href = (link.getAttribute('href') || '').split('?')[0].replace(/\/$/, '').toLowerCase();
            if (href === `/${target}` || href.endsWith(`/${target}`)) {
              match = true;
              break;
            }
          }
          if (!match) continue;

          // 找到 cell，滚动到可见
          (cell as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });

          const buttons = cell.querySelectorAll('button, [role="button"], [data-testid*="follow"]');
          for (const btn of buttons) {
            const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
            const textLower = text.toLowerCase();
            const aria = ((btn as HTMLElement).getAttribute('aria-label') || '').toLowerCase();
            const testId = ((btn as HTMLElement).getAttribute('data-testid') || '').toLowerCase();
            const span = (btn.querySelector('span')?.textContent || '').replace(/\s+/g, ' ').trim();
            const spanLower = span.toLowerCase();

            // 已经是「正在关注」→ 成功
            if (
              textLower === 'following' ||
              text === '正在关注' ||
              spanLower === 'following' ||
              span === '正在关注' ||
              testId.includes('unfollow') ||
              aria.includes('following @') ||
              aria.includes('正在关注')
            ) {
              return { found: true, status: 'already' as const };
            }

            // 待回关 / 可关注
            const isFollow =
              textLower === 'follow' ||
              textLower === 'follow back' ||
              text === '回关' ||
              text === '关注' ||
              spanLower === 'follow' ||
              spanLower === 'follow back' ||
              span === '回关' ||
              span === '关注' ||
              /^follow(\s+back)?\s+@/.test(aria) ||
              aria.startsWith('回关') ||
              aria.startsWith('关注') ||
              /-follow$/.test(testId);

            if (isFollow) {
              (btn as HTMLElement).click();
              return { found: true, status: 'clicked' as const, btnText: text || span };
            }
          }

          return { found: true, status: 'no_button' as const };
        }

        return { found: false, status: 'missing' as const };
      }, uname);

      if (action.found && action.status === 'already') {
        console.log(`[BrowserClient] @${uname} 列表上已是「正在关注」`);
        return true;
      }

      if (action.found && action.status === 'clicked') {
        // 确认弹窗（若有）
        await this.page!.waitForTimeout(400);
        const confirmBtn = await this.page!.$('[data-testid="confirmationSheetConfirm"]');
        if (confirmBtn) {
          await confirmBtn.click();
          await this.page!.waitForTimeout(600);
        }

        // 等按钮状态稳定：变成 Following 且不回弹
        await this.page!.waitForTimeout(800);
        const verified = await this.page!.evaluate((u) => {
          const target = u.toLowerCase();
          const cells = document.querySelectorAll('[data-testid="UserCell"]');
          for (const cell of cells) {
            let match = false;
            for (const link of cell.querySelectorAll('a[href]')) {
              const href = (link.getAttribute('href') || '').split('?')[0];
              if (href.toLowerCase() === `/${target}`) {
                match = true;
                break;
              }
            }
            if (!match) continue;

            const buttons = cell.querySelectorAll('button, [role="button"], [data-testid*="follow"]');
            for (const btn of buttons) {
              const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
              const textLower = text.toLowerCase();
              const aria = ((btn as HTMLElement).getAttribute('aria-label') || '').toLowerCase();
              const testId = ((btn as HTMLElement).getAttribute('data-testid') || '').toLowerCase();
              if (
                textLower === 'following' ||
                text === '正在关注' ||
                testId.includes('unfollow') ||
                aria.includes('following @') ||
                aria.includes('正在关注')
              ) {
                return 'following';
              }
              if (
                textLower === 'follow' ||
                textLower === 'follow back' ||
                text === '回关' ||
                text === '关注'
              ) {
                return 'bounced'; // 点了又弹回 Follow → 失败
              }
            }
            return 'unknown';
          }
          return 'gone'; // cell 可能被移除（较少见）
        }, uname);

        if (verified === 'following' || verified === 'gone') {
          console.log(`[BrowserClient] @${uname} 回关成功（按钮状态=${verified}）`);
          return true;
        }
        if (verified === 'bounced') {
          console.warn(`[BrowserClient] @${uname} 回关后按钮回弹为 Follow，判定失败`);
          return false;
        }
        // unknown：再等一会二次确认
        await this.page!.waitForTimeout(1000);
        const again = await this.page!.evaluate((u) => {
          const target = u.toLowerCase();
          for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
            let match = false;
            for (const link of cell.querySelectorAll('a[href]')) {
              const href = (link.getAttribute('href') || '').split('?')[0];
              if (href.toLowerCase() === `/${target}`) { match = true; break; }
            }
            if (!match) continue;
            for (const btn of cell.querySelectorAll('button, [role="button"]')) {
              const text = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
              const testId = ((btn as HTMLElement).getAttribute('data-testid') || '').toLowerCase();
              if (text === 'following' || text === '正在关注' || testId.includes('unfollow')) return true;
            }
          }
          return false;
        }, uname);
        if (again) {
          console.log(`[BrowserClient] @${uname} 二次确认成功`);
          return true;
        }
        console.warn(`[BrowserClient] @${uname} 点击后状态不明，记为失败`);
        return false;
      }

      if (action.found && action.status === 'no_button') {
        console.warn(`[BrowserClient] @${uname} 找到 UserCell 但无回关按钮`);
        return false;
      }

      // 当前视口没有该用户 → 向下滚一点继续找
      await this.scrollUserList();
      await this.page!.waitForTimeout(250 + Math.random() * 150);
    }

    console.warn(`[BrowserClient] @${uname} 在粉丝列表中未找到（已滚 ${MAX_FIND_SCROLLS} 轮）`);
    return false;
  }

  /**
   * 单用户关注（兼容旧路径）：优先用列表回关，列表找不到再回退打开主页。
   */
  async follow(
    _myUserId: string,
    targetUserId: string,
    preferUsername?: string,
  ): Promise<FollowResult> {
    this.ensureReady();

    let username =
      (preferUsername && preferUsername.trim()) ||
      this.resolveUsername(targetUserId);

    if (/^\d+$/.test(username)) {
      console.error(
        `[BrowserClient] 无法关注 userId=${targetUserId}：没有 username（缓存未命中），跳过`,
      );
      return { following: false, pending: false };
    }

    if (targetUserId && /^\d+$/.test(targetUserId)) {
      this.usernameCache.set(targetUserId, username);
      this.idCache.set(username, targetUserId);
    }

    // 优先：粉丝列表上精准点按钮（始终重新打开列表回顶，避免扫描后停在底部找不到人）
    try {
      const me = this.myUsername;
      if (me) {
        await this.page!.goto(`https://x.com/${me}/followers`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await this.page!.waitForTimeout(1200);
        await this.scrollFollowersListToTop();
        const ok = await this.clickFollowBackInList(username);
        if (ok) {
          const delay = actionInterval(this.config);
          await this.page!.waitForTimeout(delay);
          return { following: true, pending: false };
        }
      }
    } catch (err) {
      console.warn(`[BrowserClient] 列表回关失败，回退主页关注:`, (err as Error).message);
    }

    // 回退：打开个人主页点关注
    console.log(`[BrowserClient] 主页回退关注 @${username} (id=${targetUserId || '?'})`);

    await this.page!.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(2000 + Math.random() * 2000);

    const pageOk = await this.page!.evaluate((u) => {
      const path = location.pathname.toLowerCase();
      return path === `/${u.toLowerCase()}` || path.startsWith(`/${u.toLowerCase()}/`);
    }, username);
    if (!pageOk) {
      console.warn(`[BrowserClient] 打开 @${username} 主页失败，当前 URL=${this.page!.url()}`);
      return { following: false, pending: false };
    }

    const result = await this.page!.evaluate(() => {
      const root =
        document.querySelector('[data-testid="primaryColumn"]') ||
        document.body;
      const buttons = root.querySelectorAll('[role="button"], button, [data-testid*="follow"]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        const textLower = text.toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
        const spanText = (btn.querySelector('span')?.textContent || '').trim();

        if (
          textLower === 'following' ||
          text === '正在关注' ||
          aria.includes('following @') ||
          testId.includes('unfollow')
        ) {
          return { following: true, pending: false, already: true };
        }

        const isFollow =
          textLower === 'follow' ||
          textLower === 'follow back' ||
          text === '回关' ||
          text === '关注' ||
          spanText === 'Follow' ||
          spanText === 'Follow back' ||
          spanText === '回关' ||
          spanText === '关注' ||
          /^follow(\s+back)?\s+@/.test(aria) ||
          aria.startsWith('回关') ||
          aria.startsWith('关注') ||
          /-follow$/.test(testId);

        if (isFollow) {
          (btn as HTMLButtonElement).click();
          return { following: true, pending: false, already: false };
        }
      }
      return { following: false, pending: false, already: false };
    });

    if (!result.following) {
      console.warn(`[BrowserClient] @${username} 未找到关注/回关按钮`);
      return { following: false, pending: false };
    }

    await this.page!.waitForTimeout(500);
    const confirmBtn = await this.page!.$('[data-testid="confirmationSheetConfirm"]');
    if (confirmBtn) {
      await confirmBtn.click();
      await this.page!.waitForTimeout(1000);
    }

    const delay = actionInterval(this.config);
    console.log(
      `[BrowserClient] 主页关注${result.already ? '（已是关注状态）' : '完成'} @${username}，等待 ${(delay / 1000).toFixed(1)}s`,
    );
    await this.page!.waitForTimeout(delay);

    return { following: true, pending: !!result.pending };
  }

  async unfollow(_myUserId: string, targetUserId: string): Promise<UnfollowResult> {
    this.ensureReady();
    const username = this.resolveUsername(targetUserId);

    console.log(`[BrowserClient] 取关 @${username}`);

    await this.page!.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(2000 + Math.random() * 2000);

    // 先点 Following 按钮（触发 unfollow 确认）
    const followingClicked = await this.page!.evaluate(() => {
      const buttons = document.querySelectorAll('[role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        const aria = btn.getAttribute('aria-label') || '';

        if (
          text === 'Following' ||
          text === '正在关注' ||
          aria.includes('Following @')
        ) {
          (btn as HTMLButtonElement).click();
          return true;
        }
      }
      return false;
    });

    if (!followingClicked) {
      return { following: false };
    }

    // 等待 unfollow 确认框出现并点击确认
    await this.page!.waitForTimeout(800);
    const unconfirmBtn = await this.page!.$('[data-testid="confirmationSheetConfirm"]');
    if (unconfirmBtn) {
      await unconfirmBtn.click();
      await this.page!.waitForTimeout(1000);
    } else {
      // 可能没有确认框（直接 unfollow），或按钮文本不同
      const altBtn = await this.page!.$('span:has-text("Unfollow")');
      if (altBtn) { await altBtn.click(); await this.page!.waitForTimeout(500); }
    }

    const delay = actionInterval(this.config);
    console.log(`[BrowserClient] 取关完成，等待 ${(delay / 1000).toFixed(1)}s`);
    await this.page!.waitForTimeout(delay);

    return { following: false };
  }

  // ── 发帖 ─────────────────────────────────────────────

  /**
   * 发帖（无活跃时段限制，到点即发）。
   * @param options.priority  手动立即发送：排队时标记优先（不抢占 in-flight）
   * @param options.force  兼容旧调用，已无时段门闩
   */
  async postTweet(
    text: string,
    options?: { force?: boolean; priority?: boolean },
  ): Promise<{ ok: boolean; skipped?: boolean }> {
    this.ensureReady();

    const label = options?.force || options?.priority ? 'post:force' : 'post:scheduled';
    return this.pageOp(label, () => this.postTweetUnlocked(text), { priority: options?.priority });
  }

  /** Inner post implementation — must only be called under pageOp */
  private async postTweetUnlocked(text: string): Promise<{ ok: boolean; skipped?: boolean }> {
    console.log(`[BrowserClient] 发帖: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

    await this.page!.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(2000 + Math.random() * 1000);

    // 点击发帖框
    const clicked = await this.page!.evaluate(() => {
      // 方式 1：data-testid
      for (const sel of [
        '[data-testid="tweetTextarea_0"]',
        '[data-testid="tweetTextarea_0_label"]',
        '[data-testid="tweetTextarea"]',
        '[data-testid*="tweetTextarea"]',
        '[role="textbox"][data-testid*="tweet"]',
        '.public-DraftEditor-content',
        '[data-testid="tweetButtonInline"]',
      ]) {
        const el = document.querySelector(sel);
        if (el) { (el as HTMLElement).click(); return true; }
      }
      // 方式 2：所有 contenteditable 元素
      const editables = document.querySelectorAll('[contenteditable="true"]');
      for (const el of editables) {
        const aria = el.getAttribute('aria-label') || '';
        const role = el.getAttribute('role') || '';
        if (aria || role === 'textbox') {
          (el as HTMLElement).click();
          return true;
        }
      }
      // 方式 3：所有 role="textbox"
      const textboxes = document.querySelectorAll('[role="textbox"]');
      for (const el of textboxes) {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (!label || label.includes('post') || label.includes('tweet') || label.includes('what') || label.includes('text')) {
          (el as HTMLElement).click();
          return true;
        }
      }
      // 方式 4：点击 "What is happening?!" 占位区域
      const placeholder = document.querySelector('[data-testid="tweetTextarea_0_label"] span');
      if (placeholder) { (placeholder as HTMLElement).click(); return true; }
      return false;
    });

    if (!clicked) {
      console.warn('[BrowserClient] 未找到发帖框');
      return { ok: false };
    }

    await this.page!.waitForTimeout(800);

    // X.com 是 React 应用，必须用键盘逐字输入才能触发 React onChange 事件
    // fill() 虽然能填入文字，但 React 内部状态不会更新，导致发空推文
    const inputEl = this.page!.locator('[data-testid="tweetTextarea_0"], [role="textbox"]').first();
    if (await inputEl.count() > 0) {
      await inputEl.click();
      // 清除可能已有的内容
      await this.page!.keyboard.press('Control+a');
      await this.page!.keyboard.press('Delete');
      await this.page!.waitForTimeout(100);
      // 逐字输入（[...text] 正确处理 emoji 等多字节字符）
      const chars = [...text];
      for (const ch of chars) {
        await this.page!.keyboard.type(ch, { delay: 30 + Math.random() * 50 });
      }
      await this.page!.waitForTimeout(300);
    } else {
      console.warn('[BrowserClient] 未找到发帖输入框');
      return { ok: false };
    }

    await this.page!.waitForTimeout(500 + Math.random() * 500);

    // 点击发送按钮
    const btnClicked = await this.page!.evaluate(() => {
      // 方式 1：按 data-testid
      for (const sel of [
        '[data-testid="tweetButton"]',
        '[data-testid="tweetButtonInline"]',
        'button[data-testid*="tweetButton"]',
      ]) {
        const el = document.querySelector(sel);
        if (el && !(el as HTMLButtonElement).disabled) {
          (el as HTMLButtonElement).click();
          return true;
        }
      }
      // 方式 2：按 aria-label
      for (const btn of document.querySelectorAll('button, [role="button"]')) {
        const aria = ((btn as HTMLElement).getAttribute('aria-label') || '').toLowerCase();
        const text = (btn.textContent || '').trim().toLowerCase();
        const testId = ((btn as HTMLElement).getAttribute('data-testid') || '').toLowerCase();
        if (
          !(btn as HTMLButtonElement).disabled &&
          (aria.includes('post') || aria.includes('tweet') || aria.includes('send') ||
           testId.includes('tweet') || testId.includes('post') ||
           text === 'post' || text === '发帖')
        ) {
          (btn as HTMLButtonElement).click();
          return true;
        }
      }
      return false;
    });

    if (!btnClicked) {
      console.warn('[BrowserClient] 未找到发送按钮');
      return { ok: false };
    }

    // 等待发送完成：检测推文框清空或错误提示
    let posted = false;
    let errorReason = '';
    for (let wait = 0; wait < 30; wait++) {
      await this.page!.waitForTimeout(500);
      const result = await this.page!.evaluate(() => {
        // 检测错误：重复推文 / 限流 / 其他错误 toast
        // 注意：X.com 成功后会提示「你的帖子已发送」，别当成错误
        const errorSelectors = [
          '[data-testid="toast"]', '[role="alert"]',
          'div[aria-live="assertive"]', 'div[aria-live="polite"]',
          '[data-testid="snackbar"]',
        ];
        for (const sel of errorSelectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const text = (el.textContent || '').toLowerCase();
          // 先排除成功提示
          if (text.includes('已发送') || text.includes('已发布') ||
              text.includes('sent') || text.includes('posted') ||
              text.includes('view') || text.includes('查看')) {
            return { done: true, error: '' };  // 这是成功发送的确认
          }
          // 再检测真正的错误
          if (text.includes('already') || text.includes('duplicate') ||
              text.includes('重复') ||
              text.includes('limit') || text.includes('限制') ||
              text.includes('try again') || text.includes('再试') ||
              text.includes('something went wrong') || text.includes('出错了')) {
            return { done: false, error: text.substring(0, 100) };
          }
        }

        // 检测：发帖框内容被清空（推文已发出）
        const editor = document.querySelector('[data-testid="tweetTextarea_0"], [role="textbox"][data-testid*="tweetTextarea"]');
        if (editor) {
          const text = (editor as HTMLElement).innerText || (editor as HTMLInputElement).value || '';
          if (!text.trim()) return { done: true, error: '' };
        }
        return { done: false, error: '' };
      });

      if (result.error) {
        errorReason = result.error;
        posted = false;
        break;
      }
      if (result.done) {
        posted = true;
        break;
      }
    }

    if (errorReason) {
      console.warn(`[BrowserClient] 发帖被拒绝: ${errorReason}`);
      return { ok: false };
    }
    if (posted) {
      console.log('[BrowserClient] 发帖成功（检测到确认信号）');
    } else {
      console.warn('[BrowserClient] 发送后未检测到确认信号，可能未发出');
    }

    // 等待发送完成
    await this.page!.waitForTimeout(2000 + Math.random() * 1000);

    const delay = actionInterval(this.config);
    await this.page!.waitForTimeout(delay);

    return { ok: posted };
  }

  // ── 辅助方法 ─────────────────────────────────────────

  private resolveUsername(userId: string): string {
    // 缓存查找 userId → username
    if (this.usernameCache.has(userId)) {
      return this.usernameCache.get(userId)!;
    }
    // 自己的 ID
    if (userId === this.myId && this.myUsername) {
      return this.myUsername;
    }
    // 已经是 username（非纯数字），或扫描结果里用 username 作占位 id
    if (!/^\d+$/.test(userId)) {
      return userId;
    }
    // 纯数字 ID 且不在缓存：若恰好是自己，用 myUsername；否则原样返回（调用方应保证缓存）
    if (userId === '0' && this.myUsername) {
      return this.myUsername;
    }
    console.warn(`[BrowserClient] resolveUsername: 未知 userId=${userId}，缓存未命中`);
    return userId;
  }

  // ── 未使用的方法（接口兼容）─────────────────────────

  async getUserById(_id: string): Promise<XUser> { throw new Error('Not supported in browser mode'); }
  async getUsersByIds(_ids: string[]): Promise<XUser[]> { throw new Error('Not supported in browser mode'); }
  async getUserByUsername(_username: string): Promise<XUser> { throw new Error('Not supported in browser mode'); }
  async getUsersByUsernames(_usernames: string[]): Promise<XUser[]> { throw new Error('Not supported in browser mode'); }
}
