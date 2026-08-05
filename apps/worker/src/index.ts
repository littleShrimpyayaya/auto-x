/**
 * @autox/worker — background job process (PR1 scaffold).
 * Does NOT run migrations on boot (migrate is a separate compose service).
 */
const workerId = process.env.WORKER_ID ?? "worker-1";

console.log(`worker started (${workerId})`);

// Keep process alive; real loops arrive in later PRs.
const heartbeat = setInterval(() => {
  // intentional no-op heartbeat so the process stays up under Docker
}, 60_000);

function shutdown(signal: string): void {
  console.log(`worker received ${signal}, shutting down`);
  clearInterval(heartbeat);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
