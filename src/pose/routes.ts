// /v1/pose-candidates — 선택 후보의 최종 포즈 파일(BVH 또는 V3.2 FBX)을 내려준다.
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { getPoseBvh, getPoseThumbnail } from "../inference.js";
import { errorEnvelope } from "../mapping.js";
import { recordExport, validateExportCandidate } from "../analytics/store.js";
import { resolveExportArtifact } from "../refine/service.js";
import type { ExportFormat } from "../types.js";
import {
  ConverterError,
  type ConverterErrorCode,
  convertBvhToFbx,
  converterEnabled,
  sha256Hex,
} from "../converter/client.js";

export const poseRoutes = new Hono<AppEnv>();

function bytesResponse(bytes: Uint8Array, fileName: string): Response {
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(bytes.byteLength),
    },
  });
}

/**
 * converter의 업로드 파일명 검사(`^[^/\\\x00]{1,255}$` + `.bvh`)를 통과하는 이름.
 *
 * poseId는 라이브러리 값이지만 경로 구분자가 섞이면 converter가 400으로 막는다. 사용자에게
 * 보이지 않는 이름이므로 안전 문자만 남기고 잘라 쓴다.
 */
function converterUploadName(poseId: string): string {
  const safe = poseId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return `${safe || "pose"}.bvh`;
}

/** 재시도가 의미 있는 실패와 그렇지 않은 실패를 상태 코드로 구분한다. */
function converterStatus(code: ConverterErrorCode): 409 | 502 | 503 | 504 {
  if (code === "CONVERTER_REJECTED" || code === "CONVERTER_INTEGRITY") return 409;
  if (code === "CONVERTER_TIMEOUT") return 504;
  if (code === "CONVERTER_UNAVAILABLE" || code === "CONVERTER_DISABLED") return 503;
  return 502;
}

function converterMessage(code: ConverterErrorCode): string {
  switch (code) {
    case "CONVERTER_TIMEOUT":
      return "FBX 변환이 시간 안에 끝나지 않았습니다. 잠시 후 다시 시도해 주세요.";
    case "CONVERTER_UNAVAILABLE":
    case "CONVERTER_DISABLED":
      return "지금은 FBX 변환 서버를 사용할 수 없습니다. BVH로 저장하거나 잠시 후 다시 시도해 주세요.";
    case "CONVERTER_REJECTED":
      return "이 포즈는 FBX로 변환할 수 없습니다. 다른 후보를 선택하거나 BVH로 저장해 주세요.";
    case "CONVERTER_INTEGRITY":
      // 사용자가 할 수 있는 일이 없다. 재시도를 권하지 않는 이유이기도 하다.
      return "변환 결과를 검증하지 못했습니다. 문제가 계속되면 문의해 주세요.";
    default:
      return "FBX 변환에 실패했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

// GET /v1/pose-candidates/:id/export?format=bvh|fbx
//
// 최종 BVH 확정은 예나 지금이나 여기 있다(BFF-06). 달라진 것은 그 뒤다: format=fbx면
// 확정한 **그 바이트**를 내부 Converter API로 보내 V3.2 FBX를 받는다. 확정과 변환 사이에
// 다른 바이트가 끼어들 수 없게, converter가 돌려준 SHA를 우리가 계산한 값과 대조한다.
// TODO(Phase 1): requireAuth 적용
poseRoutes.get("/:id/export", async (c) => {
  const poseId = c.req.param("id");
  const candidateId = c.req.query("candidateId") ?? "";
  const jobId = c.req.query("jobId") ?? "";
  const personIndex = Number(c.req.query("personIndex"));
  const installationId = c.get("installationId")!;
  const requestedFormat = c.req.query("format") ?? "bvh";
  if (requestedFormat !== "bvh" && requestedFormat !== "fbx") {
    return c.json(
      errorEnvelope("INVALID_INPUT", "format은 bvh 또는 fbx여야 합니다.", c.get("requestId")),
      400,
    );
  }
  const format: ExportFormat = requestedFormat;
  if (
    !jobId ||
    !Number.isInteger(personIndex) ||
    personIndex < 0 ||
    !candidateId ||
    !(await validateExportCandidate(installationId, jobId, personIndex, candidateId))
  ) {
    return c.json(
      errorEnvelope("INVALID_EXPORT", "작업에서 선택된 후보가 아닙니다.", c.get("requestId")),
      409,
    );
  }

  // FBX가 꺼진 배포에서 fbx 요청이 오면 조용히 BVH로 바꾸지 않는다. 사용자가 고른 포맷과
  // 저장된 파일이 달라지면 클립스튜디오에서 열리지 않는 이유를 알 방법이 없다.
  if (format === "fbx" && !converterEnabled()) {
    return c.json(
      errorEnvelope(
        "FBX_UNAVAILABLE",
        "지금은 FBX 저장을 사용할 수 없습니다. BVH로 저장해 주세요.",
        c.get("requestId"),
      ),
      409,
    );
  }

  await recordExport({
    installationId,
    jobId,
    personIndex,
    candidateId,
    status: "requested",
    format,
  });

  // 이 바이트가 조정본과 베이스 중 무엇인지는 서버가 정한다(BFF-06). 클라이언트는
  // 추론 서버의 로컬 handle을 알 필요가 없고, 알아서도 안 된다.
  const artifact = await resolveExportArtifact(jobId, personIndex, candidateId);
  const variant = artifact.variant;
  const fallbackReason = artifact.variant === "base" ? artifact.fallbackReason : null;
  const failed = (errorCode: string) =>
    recordExport({
      installationId,
      jobId,
      personIndex,
      candidateId,
      status: "failed",
      errorCode,
      variant,
      fallbackReason: fallbackReason ?? undefined,
      format,
    });

  let finalBvh: Uint8Array;
  if (artifact.variant === "refined") {
    finalBvh = artifact.bytes;
  } else {
    let upstream: Response;
    try {
      upstream = await getPoseBvh(poseId);
    } catch {
      await failed("INFERENCE_UNAVAILABLE");
      throw new Error("pose export upstream unavailable");
    }
    // 추론이 릴리스 시점에 격리한 포즈다(409 pose_quarantined). 후보 목록은 `/analyze` 때
    // 이미 저장돼 있으므로, 격리가 늘어나면 화면에 남아 있던 선택이 여기서 409로 돌아온다.
    // 재시도로는 절대 풀리지 않으니 octet-stream으로 흘려보내면 안 된다 — 클라가 오류 JSON을
    // BVH로 받아 저장하고, 사용자는 영원히 실패하는 재시도 버튼만 보게 된다.
    if (upstream.status === 409) {
      await upstream.text().catch(() => "");
      await failed("POSE_UNAVAILABLE");
      return c.json(
        errorEnvelope(
          "POSE_UNAVAILABLE",
          "이 포즈는 더 이상 제공되지 않습니다. 다른 후보를 선택해 주세요.",
          c.get("requestId"),
        ),
        409,
      );
    }
    if (!upstream.ok) {
      await failed(`HTTP_${upstream.status}`);
      return c.json(
        errorEnvelope(
          "EXPORT_FAILED",
          "포즈 파일을 서버에서 받아오지 못했습니다.",
          c.get("requestId"),
        ),
        502,
      );
    }
    finalBvh = new Uint8Array(await upstream.arrayBuffer());
  }

  if (format === "bvh") {
    await recordExport({
      installationId,
      jobId,
      personIndex,
      candidateId,
      status: "completed",
      variant,
      fallbackReason: fallbackReason ?? undefined,
      format,
    });
    return bytesResponse(finalBvh, `${poseId}.bvh`);
  }

  // ── FBX: 확정한 바이트 하나만 converter로 보낸다 ──────────────────────────
  const finalBvhSha256 = sha256Hex(finalBvh);
  let conversion;
  try {
    conversion = await convertBvhToFbx({
      bvhBytes: finalBvh,
      fileName: converterUploadName(poseId),
      // MVP에서 mirror는 converter가 한 번만 적용하고, 우리는 아직 사용자에게 노출하지
      // 않는다(핸드오프 §3). 노출하게 되면 사용자의 명시값을 여기로 넘긴다.
      mirror: false,
    });
  } catch (error) {
    const converterError =
      error instanceof ConverterError
        ? error
        : new ConverterError("CONVERTER_FAILED", "converter call failed");
    // 양쪽 로그를 잇는 유일한 키가 conversion_id다. 우리 jobId와 함께 남기지 않으면
    // converter의 CloudWatch 로그에서 어떤 사용자 작업이 실패했는지 되짚을 수 없다.
    log.warn({
      type: "converter",
      event: "convert_failed",
      jobId,
      personIndex,
      errorCode: converterError.code,
      conversionId: converterError.conversionId ?? undefined,
      upstreamStatus: converterError.upstreamStatus,
      artifactKind: variant,
      finalBvhSha256,
    });
    await failed(converterError.code);
    return c.json(
      errorEnvelope(
        converterError.code,
        converterMessage(converterError.code),
        c.get("requestId"),
      ),
      converterStatus(converterError.code),
    );
  }

  log.info({
    type: "converter",
    event: "convert_completed",
    jobId,
    personIndex,
    candidateId,
    poseId,
    artifactKind: variant,
    fallbackReason: fallbackReason ?? undefined,
    finalBvhSha256,
    conversionId: conversion.conversionId,
    sourceBvhSha256: conversion.sourceBvhSha256,
    fbxArtifactSha256: conversion.artifactSha256,
    solverVersion: conversion.solverVersion,
    characterId: config.converterCharacterId,
    mirror: false,
  });
  await recordExport({
    installationId,
    jobId,
    personIndex,
    candidateId,
    status: "completed",
    variant,
    fallbackReason: fallbackReason ?? undefined,
    format,
  });
  return bytesResponse(conversion.fbx, `${poseId}.fbx`);
});

// GET /v1/pose-candidates/:id/thumbnail?view=front — 인증된 PNG 프록시
poseRoutes.get("/:id/thumbnail", async (c) => {
  const view = c.req.query("view");
  if (!view) {
    return c.json(
      errorEnvelope(
        "INVALID_INPUT",
        "view 쿼리 파라미터가 필요합니다.",
        c.get("requestId"),
      ),
      400,
    );
  }

  const upstream = await getPoseThumbnail(c.req.param("id"), view);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "image/png",
      "Cache-Control":
        upstream.headers.get("Cache-Control") ?? "private, max-age=86400",
    },
  });
});
