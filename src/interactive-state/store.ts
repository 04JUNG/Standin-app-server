import { randomUUID } from "node:crypto";
import { transaction } from "../db.js";
import {
  InteractiveError,
  active,
  hash,
  type Location,
  type Operation,
  type Prepare,
} from "./model.js";
export interface Db {
  query<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
}
export type Transaction = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
export type Stage = "preview" | "export" | "poster";
export class OperationStore {
  constructor(
    readonly tx: Transaction = (fn) => transaction((c) => fn(c)),
    readonly clock = Date.now,
  ) {}
  async prepare(l: Location, input: Prepare, selectionHash: string) {
    return this.tx(async (db) => {
      // Same parent-row lock as selection/retention prevents resurrection during deletion.
      if (
        !(
          await db.query(
            `SELECT id FROM jobs WHERE id=$1 AND installation_id=$2 AND status='completed' FOR UPDATE`,
            [l.jobId, l.installationId],
          )
        ).rows.length
      )
        throw new InteractiveError("NOT_FOUND", 404);
      const old = (
        await db.query<{ value: Operation }>(
          `SELECT value FROM interactive_operations WHERE job_id=$1 AND person_index=$2 AND mutation_id=$3 AND installation_id=$4`,
          [l.jobId, l.personIndex, input.mutationId, l.installationId],
        )
      ).rows[0]?.value;
      const requestHash = hash(input);
      if (old) {
        if (
          old.requestHash !== requestHash ||
          old.selectionHash !== selectionHash
        )
          throw new InteractiveError("IDEMPOTENCY_CONFLICT");
        this.checkExpiry(old);
        const head = await this.head(db, l);
        if (head?.operation_id !== old.operationId || !active(old))
          throw new InteractiveError("INTERACTIVE_SUPERSEDED");
        return { op: old, replay: true };
      }
      const head = await this.head(db, l);
      const previous = head
        ? (
            await db.query<{ value: Operation }>(
              `SELECT value FROM interactive_operations WHERE id=$1`,
              [head.operation_id],
            )
          ).rows[0]?.value
        : undefined;
      if (
        (head?.revision ?? 0) !== input.expectedRevision ||
        (input.expectedStateHash !== null &&
          input.expectedStateHash !== previous?.stateHash)
      )
        throw new InteractiveError("REVISION_CONFLICT");
      // Debounce is a client optimisation. The durable per-person head guarantees latest wins.
      if (previous)
        await this.write(db, {
          ...previous,
          previewState: "superseded",
          exportState: "superseded",
          poster: null,
          eventSequence: previous.eventSequence + 1,
        });
      // Bound each install's queued/running immutable operations, independently of client debounce.
      const count = (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM interactive_operations WHERE installation_id=$1 AND value->>'previewState' NOT IN ('cancelled','superseded','error') AND (value->>'expiresAt')::timestamptz > now() AND (value->>'previewState'='solving' OR value->>'exportState' IN ('queued','building'))`,
          [l.installationId],
        )
      ).rows[0].n;
      if (count >= 20)
        throw new InteractiveError("INTERACTIVE_QUEUE_FULL", 429);
      const op: Operation = {
        ...l,
        candidateId: input.candidateId,
        ...(input.appearance ? { appearance: input.appearance } : {}),
        ...(input.skin ? { skin: input.skin } : {}),
        operationId: `op_${randomUUID()}`,
        revision: input.revision,
        selectionHash,
        stateHash: null,
        previewState: "solving",
        exportState: "not-requested",
        eventSequence: 1,
        expiresAt: new Date(this.clock() + 60 * 60_000).toISOString(),
        createdAt: new Date(this.clock()).toISOString(),
        mutationId: input.mutationId,
        requestHash,
        errorCode: null,
        snapshotProof: null,
        snapshotId: null,
        receipt: null,
        poster: null,
      };
      await db.query(
        `INSERT INTO interactive_operations(id,job_id,installation_id,person_index,mutation_id,value) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          op.operationId,
          l.jobId,
          l.installationId,
          l.personIndex,
          input.mutationId,
          JSON.stringify(op),
        ],
      );
      await db.query(
        `INSERT INTO interactive_heads(job_id,installation_id,person_index,operation_id,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id,person_index) DO UPDATE SET operation_id=$4,revision=$5`,
        [l.jobId, l.installationId, l.personIndex, op.operationId, op.revision],
      );
      return { op, replay: false };
    });
  }
  private async head(db: Db, l: Location) {
    const h = (
      await db.query<{ operation_id: string; revision: string | number }>(
        `SELECT operation_id,revision FROM interactive_heads WHERE job_id=$1 AND person_index=$2 AND installation_id=$3`,
        [l.jobId, l.personIndex, l.installationId],
      )
    ).rows[0];
    return h ? { ...h, revision: Number(h.revision) } : undefined;
  }
  private async write(db: Db, op: Operation) {
    await db.query(
      `UPDATE interactive_operations SET value=$2::jsonb WHERE id=$1`,
      [op.operationId, JSON.stringify(op)],
    );
    return op;
  }
  checkExpiry(op: Operation) {
    if (Date.parse(op.expiresAt) <= this.clock())
      throw new InteractiveError("INTERACTIVE_EXPIRED", 410);
  }
  async currentHead(l: Location) {
    return this.tx(async (db) => {
      const head = await this.head(db, l);
      if (!head) return null;
      return (
        (
          await db.query<{ value: Operation }>(
            `SELECT value FROM interactive_operations WHERE id=$1 AND installation_id=$2`,
            [head.operation_id, l.installationId],
          )
        ).rows[0]?.value ?? null
      );
    });
  }
  async get(l: Location, id: string) {
    return this.tx(async (db) => {
      const op = (
        await db.query<{ value: Operation }>(
          `SELECT value FROM interactive_operations WHERE id=$1 AND job_id=$2 AND installation_id=$3 AND person_index=$4`,
          [id, l.jobId, l.installationId, l.personIndex],
        )
      ).rows[0]?.value;
      if (!op) throw new InteractiveError("NOT_FOUND", 404);
      this.checkExpiry(op);
      if ((await this.head(db, l))?.operation_id !== id)
        throw new InteractiveError("INTERACTIVE_SUPERSEDED");
      return op;
    });
  }
  /** Head + lease fence old workers; eventSequence orders responses without losing unrelated UI metadata. */
  async update(
    op: Operation,
    patch: Partial<
      Pick<
        Operation,
        | "previewState"
        | "exportState"
        | "stateHash"
        | "snapshotId"
        | "snapshotProof"
        | "receipt"
        | "outlineReceipt"
        | "skinReceipt"
        | "poster"
        | "uiFrame"
        | "errorCode"
      >
    >,
    leaseId?: string,
  ) {
    return this.tx(async (db) => {
      if (
        !(
          await db.query(
            `SELECT id FROM jobs WHERE id=$1 AND installation_id=$2 FOR UPDATE`,
            [op.jobId, op.installationId],
          )
        ).rows.length
      )
        return null;
      const current = (
        await db.query<{ value: Operation }>(
          `SELECT o.value FROM interactive_operations o JOIN interactive_heads h ON h.operation_id=o.id WHERE o.id=$1 AND ($2::text IS NULL OR o.lease_id=$2) FOR UPDATE OF o`,
          [op.operationId, leaseId ?? null],
        )
      ).rows[0]?.value;
      if (
        !current ||
        !active(current) ||
        Date.parse(current.expiresAt) <= this.clock()
      )
        return null;
      if (
        patch.exportState === "queued" &&
        ["queued", "building", "ready"].includes(current.exportState)
      )
        return current;
      if (
        patch.uiFrame &&
        current.uiFrame &&
        patch.uiFrame.sha256 !== current.uiFrame.sha256
      )
        throw new InteractiveError("CLIENT_FRAME_ALREADY_STORED");
      if (
        patch.stateHash &&
        current.stateHash &&
        patch.stateHash !== current.stateHash
      )
        throw new InteractiveError("CONVERTER_INTEGRITY");
      const updated = await this.write(db, {
        ...current,
        ...patch,
        eventSequence: current.eventSequence + 1,
      });
      if (patch.poster) {
        const frame = { ...updated, receipt: null, outlineReceipt: undefined, skinReceipt: undefined, uiFrame: undefined };
        await db.query(
          `INSERT INTO interactive_history_frames(job_id,installation_id,person_index,revision,value) VALUES($1,$2,$3,$4,$5::jsonb)
          ON CONFLICT(job_id,person_index) DO UPDATE SET revision=$4,value=$5::jsonb WHERE interactive_history_frames.revision<$4`,
          [
            op.jobId,
            op.installationId,
            op.personIndex,
            op.revision,
            JSON.stringify(frame),
          ],
        );
      }
      return updated;
    });
  }
  async cancel(op: Operation, superseded = false) {
    return this.update(op, {
      previewState: superseded ? "superseded" : "cancelled",
      exportState: superseded ? "superseded" : "cancelled",
      poster: null,
    });
  }
  async claim(stage: Stage) {
    return this.tx(async (db) => {
      // Transactional lock plus durable leases bounds each stage across BFF replicas.
      await db.query(`SELECT pg_advisory_xact_lock(184943, $1)`, [
        stage === "preview" ? 1 : stage === "export" ? 2 : 3,
      ]);
      if (
        (
          await db.query(
            `SELECT id FROM interactive_operations WHERE lease_stage=$1 AND lease_until>now()`,
            [stage],
          )
        ).rows.length
      )
        return null;
      const condition =
        stage === "preview"
          ? `o.value->>'previewState'='solving'`
          : stage === "export"
            ? `o.value->>'previewState'='authoritative' AND o.value->>'exportState' IN ('queued','building')`
            : `o.value->>'previewState'='authoritative' AND o.value->>'exportState'='ready' AND o.value->'poster'='null'::jsonb AND NOT (o.value ? 'posterFailed')`;
      const row = (
        await db.query<{ value: Operation }>(
          `SELECT o.value FROM interactive_operations o JOIN interactive_heads h ON h.operation_id=o.id WHERE ${condition} AND (o.value->>'expiresAt')::timestamptz>now() AND (o.lease_until IS NULL OR o.lease_until<now()) ORDER BY o.value->>'createdAt' LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) return null;
      const leaseId = randomUUID();
      await db.query(
        `UPDATE interactive_operations SET lease_id=$2,lease_stage=$3,lease_until=now()+interval '30 seconds' WHERE id=$1`,
        [row.value.operationId, leaseId, stage],
      );
      return { op: row.value, leaseId };
    });
  }
  async heartbeat(op: Operation, lease: string) {
    return this.tx(async (db) => {
      const rows = await db.query(
        `UPDATE interactive_operations o SET lease_until=now()+interval '30 seconds' FROM interactive_heads h WHERE o.id=$1 AND o.lease_id=$2 AND h.operation_id=o.id AND o.value->>'previewState' NOT IN ('cancelled','superseded','error') AND (o.value->>'expiresAt')::timestamptz>now() RETURNING o.id`,
        [op.operationId, lease],
      );
      return rows.rows.length > 0;
    });
  }
  async release(id: string, lease: string, posterFailed = false) {
    await this.tx((db) =>
      db.query(
        `UPDATE interactive_operations SET lease_id=NULL,lease_stage=NULL,lease_until=NULL, value=CASE WHEN $3 THEN value||'{"posterFailed":true}'::jsonb ELSE value END WHERE id=$1 AND lease_id=$2`,
        [id, lease, posterFailed],
      ),
    );
  }
  async frame(l: Location) {
    return this.tx(
      async (db) =>
        (
          await db.query<{ value: Operation }>(
            `SELECT f.value FROM interactive_history_frames f
      JOIN interactive_heads h ON h.job_id=f.job_id AND h.person_index=f.person_index AND h.operation_id=f.value->>'operationId'
      WHERE f.job_id=$1 AND f.person_index=$2 AND f.installation_id=$3`,
            [l.jobId, l.personIndex, l.installationId],
          )
        ).rows[0]?.value ?? null,
    );
  }
  async sweep() {
    // Keep per-person monotonic revision heads until the parent job is deleted.
    await this.tx((db) =>
      db.query(
        `UPDATE interactive_operations SET value=(value-'receipt'-'poster'-'outlineReceipt'-'skinReceipt')||'{"receipt":null,"poster":null,"previewState":"cancelled","exportState":"cancelled"}'::jsonb WHERE (value->>'expiresAt')::timestamptz<now() AND value->>'previewState' NOT IN ('cancelled','superseded')`,
      ),
    );
  }
}
