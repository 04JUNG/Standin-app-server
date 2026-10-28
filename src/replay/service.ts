import { z } from "zod";
import type { ReplayStorage } from "./storage.js";
import {
  PROTOCOL,
  LIMITS,
  ReplayError,
  fail,
  parse,
  createSchema,
  chunkSchema,
  assetSchema,
  finishSchema,
  eventsBytes,
  base64,
  hash,
  checkPolicy,
  type ReplayPolicy,
} from "./policy.js";
import { inspectInputImage } from "../inputStorage.js";
export interface ReplayDb {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export type RunTransaction = <T>(
  fn: (db: ReplayDb) => Promise<T>,
) => Promise<T>;
interface Session {
  id: string;
  installation_id: string;
  app_session_id: string;
  authorization_mode: string;
  consent_id: string | null;
  environment: string;
  app_version: string;
  os: string;
  started_at: string | number;
  expires_at: Date | string;
  state: string;
  total_bytes: string | number;
  finish_json: z.infer<typeof finishSchema> | null;
}
interface Installation {
  id: string;
  revoked_at: string | null;
  deletion_requested_at: string | null;
  replay_withdrawn_at: string | null;
  quality_consent_id: string | null;
  quality_personal_data: boolean;
  quality_content_license: boolean;
}
interface Chunk {
  window_id: string;
  sequence: number;
  content_hash: string;
  object_key: string;
  bytes: number;
  start_ms: number;
  end_ms: number;
  metadata: z.infer<typeof chunkSchema>;
}
type AssetRef = Omit<z.infer<typeof assetSchema>, "dataBase64">;
interface Asset {
  asset_hash: string;
  object_key: string;
  bytes: number;
  mime: string;
  metadata: AssetRef & { references?: AssetRef[] };
  expires_at: string | Date;
}
export class ReplayService {
  constructor(
    public db: ReplayDb,
    private transaction: RunTransaction,
    public storage: ReplayStorage,
    public policy: ReplayPolicy,
    private now = () => Date.now(),
  ) {}
  private async installation(
    db: ReplayDb,
    id: string,
    mode: string,
    consentId?: string | null,
  ) {
    checkPolicy(this.policy, mode);
    const i = (
      await db.query<Installation>(
        "SELECT * FROM installations WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!i || i.revoked_at || i.deletion_requested_at || i.replay_withdrawn_at)
      return fail("REPLAY_AUTHORIZATION_DENIED", 403);
    // Honor withdrawals recorded before replay_withdrawn_at was introduced.
    const receipt = (
      await db.query<{ personal_data: boolean; content_license: boolean }>(
        "SELECT personal_data,content_license FROM quality_consent_receipts WHERE subject_hash=$1 ORDER BY recorded_at DESC,receipt_id DESC LIMIT 1",
        [hash(Buffer.from(id))],
      )
    ).rows[0];
    if (receipt && (!receipt.personal_data || !receipt.content_license))
      return fail("REPLAY_AUTHORIZATION_DENIED", 403);
    if (
      mode === "explicit" &&
      (!i.quality_personal_data ||
        !i.quality_content_license ||
        !i.quality_consent_id ||
        (consentId !== undefined && consentId !== i.quality_consent_id))
    )
      return fail("REPLAY_AUTHORIZATION_DENIED", 403);
    return i;
  }
  private async session(
    db: ReplayDb,
    id: string,
    installationId?: string,
    write = false,
  ) {
    // Lock installation before session, matching withdrawal lock order.
    const preview = (
      await db.query<Session>("SELECT * FROM replay_sessions WHERE id=$1", [id])
    ).rows[0];
    if (
      !preview ||
      (installationId && preview.installation_id !== installationId)
    )
      return fail("REPLAY_NOT_FOUND", 404);
    await this.installation(
      db,
      preview.installation_id,
      preview.authorization_mode,
      preview.consent_id,
    );
    const row = (
      await db.query<Session>(
        `SELECT * FROM replay_sessions WHERE id=$1 ${write ? "FOR UPDATE" : "FOR SHARE"}`,
        [id],
      )
    ).rows[0];
    if (!row) return fail("REPLAY_NOT_FOUND", 404);
    if (new Date(row.expires_at).getTime() <= this.now())
      return fail("REPLAY_EXPIRED", 410);
    if (row.environment !== this.policy.environment)
      return fail("REPLAY_AUTHORIZATION_DENIED", 403);
    return row;
  }
  async create(installationId: string, input: unknown) {
    const v = parse(createSchema, input);
    if (Math.abs(v.startedAt - this.now()) > 86400000)
      return fail("REPLAY_INVALID");
    return this.transaction(async (db) => {
      const i = await this.installation(
        db,
        installationId,
        v.authorizationMode,
      );
      // Serialize per-installation creation/quota accounting across BFF replicas.
      await db.query("SELECT id FROM installations WHERE id=$1 FOR UPDATE", [
        installationId,
      ]);
      const deleted = (
        await db.query("SELECT id FROM replay_tombstones WHERE id=$1", [
          v.replayId,
        ])
      ).rows[0];
      if (deleted) return fail("REPLAY_EXPIRED", 410);
      const existing = (
        await db.query<Session>(
          "SELECT * FROM replay_sessions WHERE id=$1 OR (installation_id=$2 AND app_session_id=$3)",
          [v.replayId, installationId, v.appSessionId],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.id !== v.replayId ||
          existing.installation_id !== installationId ||
          existing.app_session_id !== v.appSessionId ||
          Number(existing.started_at) !== v.startedAt ||
          existing.authorization_mode !== v.authorizationMode ||
          existing.app_version !== v.appVersion ||
          existing.os !== v.os
        )
          return fail("REPLAY_CONFLICT", 409);
        return this.summary(existing);
      }
      const day = new Date(this.now()).toISOString().slice(0, 10);
      await db.query(
        "INSERT INTO replay_daily_usage(installation_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [installationId, day],
      );
      const usage = (
        await db.query<{ sessions: number }>(
          "SELECT sessions FROM replay_daily_usage WHERE installation_id=$1 AND day=$2 FOR UPDATE",
          [installationId, day],
        )
      ).rows[0];
      if (usage.sessions >= 100) return fail("REPLAY_QUOTA_EXCEEDED", 429);
      await db.query(
        "UPDATE replay_daily_usage SET sessions=sessions+1 WHERE installation_id=$1 AND day=$2",
        [installationId, day],
      );
      const expires = new Date(this.now() + 14 * 86400000).toISOString();
      const row = (
        await db.query<Session>(
          `INSERT INTO replay_sessions(id,installation_id,app_session_id,authorization_mode,consent_id,policy_version,environment,app_version,os,started_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            v.replayId,
            installationId,
            v.appSessionId,
            v.authorizationMode,
            v.authorizationMode === "explicit" ? i.quality_consent_id : null,
            v.policyVersion,
            this.policy.environment,
            v.appVersion,
            v.os,
            v.startedAt,
            expires,
          ],
        )
      ).rows[0];
      return this.summary(row);
    });
  }
  summary(row: Session) {
    return {
      replayId: row.id,
      appSessionId: row.app_session_id,
      installationId: row.installation_id,
      authorizationMode: row.authorization_mode,
      environment: row.environment,
      appVersion: row.app_version,
      os: row.os,
      startedAt: Number(row.started_at),
      expiresAt: new Date(row.expires_at).toISOString(),
      state: row.state,
      totalBytes: Number(row.total_bytes),
    };
  }
  private async job(db: ReplayDb, session: Session, jobId?: string) {
    if (!jobId) return;
    const row = (
      await db.query<{
        id: string;
        created_at: string;
        input_stored_at: string | null;
      }>(
        `SELECT id,created_at,input_stored_at FROM jobs WHERE id=$1 AND installation_id=$2 FOR SHARE`,
        [jobId, session.installation_id],
      )
    ).rows[0];
    if (!row) return fail("REPLAY_NOT_FOUND", 404);
    // Recording copies may not extend the original rough's lifetime.
    const expires = new Date(
      Date.parse(row.input_stored_at ?? row.created_at) + 90 * 86400000,
    ).toISOString();
    if (Date.parse(expires) <= this.now()) return fail("REPLAY_EXPIRED", 410);
    await db.query(
      "UPDATE replay_sessions SET expires_at=LEAST(expires_at,$2::timestamptz) WHERE id=$1",
      [session.id, expires],
    );
    await db.query(
      "INSERT INTO replay_job_links(replay_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [session.id, jobId],
    );
  }
  private async budget(db: ReplayDb, s: Session, bytes: number) {
    // UPDATE lock prevents two recordings from exceeding the installation daily budget.
    await db.query("SELECT id FROM installations WHERE id=$1 FOR UPDATE", [
      s.installation_id,
    ]);
    if (Number(s.total_bytes) + bytes > LIMITS.sessionBytes)
      return fail("REPLAY_TOO_LARGE", 413);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    await db.query(
      "INSERT INTO replay_daily_usage(installation_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [s.installation_id, day],
    );
    const usage = (
      await db.query<{ bytes: string }>(
        "SELECT bytes FROM replay_daily_usage WHERE installation_id=$1 AND day=$2 FOR UPDATE",
        [s.installation_id, day],
      )
    ).rows[0];
    if (Number(usage.bytes) + bytes > LIMITS.installationDailyBytes)
      return fail("REPLAY_QUOTA_EXCEEDED", 429);
    await db.query(
      "UPDATE replay_daily_usage SET bytes=bytes+$3 WHERE installation_id=$1 AND day=$2",
      [s.installation_id, day, bytes],
    );
  }
  async chunk(
    installationId: string,
    id: string,
    windowId: string,
    sequence: number,
    input: unknown,
  ) {
    const v = parse(chunkSchema, input);
    const bytes = eventsBytes(v);
    if (
      v.endedOffsetMs < v.startedOffsetMs ||
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      sequence >= 4096
    )
      return fail("REPLAY_INVALID");
    if (v.surface === "capture" && !this.policy.captureEnabled)
      return fail("REPLAY_DISABLED", 403);
    return this.transaction(async (db) => {
      const s = await this.session(db, id, installationId, true);
      const events = JSON.parse(bytes.toString("utf8")) as {
        timestamp: number;
        data?: { tag?: string };
      }[];
      if (
        events.some(
          (e) =>
            e.timestamp < Number(s.started_at) - 5000 ||
            e.timestamp > Number(s.started_at) + LIMITS.sessionDurationMs,
        )
      )
        return fail("REPLAY_INVALID");
      if (
        !this.policy.captureEnabled &&
        events.some((e) => e.data?.tag === "capture_overlay")
      )
        return fail("REPLAY_DISABLED", 403);
      if (
        !this.policy.cspEnabled &&
        events.some((e) => e.data?.tag === "csp_result_captured")
      )
        return fail("REPLAY_DISABLED", 403);
      const old = (
        await db.query<Chunk>(
          "SELECT * FROM replay_chunks WHERE replay_id=$1 AND window_id=$2 AND sequence=$3",
          [id, windowId, sequence],
        )
      ).rows[0];
      if (old) {
        if (
          old.content_hash !== v.contentHash ||
          JSON.stringify(old.metadata) !== JSON.stringify(v)
        ) {
          // JSONB key order differs; compare canonical metadata rather than serialized key order.
          if (
            old.content_hash !== v.contentHash ||
            !same(old.metadata, metadata(v))
          )
            return fail("REPLAY_CONFLICT", 409);
        }
        return { accepted: true, duplicate: true, sequence };
      }
      if (s.state !== "recording") return fail("REPLAY_FINISHED", 409);
      await this.budget(db, s, bytes.length);
      await this.job(db, s, v.jobId);
      const streams = (
        await db.query<{ window_id: string; surface: string }>(
          "SELECT * FROM replay_streams WHERE replay_id=$1",
          [id],
        )
      ).rows;
      const stream = streams.find((r) => r.window_id === windowId);
      if (
        (stream && stream.surface !== v.surface) ||
        (!stream && streams.length >= LIMITS.maxStreams)
      )
        return fail("REPLAY_CONFLICT", 409);
      const chunks = (
        await db.query<{ n: string }>(
          "SELECT count(*) AS n FROM replay_chunks WHERE replay_id=$1",
          [id],
        )
      ).rows[0];
      if (Number(chunks.n) >= LIMITS.maxChunks)
        return fail("REPLAY_TOO_LARGE", 413);
      await db.query(
        "INSERT INTO replay_streams(replay_id,window_id,surface) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [id, windowId, v.surface],
      );
      const key = `replays/${id}/chunks/${windowId}/${sequence}.json`;
      await this.storage.put(key, bytes, "application/json");
      await db.query(
        "INSERT INTO replay_chunks(replay_id,window_id,sequence,content_hash,object_key,bytes,start_ms,end_ms,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          windowId,
          sequence,
          v.contentHash,
          key,
          bytes.length,
          v.startedOffsetMs,
          v.endedOffsetMs,
          JSON.stringify(metadata(v)),
        ],
      );
      await db.query(
        "UPDATE replay_sessions SET total_bytes=total_bytes+$2 WHERE id=$1",
        [id, bytes.length],
      );
      return { accepted: true, duplicate: false, sequence };
    });
  }
  async witnessArtifact(
    installationId: string,
    jobId: string,
    artifactHash: string,
  ) {
    if (
      !this.policy.enabled ||
      (this.policy.consentMode === "assumed" &&
        !["development", "staging"].includes(this.policy.environment))
    )
      return;
    await this.transaction(async (db) => {
      await this.installation(db, installationId, this.policy.consentMode);
      const job = (
        await db.query(
          "SELECT id FROM jobs WHERE id=$1 AND installation_id=$2 FOR SHARE",
          [jobId, installationId],
        )
      ).rows[0];
      if (!job) return fail("REPLAY_NOT_FOUND", 404);
      const active = (
        await db.query(
          "SELECT id FROM replay_sessions WHERE installation_id=$1 AND expires_at>now() LIMIT 1",
          [installationId],
        )
      ).rows[0];
      if (!active) return;
      await db.query(
        "INSERT INTO replay_artifact_receipts(job_id,artifact_hash) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [jobId, artifactHash],
      );
    });
  }
  async asset(
    installationId: string,
    id: string,
    assetHash: string,
    input: unknown,
  ) {
    const v = parse(assetSchema, input),
      bytes = base64(v.dataBase64);
    if (bytes.length > LIMITS.assetBytes) return fail("REPLAY_TOO_LARGE", 413);
    if (hash(bytes) !== assetHash) return fail("REPLAY_HASH_MISMATCH");
    if (
      (v.kind === "csp_result" && !this.policy.cspEnabled) ||
      (v.kind === "capture_background" && !this.policy.captureEnabled)
    )
      return fail("REPLAY_DISABLED", 403);
    if (v.kind === "csp_result" && (!v.jobId || !v.artifactHash))
      return fail("REPLAY_INVALID");
    try {
      if (v.contentType === "font/woff2") {
        if (bytes.subarray(0, 4).toString() !== "wOF2" || v.kind !== "font")
          return fail("REPLAY_INVALID");
      } else {
        const image = inspectInputImage(bytes, v.contentType);
        if (!image.size || image.size.width * image.size.height > 40000000)
          return fail("REPLAY_INVALID");
      }
    } catch (e) {
      if (e instanceof ReplayError) throw e;
      return fail("REPLAY_INVALID");
    }
    return this.transaction(async (db) => {
      const s = await this.session(db, id, installationId, true);
      const { dataBase64: _, ...meta } = v;
      if (v.kind === "csp_result") {
        const receipt = (
          await db.query(
            "SELECT r.job_id FROM replay_artifact_receipts r JOIN jobs j ON j.id=r.job_id WHERE r.job_id=$1 AND r.artifact_hash=$2 AND j.installation_id=$3 AND r.created_at>now()-interval '14 days'",
            [v.jobId, v.artifactHash, installationId],
          )
        ).rows[0];
        if (!receipt) return fail("REPLAY_ARTIFACT_UNVERIFIED", 409);
      }
      const existing = (
        await db.query<Asset>(
          "SELECT * FROM replay_assets WHERE replay_id=$1 AND asset_hash=$2",
          [id, assetHash],
        )
      ).rows[0];
      if (existing) {
        if (existing.mime !== v.contentType)
          return fail("REPLAY_CONFLICT", 409);
        const refs = existing.metadata.references ?? [existing.metadata];
        if (!refs.some((ref) => same(ref, meta))) {
          if (s.state !== "recording") return fail("REPLAY_FINISHED", 409);
          await this.job(db, s, v.jobId);
          if (refs.length >= 64) return fail("REPLAY_TOO_LARGE", 413);
          const expiry = new Date(
            Math.min(
              new Date(existing.expires_at).getTime(),
              v.sourceExpiresAt ? Date.parse(v.sourceExpiresAt) : Infinity,
            ),
          ).toISOString();
          if (Date.parse(expiry) <= this.now())
            return fail("REPLAY_EXPIRED", 410);
          await db.query(
            "UPDATE replay_assets SET metadata=$3,expires_at=$4 WHERE replay_id=$1 AND asset_hash=$2",
            [
              id,
              assetHash,
              JSON.stringify({
                ...existing.metadata,
                references: [...refs, meta],
              }),
              expiry,
            ],
          );
          await db.query(
            "UPDATE replay_sessions SET expires_at=LEAST(expires_at,$2::timestamptz) WHERE id=$1",
            [id, expiry],
          );
        }
        return this.assetSummary({ ...existing, metadata: meta }, id);
      }
      if (s.state !== "recording") return fail("REPLAY_FINISHED", 409);
      await this.budget(db, s, bytes.length);
      await this.job(db, s, v.jobId);
      const count = (
        await db.query<{ n: string }>(
          "SELECT count(*) AS n FROM replay_assets WHERE replay_id=$1",
          [id],
        )
      ).rows[0];
      if (Number(count.n) >= 512) return fail("REPLAY_TOO_LARGE", 413);
      const expiry = new Date(
        Math.min(
          new Date(s.expires_at).getTime(),
          v.sourceExpiresAt ? Date.parse(v.sourceExpiresAt) : Infinity,
        ),
      ).toISOString();
      if (Date.parse(expiry) <= this.now()) return fail("REPLAY_EXPIRED", 410);
      // Expiring originals in snapshots requires deletion of the recording, not a black image.
      await db.query(
        "UPDATE replay_sessions SET expires_at=LEAST(expires_at,$2::timestamptz) WHERE id=$1",
        [id, expiry],
      );
      const key = `replays/${id}/assets/${assetHash}`;
      await this.storage.put(key, bytes, v.contentType);
      const a = (
        await db.query<Asset>(
          "INSERT INTO replay_assets(replay_id,asset_hash,object_key,bytes,mime,metadata,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            id,
            assetHash,
            key,
            bytes.length,
            v.contentType,
            JSON.stringify(meta),
            expiry,
          ],
        )
      ).rows[0];
      await db.query(
        "UPDATE replay_sessions SET total_bytes=total_bytes+$2 WHERE id=$1",
        [id, bytes.length],
      );
      return this.assetSummary(a, id);
    });
  }
  private assetSummary(a: Asset, id: string) {
    return {
      assetId: a.asset_hash,
      contentHash: a.asset_hash,
      url: `replay-asset://${a.asset_hash}`,
      expiresAt: new Date(a.expires_at).toISOString(),
      mime: a.mime,
      ...a.metadata,
      ...(a.metadata.kind === "csp_result"
        ? {
            artifactBinding: "server_export_hash",
            selectionBinding: "client_reported",
          }
        : {}),
      adminUrl: `/v1/admin/replays/${id}/assets/${a.asset_hash}`,
    };
  }
  async finish(installationId: string, id: string, input: unknown) {
    const v = parse(finishSchema, input);
    if (
      new Set(v.streams.map((s) => s.windowInstanceId)).size !==
      v.streams.length
    )
      return fail("REPLAY_INVALID");
    return this.transaction(async (db) => {
      const s = await this.session(db, id, installationId, true);
      if (s.finish_json && !same(s.finish_json, v))
        return fail("REPLAY_CONFLICT", 409);
      const chunks = (
        await db.query<Chunk>(
          "SELECT * FROM replay_chunks WHERE replay_id=$1 ORDER BY window_id,sequence",
          [id],
        )
      ).rows;
      const gaps = sequenceGaps(chunks, v);
      const state = gaps.length ? "incomplete" : "complete";
      await db.query(
        "UPDATE replay_sessions SET state=$2,finish_json=$3 WHERE id=$1",
        [id, state, JSON.stringify(v)],
      );
      return { replayId: id, state, gaps };
    });
  }
  async remove(installationId: string, id?: string) {
    await this.transaction(async (db) => {
      // Deletion remains available regardless of enabled flag, expiry or authorization mode.
      await db.query("SELECT id FROM installations WHERE id=$1 FOR UPDATE", [
        installationId,
      ]);
      if (id)
        await db.query(
          "DELETE FROM replay_sessions WHERE id=$1 AND installation_id=$2",
          [id, installationId],
        );
      else {
        await db.query(
          "UPDATE installations SET replay_withdrawn_at=$2 WHERE id=$1",
          [installationId, new Date(this.now()).toISOString()],
        );
        await db.query("DELETE FROM replay_sessions WHERE installation_id=$1", [
          installationId,
        ]);
        await db.query("DELETE FROM replay_daily_usage WHERE installation_id=$1",[installationId]);
        await db.query("DELETE FROM replay_artifact_receipts WHERE job_id IN (SELECT id FROM jobs WHERE installation_id=$1)",[installationId]);
      }
    });
    await this.sweep();
    return { deleted: true };
  }
  async sweep() {
    await this.db.query(
      "DELETE FROM replay_artifact_receipts WHERE created_at < $1",
      [new Date(this.now() - 14 * 86400000).toISOString()],
    );
    await this.db.query(
      "DELETE FROM replay_tombstones WHERE expires_at <= $1",
      [new Date(this.now()).toISOString()],
    );
    await this.db.query(
      "DELETE FROM replay_daily_usage WHERE day < current_date - 2",
    );
    await this.db.query("DELETE FROM replay_sessions WHERE expires_at <= $1", [
      new Date(this.now()).toISOString(),
    ]);
    const rows = (
      await this.db.query<{ prefix: string }>(
        "SELECT prefix FROM replay_object_deletions ORDER BY queued_at LIMIT 100",
      )
    ).rows;
    for (const row of rows) {
      await this.storage.deletePrefix(row.prefix);
      await this.db.query(
        "DELETE FROM replay_object_deletions WHERE prefix=$1",
        [row.prefix],
      );
    }
  }
  async list(filters: Record<string, string | undefined>) {
    checkPolicy(this.policy, this.policy.consentMode);
    const values: unknown[] = [this.policy.environment];
    const conditions = [
      `s.environment=$1`,
      `s.expires_at>now()`,
      `i.revoked_at IS NULL`,
      `i.deletion_requested_at IS NULL`,
      `i.replay_withdrawn_at IS NULL`,
      "COALESCE((SELECT personal_data AND content_license FROM quality_consent_receipts qr WHERE qr.subject_hash=encode(sha256(convert_to(i.id,'UTF8')),'hex') ORDER BY recorded_at DESC,receipt_id DESC LIMIT 1),true)",
    ];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      conditions.push(sql.replace("?", `$${values.length}`));
    };
    if (this.policy.consentMode === "assumed")
      conditions.push("s.authorization_mode='assumed'");
    else
      conditions.push(
        "s.authorization_mode='explicit' AND i.quality_personal_data AND i.quality_content_license AND s.consent_id=i.quality_consent_id",
      );
    for (const [key, column] of Object.entries({
      installationId: "installation_id",
      environment: "environment",
      os: "os",
      appVersion: "app_version",
      appSessionId: "app_session_id",
    }))
      if (filters[key]) add(`s.${column}=?`, filters[key]);
    for (const key of ["from", "to"])
      if (filters[key]) {
        if (!Number.isFinite(Date.parse(filters[key]!)))
          return fail("REPLAY_INVALID");
        add(
          `s.created_at ${key === "from" ? ">=" : "<"} ?::timestamptz`,
          filters[key],
        );
      }
    if (filters.before) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(
          Buffer.from(filters.before, "base64url").toString("utf8"),
        );
      } catch {
        return fail("REPLAY_INVALID");
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        !Number.isFinite(Date.parse(cursor[0])) ||
        typeof cursor[1] !== "string" ||
        cursor[1].length > 128
      )
        return fail("REPLAY_INVALID");
      values.push(cursor[0], cursor[1]);
      conditions.push(
        `(s.created_at,s.id)<($${values.length - 1}::timestamptz,$${values.length}::text)`,
      );
    }
    if (filters.jobId)
      add(
        "EXISTS(SELECT 1 FROM replay_job_links l WHERE l.replay_id=s.id AND l.job_id=?)",
        filters.jobId,
      );
    if (filters.audience === "internal")
      conditions.push(
        "EXISTS(SELECT 1 FROM internal_installations x WHERE x.id=s.installation_id)",
      );
    else if (filters.audience === "unclassified")
      conditions.push(
        "NOT EXISTS(SELECT 1 FROM internal_installations x WHERE x.id=s.installation_id)",
      );
    for (const key of ["screen", "feature", "saveState"])
      if (filters[key])
        add(
          `EXISTS(SELECT 1 FROM replay_chunks c WHERE c.replay_id=s.id AND c.metadata->>'${key}'=?)`,
          filters[key],
        );
    if (filters.failed === "true")
      conditions.push(
        "EXISTS(SELECT 1 FROM replay_chunks c WHERE c.replay_id=s.id AND c.metadata->>'failed'='true')",
      );
    if (filters.failed === "false")
      conditions.push(
        "NOT EXISTS(SELECT 1 FROM replay_chunks c WHERE c.replay_id=s.id AND c.metadata->>'failed'='true')",
      );
    if (filters.surface)
      add(
        "EXISTS(SELECT 1 FROM replay_streams st WHERE st.replay_id=s.id AND st.surface=?)",
        filters.surface,
      );
    const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 100));
    values.push(limit + 1);
    const rows = (
      await this.db.query<Session & { created_at: Date | string }>(
        `SELECT s.* FROM replay_sessions s JOIN installations i ON i.id=s.installation_id WHERE ${conditions.join(" AND ")} ORDER BY s.created_at DESC,s.id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    return {
      protocolVersion: PROTOCOL,
      items: rows.slice(0, limit).map((s) => ({
        ...this.summary(s),
        createdAt: new Date(s.created_at).toISOString(),
      })),
      nextBefore:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify([
                new Date(rows[limit - 1].created_at).toISOString(),
                rows[limit - 1].id,
              ]),
            ).toString("base64url")
          : null,
    };
  }
  async manifest(id: string) {
    return this.transaction(async (db) => {
      const s = await this.session(db, id);
      const streams = (
        await db.query<{ window_id: string; surface: string }>(
          "SELECT * FROM replay_streams WHERE replay_id=$1 ORDER BY window_id",
          [id],
        )
      ).rows;
      const chunks = (
        await db.query<Chunk>(
          "SELECT * FROM replay_chunks WHERE replay_id=$1 ORDER BY window_id,sequence",
          [id],
        )
      ).rows;
      const assets = (
        await db.query<Asset>(
          "SELECT * FROM replay_assets WHERE replay_id=$1 ORDER BY asset_hash",
          [id],
        )
      ).rows;
      // Existing metrics remain authoritative. Replay does not write analytics_events.
      const timeline = (
        await db.query<{
          event_name: string;
          occurred_at: string;
          job_id: string | null;
          surface: string | null;
        }>(
          `SELECT event_name,occurred_at,job_id,properties_json::jsonb->>'surface' AS surface FROM analytics_events WHERE installation_id=$1 AND
      (job_id IN(SELECT job_id FROM replay_job_links WHERE replay_id=$2) OR properties_json::jsonb->>'sessionId'=$3)
      AND occurred_at::timestamptz >= to_timestamp($4::double precision/1000) AND occurred_at::timestamptz <= to_timestamp(($4::double precision+$5)/1000) ORDER BY occurred_at LIMIT 2000`,
          [
            s.installation_id,
            id,
            s.app_session_id,
            Number(s.started_at),
            LIMITS.sessionDurationMs,
          ],
        )
      ).rows;
      return {
        protocolVersion: PROTOCOL,
        session: this.summary(s),
        streams: streams.map((st) => ({
          windowInstanceId: st.window_id,
          surface: st.surface,
          chunks: chunks
            .filter((c) => c.window_id === st.window_id)
            .map((c) => ({
              sequence: c.sequence,
              bytes: c.bytes,
              ...c.metadata,
              url: `/v1/admin/replays/${id}/streams/${st.window_id}/chunks/${c.sequence}`,
            })),
        })),
        assets: assets.flatMap((a) =>
          (a.metadata.references ?? [a.metadata]).map((meta) =>
            this.assetSummary({ ...a, metadata: meta }, id),
          ),
        ),
        gaps: sequenceGaps(chunks, s.finish_json),
        timeline: timeline.map((t) => ({
          name: t.event_name,
          surface: t.surface,
          jobId: t.job_id,
          offsetMs: Date.parse(t.occurred_at) - Number(s.started_at),
        })),
        recordingMethod: "rrweb + capture_overlay_reconstruction",
        canvasStatus:
          "Only uploaded canvas_frame assets are available; DOM alone does not record WebGL.",
      };
    });
  }
  async read(
    id: string,
    kind: "chunk" | "asset",
    key: string,
    sequence?: number,
  ) {
    return this.transaction(async (db) => {
      await this.session(db, id);
      const row =
        kind === "asset"
          ? (
              await db.query<Asset>(
                "SELECT * FROM replay_assets WHERE replay_id=$1 AND asset_hash=$2",
                [id, key],
              )
            ).rows[0]
          : (
              await db.query<Chunk>(
                "SELECT * FROM replay_chunks WHERE replay_id=$1 AND window_id=$2 AND sequence=$3",
                [id, key, sequence],
              )
            ).rows[0];
      if (!row) return fail("REPLAY_NOT_FOUND", 404);
      if (
        "expires_at" in row &&
        new Date(row.expires_at).getTime() <= this.now()
      )
        return fail("REPLAY_EXPIRED", 410);
      let bytes: Uint8Array;
      try {
        bytes = await this.storage.get(row.object_key);
      } catch {
        return fail("REPLAY_STORAGE_UNAVAILABLE", 503);
      }
      const expected = "asset_hash" in row ? row.asset_hash : row.content_hash;
      if (hash(bytes) !== expected)
        return fail("REPLAY_STORAGE_UNAVAILABLE", 503);
      return { bytes, mime: "mime" in row ? row.mime : "application/json" };
    });
  }
}
function metadata(v: z.infer<typeof chunkSchema>) {
  const { events: _, data: __, ...rest } = v;
  return rest;
}
function same(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
export function sequenceGaps(
  chunks: Pick<Chunk, "window_id" | "sequence">[],
  finish: z.infer<typeof finishSchema> | null,
) {
  const gaps: {
    windowInstanceId: string;
    sequence?: number;
    reason: string;
  }[] = [];
  const ids = new Set([
    ...chunks.map((c) => c.window_id),
    ...(finish?.streams.map((s) => s.windowInstanceId) ?? []),
  ]);
  for (const window of ids) {
    const seqs = chunks
      .filter((c) => c.window_id === window)
      .map((c) => c.sequence);
    const declared = finish?.streams.find((s) => s.windowInstanceId === window);
    const max = declared?.lastSequence ?? Math.max(-1, ...seqs);
    for (let i = 0; i <= max; i++)
      if (!seqs.includes(i))
        gaps.push({
          windowInstanceId: window,
          sequence: i,
          reason: "missing_chunk",
        });
    if (!declared)
      gaps.push({ windowInstanceId: window, reason: "upload_incomplete" });
    if (seqs.some((i) => i > max))
      gaps.push({
        windowInstanceId: window,
        reason: "finish_sequence_conflict",
      });
  }
  if (!ids.size)
    gaps.push({ windowInstanceId: "none", reason: "not_collected" });
  return gaps;
}
