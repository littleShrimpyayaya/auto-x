import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { XUser, PaginatedUsers, FollowResult, UnfollowResult } from './types.js';
import {
  loadAutomationConfig,
  actionInterval,
  isActiveHours,
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

  constructor(config?: AutomationConfig) {
    this.config = config ?? loadAutomationConfig();
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

      // 头像
      const avatarImg = document.querySelector('img[src*="profile_images"]');
      const profileImageUrl = avatarImg?.getAttribute('src') || undefined;

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
    await this.page!.waitForTimeout(3000);

    try {
      await this.page!.waitForSelector('[data-testid="UserCell"]', { timeout: 10000 });
    } catch {
      this.page!.off('response', onResponse);
      console.warn('[BrowserClient] 粉丝列表未加载');
      return [];
    }

    const needFollow: FollowBackCandidate[] = [];
    const needFollowKeys = new Set<string>(); // username lowercased
    const seenAllUsers = new Set<string>();   // 页面上见过的所有粉丝（含已关注）
    let prevSeenAll = 0;
    let noNewCount = 0;
    const MAX_SCROLLS = 800;
    const MAX_NO_NEW = 10;

    for (let i = 0; i < MAX_SCROLLS; i++) {
      // 扫描当前视口：只收「需要回关」的 UserCell，同时统计所有出现过的粉丝
      const batch = await this.page!.evaluate(() => {
        type CellResult = {
          username: string;
          name: string;
          profileImageUrl?: string;
          needsFollowBack: boolean;
          buttonHint: string;
          userId: string;
        };

        const SKIP = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose']);

        /** 从按钮 data-testid 中提取用户 ID（如 "123456-follow" → "123456"） */
        function extractUserIdFromButton(btn: Element): string {
          const testId = ((btn as HTMLElement).getAttribute('data-testid') || '');
          const m = testId.match(/^(\d+)-(?:follow|unfollow|pending)/);
          return m ? m[1] : '';
        }

        /** 是否为「需要回关」按钮 — 只匹配 Follow back / 回关（排除推荐用户的 Follow / 关注） */
        function isFollowBackButton(btn: Element): boolean {
          const rawText = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          const text = rawText.toLowerCase();
          const aria = ((btn as HTMLElement).getAttribute('aria-label') || '').toLowerCase();
          const testId = ((btn as HTMLElement).getAttribute('data-testid') || '').toLowerCase();

          // 已关注 / 请求中 / 取关 —— 明确排除
          if (
            text === 'following' ||
            text === 'pending' ||
            text === 'unfollow' ||
            text === '正在关注' ||
            text === '已请求' ||
            text === '取消关注' ||
            testId.includes('unfollow') ||
            aria.includes('following @') ||
            aria.includes('unfollow @') ||
            aria.includes('正在关注')
          ) {
            return false;
          }

          // ⚠ 排除纯「关注 / Follow」（推荐用户），只保留「回关 / Follow back」
          if (
            text === 'follow' ||
            text === '关注'
          ) {
            return false;
          }

          // data-testid 形如 "123456-follow" + 上下文必须是 follow back
          if (/-follow$/.test(testId)) {
            // 按钮 text/aria 里必须带 "back" 或 "回" 才认定是回关
            if (
              text.includes('back') ||
              text === '回关' ||
              aria.includes('follow back') ||
              aria.includes('回关')
            ) {
              return true;
            }
            return false;
          }

          // 中英文回关文案
          if (
            text === 'follow back' ||
            text === '回关'
          ) {
            return true;
          }

          // aria-label: "Follow back @user" / "回关 @user"
          if (
            /^follow\s+back\s+@/.test(aria) ||
            aria.startsWith('回关')
          ) {
            return true;
          }

          return false;
        }

        const results: CellResult[] = [];
        const cells = document.querySelectorAll('[data-testid="UserCell"]');

        for (const cell of cells) {
          // 提取 username / name
          let username = '';
          let name = '';
          const links = cell.querySelectorAll('a[role="link"]');
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            const m = href.match(/^\/([A-Za-z0-9_]+)$/);
            if (!m || SKIP.has(m[1].toLowerCase())) continue;
            username = m[1];
            const spans = link.querySelectorAll('span');
            for (const span of spans) {
              const t = (span.textContent || '').trim();
              if (!t || t.startsWith('@')) continue;
              if (t.length < 100 && !name) name = t;
            }
            break;
          }
          if (!username) continue;

          // 头像
          const img =
            cell.querySelector('img[src*="profile_images"]') ||
            cell.querySelector('img[src*="twimg.com"]');
          const profileImageUrl = img?.getAttribute('src') || undefined;

          // 找关注相关按钮，同时提取用户 ID
          const allBtns = cell.querySelectorAll('button, [role="button"], [data-testid*="follow"]');
          let needsFollowBack = false;
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
              domUserId = extractUserIdFromButton(btn);
            }
            if (isFollowBackButton(btn)) {
              needsFollowBack = true;
              break;
            }
          }

          // 备用：尝试从链接的 data-user-id 获取
          if (!domUserId) {
            const userLink = cell.querySelector(`a[href="/${username}"]`);
            if (userLink) {
              domUserId = userLink.getAttribute('data-user-id') || '';
            }
          }

          results.push({
            username,
            name: name || username,
            profileImageUrl,
            needsFollowBack,
            buttonHint,
            userId: domUserId,
          });
        }
        return results;
      });

      for (const user of batch) {
        const key = user.username.toLowerCase();
        seenAllUsers.add(key);

        if (!user.needsFollowBack) continue;
        if (needFollowKeys.has(key)) continue;
        needFollowKeys.add(key);

        const gql = gqlByUsername.get(key);
        // GraphQL 若明确说已经 following，以 GraphQL 为准跳过（避免误检）
        if (gql?.following === true) {
          console.log(`[BrowserClient] ⏭ 跳过 @${user.username} — GraphQL 显示已关注 (following=true)`);
          continue;
        }

        // ID 优先级：GraphQL → idCache → DOM 提取 → '0'
        const userIdSource = gql?.id ? 'gql' : this.idCache.get(user.username) ? 'cache' : user.userId ? 'dom' : 'none';
        const userId = gql?.id || this.idCache.get(user.username) || user.userId || '0';
        const profileImageUrl =
          user.profileImageUrl ||
          gql?.profileImageUrl ||
          undefined;

        console.log(
          `[BrowserClient] ✅ @${user.username}  name="${user.name}"  userId=${userId}(${userIdSource})  ` +
          `btn=${user.buttonHint}  img=${profileImageUrl ? 'yes' : 'no'}`,
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

      // 滚动加载更多粉丝
      for (let r = 0; r < 4; r++) {
        await this.scrollUserList();
        await this.page!.waitForTimeout(200);
      }
      await this.page!.waitForTimeout(600 + Math.random() * 400);

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

    // 对仍缺 userId 的，再试一次 GraphQL 缓存
    for (const u of needFollow) {
      if (u.userId !== '0') continue;
      const gql = gqlByUsername.get(u.username.toLowerCase());
      if (gql?.id) {
        u.userId = gql.id;
        if (!u.profileImageUrl && gql.profileImageUrl) u.profileImageUrl = gql.profileImageUrl;
        if (gql.name) u.name = gql.name;
      }
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

  // ── 关注 / 取关 ─────────────────────────────────────

  async follow(_myUserId: string, targetUserId: string): Promise<FollowResult> {
    this.ensureReady();
    const username = this.resolveUsername(targetUserId);

    console.log(`[BrowserClient] 关注 @${username}`);

    await this.page!.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(2000 + Math.random() * 2000);

    const result = await this.page!.evaluate(() => {
      // 查找 Follow / 回关 / 关注 按钮
      const buttons = document.querySelectorAll('[role="button"], button, [data-testid*="follow"]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        const textLower = text.toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
        const spanText = (btn.querySelector('span')?.textContent || '').trim();

        // 已经关注了
        if (
          textLower === 'following' ||
          text === '正在关注' ||
          aria.includes('following @') ||
          testId.includes('unfollow')
        ) {
          return { following: true, pending: false };
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
          /-follow$/.test(testId);

        if (isFollow) {
          (btn as HTMLButtonElement).click();
          return { following: true, pending: false };
        }
      }
      return { following: false, pending: false };
    });

    // 检查是否有确认对话框
    await this.page!.waitForTimeout(500);
    const confirmBtn = await this.page!.$('[data-testid="confirmationSheetConfirm"]');
    if (confirmBtn) {
      await confirmBtn.click();
      await this.page!.waitForTimeout(1000);
    }

    // 加入随机延迟
    const delay = actionInterval(this.config);
    console.log(`[BrowserClient] 关注完成，等待 ${(delay / 1000).toFixed(1)}s`);
    await this.page!.waitForTimeout(delay);

    return result;
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

  async postTweet(text: string): Promise<{ ok: boolean }> {
    this.ensureReady();

    if (!isActiveHours(this.config)) {
      console.log('[BrowserClient] 当前不在活跃时段，跳过发帖');
      return { ok: false };
    }

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

  private async waitUntilActive(): Promise<void> {
    while (!isActiveHours(this.config)) {
      const now = new Date();
      const nextStart = new Date(now);
      nextStart.setHours(this.config.activeHoursStart, 0, 0, 0);
      if (nextStart <= now) nextStart.setDate(nextStart.getDate() + 1);

      const waitMs = nextStart.getTime() - now.getTime();
      console.log(`[BrowserClient] 等待至 ${nextStart.toLocaleString()}（${Math.round(waitMs / 60000)} 分钟）`);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 600_000))); // 最多等 10 分钟检查一次
    }
  }

  // ── 未使用的方法（接口兼容）─────────────────────────

  async getUserById(_id: string): Promise<XUser> { throw new Error('Not supported in browser mode'); }
  async getUsersByIds(_ids: string[]): Promise<XUser[]> { throw new Error('Not supported in browser mode'); }
  async getUserByUsername(_username: string): Promise<XUser> { throw new Error('Not supported in browser mode'); }
  async getUsersByUsernames(_usernames: string[]): Promise<XUser[]> { throw new Error('Not supported in browser mode'); }
}
