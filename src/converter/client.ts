// 내부 Converter API(V3.2 BVH→FBX) 호출을 한 곳에 격리한다.
//
// 계약 원본: Standin-server/docs/FBX_CONVERTER_V3_2_PHASE3_BFF_HANDOFF.md
//
// 이 모듈이 지키는 것은 하나다: **lineage가 끊긴 FBX는 내보내지 않는다.** converter는
// 자기가 받은 BVH의 SHA와 자기가 만든 FBX의 SHA를 헤더로 돌려준다. 우리가 보낸 바이트와
// 받은 바이트를 각각 다시 해싱해 대조하지 않으면, 프록시·재시도·캐시가 중간에서 다른 결과를
// 끼워 넣어도 알 수 없다. 불일치는 오류가 아니라 **폐기** 사유다(핸드오프 §2, §5).
import { createHash } from "node:crypto";
import { config } from "../config.js";

/** 이 BFF가 인정하는 유일한 solver. 다른 값이 오면 배포가 어긋난 것이다. */
export const EXPECTED_SOLVER_VERSION = "chain-transport-v3.2";

/** converter가 강제하는 고정 옵션(app.py의 INVALID_OPTION 검사와 동일). */
const FIXED_FRAME = 0;
const FIXED_OUTPUT_MODE = "rigged_rest";
const FIXED_APPLY_ROOT_TRANSLATION = false;

export type ConverterErrorCode =
  /** 이 BFF에서 FBX가 켜져 있지 않다. 사용자 오류가 아니라 배포 상태다. */
  | "CONVERTER_DISABLED"
  /** Blender·캐릭터 artifact 없음(503) 또는 네트워크 도달 실패. 재시도 가능. */
  | "CONVERTER_UNAVAILABLE"
  /** 변환이 상한을 넘겼다(504 또는 우리 abort). 재시도 가능. */
  | "CONVERTER_TIMEOUT"
  /** 입력 BVH·옵션·character_id가 거부됐다(400/413/422). 재시도해도 같다. */
  | "CONVERTER_REJECTED"
  /** worker 내부 실패(500). 재시도 가능하지만 운영 확인이 필요하다. */
  | "CONVERTER_FAILED"
  /** SHA 또는 solver 버전 불일치. 이 FBX는 저장·배포하지 않는다. */
  | "CONVERTER_INTEGRITY";

export class ConverterError extends Error {
  constructor(
    readonly code: ConverterErrorCode,
    message: string,
    /** converter의 conversion_id. 양쪽 로그를 잇는 유일한 키라 실패에도 최대한 남긴다. */
    readonly conversionId: string | null = null,
    /** converter가 돌려준 HTTP 상태. 도달 실패는 0이다. */
    readonly upstreamStatus = 0,
  ) {
    super(message);
    this.name = "ConverterError";
  }
}

export interface ConversionResult {
  fbx: Uint8Array;
  conversionId: string;
  /** converter가 독립 계산한 입력 BVH SHA. 우리 계산값과 이미 대조를 마친 값이다. */
  sourceBvhSha256: string;
  artifactSha256: string;
  solverVersion: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** FBX export를 노출할 수 있는 상태인가. URL과 flag가 **둘 다** 있어야 한다. */
export function converterEnabled(): boolean {
  return config.fbxExportEnabled && config.converterBaseUrl.trim() !== "";
}

/** converter의 오류 본문. 실패 응답에서 conversion_id를 건져 로그를 잇는다. */
function parseConversionId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { conversion_id?: unknown } };
    const id = parsed.error?.conversion_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function mapUpstreamFailure(status: number, body: string): ConverterError {
  const conversionId = parseConversionId(body);
  // 재시도 가능 여부가 갈리는 지점이다. 400/413/422는 우리가 보낸 입력이 잘못된 것이라
  // 같은 입력으로 다시 눌러도 영원히 같은 결과가 나온다 — 사용자에게 재시도를 권하면 안 된다.
  if (status === 400 || status === 413 || status === 422) {
    return new ConverterError("CONVERTER_REJECTED", "converter rejected the BVH", conversionId, status);
  }
  if (status === 503) {
    return new ConverterError("CONVERTER_UNAVAILABLE", "converter is unavailable", conversionId, status);
  }
  if (status === 504) {
    return new ConverterError("CONVERTER_TIMEOUT", "converter timed out", conversionId, status);
  }
  return new ConverterError("CONVERTER_FAILED", "converter failed", conversionId, status);
}

export interface ConvertInput {
  bvhBytes: Uint8Array;
  /**
   * 업로드 파일명. converter가 `^[^/\\x00]{1,255}$`와 `.bvh` 확장자를 강제하므로
   * 사용자 입력을 그대로 넣지 않고 호출측이 안전한 값을 만든다.
   */
  fileName: string;
  /**
   * 좌우 반전. **converter가 한 번만 적용한다**(핸드오프 §3). BFF가 BVH rotation을 직접
   * 미러링하거나, CSP 단계에서 같은 반전을 다시 하면 두 번 적용된다.
   */
  mirror?: boolean;
  characterId?: string;
}

export interface ConverterDeps {
  fetch: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  defaultCharacterId: string;
}

function defaultDeps(): ConverterDeps {
  return {
    fetch,
    baseUrl: config.converterBaseUrl.replace(/\/+$/, ""),
    timeoutMs: config.converterTimeoutMs,
    defaultCharacterId: config.converterCharacterId,
  };
}

/**
 * 최종 BVH 바이트 → V3.2 FBX.
 *
 * 호출측이 **이미 확정한** 바이트만 받는다. 이 함수는 base/refined를 고르지 않는다 —
 * 그 결정은 refine 소유이고(resolveExportArtifact), 여기서 다시 고르면 두 곳이 서로 다른
 * 답을 낼 수 있다.
 */
export async function convertBvhToFbx(
  input: ConvertInput,
  overrides: Partial<ConverterDeps> = {},
): Promise<ConversionResult> {
  const deps = { ...defaultDeps(), ...overrides };
  if (!deps.baseUrl) {
    throw new ConverterError("CONVERTER_DISABLED", "converter base url is not configured");
  }

  const sourceBvhSha256 = sha256Hex(input.bvhBytes);
  const form = new FormData();
  // ⚠ Blob type은 converter의 ALLOWED_BVH_TYPES에 있어야 한다. 비워 두면 런타임에 따라
  //   빈 content-type이 나가고 converter가 400 INVALID_CONTENT_TYPE으로 막는다.
  form.set("bvh", new Blob([input.bvhBytes], { type: "application/octet-stream" }), input.fileName);
  form.set("character_id", input.characterId ?? deps.defaultCharacterId);
  form.set("frame", String(FIXED_FRAME));
  form.set("mirror", String(input.mirror ?? false));
  form.set("output_mode", FIXED_OUTPUT_MODE);
  form.set("apply_root_translation", String(FIXED_APPLY_ROOT_TRANSLATION));

  let res: Response;
  try {
    res = await deps.fetch(`${deps.baseUrl}/convert`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ConverterError(
      timedOut ? "CONVERTER_TIMEOUT" : "CONVERTER_UNAVAILABLE",
      timedOut ? "converter request timed out" : "converter is unreachable",
    );
  }

  if (!res.ok) {
    throw mapUpstreamFailure(res.status, await res.text().catch(() => ""));
  }

  const conversionId = res.headers.get("X-Standin-Conversion-Id") ?? "";
  const upstreamSourceSha = res.headers.get("X-Standin-Source-BVH-SHA256") ?? "";
  const artifactSha = res.headers.get("X-Standin-Artifact-SHA256") ?? "";
  const solverVersion = res.headers.get("X-Standin-Solver-Version") ?? "";
  const fbx = new Uint8Array(await res.arrayBuffer());

  // 핸드오프 §2의 세 대조. 하나라도 어긋나면 이 FBX는 폐기한다.
  if (upstreamSourceSha !== sourceBvhSha256) {
    throw new ConverterError(
      "CONVERTER_INTEGRITY",
      "converter saw a different source BVH",
      conversionId || null,
      res.status,
    );
  }
  if (sha256Hex(fbx) !== artifactSha) {
    throw new ConverterError(
      "CONVERTER_INTEGRITY",
      "FBX body does not match the declared artifact hash",
      conversionId || null,
      res.status,
    );
  }
  if (solverVersion !== EXPECTED_SOLVER_VERSION) {
    throw new ConverterError(
      "CONVERTER_INTEGRITY",
      `unexpected solver version: ${solverVersion || "(missing)"}`,
      conversionId || null,
      res.status,
    );
  }

  return { fbx, conversionId, sourceBvhSha256, artifactSha256: artifactSha, solverVersion };
}
