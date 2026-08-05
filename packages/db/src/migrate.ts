/**
 * Sole migrator entrypoint (K25). Used by compose service `migrate` only.
 * api/worker must never import/run this on boot.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("FATAL: DATABASE_URL required for migrate");
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const id = file;
      const exists = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [id]);
      if (exists.rowCount) {
        console.log(`skip ${id} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      console.log(`applying ${id}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
        await client.query("COMMIT");
        console.log(`applied ${id}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    console.log("migrate complete");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("migrate failed", err);
  process.exit(1);
});
