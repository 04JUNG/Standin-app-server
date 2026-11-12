/**
 * Inference/Converter hand-library agreement with coalescing and bounded tolerance.
 *
 * A Converter that answers with a different library, solver, framing or scope set fails
 * closed at once and forgets the last agreement. Only an unavailable check (timeout,
 * network error, HTTP 429/5xx, catalog outage) may reuse an agreement verified within
 * `graceMs`. The Converter still rejects a changed library on every solve
 * (`hand library changed`), so tolerance never lets a mismatched library reach a file.
 */
import { randomUUID } from "node:crypto";
import { EXPECTED_SOLVER_VERSION } from "../converter/client.js";
import { FRAMING_VERSION } from "../converter/framing.js";
import { probeDeadline, probeOnce, type ProbeDeadline } from "../converter/probeDeadline.js";
import { log } from "../log.js";
import { HandError, record, type HandCatalog } from "./model.js";

export interface HandAgreementDeps {
  enabled: () => boolean;
  catalog: () => Promise<HandCatalog>;
  health: (init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
}
export interface HandAgreementOptions {
  /** Evidence age accepted by `fresh` reads (handBakeFor on prepare/poll/export). */
  freshMs?: number;
  /** Evidence age accepted by listing reads (catalog, selection). */
  cacheMs?: number;
  /** How long a verified agreement survives an unavailable check. */
  graceMs?: number;
  /** Responsive probe budget; event-loop stalls of this process are not counted. */
  probeTimeoutMs?: number;
  now?: () => number;
  deadline?: (budgetMs: number) => ProbeDeadline;
}

class Mismatch extends Error {}
const unavailable = () =>
  new HandError("HANDS_UNAVAILABLE", 503, "손 적용 서비스를 확인하지 못했습니다.");

export class HandAgreement {
  private verified?: { at: number; catalog: HandCatalog };
  private pending?: Promise<HandCatalog>;
  private readonly freshMs: number;
  private readonly cacheMs: number;
  private readonly graceMs: number;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;
  private readonly deadline: (budgetMs: number) => ProbeDeadline;
  constructor(
    private readonly deps: HandAgreementDeps,
    options: HandAgreementOptions = {},
  ) {
    this.freshMs = options.freshMs ?? 2000;
    this.cacheMs = options.cacheMs ?? 5000;
    this.graceMs = options.graceMs ?? 120_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.deadline = options.deadline ?? ((ms) => probeDeadline(ms));
  }

  async read(fresh = false): Promise<HandCatalog> {
    if (!this.deps.enabled())
      throw new HandError("HAND_SELECTION_DISABLED", 503, "손 선택을 사용할 수 없습니다.");
    const verified = this.verified;
    if (verified && this.now() - verified.at < (fresh ? this.freshMs : this.cacheMs))
      return verified.catalog;
    // Concurrent readers share one check; its evidence is never older than the probe start.
    this.pending ??= this.check().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async check(): Promise<HandCatalog> {
    const started = this.now();
    const probeRequestId = `req_${randomUUID()}`;
    const deadline = this.deadline(this.probeTimeoutMs);
    try {
      const catalog = await this.deps.catalog();
      const response = await probeOnce(
        () => this.deps.health({ signal: deadline.signal, headers: { "X-Request-Id": probeRequestId } }),
        deadline.signal,
      );
      // 429/5xx is the Converter saying "not now", not a different library.
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`health ${response.status}`);
      }
      let value: Record<string, unknown>;
      try {
        value = record(await response.json());
      } catch (error) {
        if (deadline.signal.aborted) throw error;
        throw new Mismatch("unreadable health");
      }
      const library = record(value.hand_library);
      if (
        value.ok !== true ||
        value.solver_version !== EXPECTED_SOLVER_VERSION ||
        value.framing_version !== FRAMING_VERSION ||
        !Array.isArray(value.output_scopes) ||
        !["full", "half", "bust", "head"].every((s) => (value.output_scopes as unknown[]).includes(s)) ||
        library.version !== catalog.library_version ||
        library.sha256 !== catalog.library_sha256
      )
        throw new Mismatch("hand library mismatch");
      this.verified = { at: this.now(), catalog };
      log.info({ type: "hand_readiness_probe", probeRequestId, outcome: "verified",
        durationMs: this.now() - started, stalledMs: Math.round(deadline.stalledMs()) });
      return catalog;
    } catch (error) {
      if (error instanceof HandError && error.code === "HAND_SELECTION_DISABLED") throw error;
      if (error instanceof Mismatch) {
        this.verified = undefined;
        log.warn({ type: "hand_readiness_probe_failed", probeRequestId, outcome: "mismatch",
          durationMs: this.now() - started });
        throw unavailable();
      }
      const errorCode = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
        ? error.name : error instanceof HandError ? error.code : "HANDS_UNAVAILABLE";
      const verified = this.verified;
      const ageMs = verified ? this.now() - verified.at : undefined;
      const tolerated = verified !== undefined && ageMs! <= this.graceMs;
      log.warn({ type: "hand_readiness_probe_failed", probeRequestId,
        outcome: tolerated ? "tolerated" : "unavailable", errorCode,
        durationMs: this.now() - started, stalledMs: Math.round(deadline.stalledMs()),
        ...(ageMs === undefined ? {} : { agreementAgeMs: ageMs }) });
      if (tolerated) return verified.catalog;
      throw error instanceof HandError ? error : unavailable();
    } finally {
      deadline.clear();
    }
  }
}
