/** Operator-only CLI. Code plaintext is written to an exclusive 0600 file. */
import { randomBytes, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { pool, transaction } from "../dist/db.js";
import { ACCESS_SCHEMA } from "../dist/access/schema.js";
import { accessCodeHash } from "../dist/access/store.js";

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "issue") {
    const [countValue, output, label = "서포터즈"] = args;
    const count = Number(countValue);
    if (!Number.isInteger(count) || count < 1 || count > 100 || !output)
      throw Error("Usage: node scripts/access-codes.mjs issue <1-100> <private-output.json> [label]");
    const file = await open(output, "wx", 0o600);
    try {
      const codes = Array.from({ length: count }, () => {
        const value = randomBytes(16).toString("hex").toUpperCase();
        return { id: randomUUID(), code: "STDN-" + value.match(/.{8}/g).join("-"), label };
      });
      // Save first so interruption cannot consume the only copy of a distributed code.
      await file.writeFile(JSON.stringify({ status: "pending_database_commit", codes }, null, 2) + "\n");
      await file.sync();
      await transaction(async db => {
        await db.query(ACCESS_SCHEMA);
        for (const entry of codes)
          await db.query("INSERT INTO supporter_access_codes(id,code_hash,label) VALUES($1,$2,$3)",
            [entry.id, accessCodeHash(entry.code), entry.label]);
      });
      await file.truncate(0);
      await file.write(JSON.stringify({ status: "issued", codes }, null, 2) + "\n", 0);
      await file.sync();
      console.log(JSON.stringify({ issued: count, output }));
    } finally { await file.close(); }
  } else if (command === "revoke") {
    const [id] = args;
    if (!/^[a-f0-9-]{36}$/.test(id ?? "")) throw Error("Usage: node scripts/access-codes.mjs revoke <code-id>");
    const result = await pool.query("UPDATE supporter_access_codes SET revoked_at=now() WHERE id=$1 RETURNING id", [id]);
    console.log(JSON.stringify({ revoked: result.rowCount }));
  } else throw Error("Commands: issue, revoke");
} catch (error) {
  // Never print connection strings or query parameters.
  console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Code operation failed. Check database access and the private output file.");
  process.exitCode = 1;
} finally { await pool.end(); }
