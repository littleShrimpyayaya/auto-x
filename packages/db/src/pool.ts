import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX ?? 10),
  });
  pool.on("error", (err) => {
    console.error("pg pool error", err);
  });
  return pool;
}

export async function withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  const c = await p.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
