import { candidatePathId, candidateSourceBytes } from "../candidate-source.js";
import { refinableLibraryCandidate } from "../refine/eligibility.js";
import { loadAssets } from "../pose-presentation.js";
import { manualPresentationCamera } from "../pose-presentation.js";
import { exportCandidateAllowed, manualExportCandidate } from "../routed-search.js";
import { shapeRenderable } from "../body-selection/shape.js";
import { handBakeFor } from "../hands/service.js";
import { HandError } from "../hands/model.js";
import { bodyUxAvailable } from "../body-selection/availability.js";
import { bodyStore, BodyError } from "../body-selection/store.js";
import { sameBody } from "../body-selection/model.js";
import { getPreviewRuntime } from "../converter/previewRuntime.js";
import { validCamera } from "../body-selection/previews.js";
/** Authenticated output framing, isolated from the legacy whole-body export. */
import { cameraArtifact } from "../candidate-camera/artifacts.js";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getOwnedJob } from "../jobs/store.js";
import { recordExport, validateExportCandidate, validateConfirmedSelection } from "../analytics/store.js";
import { resolveExportArtifact } from "../refine/service.js";
import { getPoseBvh } from "../inference.js";
import { checkCharacter } from "../characters/service.js";
import { config } from "../config.js";
import {
  getPreviewModel,
  matchesLibraryModel,
} from "../converter/previewModel.js";
import { errorEnvelope } from "../mapping.js";
import {
  ConverterError,
  converterEnabled,
  sha256Hex,
} from "../converter/client.js";
import {
  convertFramed,
  FramedArtifactCache,
  FRAMING_VERSION,
  modelPreviewIdentity,
} from "../converter/framing.js";
import { isBodyScope, resolvePersonOutputScope, scopeIncludesHands } from "./model.js";

const cache = new FramedArtifactCache();
const defaults = {
  loadAssets,
  getOwnedJob,
  validateExportCandidate,
  validateConfirmedSelection,
  resolveExportArtifact,
  getPoseBvh,
  checkCharacter,
  convertFramed,
  converterEnabled,
  recordExport,
  modelPreviewIdentity,
  getPreviewModel,
  handBakeFor,
};
const bodyDefaults = {
  selection: bodyStore.selection,
  runtime: getPreviewRuntime,
  enabled: bodyUxAvailable,
};
export function createFramingRoutes(
  overrides: Partial<typeof defaults> = {},
  bodyDeps = bodyDefaults,
) {
  const deps = { ...defaults, ...overrides };
  const routes = new Hono<AppEnv>();
  routes.get("/:id/framed", async (c) => {
    const fail = (
      status: 400 | 409 | 502 | 503 | 504,
      code: string,
      message: string,
    ) => c.json(errorEnvelope(code, message, c.get("requestId")), status);
    const installationId = c.get("installationId")!;
    const jobId = c.req.query("jobId") ?? "",
      candidateId = c.req.query("candidateId") ?? "";
    const rawPerson = c.req.query("personIndex");
    const personIndex = Number(rawPerson);
    const scope = c.req.query("outputScope"),
      format = c.req.query("format");
    const poseId = c.req.param("id");
    const expectedSource = c.req.query("expectedBvhSha256");
    const expectedCharacter = c.req.query("expectedCharacterSha256");
    const expectedRevision = c.req.query("expectedModelRevision");
    if (
      [expectedSource, expectedCharacter, expectedRevision].some(
        (value) => value !== undefined && !/^[a-f0-9]{64}$/.test(value),
      )
    )
      return fail(400, "INVALID_INPUT", "미리보기를 다시 확인해 주세요.");
    if (
      !jobId ||
      !candidateId ||
      !rawPerson ||
      !Number.isInteger(personIndex) ||
      personIndex < 0 ||
      !isBodyScope(scope) ||
      (format !== "preview" && format !== "fbx" && format !== "model")
    )
      return fail(
        400,
        "INVALID_INPUT",
        "출력 범위와 저장할 포즈를 다시 선택해 주세요.",
      );
    const job = await deps.getOwnedJob(jobId, installationId);
    const person = job?.result?.candidatesByPerson.find(
      (p) => p.personIndex === personIndex,
    );
    const candidate = person?.candidates.find(
      (p) => p.id === candidateId && candidatePathId(p) === poseId,
    );
    if (
      !candidate ||
      job?.status !== "completed" ||
      !(await deps.validateExportCandidate(
        installationId,
        jobId,
        personIndex,
        candidateId,
      ))
    )
      return fail(409, "INVALID_EXPORT", "작업에서 선택된 후보가 아닙니다.");
    if (
      format === "fbx" &&
      (!exportCandidateAllowed(candidate) || (job.result?.source === "semantic" && !manualExportCandidate(candidate)))
    )
      return fail(
        409,
        "CANDIDATE_RELEASE_FORBIDDEN",
        "검수용 후보는 저장할 수 없습니다.",
      );
    if (scope !== resolvePersonOutputScope(person).resolved)
      return fail(
        409,
        "OUTPUT_SCOPE_CHANGED",
        "출력 범위가 바뀌었습니다. 후보 화면에서 다시 확인해 주세요.",
      );
    if (!deps.converterEnabled())
      return fail(
        503,
        "FBX_UNAVAILABLE",
        "지금은 FBX 출력을 사용할 수 없습니다.",
      );
    let characterId = c.req.query("characterId") || config.converterCharacterId;
    const exportEvent = (
      status: "requested" | "completed" | "failed",
      errorCode?: string,
    ) =>
      format === "fbx"
        ? deps.recordExport({
            installationId,
            jobId,
            personIndex,
            candidateId,
            status,
            format: "fbx",
            errorCode,
          })
        : Promise.resolve();
    try {
      const hands = scopeIncludesHands(scope) ? await deps.handBakeFor(person) : null;
      if (
        hands &&
        c.req.query("handSelectionRevision") !== String(hands.revision)
      )
        return fail(
          409,
          "HANDS_CHANGED",
          "손 선택이 바뀌었습니다. 다시 확인해 주세요.",
        );
      const revision = c.req.query("bodySelectionRevision");
      const bodyMode = revision !== undefined;
      const manual = manualPresentationCamera(person, candidate);
      const authorReview = manualExportCandidate(candidate);
      if (format === "fbx" && authorReview && !(await deps.validateConfirmedSelection(installationId, jobId, personIndex, candidateId)))
        return fail(409, "MANUAL_SELECTION_REQUIRED", "저장할 포즈를 직접 선택하고 확정해 주세요.");
      if (authorReview && !manual)
        return fail(409, "MANUAL_REVIEW_UNAVAILABLE", "선택한 포즈의 검수 정보를 확인하지 못했습니다.");
      const cameraRotation =
        manual?.camera.rotation ?? candidate.camera?.rotation;
      if (
        bodyMode &&
        (!/^(0|[1-9][0-9]*)$/.test(revision!) ||
          !Number.isSafeInteger(Number(revision)))
      )
        return fail(400, "INVALID_INPUT", "체형 버전을 확인해 주세요.");
      if (bodyMode && !bodyDeps.enabled())
        return fail(
          503,
          "BODY_SELECTION_DISABLED",
          "체형 미리보기를 사용할 수 없습니다.",
        );
      const body = bodyMode
        ? await bodyDeps.selection(installationId, jobId, personIndex)
        : null;
      if (
        bodyMode &&
        (body?.resolutionStatus !== "ready" ||
          !body.resolvedBody ||
          body.selectionRevision !== Number(revision))
      )
        return fail(
          409,
          "BODY_PREVIEW_STALE",
          "체형이 변경되었습니다. 다시 확인해 주세요.",
        );
      if (bodyMode && body && !shapeRenderable(body))
        return fail(
          409,
          "BODY_SHAPE_RENDER_UNSUPPORTED",
          "조절한 체형은 아직 저장할 수 없습니다. 기본 체형으로 되돌린 뒤 다시 시도해 주세요.",
        );
      if (bodyMode && !validCamera(candidate.camera) && !manual)
        return fail(
          409,
          "BODY_PREVIEW_UNSUPPORTED",
          "이 작업은 체형 미리보기를 지원하지 않습니다.",
        );
      if (body?.resolvedBody) {
        characterId = body.resolvedBody.characterId;
        if (
          c.req.query("characterId") &&
          c.req.query("characterId") !== characterId
        )
          return fail(
            409,
            "BODY_PREVIEW_STALE",
            "체형이 변경되었습니다. 다시 확인해 주세요.",
          );
      }
      const runtime = (bodyMode || authorReview) ? await bodyDeps.runtime() : null;
      const authorIdentity = authorReview ? await deps.modelPreviewIdentity(characterId) : null;
      if (authorReview && !authorIdentity)
        return fail(503, "PREVIEW_UNAVAILABLE", "최종 모델 버전을 확인하지 못했습니다. 다시 시도해 주세요.");
      const expectedReview = c.req.query("reviewKey");
      if (
        (bodyMode || hands !== null || authorReview) &&
        format === "fbx" &&
        (!expectedReview || !/^[a-f0-9]{64}$/.test(expectedReview))
      )
        return fail(
          409,
          authorReview ? "MANUAL_REVIEW_REQUIRED" : bodyMode ? "BODY_REVIEW_REQUIRED" : "HAND_REVIEW_REQUIRED",
          "저장 전 결과를 확인해 주세요.",
        );
      if ((await deps.checkCharacter(characterId)) !== "ok")
        return fail(
          409,
          "CHARACTER_UNAVAILABLE",
          "선택한 모델을 지금은 사용할 수 없습니다.",
        );
      await exportEvent("requested");
      const artifact = await deps.resolveExportArtifact(
        jobId,
        personIndex,
        candidateId,
      );
      // Refined output still belongs to this approved base pose. Check quarantine
      // and source lineage on every body request, including paired cache hits.
      let checkedBase: Uint8Array | undefined;
      if (bodyMode || (artifact.variant === "refined" && candidate.sourceBvhSha256)) {
        checkedBase = await candidateSourceBytes(jobId, person!, candidate, deps.getPoseBvh, deps.loadAssets);
        if (sha256Hex(checkedBase) !== (manual?.sourceBvhSha256 ?? candidate.camera?.source_bvh_sha256 ?? candidate.sourceBvhSha256))
          return fail(409, "POSE_UNAVAILABLE", "포즈가 변경되었습니다. 다시 확인해 주세요.");
      }
      let bvhBytes: Uint8Array;
      if (artifact.variant === "refined") bvhBytes = artifact.bytes;
      else bvhBytes = checkedBase ?? await candidateSourceBytes(jobId, person!, candidate, deps.getPoseBvh, deps.loadAssets);
      if (
        candidate.sourceBvhSha256 &&
        (artifact.variant === "refined"
          ? !refinableLibraryCandidate(candidate)
          : sha256Hex(bvhBytes) !== candidate.sourceBvhSha256)
      )
        return fail(
          409,
          "POSE_UNAVAILABLE",
          "포즈가 변경되었습니다. 다시 검색해 주세요.",
        );
      if (
        artifact.variant === "base" &&
        candidate.camera &&
        sha256Hex(bvhBytes) !== candidate.camera.source_bvh_sha256
      )
        return fail(
          409,
          "POSE_UNAVAILABLE",
          "포즈가 변경되었습니다. 다시 분석해 주세요.",
        );
      const key = JSON.stringify([
        installationId,
        jobId,
        personIndex,
        candidateId,
        sha256Hex(bvhBytes),
        characterId,
        scope,
        FRAMING_VERSION,
        cameraRotation,
        manual,
        body,
        runtime,
        authorIdentity,
        hands,
      ]);
      const expected =
        body?.resolvedBody && runtime
          ? {
              expectedCharacterSha256: body.resolvedBody.assetSha256,
              shape: body.shape,
              shapeSource: body.shapeSource,
              expectedPreviewRevision: runtime.previewRevision,
            }
          : authorReview ? {
              expectedCharacterSha256: authorIdentity!.characterSha256,
              expectedPreviewRevision: runtime!.previewRevision,
            } : {};
      const useModel =
        format === "model" ||
        (format === "fbx" && c.req.query("previewType") === "model");
      const identity = useModel
        ? authorIdentity ?? await deps.modelPreviewIdentity(characterId)
        : authorIdentity;
      if (useModel && !identity)
        return fail(
          503,
          "PREVIEW_UNAVAILABLE",
          "미리보기를 지금 준비할 수 없습니다. 다시 시도해 주세요.",
        );
      const sourceSha = sha256Hex(bvhBytes);
      if (
        (expectedSource && expectedSource !== sourceSha) ||
        (expectedCharacter && identity &&
          expectedCharacter !== identity.characterSha256) ||
        (expectedRevision && expectedRevision !== identity?.modelRevision)
      ) {
        await exportEvent("failed", "PREVIEW_CHANGED");
        return fail(
          409,
          "PREVIEW_CHANGED",
          "포즈나 모델이 바뀌었습니다. 미리보기를 다시 확인해 주세요.",
        );
      }
      const prepare = () =>
        useModel
          ? cameraArtifact(
              [
                installationId,
                jobId,
                personIndex,
                candidateId,
                ...(bodyMode || hands || authorReview ? [key] : []),
              ],
              {
                bvhBytes,
                purpose: format === "fbx" ? "export" : "preview",
                ...(hands ? { hands } : {}),
                characterId,
                scope,
                cameraRotation,
                previewFormat: "model",
                ...identity!,
                ...expected,
              },
              deps.convertFramed,
              authorReview && format === "fbx",
            )
          : cameraRotation
            ? cameraArtifact(
                [
                  installationId,
                  jobId,
                  personIndex,
                  candidateId,
                  ...(bodyMode || hands || authorReview ? [key] : []),
                ],
                {
                  bvhBytes,
                  purpose: format === "fbx" ? "export" : "preview",
                  ...(hands ? { hands } : {}),
                  characterId,
                  scope,
                  cameraRotation,
                  ...expected,
                },
                deps.convertFramed,
                authorReview && format === "fbx",
              )
            : cache.get(key, () =>
                deps.convertFramed({
                  bvhBytes,
                  purpose: format === "fbx" ? "export" : "preview",
                  characterId,
                  scope,
                  ...expected,
                  ...(hands ? { hands } : {}),
                }),
                bodyMode || authorReview ? { installationId, jobId } : undefined,
              );
      let libraryModel: Buffer | undefined;
      // The stored artifact, not a client's refine flag, decides whether the
      // library surface still describes the output. Cache misses use the pair.
      if (
        !bodyMode &&
        !hands &&
        format === "model" &&
        c.req.query("useLibraryModel") === "true" &&
        artifact.variant === "base" &&
        scope === "full" &&
        candidate.camera
      ) {
        try {
          const bytes = await deps.getPreviewModel(sourceSha, characterId);
          if (
            matchesLibraryModel(
              bytes,
              sourceSha,
              characterId,
              identity!.characterSha256,
            )
          )
            libraryModel = bytes;
        } catch {
          /* Fall through to the exact final model. */
        }
      }
      const result = libraryModel ? undefined : await prepare();
      if (authorReview && (!result || !/^[a-f0-9]{64}$/.test(result.characterSha256 ?? "") ||
        (expectedCharacter && expectedCharacter !== result.characterSha256) ||
        result.previewRevision !== runtime!.previewRevision || result.characterSha256 !== authorIdentity!.characterSha256))
        return fail(409, "PREVIEW_CHANGED", "모델이 바뀌었습니다. 최종 미리보기를 다시 확인해 주세요.");
      // A preference or confirmation may change while Blender is working.
      const current = await deps.getOwnedJob(jobId, installationId);
      const currentPerson = current?.result?.candidatesByPerson.find(
        (p) => p.personIndex === personIndex,
      );
      if (
        current?.status !== "completed" ||
        !currentPerson ||
        !exportCandidateAllowed(currentPerson.candidates.find((c) => c.id === candidateId && candidatePathId(c) === poseId)) ||
        JSON.stringify(currentPerson.candidates.find((c) => c.id === candidateId)) !== JSON.stringify(candidate) ||
        JSON.stringify(manualPresentationCamera(currentPerson, currentPerson.candidates.find((c) => c.id === candidateId))) !== JSON.stringify(manual) ||
        resolvePersonOutputScope(currentPerson).resolved !== scope ||
        !(await deps.validateExportCandidate(
          installationId,
          jobId,
          personIndex,
          candidateId,
        ))
      ) {
        await exportEvent("failed", "OUTPUT_SCOPE_CHANGED");
        return fail(
          409,
          "OUTPUT_SCOPE_CHANGED",
          "출력 설정이 바뀌었습니다. 다시 확인해 주세요.",
        );
      }
      if (
        JSON.stringify(scopeIncludesHands(scope) ? await deps.handBakeFor(currentPerson) : null) !==
        JSON.stringify(hands)
      )
        return fail(
          409,
          "HANDS_CHANGED",
          "손 선택이 바뀌었습니다. 다시 확인해 주세요.",
        );
      if (authorReview) {
        if ((format === "fbx" && !(await deps.validateConfirmedSelection(installationId, jobId, personIndex, candidateId))) ||
          JSON.stringify(await bodyDeps.runtime()) !== JSON.stringify(runtime) ||
          JSON.stringify(await deps.modelPreviewIdentity(characterId)) !== JSON.stringify(authorIdentity))
          return fail(409, "MANUAL_REVIEW_REQUIRED", "선택 또는 렌더 버전이 변경되었습니다. 다시 확인해 주세요.");
        const fresh = await candidateSourceBytes(jobId, currentPerson, candidate, deps.getPoseBvh, deps.loadAssets);
        if (sha256Hex(fresh) !== candidate.sourceBvhSha256)
          return fail(409, "POSE_UNAVAILABLE", "포즈가 변경되었거나 더 이상 제공되지 않습니다.");
      }
      const reviewKey = sha256Hex(
        new TextEncoder().encode(JSON.stringify([key, result?.artifactSha256])),
      );
      if ((hands || authorReview) && format === "fbx" && expectedReview !== reviewKey)
        return fail(
          409,
          authorReview ? "MANUAL_REVIEW_REQUIRED" : "HAND_REVIEW_REQUIRED",
          "최종 미리보기를 다시 확인해 주세요.",
        );
      if (bodyMode) {
        const nowBody = await bodyDeps.selection(
          installationId,
          jobId,
          personIndex,
        );
        const nowRuntime = await bodyDeps.runtime();
        const nowCandidate = currentPerson.candidates.find(
          (c) => c.id === candidateId,
        );
        const nowArtifact = await deps.resolveExportArtifact(
          jobId,
          personIndex,
          candidateId,
        );
        const finalSha =
          nowArtifact.variant === "refined"
            ? sha256Hex(nowArtifact.bytes)
            : (manualPresentationCamera(currentPerson, nowCandidate)
                ?.sourceBvhSha256 ?? candidate.camera?.source_bvh_sha256);
        if (
          nowBody.resolutionStatus !== "ready" ||
          nowBody.selectionRevision !== body!.selectionRevision ||
          !sameBody(nowBody.resolvedBody!, body!.resolvedBody!) ||
          JSON.stringify(nowRuntime) !== JSON.stringify(runtime) ||
          JSON.stringify(nowBody.shape) !== JSON.stringify(body!.shape) ||
          JSON.stringify(nowBody.shapeSource) !==
            JSON.stringify(body!.shapeSource) ||
          JSON.stringify(
            manualPresentationCamera(currentPerson, nowCandidate),
          ) !== JSON.stringify(manual) ||
          JSON.stringify(nowCandidate?.camera) !==
            JSON.stringify(candidate.camera) ||
          finalSha !== sha256Hex(bvhBytes) ||
          (format === "fbx" && expectedReview !== reviewKey)
        )
          return fail(
            409,
            "BODY_PREVIEW_STALE",
            "결과가 변경되었습니다. 다시 확인해 주세요.",
          );
        if (
          result?.characterSha256 !== body!.resolvedBody!.assetSha256 ||
          result?.previewRevision !== runtime!.previewRevision
        )
          return fail(
            409,
            "CONVERTER_INTEGRITY",
            "체형 파일을 확인하지 못했습니다.",
          );
      }
      await exportEvent("completed");
      if (libraryModel) void prepare().catch(() => {});
      const bytes =
        libraryModel ?? (format === "fbx" ? result!.fbx : result!.preview);
      return new Response(bytes, {
        headers: {
          "Content-Type":
            format === "model"
              ? "model/gltf-binary"
              : format === "preview"
                ? "image/png"
                : "application/octet-stream",
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, no-store",
          "X-Standin-Output-Scope": scope,
          ...((hands || authorReview) ? { "X-Standin-Review-Key": reviewKey } : {}),
          ...(authorReview ? {
            "X-Standin-Character-SHA256": result!.characterSha256!,
            "X-Standin-Source-BVH-SHA256": sha256Hex(bvhBytes),
            "X-Standin-Preview-Artifact-SHA256": sha256Hex(result!.preview),
          } : {}),
          ...(hands
            ? {
                "X-Standin-Hand-Revision": String(hands.revision),
                "X-Standin-Hand-Library-SHA256": hands.library_sha256,
              }
            : {}),
          ...(bodyMode
            ? {
                "X-Standin-Review-Key": reviewKey,
                "X-Standin-Body-Revision": String(body!.selectionRevision),
                "X-Standin-Character-SHA256": body!.resolvedBody!.assetSha256,
                "X-Standin-Source-BVH-SHA256": sha256Hex(bvhBytes),
              }
            : {}),
          ...(result
            ? { "X-Standin-Artifact-SHA256": result.artifactSha256 }
            : {}),
          ...(format === "fbx"
            ? {
                "Content-Disposition": `attachment; filename="pose-${scope}.fbx"`,
              }
            : {}),
        },
      });
    } catch (error) {
      if (error instanceof HandError)
        return c.json(
          errorEnvelope(error.code, error.message, c.get("requestId")),
          error.status,
        );
      if (error instanceof BodyError)
        return c.json(
          errorEnvelope(
            error.code,
            error.code === "GENERATED_SOURCE_UNAVAILABLE" ? "새로 만든 포즈의 원본을 찾지 못했습니다. 다시 분석해 주세요." :
            error.code === "GENERATED_CHECKS_FAILED" ? "만든 포즈가 확인 과정을 통과하지 못했습니다. 다른 포즈를 선택해 주세요." :
            error.code === "PREVIEW_HASH_MISMATCH" || error.code === "PREVIEW_SOURCE_CHANGED" ? "포즈 파일이 변경되었습니다. 다시 분석해 주세요." : "체형 또는 포즈 상태를 다시 확인해 주세요.",
            c.get("requestId"),
          ),
          error.status,
        );
      const code =
        error instanceof ConverterError ? (error.code === "PREVIEW_NOT_READY" && manualExportCandidate(candidate) ? "MANUAL_REVIEW_REQUIRED" : error.code) : "CONVERTER_FAILED";
      await exportEvent("failed", code);
      return fail(
        code === "CONVERTER_TIMEOUT"
          ? 504
          : code === "MANUAL_REVIEW_REQUIRED" || code === "CONVERTER_REJECTED" || code === "CONVERTER_INTEGRITY"
            ? 409
            : 503,
        code,
        code === "MANUAL_REVIEW_REQUIRED" ? "확인한 파일이 만료되었습니다. 최종 결과를 다시 확인해 주세요." : "선택한 범위로 결과를 만들지 못했습니다. 다시 시도하거나 다른 후보를 선택해 주세요.",
      );
    }
  });
  return routes;
}
