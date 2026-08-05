import { LiveXClient } from "./live.js";
import { MockXClient } from "./mock.js";
import type { XClient } from "./types.js";

export * from "./types.js";
export { MockXClient } from "./mock.js";
export { LiveXClient } from "./live.js";

let singleton: XClient | null = null;

export function createXClient(): XClient {
  if (singleton) return singleton;
  const mode = (process.env.X_CLIENT_MODE ?? "mock").toLowerCase();
  if (mode === "live") {
    singleton = new LiveXClient();
  } else {
    singleton = new MockXClient();
  }
  console.log(`XClient mode=${mode}`);
  return singleton;
}
