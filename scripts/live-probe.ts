/**
 * Live X API probe — uses real credentials from env.
 * Usage (from repo root):
 *   set -a && source .env && set +a
 *   pnpm exec tsx scripts/live-probe.ts
 *
 * Exit 0 if getMe works; prints JSON capabilities.
 * Does NOT follow/unfollow anyone.
 */
import { createXClient, hasLiveCredentials, resolveXClientMode } from "../packages/x-client/src/index.ts";

async function main() {
  const mode = resolveXClientMode();
  console.log("resolve mode:", mode);
  console.log("credentials complete:", hasLiveCredentials());

  if (mode !== "live") {
    console.error(
      "Not in live mode. Set X_CLIENT_MODE=live (or auto) and all four:\n" +
        "  X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET",
    );
    process.exit(2);
  }

  const x = createXClient();
  console.log("probing real X API…");
  const caps = await x.probeCapabilities();
  console.log(JSON.stringify(caps, null, 2));

  if (!caps.me) {
    console.error("FAIL: getMe — check OAuth tokens / app permissions");
    process.exit(1);
  }
  if (!caps.readFollowers) {
    console.warn("WARN: cannot read followers — follow-back/sync may be limited for this API tier");
  }
  if (!caps.readFollowing) {
    console.warn("WARN: cannot read following — observation/unfollow graph may be limited");
  }
  console.log("OK: live getMe as @" + caps.meUser?.username + " id=" + caps.meUser?.id);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
