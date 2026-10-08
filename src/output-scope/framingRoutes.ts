/** Authenticated output framing, isolated from the legacy whole-body export. */
import { cameraArtifact } from "../candidate-camera/artifacts.js";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getOwnedJob } from "../jobs/store.js";
import { recordExport, validateExportCandidate } from "../analytics/store.js";
import { resolveExportArtifact } from "../refine/service.js";
import { getPoseBvh } from "../inference.js";
import { checkCharacter } from "../characters/service.js";
import { config } from "../config.js";
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
import { isBodyScope, resolveOutputScope } from "./model.js";

const cache = new FramedArtifactCache();
const defaults = {
  getOwnedJob,
  validateExportCandidate,
  resolveExportArtifact,
  getPoseBvh,
  checkCharacter,
  convertFramed,
  converterEnabled,
  recordExport,
  modelPreviewIdentity,
};
export function createFramingRoutes(overrides: Partial<typeof defaults> = {}) {
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
      (p) => p.id === candidateId && p.poseId === poseId,
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
    if (scope !== resolveOutputScope(person?.outputScope).resolved)
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
    const characterId =
      c.req.query("characterId") || config.converterCharacterId;
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
      let bvhBytes: Uint8Array;
      if (artifact.variant === "refined") bvhBytes = artifact.bytes;
      else {
        const response = await deps.getPoseBvh(poseId);
        if (!response.ok)
          return fail(
            response.status === 409 ? 409 : 502,
            "POSE_UNAVAILABLE",
            "이 포즈를 사용할 수 없습니다. 다른 후보를 선택해 주세요.",
          );
        bvhBytes = new Uint8Array(await response.arrayBuffer());
      }
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
        candidate.camera?.rotation,
      ]);
      const useModel =
        format === "model" ||
        (format === "fbx" && c.req.query("previewType") === "model");
      const identity = useModel
        ? await deps.modelPreviewIdentity(characterId)
        : null;
      if (useModel && !identity)
        return fail(
          503,
          "PREVIEW_UNAVAILABLE",
          "미리보기를 지금 준비할 수 없습니다. 다시 시도해 주세요.",
        );
      const result = useModel
        ? await cameraArtifact(
            [installationId, jobId, personIndex, candidateId],
            {
              bvhBytes,
              characterId,
              scope,
              cameraRotation: candidate.camera?.rotation,
              previewFormat: "model",
              ...identity!,
            },
            deps.convertFramed,
          )
        : candidate.camera
          ? await cameraArtifact(
              [installationId, jobId, personIndex, candidateId],
              {
                bvhBytes,
                characterId,
                scope,
                cameraRotation: candidate.camera.rotation,
              },
              deps.convertFramed,
            )
          : await cache.get(key, () =>
              deps.convertFramed({ bvhBytes, characterId, scope }),
            );
      // A preference or confirmation may change while Blender is working.
      const current = await deps.getOwnedJob(jobId, installationId);
      const currentPerson = current?.result?.candidatesByPerson.find(
        (p) => p.personIndex === personIndex,
      );
      if (
        !currentPerson ||
        resolveOutputScope(currentPerson.outputScope).resolved !== scope ||
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
      await exportEvent("completed");
      const bytes = format === "fbx" ? result.fbx : result.preview;
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
          "X-Standin-Artifact-SHA256": result.artifactSha256,
          ...(format === "fbx"
            ? {
                "Content-Disposition": `attachment; filename="pose-${scope}.fbx"`,
              }
            : {}),
        },
      });
    } catch (error) {
      const code =
        error instanceof ConverterError ? error.code : "CONVERTER_FAILED";
      await exportEvent("failed", code);
      return fail(
        code === "CONVERTER_TIMEOUT"
          ? 504
          : code === "CONVERTER_REJECTED" || code === "CONVERTER_INTEGRITY"
            ? 409
            : 503,
        code,
        "선택한 범위로 결과를 만들지 못했습니다. 다시 시도하거나 다른 후보를 선택해 주세요.",
      );
    }
  });
  return routes;
}
