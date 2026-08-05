/**
 * @autox/api — Hono HTTP server (PR1 scaffold).
 * Does NOT run migrations on boot (migrate is a separate compose service).
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { isAdminTokenWeak } from "@autox/config";

function assertAdminToken(): void {
  const token = process.env.ADMIN_TOKEN;
  if (isAdminTokenWeak(token)) {
    console.error(
      "FATAL: ADMIN_TOKEN is missing, too short (<16), or equals the weak placeholder 'change-me-to-long-random'. Set a strong token in .env.",
    );
    process.exit(1);
  }
}

assertAdminToken();

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true as const }));

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`api listening on http://0.0.0.0:${info.port}`);
});
