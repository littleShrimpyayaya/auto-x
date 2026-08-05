/**
 * @autox/db — PostgreSQL access + migrations (PR1 stub).
 * Full Drizzle schema lands in a later PR.
 * Only the compose `migrate` service (or manual `pnpm db:migrate`) should run migrations.
 * apps/api and apps/worker MUST NOT call migrate on boot.
 */

export const PACKAGE_NAME = "@autox/db" as const;
