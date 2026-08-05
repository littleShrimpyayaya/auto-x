/** Pure domain helpers */

export function isMutual(followerActive: boolean, followingActive: boolean): boolean {
  return followerActive && followingActive;
}

export function shouldFollowBack(opts: {
  isFollower: boolean;
  isFollowing: boolean;
  followBackEnabled: boolean;
}): boolean {
  return opts.followBackEnabled && opts.isFollower && !opts.isFollowing;
}

export function observationExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function computeExpiresAt(enteredAt: Date, days: number): Date {
  return new Date(enteredAt.getTime() + days * 24 * 60 * 60 * 1000);
}

/** FOAF score: overlap count + verified boost */
export function foafScore(overlap: number, verified: boolean, preferVerified: boolean): number {
  return overlap + (preferVerified && verified ? 1 : 0);
}

export function chargeFollow(wasLocalActive: boolean): boolean {
  // K22: charge if no active edge before write
  return !wasLocalActive;
}

export function chargeUnfollow(wasLocalActive: boolean): boolean {
  return wasLocalActive;
}
