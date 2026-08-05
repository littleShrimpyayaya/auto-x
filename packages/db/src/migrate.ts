/**
 * PR1 migrate stub.
 *
 * Compose service `migrate` runs: `pnpm --filter @autox/db db:migrate`
 * Real Drizzle migrations arrive in PR2. Until then this exits 0 so
 * api/worker can start after `service_completed_successfully`.
 *
 * Does NOT open a DB connection yet (schema not ready). Logs clearly.
 */
console.log("PR1: no migrations yet — migrate stub exiting 0");
process.exit(0);
