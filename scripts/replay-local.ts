/** Local-only launcher for the real BFF entrypoint, using embedded PostgreSQL and local objects. */
import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(process.env.REPLAY_LOCAL_ROOT ?? "work/replay-local");
await mkdir(root, { recursive: true, mode: 0o700 });
process.env.PORT ??= "18080";
process.env.REPLAY_ENVIRONMENT = "development";
process.env.REPLAY_BUCKET = "";
process.env.REPLAY_LOCAL_DIR = resolve(root, "objects");
const previous = await readFile(resolve(root, "connection.json"), "utf8")
  .then((t) => JSON.parse(t))
  .catch(() => null);
process.env.BETA_REVIEW_ADMIN_TOKEN = /^[a-f0-9]{48}$/.test(
  previous?.adminToken ?? "",
)
  ? previous.adminToken
  : randomBytes(24).toString("hex");
// This local launcher never sends email/Slack or talks to AWS queues.
process.env.DISCORD_WEBHOOK_ALERT = "";
process.env.DISCORD_WEBHOOK_WARN = "";
process.env.DISCORD_WEBHOOK_OPS = "";
process.env.SMTP_HOST = "";
process.env.JOB_EXECUTION_MODE = "inline";
const db = new PGlite(resolve(root, "postgres"));
const { pool } = await import("../src/db.js");
const raw = async (sql: string, params?: unknown[]) => {
  const result = params?.length
    ? await db.query(sql, params)
    : (await db.exec(sql)).at(-1)!;
  return {
    rows: result.rows,
    rowCount: result.affectedRows ?? result.rows.length,
    fields: [],
    command: "",
    oid: 0,
  };
};
let unlock: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
// Match pg's transaction reservation: one PGlite connection cannot interleave BEGIN/COMMIT.
const connect = async () => {
  const previous = gate;
  gate = new Promise<void>((r) => {
    unlock = r;
  });
  const release = unlock;
  await previous;
  return { query: raw, release };
};
const query = async (sql: string, params?: unknown[]) => {
  const connection = await connect();
  try {
    return await raw(sql, params);
  } finally {
    connection.release();
  }
};
Object.assign(pool, { query, connect, end: () => db.close() });
await writeFile(
  resolve(root, "connection.json"),
  JSON.stringify(
    {
      baseUrl: `http://localhost:${process.env.PORT}`,
      adminToken: process.env.BETA_REVIEW_ADMIN_TOKEN,
      dashboard: `http://localhost:${process.env.PORT}/v1/admin/ops/dashboard?token=${process.env.BETA_REVIEW_ADMIN_TOKEN}`,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `Local replay BFF: http://localhost:${process.env.PORT}; ephemeral admin credentials: ${resolve(root, "connection.json")}`,
);
const { app } = await import("../src/index.js");
const { build } = await import("esbuild");
const fixture = await build({
  entryPoints: ["scripts/replay-fixture.mjs"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});
app.get("/__replay-fixture.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(fixture.outputFiles[0].text);
});
app.get("/__replay-fixture", (c) =>
  c.html(
    `<!doctype html><meta charset="utf-8"><title>Local recorder verification</title><style>body{font:18px system-ui;background:#182538;color:#fff;padding:40px}button{padding:12px;margin:8px}#pose{width:130px;height:170px;border:12px solid #f9b45b;border-radius:50%;margin:40px}</style><h1>합성 로컬 녹화 검증</h1><p>실제 제품 사용 증거와 구분하는 recorder HTTP 왕복 검증</p><button id="start">녹화 시작</button><button id="choose">후보 변경</button><button id="capture">캡처 선택</button><button id="finish">업로드 완료</button><p id="status" class="rr-block">대기</p><div id="pose"></div><p id="label">후보 A</p><script src="/__replay-fixture.js"></script>`,
  ),
);
