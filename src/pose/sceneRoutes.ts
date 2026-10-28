import { SCENE_MANIFEST_VERSION, sceneManifest, scenePeople, type SceneManifest } from "./sceneManifest.js";
import { log } from "../log.js";
import { SCENE_SAVE_CONTRACT, SCENE_REVIEW_VERSION, SCENE_REVIEW_TTL_MS, SceneError, sceneErrorDetails } from "./sceneContract.js";
import { loadSceneReceipt, saveSceneReceipt, sceneReceiptStorageAvailable, type SceneReceipt } from "./sceneStorage.js";
import { renderFinalPreview } from "../converter/finalPreview.js";
import { randomBytes } from "node:crypto";
import { prepareRefinedScene, type RefinedScene } from "./sceneRefinement.js";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getOwnedJob } from "../jobs/store.js";
import { validateConfirmedSelection } from "../analytics/store.js";
import { config } from "../config.js";
import {
  ConverterError,
  converterEnabled,
  sha256Hex,
} from "../converter/client.js";
import { composeRoughScene, type SceneSource } from "../converter/scene.js";
import { errorEnvelope } from "../mapping.js";
import { CLIENT_VERSION_HEADER } from "../client-version/policy.js";

const defaults = {
  loadSceneReceipt, saveSceneReceipt,
  receiptStorageAvailable: sceneReceiptStorageAvailable,
  renderFinalPreview,
  getOwnedJob,
  validateConfirmedSelection,
  composeRoughScene,
  prepareRefinedScene,
  refinementEnabled: () =>
    sceneReceiptStorageAvailable() &&
    config.sceneRefinementEnabled &&
    !!config.sceneRefinementBaseUrl &&
    !!config.sceneRefinementToken,
  enabled: () => config.sceneExportEnabled && converterEnabled(),
};
// Bounded development/cache receipts. Shared publication completes before a key is returned.
const receiptCacheKey = (owner: string, job: string, key: string) => `${owner}/${job}/${key}`;
const MAX_RECEIPT_BYTES = 256 * 1024 * 1024;
async function remember(
  receipts: Map<string, SceneReceipt>, binding: string, scene: RefinedScene,
  owner: string, job: string, save: typeof saveSceneReceipt, manifest: SceneManifest,
) {
  const key = randomBytes(24).toString("hex");
  const receipt: SceneReceipt = { manifest, reviewVersion: SCENE_REVIEW_VERSION, binding, scene, expires: Date.now() + SCENE_REVIEW_TTL_MS };
  await save(owner, job, key, receipt);
  for (const [k, v] of receipts) if (v.expires < Date.now()) receipts.delete(k);
  let size = scene.bytes.length + scene.preview.length;
  for (const v of receipts.values())
    size += v.scene.bytes.length + v.scene.preview.length;
  while (size > MAX_RECEIPT_BYTES && receipts.size) {
    const key = receipts.keys().next().value!;
    const v = receipts.get(key)!;
    size -= v.scene.bytes.length + v.scene.preview.length;
    receipts.delete(key);
  }
  if (size > MAX_RECEIPT_BYTES)
    throw new SceneError("SCENE_UNAVAILABLE", "scene review exceeds memory budget");
  receipts.set(receiptCacheKey(owner, job, key), receipt);
  return { key, receipt };
}
export function createSceneRoutes(
  dispatch: (request: Request) => Response | Promise<Response>,
  overrides: Partial<typeof defaults> = {},
) {
  const deps = { ...defaults, ...overrides };
  const routes = new Hono<AppEnv>();
  // Per application, never a module-global cross-owner/replica registry.
  const receipts = new Map<string, SceneReceipt>();
  routes.post("/:jobId/scene", async (c) => {
    const started = Date.now();
    let allowOriginal = false;
    let serverOperationMayContinue: boolean | undefined;
    const fail = (
      status: 400 | 409 | 502 | 503 | 504,
      code: string,
      message: string,
    ) => {
      log.info({ type: "scene_save_failed", jobId: c.req.param("jobId"), requestId: c.get("requestId"),
        phase: "scene_prepare", errorCode: code, durationMs: Date.now() - started });
      c.header("Cache-Control", "private, no-store");
      return c.json(errorEnvelope(code, message, c.get("requestId"), sceneErrorDetails(code, allowOriginal, serverOperationMayContinue)), status);
    };
    if (!deps.enabled())
      return fail(
        503,
        "SCENE_UNAVAILABLE",
        "지금은 장면 FBX 저장을 사용할 수 없습니다.",
      );
    const owner = c.get("installationId")!,
      jobId = c.req.param("jobId");
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      return fail(400, "INVALID_INPUT", "저장할 인물을 다시 선택해 주세요.");
    }
    const input = value as {
      contractVersion?: unknown;
      saveMode?: unknown;
      reviewVersion?: unknown;
      artifactSha256?: unknown;
      persons?: unknown;
      prepare?: unknown;
      reviewKey?: unknown;
      preview?: unknown;
      artifactOnly?: unknown;
      manifestVersion?: unknown;
      metadataOnly?: unknown;
      excludedPersonIds?: unknown;
      partialConfirmation?: unknown;
    } | null;
    if (
      !input ||
      (input.artifactOnly !== undefined && typeof input.artifactOnly !== "boolean") ||
      !Array.isArray(input.persons) ||
      input.persons.length < 1 ||
      input.persons.length > 8
    )
      return fail(
        400,
        "INVALID_INPUT",
        "한 장면에는 1~8명을 저장할 수 있습니다.",
      );
    const manifestRequest = input.manifestVersion !== undefined;
    if (manifestRequest && input.manifestVersion !== SCENE_MANIFEST_VERSION)
      return fail(409, "SCENE_CONTRACT_UNSUPPORTED", "장면 정보 버전을 다시 확인해 주세요.");
    if (input.metadataOnly !== undefined && (input.metadataOnly !== true || !manifestRequest || input.prepare === true || input.preview !== undefined))
      return fail(400, "INVALID_INPUT", "장면 정보 조회 요청을 다시 확인해 주세요.");
    if (input.excludedPersonIds !== undefined && (!Array.isArray(input.excludedPersonIds) ||
        input.excludedPersonIds.some(v => !Number.isInteger(v)) || new Set(input.excludedPersonIds).size !== input.excludedPersonIds.length))
      return fail(400, "INVALID_INPUT", "제외할 인물을 다시 확인해 주세요.");
    const excludedIds = [...(input.excludedPersonIds ?? []) as number[]].sort((a, b) => a - b);
    const explicit = input.contractVersion !== undefined || input.saveMode !== undefined;
    const reviewRequest = [input.prepare, input.reviewKey, input.preview, input.artifactOnly,
      input.reviewVersion, input.artifactSha256].some(v => v !== undefined);
    if ((explicit && (input.contractVersion !== SCENE_SAVE_CONTRACT ||
        (input.saveMode !== "original-selection" && input.saveMode !== "auto-correct-v4"))) ||
        (!explicit && reviewRequest))
      return fail(409, "SCENE_CONTRACT_UNSUPPORTED", "저장 방식을 다시 확인해 주세요.");
    const refined = explicit && input.saveMode === "auto-correct-v4";
    const saveMode = refined ? "auto-correct-v4" as const : "original-selection" as const;
    const receiptFlow = refined || manifestRequest;
    if (manifestRequest && !explicit)
      return fail(409, "SCENE_CONTRACT_UNSUPPORTED", "저장 방식을 다시 확인해 주세요.");
    if (manifestRequest && !deps.receiptStorageAvailable())
      return fail(503, "SCENE_UNAVAILABLE", "장면 정보를 보관할 수 없습니다.");
    if (!receiptFlow && reviewRequest)
      return fail(400, "INVALID_INPUT", "기본 통합 저장에는 보정 검수 정보를 보낼 수 없습니다.");
    if (receiptFlow && ((input.prepare !== undefined && input.prepare !== true) ||
        (input.preview !== undefined && input.preview !== true) ||
        (input.prepare === true && (input.reviewKey !== undefined || input.preview !== undefined ||
          input.reviewVersion !== undefined || input.artifactSha256 !== undefined)) ||
        (input.prepare !== true && input.artifactOnly !== undefined)))
      return fail(400, "INVALID_INPUT", "장면 준비와 확인 요청을 구분해 주세요.");
    if (receiptFlow && input.prepare !== true && input.reviewVersion !== SCENE_REVIEW_VERSION)
      return fail(409, "SCENE_CONTRACT_UNSUPPORTED", "최종 장면 확인 버전을 다시 확인해 주세요.");
    if (receiptFlow && input.prepare !== true &&
        (typeof input.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.artifactSha256)))
      return fail(400, "INVALID_INPUT", "확인한 장면의 SHA가 필요합니다.");
    allowOriginal = refined;
    if (refined && !deps.refinementEnabled())
      return fail(503, "SCENE_UNAVAILABLE", "장면 보정을 사용할 수 없습니다.");
    const job = await deps.getOwnedJob(jobId, owner);
    if (
      !job?.result?.image ||
      job.status !== "completed" ||
      job.result.source === "semantic"
    ) {
      allowOriginal = false;
      return fail(
        409,
        "SCENE_OBSERVATION_MISSING",
        "러프의 인물 위치를 찾지 못했습니다. 다시 분석해 주세요.",
      );
    }
    if (refined && !job.inputS3Key)
      return fail(503, "SCENE_UNAVAILABLE", "원본이 보관된 작업에서 장면 보정을 다시 요청해 주세요.");

    const image = job.result.image;
    const seen = new Set<number>();
    const refs: {
      personIndex: number;
      candidateId: string;
      exportPath: string;
      sha256: string;
    }[] = [];
    const sources: SceneSource[] = [];
    try {
      for (const raw of input.persons) {
        const row = raw as (typeof refs)[number];
        if (
          !row ||
          !Number.isInteger(row.personIndex) ||
          seen.has(row.personIndex) ||
          typeof row.candidateId !== "string" ||
          typeof row.exportPath !== "string" ||
          typeof row.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.sha256)
        )
          return fail(
            400,
            "INVALID_INPUT",
            "저장할 인물 정보가 올바르지 않습니다.",
          );
        seen.add(row.personIndex);
        const person = job.result.candidatesByPerson.find(
          (p) => p.personIndex === row.personIndex,
        );
        const candidate = person?.candidates.find(
          (p) => p.id === row.candidateId,
        );
        if (
          !person ||
          !candidate ||
          !person.box ||
          person.box.length !== 4 ||
          !(await deps.validateConfirmedSelection(
            owner,
            jobId,
            row.personIndex,
            row.candidateId,
          ))
        )
          return fail(
            409,
            "INVALID_EXPORT",
            "확정한 인물과 후보를 다시 확인해 주세요.",
          );
        // Unselected generation alternatives cannot disable library exports.
        // Generated artifacts still require their own approval/export contract.
        if (candidate.source === "generation")
          return fail(409, "GENERATED_INDIVIDUAL_ONLY", "새로 만든 포즈는 인물별로 저장해 주세요.");
        // Local dispatch reuses every existing body/hand/scope/review/lineage guard.
        // This is never a network request to a client-supplied URL.
        const url = new URL(row.exportPath, "https://scene.internal");
        const prefix = `/v1/pose-candidates/${encodeURIComponent(candidate.poseId!)}/`;
        if (
          url.origin !== "https://scene.internal" ||
          !row.exportPath.startsWith("/v1/") ||
          url.hash ||
          ![prefix + "framed", prefix + "export"].includes(url.pathname) ||
          Object.keys(Object.fromEntries(url.searchParams)).some(
            (key) => url.searchParams.getAll(key).length !== 1,
          ) ||
          url.searchParams.get("jobId") !== jobId ||
          url.searchParams.get("personIndex") !== String(row.personIndex) ||
          url.searchParams.get("candidateId") !== row.candidateId ||
          url.searchParams.get("format") !== "fbx"
        )
          return fail(400, "INVALID_INPUT", "확인한 FBX 저장 경로가 아닙니다.");
        const headers = new Headers();
        for (const key of ["X-Installation-Id", "X-Device-Token", CLIENT_VERSION_HEADER])
          if (c.req.header(key)) headers.set(key, c.req.header(key)!);
        const response = await dispatch(new Request(url, { headers }));
        if (!response.ok)
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 32 * 1024 * 1024 || sha256Hex(bytes) !== row.sha256)
          return fail(
            409,
            "SCENE_SOURCE_CHANGED",
            "확인한 파일이 바뀌었습니다. 저장 전 확인으로 돌아가 주세요.",
          );
        const [x1, y1, x2, y2] = person.box;
        const box = [
          Math.max(0, x1!),
          Math.max(0, y1!),
          Math.min(image.width, x2!),
          Math.min(image.height, y2!),
        ];
        sources.push({
          person_index: row.personIndex,
          bytes,
          observation: {
            box,
            keypoints:
              person.skeleton?.keypoints ??
              Array.from({ length: 17 }, () => [0, 0]),
            scores: person.skeleton?.scores ?? (Array(17).fill(0) as number[]),
          },
        });
        refs.push({ personIndex: row.personIndex, candidateId: row.candidateId,
          exportPath: row.exportPath, sha256: row.sha256 });
      }
      if (excludedIds.some(id => seen.has(id) || !job.result!.candidatesByPerson.some(p => p.personIndex === id && p.candidates.length > 0)))
        return fail(400, "INVALID_INPUT", "제외할 인물을 다시 확인해 주세요.");
      const people = scenePeople(job, refs.map(r => r.personIndex), excludedIds);
      const binding = sha256Hex(
        Buffer.from(JSON.stringify([owner, jobId, job.updatedAt, refs, saveMode, excludedIds])),
      );
      const confirmation = input.partialConfirmation as { snapshotSha256?: unknown } | null;
      const partialConfirmed = confirmation?.snapshotSha256 === binding;
      if (input.partialConfirmation !== undefined && (!confirmation || typeof confirmation !== "object" ||
          Array.isArray(confirmation) || typeof confirmation.snapshotSha256 !== "string"))
        return fail(400, "INVALID_INPUT", "부분 저장 확인 정보가 올바르지 않습니다.");
      if (people.partial && input.prepare !== true && input.metadataOnly !== true && !partialConfirmed)
        return fail(409, "SCENE_PARTIAL_CONFIRMATION_REQUIRED", "일부 인물만 저장됩니다. 장면을 준비하고 저장 인원을 확인해 주세요.");
      if (people.partial && !receiptFlow)
        return fail(409, "SCENE_PARTIAL_CONFIRMATION_REQUIRED", "부분 저장은 장면 정보 확인이 필요합니다.");
      let scene: { bytes: Uint8Array; sha256: string };
      let prepared: RefinedScene | undefined;
      let reviewed: SceneReceipt | undefined;
      if (receiptFlow) {
        if (input.prepare === true) {
          prepared = refined
            ? await deps.prepareRefinedScene(owner, job, refs, sources, {}, input.artifactOnly === true)
            : { ...await deps.composeRoughScene(jobId, image, sources), artifactContract: "verified-scene-fbx-v1",
                preview: "", previewSha256: sha256Hex(Buffer.alloc(0)), summary: [] };
          scene = prepared;
        } else {
          const receipt =
            typeof input.reviewKey === "string" && /^[a-f0-9]{48}$/.test(input.reviewKey)
              ? receipts.get(receiptCacheKey(owner, jobId, input.reviewKey)) ?? await deps.loadSceneReceipt(owner, jobId, input.reviewKey)
              : undefined;
          if (!receipt)
            return fail(
              409,
              "SCENE_REVIEW_REQUIRED",
              "보정된 장면을 다시 확인한 뒤 저장해 주세요.",
            );
          if (receipt.reviewVersion !== SCENE_REVIEW_VERSION)
            return fail(409, "SCENE_REVIEW_REQUIRED", "장면 확인 계약이 바뀌었습니다. 다시 준비해 주세요.");
          if (receipt.expires <= Date.now())
            return fail(409, "SCENE_REVIEW_EXPIRED", "확인 시간이 지났습니다. 장면을 다시 준비해 주세요.");
          if (receipt.binding !== binding)
            return fail(409, "SCENE_SOURCE_CHANGED", "선택이 바뀌었습니다. 인물별 확인으로 돌아가 주세요.");
          if (receipt.scene.sha256 !== input.artifactSha256 ||
              sha256Hex(receipt.scene.bytes) !== receipt.scene.sha256)
            return fail(502, "SCENE_INTEGRITY", "확인한 장면과 파일이 일치하지 않습니다. 다시 준비해 주세요.");
          if (manifestRequest && (!receipt.manifest || receipt.manifest.version !== SCENE_MANIFEST_VERSION ||
              receipt.manifest.artifact.sha256 !== receipt.scene.sha256 || receipt.manifest.snapshotSha256 !== binding ||
              receipt.manifest.artifact.saveMode !== saveMode ||
              JSON.stringify(receipt.manifest) !== JSON.stringify(sceneManifest(job, binding, receipt.scene.sha256, saveMode, people))))
            return fail(502, "SCENE_INTEGRITY", "장면 정보가 파일과 일치하지 않습니다.");
          reviewed = receipt;
          scene = receipt.scene;
        }
      } else {
        scene = await deps.composeRoughScene(jobId, image, sources);
      }
      // Preview rendering can outlast a body/hand/selection change. The final
      // authorization below must run after every asynchronous artifact operation.
      let png: Uint8Array | undefined;
      let previewFailure: { error: unknown } | undefined;
      if (input.preview === true) {
        if (prepared || !refined)
          return fail(400, "INVALID_INPUT", "준비한 장면을 다시 선택해 주세요.");
        try {
          png = await deps.renderFinalPreview(
            { fbx: scene.bytes, artifactSha256: scene.sha256 }, true, {}, true, c.req.raw.signal,
          );
        } catch (error) {
          // A render-only failure cannot hide concurrent review invalidation.
          previewFailure = { error };
        }
      }
      const current = await deps.getOwnedJob(jobId, owner);
      if (
        !current ||
        current.updatedAt !== job.updatedAt ||
        current.status !== "completed" ||
        !(
          await Promise.all(
            refs.map((r) =>
              deps.validateConfirmedSelection(
                owner,
                jobId,
                r.personIndex,
                r.candidateId,
              ),
            ),
          )
        ).every(Boolean)
      )
        return fail(
          409,
          "SCENE_SOURCE_CHANGED",
          "작업이 변경되었습니다. 후보 화면에서 다시 확인해 주세요.",
        );
      // Body/hand revisions live outside the job row. Re-authorize pinned
      // downloads after composition as well; stale reviews cannot be released.
      for (const ref of refs) {
        const headers = new Headers();
        for (const key of ["X-Installation-Id", "X-Device-Token", CLIENT_VERSION_HEADER])
          if (c.req.header(key)) headers.set(key, c.req.header(key)!);
        const response = await dispatch(
          new Request(new URL(ref.exportPath, "https://scene.internal"), {
            headers,
          }),
        );
        if (!response.ok)
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        if (
          sha256Hex(new Uint8Array(await response.arrayBuffer())) !== ref.sha256
        )
          return fail(
            409,
            "SCENE_SOURCE_CHANGED",
            "확인한 체형이나 손이 바뀌었습니다. 다시 확인해 주세요.",
          );
      }
      // Reauthorization/preview can be slow; never release an expired review.
      if (reviewed && reviewed.expires <= Date.now())
        return fail(409, "SCENE_REVIEW_EXPIRED", "확인 시간이 지났습니다. 장면을 다시 준비해 주세요.");
      if (previewFailure) throw previewFailure.error;
      if (png) {
        return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store",
          "X-Standin-Artifact-SHA256": scene.sha256, "X-Standin-Preview-Artifact-SHA256": sha256Hex(png) } });
      }
      const manifest = reviewed?.manifest ?? sceneManifest(job, binding, scene.sha256, saveMode, people);
      const observe = () => log.info({ type: "scene_save_result", jobId, requestId: c.get("requestId"),
        saveMode, operation: input.metadataOnly === true ? "metadata" : prepared ? "prepare" : "release",
        path: reviewed ? "scene_receipt" : refined ? "scene_refinement" : "compose_scene",
        detectedIds: people.detectedIds, requestedIds: people.requestedIds, includedIds: people.includedIds,
        missingIds: people.missing.map(p => p.personIndex), missingReasons: people.missing.map(p => p.reason),
        partial: people.partial, partialConfirmed, fileCount: 1, personCount: refs.length, durationMs: Date.now() - started });
      if (input.metadataOnly === true) {
        observe();
        return c.json({ manifest, partialConfirmed, expiresAt: new Date(reviewed!.expires).toISOString() }, 200, { "Cache-Control": "private, no-store" });
      }
      if (prepared) {
        const { key: reviewKey, receipt } = await remember(receipts, binding, prepared, owner, jobId, deps.saveSceneReceipt, manifest);
        observe();
        c.header("Cache-Control", "private, no-store");
        return c.json({
          contractVersion: SCENE_SAVE_CONTRACT,
          saveMode,
          manifest,
          partialConfirmed: false,
          reviewVersion: SCENE_REVIEW_VERSION,
          expiresAt: new Date(receipt.expires).toISOString(),
          fileCount: 1,
          version: manifest.artifact.layoutVersion,
          ...(prepared.artifactContract ? { artifactContract: prepared.artifactContract } : {}),
          reviewKey,
          artifactSha256: prepared.sha256,
          previewSha256: prepared.previewSha256,
          previewBase64: prepared.preview,
          summary: prepared.summary,
          personCount: refs.length,
        });
      }
      observe();
      return new Response(scene.bytes, {
        headers: {
          "X-Standin-Scene-Contract": SCENE_SAVE_CONTRACT,
          "X-Standin-Scene-Manifest-Version": SCENE_MANIFEST_VERSION,
          "X-Standin-Scene-Snapshot-SHA256": binding,
          "X-Standin-File-Count": "1",
          "X-Standin-Scene-Save-Mode": refined ? "auto-correct-v4" : "original-selection",
          "Content-Type": "application/octet-stream",
          "Cache-Control": "private, no-store",
          "X-Standin-Artifact-SHA256": scene.sha256,
          "X-Standin-Person-Count": String(sources.length),
          "X-Standin-Scene-Version": refined
            ? "scene-refinement-v4"
            : "rough-layout-v1",
          "Content-Disposition": 'attachment; filename="standin_scene.fbx"',
        },
      });
    } catch (e) {
      if (e instanceof SceneError) serverOperationMayContinue = e.serverOperationMayContinue;
      const code = e instanceof SceneError ? e.code : e instanceof ConverterError
        ? e.code === "CONVERTER_TIMEOUT" ? "SCENE_TIMEOUT"
          : ["CONVERTER_UNAVAILABLE", "CONVERTER_DISABLED", "BODY_PREVIEW_UNAVAILABLE"].includes(e.code) ? "SCENE_UNAVAILABLE"
          : e.code === "CONVERTER_INTEGRITY" ? "SCENE_INTEGRITY" : "SCENE_FAILED"
        : "SCENE_FAILED";
      return fail(code === "SCENE_TIMEOUT" ? 504
        : ["SCENE_UNAVAILABLE", "SCENE_BUSY"].includes(code) ? 503
        : ["SCENE_UNSUPPORTED_BODY", "SCENE_SOURCE_CHANGED"].includes(code) ? 409 : 502,
        code, "장면 FBX를 만들지 못했습니다. 복구 안내에 따라 다시 시도해 주세요.");
    }
  });
  return routes;
}
