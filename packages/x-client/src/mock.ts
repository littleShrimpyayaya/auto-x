import type { FollowResult, Page, XCapabilities, XClient, XUser } from "./types.js";

/** Deterministic mock graph for offline dev only. */
export class MockXClient implements XClient {
  readonly mode = "mock" as const;

  me: XUser = {
    id: "100",
    username: "autox_me",
    name: "AutoX Me",
    verified: false,
    followers_count: 0,
    following_count: 0,
  };

  users = new Map<string, XUser>();
  followers = new Set<string>();
  following = new Set<string>();
  foafFollowing = new Map<string, string[]>();

  constructor() {
    this.seed();
  }

  private seed() {
    const mk = (id: string, username: string, name: string, verified = false): XUser => ({
      id,
      username,
      name,
      verified,
      protected: false,
    });
    const u = [
      mk("101", "alice_dev", "Alice", false),
      mk("102", "bob_crypto", "Bob", true),
      mk("103", "carol_blue", "Carol", true),
      mk("104", "dave_no_back", "Dave", false),
      mk("105", "erin_new", "Erin", false),
      mk("201", "foaf_one", "Foaf One", true),
      mk("202", "foaf_two", "Foaf Two", false),
    ];
    for (const x of u) this.users.set(x.id, x);
    this.users.set(this.me.id, this.me);
    for (const id of ["101", "102", "103", "105"]) this.followers.add(id);
    for (const id of ["102", "103", "104"]) this.following.add(id);
    this.foafFollowing.set("102", ["201", "202", "101"]);
    this.foafFollowing.set("103", ["201", "105"]);
    this.refreshCounts();
  }

  private refreshCounts() {
    this.me.followers_count = this.followers.size;
    this.me.following_count = this.following.size;
  }

  async getMe(): Promise<XUser> {
    this.refreshCounts();
    return { ...this.me };
  }

  private page(ids: string[], token?: string | null, maxResults = 100): Page<XUser> {
    const all = [...ids];
    const start = token ? Number(token) : 0;
    const slice = all.slice(start, start + maxResults);
    const next = start + maxResults < all.length ? String(start + maxResults) : null;
    return {
      data: slice.map((id) => this.users.get(id) ?? { id, username: `u_${id}`, name: id }),
      nextToken: next,
    };
  }

  async getFollowers(_userId: string, token?: string | null, maxResults = 100) {
    return this.page([...this.followers], token, maxResults);
  }

  async getFollowing(userId: string, token?: string | null, maxResults = 100) {
    if (userId === this.me.id) return this.page([...this.following], token, maxResults);
    return this.page(this.foafFollowing.get(userId) ?? [], token, maxResults);
  }

  async follow(_source: string, target: string): Promise<FollowResult> {
    if (this.following.has(target)) return { pendingFollow: false, alreadyFollowing: true };
    if (target === "105") {
      this.following.add(target);
      this.refreshCounts();
      return { pendingFollow: true };
    }
    this.following.add(target);
    this.refreshCounts();
    return { pendingFollow: false };
  }

  async unfollow(_source: string, target: string): Promise<void> {
    this.following.delete(target);
    this.refreshCounts();
  }

  async probeCapabilities(): Promise<XCapabilities> {
    const me = await this.getMe();
    return {
      mode: "mock",
      me: true,
      readFollowers: true,
      readFollowing: true,
      writeFollow: true,
      writeUnfollow: true,
      probedAt: new Date().toISOString(),
      errors: {},
      meUser: me,
    };
  }
}
