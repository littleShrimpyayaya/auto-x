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

      // 找 followers/following 链接中的数字
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

    // 尝试从页面获取 user ID
    const userId = await this.page!.evaluate(() => {
      // 从 React 内部状态或 data 属性中获取
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || '');
          // 在 JSON 数据中搜索 user id
          const walk = (obj: any, depth: number): string | null => {
            if (!obj || depth > 10) return null;
            if (typeof obj !== 'object') return null;
            if (obj.rest_id && obj.legacy?.screen_name) return String(obj.rest_id);
            if (Array.isArray(obj)) {
              for (const item of obj) { const r = walk(item, depth + 1); if (r) return r; }
            } else {
              for (const v of Object.values(obj)) { const r = walk(v, depth + 1); if (r) return r; }
            }
            return null;
          };
          return walk(data, 0);
        } catch { /* continue */ }
      }
      return null;
    });

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

    await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(3000);

    // 等待用户列表渲染
    try {
      await this.page!.waitForSelector('[data-testid="UserCell"]', { timeout: 10000 });
    } catch {
      console.warn(`[BrowserClient] ${type} 页面未找到用户列表`);
      return;
    }

    const seen = new Set<string>();
    let prevCount = 0;
    let noNewCount = 0;
    const MAX_SCROLLS = 500; // 安全上限
    const MAX_NO_NEW = 5;    // 连续无新数据退出

    for (let i = 0; i < MAX_SCROLLS; i++) {
      // 提取当前页面的所有用户
      const batch = await this.extractUsersFromPage(type);

      for (const user of batch) {
        const key = user.id !== '0' ? user.id : user.username;
        if (!seen.has(key)) {
          seen.add(key);
          // 缓存 ID ↔ username 映射
          if (user.id !== '0' && user.username) {
            this.usernameCache.set(user.id, user.username);
            this.idCache.set(user.username, user.id);
          }
          yield user;
        }
      }

      // 检测是否已到底
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

      // 滚动加载更多
      await this.scrollUserList();
      await this.page!.waitForTimeout(1500 + Math.random() * 1000);
    }
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

          // 对于 followers 列表：检查是否已关注（按钮显示 "Following"）
          // 对于 following 列表：检查对方是否关注你（"Follows you" 标记）
          const btnText = cell.querySelector('[role="button"]')?.textContent?.trim().toLowerCase() || '';
          const cellText = cell.textContent?.toLowerCase() || '';

          if (listType === 'followers' && (btnText === 'following' || btnText === '正在关注')) {
            connectionStatus.push('following');
          }
          if (listType === 'following' && cellText.includes('follows you')) {
            connectionStatus.push('followed_by');
          }

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

    await this.page.evaluate(() => {
      // 找到可滚动的用户列表容器
      const scrollable = document.querySelector('[data-viewportview="true"]') ||
        document.querySelector('div[style*="overflow"]') ||
        document.querySelector('[role="region"]');
      if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight;
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
    });
  }

  // ── 关注 / 取关 ─────────────────────────────────────

  async follow(_myUserId: string, targetUserId: string): Promise<FollowResult> {
    this.ensureReady();
    const username = this.resolveUsername(targetUserId);

    // 检查活跃时段
    if (!isActiveHours(this.config)) {
      console.log('[BrowserClient] 当前不在活跃时段，延迟操作');
      await this.waitUntilActive();
    }

    console.log(`[BrowserClient] 关注 @${username}`);

    // 方案 A：从列表页直接点（更高效）
    // 方案 B：打开 profile 页面再点（更可靠）
    await this.page!.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(2000 + Math.random() * 2000);

    const result = await this.page!.evaluate(() => {
      // 查找 Follow 按钮
      const buttons = document.querySelectorAll('[role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        const aria = btn.getAttribute('aria-label') || '';

        if (
          text === 'Follow' ||
          aria.includes('Follow @') ||
          (btn.querySelector('span')?.textContent?.trim() === 'Follow')
        ) {
          (btn as HTMLButtonElement).click();
          return { following: true, pending: false };
        }

        // 已经关注了
        if (text === 'Following' || text === '正在关注' || aria.includes('Following @')) {
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

    if (!isActiveHours(this.config)) {
      console.log('[BrowserClient] 当前不在活跃时段，延迟操作');
      await this.waitUntilActive();
    }

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
      // X 的发帖框有多种可能的 selector
      const selectors = [
        '[data-testid="tweetTextarea_0"]',
        '[data-testid="tweetTextarea_0_label"]',
        '[role="textbox"][data-testid*="tweet"]',
        '.public-DraftEditor-content',
        '[aria-label="Post text"]',
        '[data-testid="tweetButtonInline"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { (el as HTMLElement).click(); return true; }
      }
      // 备用：找 "What's happening?" 区域
      const allDivs = document.querySelectorAll('[role="textbox"]');
      for (const div of allDivs) {
        const label = div.getAttribute('aria-label') || '';
        if (label.includes('Post') || label.includes('Tweet') || label.includes('What')) {
          (div as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) {
      console.warn('[BrowserClient] 未找到发帖框');
      return { ok: false };
    }

    await this.page!.waitForTimeout(800);

    // 模拟人类逐字符输入
    for (let i = 0; i < text.length; i++) {
      await this.page!.keyboard.type(text[i], { delay: 30 + Math.random() * 50 });
    }

    await this.page!.waitForTimeout(500 + Math.random() * 500);

    // 点击发送按钮
    const posted = await this.page!.evaluate(() => {
      const selectors = [
        '[data-testid="tweetButton"]',
        '[data-testid="tweetButtonInline"]',
        'button[aria-label*="Post"]',
        'button[aria-label*="Tweet"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && !(el as HTMLButtonElement).disabled) {
          (el as HTMLButtonElement).click();
          return true;
        }
      }
      // 备用：找包含 "Post" 文字的按钮
      const buttons = document.querySelectorAll('[role="button"]');
      for (const btn of buttons) {
        const label = btn.getAttribute('aria-label') || btn.textContent || '';
        if ((label.includes('Post') || label.includes('发帖') || label.includes('Tweet')) && !btn.hasAttribute('disabled')) {
          (btn as HTMLButtonElement).click();
          return true;
        }
      }
      return false;
    });

    if (posted) {
      console.log('[BrowserClient] 发帖成功');
    } else {
      console.warn('[BrowserClient] 未找到发送按钮');
    }

    // 等待发送完成
    await this.page!.waitForTimeout(2000 + Math.random() * 1000);

    const delay = actionInterval(this.config);
    await this.page!.waitForTimeout(delay);

    return { ok: posted };
  }

  // ── 辅助方法 ─────────────────────────────────────────

  private resolveUsername(userId: string): string {
    // 优先从缓存查找
    if (this.usernameCache.has(userId)) {
      return this.usernameCache.get(userId)!;
    }
    // 如果是自己的 ID
    if (userId === this.myId && this.myUsername) {
      return this.myUsername;
    }
    // 如果 userId 看起来像 ID（纯数字），尝试查缓存
    if (/^\d+$/.test(userId)) {
      throw new Error(`无法解析 userId=${userId} 对应的用户名，请先同步数据`);
    }
    // 可能传入的就是 username
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
