import { randomUUID } from "node:crypto";
import { transaction } from "../db.js";
import type { Db, Transaction } from "../interactive-state/store.js";
import { active, hash, PreparationError, type Batch, type Owner, type Prepare } from "./model.js";
/** Durable job-wide single flight and one global worker reservation across BFF replicas. */
export class PreparationStore {
  constructor(readonly tx: Transaction = fn => transaction(c => fn(c)), readonly clock = Date.now) {}
  private async owned(db: Db, l: Owner) {
    if (!(await db.query(`SELECT id FROM jobs WHERE id=$1 AND installation_id=$2 AND status='completed' FOR UPDATE`,
      [l.jobId, l.installationId])).rows.length) throw new PreparationError("NOT_FOUND", 404);
  }
  async head(l: Owner) {
    return this.tx(async db => {
      await this.owned(db, l);
      return (await db.query<{ value: Batch }>(`SELECT b.value FROM candidate_preparation_heads h
        JOIN candidate_preparation_batches b ON b.id=h.batch_id WHERE h.job_id=$1 AND h.installation_id=$2`,
      [l.jobId, l.installationId])).rows[0]?.value ?? null;
    });
  }
  async get(l: Owner, id: string) {
    const b = await this.head(l);
    if (!b || b.batchId !== id) throw new PreparationError("PREPARATION_SUPERSEDED");
    if (Date.parse(b.expiresAt) <= this.clock()) throw new PreparationError("PREPARATION_EXPIRED", 410);
    return b;
  }
  async prepare(l: Owner, input: Prepare, draft: Omit<Batch, "batchId" | "revision" | "input"> & { input: Batch["input"] }) {
    return this.tx(async db => {
      // Installation then job matches deletion/selection lock order.
      await db.query("SELECT id FROM installations WHERE id=$1 FOR UPDATE", [l.installationId]);
      await this.owned(db, l);
      const head = (await db.query<{ value: Batch }>(`SELECT b.value FROM candidate_preparation_heads h
        JOIN candidate_preparation_batches b ON b.id=h.batch_id WHERE h.job_id=$1 AND h.installation_id=$2`,
      [l.jobId, l.installationId])).rows[0]?.value;
      const previous = (await db.query<{ request_hash: string; batch_id: string }>(
        `SELECT request_hash,batch_id FROM candidate_preparation_mutations WHERE job_id=$1 AND installation_id=$2 AND mutation_id=$3`,
        [l.jobId, l.installationId, input.mutationId])).rows[0];
      const requestHash = hash({ input, context: draft.contextHash });
      if (previous) {
        if (previous.request_hash !== requestHash) throw new PreparationError("IDEMPOTENCY_CONFLICT");
        if (head?.batchId !== previous.batch_id || !active(head)) throw new PreparationError("PREPARATION_SUPERSEDED");
        if (Date.parse(head.expiresAt) <= this.clock()) throw new PreparationError("PREPARATION_EXPIRED", 410);
        return { batch: head, replay: true };
      }
      // Fullscreen/bar and reentry requests share the same in-flight/result, even with distinct mutation IDs.
      const reusable = head && active(head) && head.contextHash === draft.contextHash &&
        Date.parse(head.expiresAt) > this.clock() &&
        (!head.retryAfter || Date.parse(head.retryAfter) > this.clock());
      if (!reusable && (head?.revision ?? 0) !== input.expectedRevision) throw new PreparationError("REVISION_CONFLICT");
      if (reusable) {
        await this.remember(db, l, input.mutationId, requestHash, head.batchId);
        return { batch: head, replay: true };
      }
      const count = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM candidate_preparation_batches
        WHERE installation_id=$1 AND id<>$2 AND value->>'status' IN ('queued','running') AND (value->>'expiresAt')::timestamptz>now()`,
      [l.installationId, head?.batchId ?? ''])).rows[0].n;
      if (count >= 2) throw new PreparationError("PREPARATION_QUEUE_FULL", 429);
      await db.query("SELECT pg_advisory_xact_lock(184945,1)");
      const globalCount = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM candidate_preparation_batches
        WHERE id<>$1 AND value->>'status' IN ('queued','running') AND (value->>'expiresAt')::timestamptz>now()`,
        [head?.batchId ?? ''])).rows[0].n;
      if (globalCount >= 20) throw new PreparationError("PREPARATION_QUEUE_FULL", 429);
      if (head && active(head)) await this.write(db, this.closed(head, "invalidated"));
      const id = `prep_${randomUUID()}`;
      const b: Batch = { ...draft, batchId: id, revision: (head?.revision ?? 0) + 1,
        input: { ...draft.input, batch_id: id } };
      await db.query(`INSERT INTO candidate_preparation_batches(id,job_id,installation_id,context_hash,value) VALUES($1,$2,$3,$4,$5::jsonb)`,
        [id, l.jobId, l.installationId, b.contextHash, JSON.stringify(b)]);
      await db.query(`INSERT INTO candidate_preparation_heads(job_id,installation_id,batch_id,revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(job_id) DO UPDATE SET batch_id=$3,revision=$4`, [l.jobId, l.installationId, id, b.revision]);
      await this.remember(db, l, input.mutationId, requestHash, id);
      return { batch: b, replay: false };
    });
  }
  private async remember(db: Db, l: Owner, mutation: string, request: string, batch: string) {
    await db.query(`INSERT INTO candidate_preparation_mutations(job_id,installation_id,mutation_id,request_hash,batch_id) VALUES($1,$2,$3,$4,$5)`,
      [l.jobId, l.installationId, mutation, request, batch]);
  }
  private async write(db: Db, b: Batch) {
    await db.query("UPDATE candidate_preparation_batches SET value=$2::jsonb WHERE id=$1", [b.batchId, JSON.stringify(b)]);
    return b;
  }
  private closed(b: Batch, status: "cancelled" | "invalidated"): Batch {
    return { ...b, status, eventSequence: b.eventSequence + 1,
      candidates: b.candidates.map(c => ({ ...c, status, bvh: null, modelSha256: null, modelBytes: null })) };
  }
  async close(b: Batch, status: "cancelled" | "invalidated") {
    return this.update(b, current => this.closed(current, status));
  }
  async update(b: Batch, apply: (current: Batch) => Batch, lease?: string) {
    return this.tx(async db => {
      const job = await db.query("SELECT id FROM jobs WHERE id=$1 AND installation_id=$2 FOR UPDATE", [b.jobId, b.installationId]);
      if (!job.rows.length) return null;
      const row = (await db.query<{ value: Batch }>(`SELECT b.value FROM candidate_preparation_batches b
        JOIN candidate_preparation_heads h ON h.batch_id=b.id WHERE b.id=$1 AND ($2::text IS NULL OR b.lease_id=$2)
        FOR UPDATE OF b`, [b.batchId, lease ?? null])).rows[0];
      if (!row || !active(row.value) || Date.parse(row.value.expiresAt) <= this.clock()) return null;
      const next = apply(row.value);
      return this.write(db, { ...next, eventSequence: row.value.eventSequence + 1 });
    });
  }
  async claim() {
    return this.tx(async db => {
      await db.query("SELECT pg_advisory_xact_lock(184944,1)");
      // Do not release the slot merely because cancellation removed the head. Remote work still must settle.
      if ((await db.query("SELECT id FROM candidate_preparation_batches WHERE lease_until>now()")).rows.length) return null;
      const row = (await db.query<{ value: Batch }>(`SELECT b.value FROM candidate_preparation_batches b
        JOIN candidate_preparation_heads h ON h.batch_id=b.id
        WHERE (b.value->>'expiresAt')::timestamptz>now() AND (lease_until IS NULL OR lease_until<now())
          AND b.value->>'status' IN ('queued','running')
        ORDER BY b.created_at
        LIMIT 1 FOR UPDATE OF b SKIP LOCKED`)).rows[0]?.value;
      if (!row) return null;
      const leaseId = randomUUID();
      await db.query(`UPDATE candidate_preparation_batches SET lease_id=$2,lease_until=now()+interval '30 seconds' WHERE id=$1`,
        [row.batchId, leaseId]);
      return { batch: row, leaseId };
    });
  }
  async heartbeat(b: Batch, lease: string) {
    return this.tx(async db => !!(await db.query(`UPDATE candidate_preparation_batches b SET lease_until=now()+interval '30 seconds'
      FROM candidate_preparation_heads h WHERE b.id=$1 AND b.lease_id=$2 AND h.batch_id=b.id AND b.value->>'status' NOT IN ('cancelled','invalidated')
      AND (b.value->>'expiresAt')::timestamptz>now() RETURNING b.id`, [b.batchId, lease])).rows.length);
  }
  async release(id: string, lease: string) {
    await this.tx(db => db.query(`UPDATE candidate_preparation_batches SET lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2`, [id, lease]));
  }
}
