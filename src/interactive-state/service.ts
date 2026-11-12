import { checkSkinPreviewModel, type SkinPreview } from "../appearance/skin-preview.js";
import { nondefaultSkin, type Skin } from "../appearance/skin.js";
import { nonzeroAppearance, type Appearance } from "../appearance/model.js";
import { parsePacket, parseReceipt } from "./packet.js";
import { sha256Hex } from "../converter/client.js";
import { decodeFrame, type ClientFrame } from "./clientFrame.js";
import {
  InteractiveError,
  active,
  hash,
  type Location,
  type Operation,
  type Prepare,
  publicOperation,
  finalReceipt,
  outlineSourceOperation,
} from "./model.js";
import { OperationStore, type Stage } from "./store.js";
import type { ResolvedSelection } from "./selection.js";
import type { InteractiveWorker } from "./worker.js";
export interface PosterStorage {
  publish(
    op: Operation,
    png: Uint8Array,
  ): Promise<{ sha256: string; renderer: string }>;
  read(op: Operation): Promise<Uint8Array | null>;
  publishAuxiliary?(
    op: Operation,
    png: Uint8Array,
    sha256: string,
  ): Promise<void>;
}
export interface OutlineArtifacts {
  check(selection: ResolvedSelection, appearance?: Appearance): Promise<void>;
  prepare(op: Operation, selection: ResolvedSelection, source: Uint8Array, signal: AbortSignal): Promise<Record<string, unknown>>;
  file(op: Operation, selection: ResolvedSelection, signal?: AbortSignal): Promise<Uint8Array>;
}
export interface SkinApproval {
  /** Digest of exact manifest/version/model/UV/texture/runtime + certified target. */
  identity: string;
  supportedIds: Skin["id"][];
  preview?: SkinPreview;
}
export interface SkinArtifacts {
  previewAsset?(selection: ResolvedSelection, skin: Skin, digest: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }>;
  asset?(op: Operation, selection: ResolvedSelection, digest: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }>;
  check(selection: ResolvedSelection, skin?: Skin, appearance?: Appearance): Promise<SkinApproval>;
  prepare(op: Operation, selection: ResolvedSelection, source: Uint8Array, signal: AbortSignal): Promise<Record<string, unknown>>;
  file(op: Operation, selection: ResolvedSelection, signal?: AbortSignal): Promise<Uint8Array>;
}
export interface InteractiveDeps {
  skin?: SkinArtifacts;
  outline?: OutlineArtifacts;
  store: OperationStore;
  resolve(l: Location, candidateId: string): Promise<ResolvedSelection>;
  worker: InteractiveWorker;
  posters: PosterStorage;
  renderPoster(
    op: Operation,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  metric(
    event: string,
    stage: Stage | "download" | "validation",
    elapsedMs: number,
    code?: string,
    context?: { operationId: string; revision: number },
  ): void;
}
export class InteractiveService {
  private running = new Map<string, AbortController>();
  private stopped = false;
  constructor(readonly deps: InteractiveDeps) {}
  private async timed<T>(op: Operation, event: string, stage: Stage | "download" | "validation", action: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    let code: string | undefined;
    try { return await action(); }
    catch (error) {
      code = error instanceof InteractiveError ? error.code : "INTERACTIVE_UNAVAILABLE";
      throw error;
    } finally {
      this.deps.metric(event, stage, performance.now() - started, code,
        { operationId: op.operationId, revision: op.revision });
    }
  }
  private async consume<T>(
    op: Operation,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof InteractiveError &&
        error.code === "INTERACTIVE_EXPIRED"
      )
        await this.cancel(op, true);
      throw error;
    }
  }
  private async resolve(l: Location, candidateId: string, appearance?: Appearance, skin?: Skin) {
    const selection = await this.deps.resolve(l, candidateId);
    const normalized = nonzeroAppearance(appearance);
    const material = nondefaultSkin(skin);
    const approval = material ? await this.skin().check(selection, material, normalized) : undefined;
    return this.withAppearance(selection, normalized, material, approval);
  }
  private withAppearance(selection: ResolvedSelection, appearance?: Appearance, skin?: Skin, approval?: SkinApproval): ResolvedSelection & { skinPreview?: SkinPreview } {
    return appearance || skin ? { ...selection, ...(skin && approval?.preview ? { skinPreview: approval.preview } : {}), selectionHash: hash({ baseSelectionHash: selection.selectionHash, ...(appearance ? { appearance } : {}), ...(skin ? { skin, skinAssetIdentity: approval!.identity } : {}) }) } : selection;
  }
  async prepare(l: Location, input: Prepare) {
    const selection = await this.resolve(l, input.candidateId, input.appearance, input.skin);
    if (input.appearance) await this.outline().check(selection, input.appearance);
    const prepared = await this.deps.store.prepare(
      l,
      input,
      selection.selectionHash,
      "skinPreview" in selection ? selection.skinPreview : undefined,
    );
    try {
      await this.revalidate(prepared.op);
    } catch (e) {
      await this.cancel(prepared.op, true);
      throw e;
    }
    return prepared;
  }
  async head(l: Location, candidateId: string, appearance?: Appearance, skin?: Skin) {
    let selection = await this.deps.resolve(l, candidateId);
    const head = await this.deps.store.currentHead(l), normalized = nonzeroAppearance(appearance), material = nondefaultSkin(skin);
    let appearanceAvailable = false;
    if (this.deps.outline) {
      try { await this.deps.outline.check(selection, nonzeroAppearance(appearance)); appearanceAvailable = true; } catch { /* Fail closed capability only. */ }
    }
    let approval: SkinApproval | undefined;
    if (this.deps.skin) {
      try { approval = await this.deps.skin.check(selection, material, normalized); } catch { /* Fail closed capability only. */ }
    }
    if (!material || approval) selection = this.withAppearance(selection, normalized, material, approval);
    return {
      schemaVersion: "standin.interactive-http.v1",
      skinExport: { version: "fbx-skin-v1", available: !!approval, supportedIds: approval?.supportedIds ?? ["default"] },
      appearanceExport: { version: "fbx-outline-v1", available: appearanceAvailable },
      currentRevision: head?.revision ?? 0,
      currentStateHash: head?.stateHash ?? null,
      operation:
        head && (!material || approval) &&
        head.selectionHash === selection.selectionHash &&
        active(head) &&
        Date.parse(head.expiresAt) > this.deps.store.clock()
          ? publicOperation(head)
          : null,
    };
  }
  async current(l: Location, id: string) {
    const op = await this.deps.store.get(l, id);
    // Cancelled states are visible after ownership/current selection validation.
    await this.revalidate(op);
    return op;
  }
  async revalidate(op: Operation) {
    return this.timed(op, "artifact_revalidate", "validation", () => this.revalidateSelection(op));
  }
  private async revalidateSelection(op: Operation) {
    const selection = await this.resolve(op, op.candidateId, op.appearance, op.skin);
    if (op.skin && hash(op.skinPreview ?? null) !== hash(selection.skinPreview ?? null)) {
      await this.cancel(op, true);
      throw new InteractiveError("SKIN_BINDING_MISMATCH");
    }
    if (selection.selectionHash !== op.selectionHash) {
      await this.cancel(op, true);
      throw new InteractiveError("INTERACTIVE_SUPERSEDED");
    }
    const current = await this.deps.store.get(op, op.operationId);
    if (
      current.revision !== op.revision ||
      current.selectionHash !== op.selectionHash ||
      (op.stateHash && op.stateHash !== current.stateHash)
    )
      throw new InteractiveError("INTERACTIVE_SUPERSEDED");
    return selection;
  }
  async cancel(op: Operation, superseded = false) {
    this.running.get(op.operationId)?.abort();
    const next = await this.deps.store.cancel(op, superseded);
    // Do not let a slow/dead worker prevent durable cancellation and stale-file denial.
    void this.deps.worker.cancel(op).catch(() => {});
    return next ?? (await this.deps.store.get(op, op.operationId));
  }
  async requestExport(op: Operation) {
    await this.revalidate(op);
    if (!active(op)) throw new InteractiveError("INTERACTIVE_SUPERSEDED");
    if (op.previewState !== "authoritative" || !op.stateHash)
      throw new InteractiveError("INTERACTIVE_NOT_READY");
    if (["queued", "building", "ready"].includes(op.exportState)) return op;
    return (
      (await this.deps.store.update(op, {
        exportState: "queued",
        errorCode: null,
      })) ?? this.current(op, op.operationId)
    );
  }
  async model(op: Operation, signal?: AbortSignal) {
    if (!active(op) || !op.stateHash)
      throw new InteractiveError("INTERACTIVE_NOT_READY");
    const selection = await this.revalidate(op);
    const bytes = await this.consume(op, () =>
      this.deps.worker.model(op, signal),
    );
    if (bytes.length > 96 * 1024 * 1024)
      throw new InteractiveError("CONVERTER_INTEGRITY");
    let packet: unknown;
    try {
      packet = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new InteractiveError("CONVERTER_INTEGRITY");
    }
    const parsed = parsePacket(packet, op, selection);
    checkSkinPreviewModel(op.skinPreview, parsed.payload.model);
    await this.assertDeliverable(op);
    return bytes;
  }
  async file(op: Operation, signal?: AbortSignal) {
    if (!active(op) || op.exportState !== "ready" || !op.receipt)
      throw new InteractiveError("INTERACTIVE_NOT_READY");
    const selection = await this.revalidate(op);
    // Preserve the existing Converter handle/expiry fence even when final bytes are privately cached.
    if (op.appearance || op.skin) await this.verifiedFile(op, signal);
    const bytes = op.appearance || op.skin
      ? await this.postprocessedFile(op, selection, signal)
      : await this.verifiedFile(op, signal);
    await this.assertDeliverable(op);
    // This is HTTP delivery, not native disk persistence or an export-completed event.
    this.deps.metric("artifact_download_delivered", "download", 0);
    return bytes;
  }
  /** Read-only appearance overlays never prepare an operation or grant file permission. */
  async selectionSkinPreview(l: Location, candidateId: string, skin: Skin) {
    const selection = await this.deps.resolve(l, candidateId);
    const approval = await this.skin().check(selection, skin);
    if (!approval.preview) throw new InteractiveError("SKIN_UNSUPPORTED");
    const fresh = await this.deps.resolve(l, candidateId);
    if (fresh.selectionHash !== selection.selectionHash) throw new InteractiveError("PREVIEW_CHANGED");
    const query = new URLSearchParams({ candidateId, skin: JSON.stringify(skin), baseSelectionHash: selection.selectionHash });
    const base = `/v1/analysis/jobs/${l.jobId}/people/${l.personIndex}/selection-skin-assets`;
    const preview = approval.preview;
    return { baseSelectionHash: selection.selectionHash, skinPreview: { ...preview,
      uv: { ...preview.uv, url: `${base}/${preview.uv.sha256}?${query}` },
      texture: { ...preview.texture, url: `${base}/${preview.texture.sha256}?${query}` } } };
  }
  async selectionSkinAsset(l: Location, candidateId: string, skin: Skin, digest: string, baseSelectionHash: string, signal?: AbortSignal) {
    const selection = await this.deps.resolve(l, candidateId);
    if (selection.selectionHash !== baseSelectionHash) throw new InteractiveError("PREVIEW_CHANGED");
    if (!this.skin().previewAsset) throw new InteractiveError("SKIN_UNAVAILABLE", 503);
    const asset = await this.skin().previewAsset!(selection, skin, digest, signal);
    const fresh = await this.deps.resolve(l, candidateId);
    if (fresh.selectionHash !== selection.selectionHash) throw new InteractiveError("PREVIEW_CHANGED");
    return { ...asset, baseSelectionHash: selection.selectionHash };
  }
  async skinAsset(op: Operation, digest: string, signal?: AbortSignal) {
    if (!active(op) || !op.stateHash || !op.skin || !op.skinPreview || !this.deps.skin?.asset)
      throw new InteractiveError("INTERACTIVE_NOT_READY");
    const selection = await this.revalidate(op);
    const asset = await this.consume(op, () => this.skin().asset!(op, selection, digest, signal));
    await this.assertDeliverable(op);
    return asset;
  }
  async variants(op: Operation, signal?: AbortSignal) {
    if (!active(op) || op.exportState !== "ready" || !this.deps.worker.variants)
      throw new InteractiveError("INTERACTIVE_NOT_READY");
    await this.revalidate(op);
    const bytes = await this.consume(op, () =>
      this.deps.worker.variants!(op, signal),
    );
    if (bytes.length > 64 * 1024 * 1024)
      throw new InteractiveError("CONVERTER_INTEGRITY");
    await this.assertDeliverable(op);
    return bytes;
  }
  async clientFrame(op: Operation, frame: ClientFrame) {
    if (
      !active(op) ||
      !op.stateHash ||
      frame.stateHash !== op.stateHash ||
      frame.revision !== op.revision
    )
      throw new InteractiveError("INTERACTIVE_SUPERSEDED");
    await this.revalidate(op);
    const png = decodeFrame(frame);
    if (op.uiFrame) {
      if (op.uiFrame.sha256 !== frame.imageSha256)
        throw new InteractiveError("CLIENT_FRAME_ALREADY_STORED");
      return {
        schemaVersion: "standin.interactive-http.v1",
        revision: op.revision,
        stateHash: op.stateHash,
        source: "client-canvas-ui-auxiliary",
        imageSha256: frame.imageSha256,
        accuracyEvidence: false,
        fileSafetyEvidence: false,
      };
    }
    if (!this.deps.posters.publishAuxiliary)
      throw new InteractiveError("POSTER_STORAGE_UNAVAILABLE", 503);
    await this.deps.posters.publishAuxiliary(op, png, frame.imageSha256);
    await this.assertDeliverable(op);
    const updated = await this.deps.store.update(op, {
      uiFrame: {
        sha256: frame.imageSha256,
        renderer: frame.rendererVersion,
        cameraHash: frame.cameraHash,
      },
    });
    if (!updated) throw new InteractiveError("INTERACTIVE_SUPERSEDED");
    return {
      schemaVersion: "standin.interactive-http.v1",
      revision: op.revision,
      stateHash: op.stateHash,
      source: "client-canvas-ui-auxiliary",
      imageSha256: frame.imageSha256,
      accuracyEvidence: false,
      fileSafetyEvidence: false,
    };
  }
  async historyFrame(l: Location) {
    const op = await this.deps.store.frame(l);
    if (!op) throw new InteractiveError("NOT_FOUND", 404);
    const selection = await this.resolve(l, op.candidateId, op.appearance, op.skin);
    if (selection.selectionHash !== op.selectionHash)
      throw new InteractiveError("NOT_FOUND", 404);
    const bytes = await this.deps.posters.read(op);
    const current = await this.deps.store.frame(l),
      fresh = await this.resolve(l, op.candidateId, op.appearance, op.skin);
    if (
      !bytes ||
      current?.revision !== op.revision ||
      fresh.selectionHash !== op.selectionHash
    )
      throw new InteractiveError("NOT_FOUND", 404);
    return { op, bytes };
  }
  private verifyAppearanceBytes(bytes: Uint8Array, receipt: Record<string, unknown> | undefined, code: string) {
    const signature = Buffer.from(bytes.subarray(0, 23));
    if (!receipt || bytes.length > 30 * 1024 * 1024 ||
        bytes.length !== receipt.artifactBytes || sha256Hex(bytes) !== receipt.artifactSha256 ||
        !(signature.equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0")) || signature.subarray(0, 5).toString("ascii") === "; FBX"))
      throw new InteractiveError(code);
  }
  private skin() {
    if (!this.deps.skin) throw new InteractiveError("SKIN_DISABLED", 503);
    return this.deps.skin;
  }
  private async postprocessedFile(op: Operation, selection: ResolvedSelection, signal?: AbortSignal) {
    let bytes: Uint8Array | undefined;
    if (op.skin) {
      bytes = await this.consume(op, () => this.skin().file(op, selection, signal));
      this.verifyAppearanceBytes(bytes, op.skinReceipt, "SKIN_INTEGRITY_ERROR");
      outlineSourceOperation(op); // Enforce base → skin lineage even for skin-only downloads.
    }
    if (op.appearance) {
      const source = outlineSourceOperation(op);
      if (op.skin && op.outlineReceipt?.sourceArtifactSha256 !== source.receipt?.artifactSha256)
        throw new InteractiveError("SKIN_BINDING_MISMATCH");
      bytes = await this.consume(op, () => this.outline().file(source, selection, signal));
      this.verifyAppearanceBytes(bytes, op.outlineReceipt, "OUTLINE_INTEGRITY_ERROR");
    }
    if (!bytes) throw new InteractiveError("INTERACTIVE_NOT_READY");
    this.verifyAppearanceBytes(bytes, finalReceipt(op) ?? undefined, op.appearance ? "OUTLINE_INTEGRITY_ERROR" : "SKIN_INTEGRITY_ERROR");
    return bytes;
  }
  private outline() {
    if (!this.deps.outline) throw new InteractiveError("OUTLINE_DISABLED", 503);
    return this.deps.outline;
  }
  private async verifiedFile(op: Operation, signal?: AbortSignal) {
    const bytes = await this.consume(op, () =>
        this.deps.worker.file(op, signal),
      ),
      receipt = op.receipt;
    const binary = Buffer.from(bytes.subarray(0, 23)).equals(
      Buffer.from("Kaydara FBX Binary  \0\x1a\0"),
    );
    const ascii =
      Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "; FBX";
    if (
      !receipt ||
      bytes.length > 64 * 1024 * 1024 ||
      bytes.length !== receipt.artifactBytes ||
      sha256Hex(bytes) !== receipt.artifactSha256 ||
      (!binary && !ascii)
    )
      throw new InteractiveError("CONVERTER_INTEGRITY");
    return bytes;
  }
  async poster(op: Operation) {
    if (!op.poster || !active(op)) throw new InteractiveError("NOT_FOUND", 404);
    await this.revalidate(op);
    const bytes = await this.deps.posters.read(op);
    await this.assertDeliverable(op);
    if (!bytes) throw new InteractiveError("NOT_FOUND", 404);
    return bytes;
  }
  private async assertDeliverable(op: Operation) {
    await this.revalidate(op);
    const current = await this.deps.store.get(op, op.operationId);
    if (
      !active(current) ||
      (op.exportState === "ready" && current.exportState !== "ready")
    )
      throw new InteractiveError("INTERACTIVE_SUPERSEDED");
  }
  /** One durable slot each for solve/export/poster. Different loops never share a mutable scene. */
  async tick(stage: Stage) {
    if (this.stopped) return;
    const claim = await this.deps.store.claim(stage);
    if (!claim) return;
    let op = claim.op;
    const controller = new AbortController(),
      started = Date.now();
    this.running.set(op.operationId, controller);
    let checking = false,
      posterFailed = false;
    const guard = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.deps.store
        .heartbeat(op, claim.leaseId)
        .then((ok) => {
          if (!ok) controller.abort();
        })
        .catch(() => controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 1000);
    guard.unref();
    try {
      const selection = await this.revalidate(op);
      this.deps.metric(
        "artifact_prepare_started",
        stage,
        Date.now() - Date.parse(op.createdAt),
        undefined, { operationId: op.operationId, revision: op.revision },
      );
      if (stage === "preview") {
        const solved = await this.timed(op, "artifact_converter_solve", stage, () => this.deps.worker.solve(
          selection,
          op,
          controller.signal,
        ));
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(solved.snapshotId))
          throw new InteractiveError("CONVERTER_INTEGRITY");
        const validated = await this.timed(op, "artifact_packet_validation", stage,
          () => parsePacket(solved.packet, op, selection));
        checkSkinPreviewModel(op.skinPreview, validated.payload.model);
        if (controller.signal.aborted) return;
        await this.revalidate(op);
        const published = await this.deps.store.update(
          op,
          {
            stateHash: validated.packet.stateHash,
            snapshotId: solved.snapshotId,
            snapshotProof: validated.snapshotProof,
            previewState: "authoritative",
          },
          claim.leaseId,
        );
        if (!published) throw new InteractiveError("INTERACTIVE_SUPERSEDED");
      } else if (stage === "export") {
        const building = await this.deps.store.update(
          op,
          { exportState: "building" },
          claim.leaseId,
        );
        if (!building) return;
        op = building;
        const receipt = parseReceipt(
          await this.consume(op, () =>
            this.timed(op, "artifact_converter_export", stage, () => this.deps.worker.export(op, controller.signal)),
          ),
          op,
          selection,
        );
        if (controller.signal.aborted) return;
        await this.revalidate(op);
        let processed = { ...op, receipt }, source: Uint8Array | undefined;
        if (op.skin || op.appearance) source = await this.verifiedFile(processed, controller.signal);
        const skinReceipt = op.skin
          ? await this.skin().prepare(processed, selection, source!, controller.signal)
          : undefined;
        if (controller.signal.aborted) return;
        await this.revalidate(op);
        if (skinReceipt) {
          processed = { ...processed, skinReceipt };
          source = await this.skin().file(processed, selection, controller.signal);
          this.verifyAppearanceBytes(source, skinReceipt, "SKIN_INTEGRITY_ERROR");
          outlineSourceOperation(processed);
        }
        if (controller.signal.aborted) return;
        await this.revalidate(op);
        const outlineReceipt = op.appearance
          ? await this.outline().prepare(outlineSourceOperation(processed), selection, source!, controller.signal)
          : undefined;
        if (op.skin && outlineReceipt && outlineReceipt.sourceArtifactSha256 !== skinReceipt?.artifactSha256)
          throw new InteractiveError("SKIN_BINDING_MISMATCH");
        if (controller.signal.aborted) return;
        await this.revalidate(op);
        const published = await this.deps.store.update(
          op,
          { exportState: "ready", receipt, ...(outlineReceipt ? { outlineReceipt } : {}), ...(skinReceipt ? { skinReceipt } : {}) },
          claim.leaseId,
        );
        if (!published) throw new InteractiveError("INTERACTIVE_SUPERSEDED");
      } else {
        const bytes = op.appearance || op.skin
          ? await this.postprocessedFile(op, selection, controller.signal)
          : await this.verifiedFile(op, controller.signal);
        const png = await this.deps.renderPoster(op, bytes, controller.signal);
        if (controller.signal.aborted) return;
        await this.revalidate(op);
        const poster = await this.deps.posters.publish(op, png);
        await this.revalidate(op);
        const published = await this.deps.store.update(
          op,
          { poster },
          claim.leaseId,
        );
        if (!published) throw new InteractiveError("INTERACTIVE_SUPERSEDED");
      }
      this.deps.metric("artifact_prepare_ready", stage, Date.now() - started,
        undefined, { operationId: op.operationId, revision: op.revision });
    } catch (error) {
      const code =
        error instanceof InteractiveError
          ? error.code
          : "INTERACTIVE_WORKER_FAILED";
      if (!controller.signal.aborted) {
        if (stage === "poster") posterFailed = true;
        else
          await this.deps.store.update(
            op,
            stage === "preview"
              ? { previewState: "error", errorCode: code }
              : { exportState: "failed", errorCode: code },
            claim.leaseId,
          );
      }
      this.deps.metric(
        controller.signal.aborted
          ? "artifact_prepare_cancelled"
          : "artifact_prepare_failed",
        stage,
        Date.now() - started,
        code,
        { operationId: op.operationId, revision: op.revision },
      );
    } finally {
      clearInterval(guard);
      this.running.delete(op.operationId);
      await this.deps.store.release(
        op.operationId,
        claim.leaseId,
        posterFailed,
      );
    }
  }
  start() {
    this.stopped = false;
    const timers = (["preview", "export", "poster"] as const).map((stage) => {
      let pending = false;
      const timer = setInterval(() => {
        if (pending) return;
        pending = true;
        void this.tick(stage)
          .catch(() =>
            this.deps.metric(
              "artifact_queue_failed",
              stage,
              0,
              "INTERACTIVE_QUEUE_FAILED",
            ),
          )
          .finally(() => {
            pending = false;
          });
      }, 500);
      timer.unref();
      return timer;
    });
    const sweep = setInterval(
      () => void this.deps.store.sweep().catch(() => {}),
      60_000,
    );
    sweep.unref();
    return () => {
      this.stopped = true;
      timers.forEach(clearInterval);
      clearInterval(sweep);
      for (const c of this.running.values()) c.abort();
    };
  }
}
