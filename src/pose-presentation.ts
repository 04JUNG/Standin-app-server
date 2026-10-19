import { verifiedPoster } from "./pose-posters.js";
import { getPosePoster } from "./inference.js";
import { isBodyScope, resolvePersonOutputScope } from "./output-scope/model.js";
/** Versioned, lookup-only presentation. Assets stay in the private per-person context. */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AnalysisPerson, PoseCandidate } from "./types.js";
import type { AppEnv } from "./env.js";
import { queryOne } from "./db.js";
import { getOwnedJob } from "./jobs/store.js";
import { getPoseBvh } from "./inference.js";
import { errorEnvelope } from "./mapping.js";
import { config } from "./config.js";
import { BodyError, bodyStore } from "./body-selection/store.js";
import { shapeRenderable } from "./body-selection/shape.js";
import { checkCharacter } from "./characters/service.js";
import { converterEnabled, ConverterError } from "./converter/client.js";
import { convertFramed } from "./converter/framing.js";
import { getPreviewRuntime } from "./converter/previewRuntime.js";
import { cameraArtifact } from "./candidate-camera/artifacts.js";

export interface RenderCamera {
  version: "pose-preview-camera-v1";
  projection: "orthographic" | "perspective";
  rotation: number[][];
  yaw_degrees: number;
  pitch_degrees: number;
  roll_degrees: number;
  distance_torso: number | null;
  basis: "right-handed-Y-up";
  rotation_order: "Rz@Rx@Ry_column_vectors";
  origin: "hip_midpoint";
  scale: "hip_to_shoulder_midpoint_length";
  screen_y: "down";
  projection_rule: "xy=(x,-y)" | "xy=(x,-y)/(z+distance_torso)";
  projection_matches_search: boolean;
  fit_to_rough_pixels: false;
  bvh_camera_rotation_applied: false;
}
export interface MirrorComparison {
  family_id: string;
  original_pose_id: string;
  original_bvh_sha256: string;
  original_candidate_id: string;
  is_mirror: boolean;
  observed_side: "left" | "right";
  reference_side: "left" | "right";
  reason: "opposite_hand_reference";
  matches_observed_side: false;
}
export interface PreviewCandidate {
  candidate_id: string;
  pose_id: string | null;
  source: "library" | "generation";
  kind: string;
  mirror_comparison?: MirrorComparison | null;
  rank: number;
  camera_kind: string;
  render_camera: RenderCamera;
  score_kind: "weighted_rrf" | "semantic_similarity" | null;
  rank_score: number | null;
  score_is_accuracy: false;
  asset: {
    transport: "library_bvh" | "inline_bvh";
    bvh_sha256: string;
    preview_bvh_url: string;
  };
  lookup_allowed: true;
  review_required: true;
  auto_apply_allowed: false;
  refine_allowed: false;
  export_allowed: false;
  release_allowed: false;
  actual_mesh_validated: false;
}
export interface PosePresentation {
  version: string;
  person_index: number;
  route: string;
  status: string;
  search_status: string;
  search_reason: string | null;
  generation_status: string | null;
  generation_reason: string | null;
  output_scope: string | null;
  unobserved_body_is_default: boolean | null;
  library_candidates: PreviewCandidate[];
  review_candidates: PreviewCandidate[];
  generated_candidates: PreviewCandidate[];
  mirror_comparison?: {
    status: "ready" | "unavailable" | "not_requested";
    reason: string | null;
  } | null;
  basic_model: { status: string; output_scope: string | null } | null;
  issues: string[];
  preview_status: string;
  auto_apply_allowed: false;
  refine_allowed: false;
  export_allowed: false;
}
/** Only an explicitly selectable, owned library row can use its stored presentation camera.
 * This does not fabricate a fitted candidate-camera contract or promote references/generation.
 */
export function manualPresentationCamera(
  person: AnalysisPerson | undefined,
  candidate: PoseCandidate | undefined,
) {
  const p = person?.posePresentation;
  if (
    !candidate ||
    candidate.source !== "library" ||
    candidate.lookupAllowed !== true ||
    candidate.releaseAllowed !== true ||
    !candidate.bvhAvailable ||
    !candidate.sourceBvhSha256 ||
    p?.version !== "dynamic-pose-presentation-v1" ||
    !["ready", "review_ready"].includes(p.status) ||
    !["ok", "partial_error"].includes(p.search_status)
  )
    return null;
  const row = p.library_candidates.find(
    (c) =>
      c.candidate_id === candidate.id &&
      c.pose_id === candidate.poseId &&
      c.source === "library" &&
      c.kind === "library_match" &&
      c.asset.transport === "library_bvh" &&
      c.asset.bvh_sha256 === candidate.sourceBvhSha256,
  );
  if (!row) return null;
  try {
    return {
      camera: validateRenderCamera(row.render_camera),
      sourceBvhSha256: row.asset.bvh_sha256,
    };
  } catch {
    return null;
  }
}
export interface PrivatePreviewAsset {
  transport: "library_bvh" | "inline_bvh";
  bvh_sha256: string;
  pose_id: string | null;
  bvh?: string;
}
const groups = [
  "library_candidates",
  "review_candidates",
  "generated_candidates",
] as const;
const forbidden = [
  "auto_apply_allowed",
  "refine_allowed",
  "export_allowed",
  "release_allowed",
  "actual_mesh_validated",
];
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("invalid_object");
  return v as Record<string, unknown>;
};
const code = (v: unknown): string | null =>
  typeof v === "string" && /^[A-Za-z0-9_:.-]{1,160}$/.test(v) ? v : null;
const requireCode = (v: unknown) => {
  const x = code(v);
  if (!x) throw Error("invalid_status");
  return x;
};
const digest = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    throw Error("invalid_hash");
  return v;
};
export function validateRenderCamera(value: unknown): RenderCamera {
  const c = object(value);
  if (
    c.version !== "pose-preview-camera-v1" ||
    c.basis !== "right-handed-Y-up" ||
    c.rotation_order !== "Rz@Rx@Ry_column_vectors" ||
    c.origin !== "hip_midpoint" ||
    c.scale !== "hip_to_shoulder_midpoint_length" ||
    c.screen_y !== "down" ||
    c.bvh_camera_rotation_applied !== false ||
    c.fit_to_rough_pixels !== false ||
    typeof c.projection_matches_search !== "boolean"
  )
    throw Error("invalid_camera_contract");
  if (
    ![c.yaw_degrees, c.pitch_degrees, c.roll_degrees].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    )
  )
    throw Error("invalid_camera_angles");
  if (
    c.projection === "orthographic"
      ? c.distance_torso !== null || c.projection_rule !== "xy=(x,-y)"
      : c.projection !== "perspective" ||
        typeof c.distance_torso !== "number" ||
        !Number.isFinite(c.distance_torso) ||
        c.distance_torso <= 0 ||
        c.projection_rule !== "xy=(x,-y)/(z+distance_torso)"
  )
    throw Error("invalid_projection");
  const m = c.rotation as number[][];
  if (
    !Array.isArray(m) ||
    m.length !== 3 ||
    m.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 3 ||
        r.some((x) => !Number.isFinite(x)),
    )
  )
    throw Error("invalid_rotation");
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (
        Math.abs(
          m[i].reduce((s, x, k) => s + x * m[j][k], 0) - (i === j ? 1 : 0),
        ) > 1e-5
      )
        throw Error("nonorthogonal_rotation");
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det - 1) > 1e-5) throw Error("reflected_rotation");
  const keys = [
    "version",
    "projection",
    "rotation",
    "yaw_degrees",
    "pitch_degrees",
    "roll_degrees",
    "distance_torso",
    "basis",
    "rotation_order",
    "origin",
    "scale",
    "screen_y",
    "projection_rule",
    "projection_matches_search",
    "fit_to_rough_pixels",
    "bvh_camera_rotation_applied",
  ];
  return Object.fromEntries(
    keys.map((k) => [k, structuredClone(c[k])]),
  ) as unknown as RenderCamera;
}

export function mapPosePresentation(
  value: unknown,
  index: number,
  jobId: string,
): {
  presentation: PosePresentation;
  assets: Record<string, PrivatePreviewAsset>;
} | null {
  if (value == null) return null;
  const empty: PosePresentation = {
    version: "unsupported",
    person_index: index,
    route: "error",
    status: "error",
    search_status: "error",
    search_reason: null,
    generation_status: null,
    generation_reason: null,
    output_scope: null,
    unobserved_body_is_default: null,
    library_candidates: [],
    review_candidates: [],
    generated_candidates: [],
    basic_model: null,
    issues: [],
    preview_status: "unavailable",
    auto_apply_allowed: false,
    refine_allowed: false,
    export_allowed: false,
  };
  try {
    const raw = object(value);
    if (raw.version !== "dynamic-pose-presentation-v1")
      throw Error("unsupported_presentation_version");
    if (
      raw.person_index !== index ||
      raw.source !== "dynamic_search" ||
      ["auto_apply_allowed", "refine_allowed", "export_allowed"].some(
        (k) => raw[k] !== false,
      )
    )
      throw Error("invalid_presentation_policy");
    const scope = raw.output_scope;
    if (
      scope !== null &&
      !["full", "half", "bust", "shoulder_head", "head"].includes(String(scope))
    )
      throw Error("unsupported_output_scope");
    const presentation: PosePresentation = {
      ...empty,
      version: raw.version,
      route: requireCode(raw.route),
      status: requireCode(raw.status),
      search_status: requireCode(raw.search_status),
      search_reason: code(raw.search_reason),
      generation_status: code(raw.generation_status),
      generation_reason: code(raw.generation_reason),
      output_scope: scope as string | null,
      unobserved_body_is_default:
        typeof raw.unobserved_body_is_default === "boolean"
          ? raw.unobserved_body_is_default
          : null,
      issues: Array.isArray(raw.issues)
        ? raw.issues
            .map(code)
            .filter((x): x is string => !!x)
            .slice(0, 30)
        : [],
      preview_status: requireCode(raw.preview_status),
    };
    if (raw.basic_model) {
      const b = object(raw.basic_model);
      presentation.basic_model = {
        status: requireCode(b.status),
        output_scope: code(b.output_scope),
      };
    }
    const assets: Record<string, PrivatePreviewAsset> = {};
    for (const group of groups) {
      const rows = raw[group];
      const limit =
        group === "review_candidates"
          ? 10
          : group === "library_candidates"
            ? 5
            : 3;
      if (!Array.isArray(rows) || rows.length > limit)
        throw Error("invalid_candidate_group");
      for (const row of rows) {
        const c = object(row),
          a = object(c.asset),
          id = c.candidate_id;
        if (
          typeof id !== "string" ||
          !/^preview_[a-f0-9]{64}$/.test(id) ||
          assets[id] ||
          !Number.isInteger(c.rank) ||
          (c.rank as number) < 1 ||
          forbidden.some((k) => c[k] !== false) ||
          c.lookup_allowed !== true ||
          c.review_required !== true ||
          c.score_is_accuracy !== false
        )
          throw Error("invalid_candidate_policy");
        const hash = digest(a.bvh_sha256),
          generated = group === "generated_candidates";
        const kinds =
          group === "library_candidates"
            ? ["library_match"]
            : generated
              ? ["generated_review"]
              : [
                  "near_match",
                  "geometry_review",
                  "framing_reference",
                  "mirror_reference",
                ];
        if (
          !kinds.includes(String(c.kind)) ||
          c.source !== (generated ? "generation" : "library")
        )
          throw Error("invalid_candidate_source");
        const pid = c.pose_id;
        if (generated) {
          if (
            pid !== null ||
            a.transport !== "inline_bvh" ||
            a.bvh_url !== null ||
            a.encoding !== "utf-8" ||
            a.library_lookup_supported !== false ||
            typeof a.bvh !== "string" ||
            !a.bvh ||
            Buffer.byteLength(a.bvh) > 2_000_000 ||
            sha(a.bvh) !== hash
          )
            throw Error("invalid_inline_bvh");
          assets[id] = {
            transport: "inline_bvh",
            bvh_sha256: hash,
            pose_id: null,
            bvh: a.bvh,
          };
        } else {
          if (
            typeof pid !== "string" ||
            !pid ||
            pid.length > 512 ||
            /[\/\\\x00-\x1f\x7f]/.test(pid) ||
            [".", ".."].includes(pid) ||
            a.transport !== "library_bvh" ||
            a.bvh_url !==
              `/pose/${encodeURIComponent(pid).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}/bvh` ||
            a.bvh !== null ||
            a.encoding !== null ||
            a.library_lookup_supported !== true
          )
            throw Error("invalid_library_binding");
          assets[id] = {
            transport: "library_bvh",
            bvh_sha256: hash,
            pose_id: pid,
          };
        }
        if (
          c.rank_score !== null &&
          (typeof c.rank_score !== "number" || !Number.isFinite(c.rank_score))
        )
          throw Error("invalid_rank_score");
        let comparison: MirrorComparison | null = null;
        if (c.kind === "mirror_reference") {
          const m = object(c.mirror_comparison);
          const validation = object(c.validation);
          const mirrorCamera = validateRenderCamera(c.render_camera);
          const original = presentation.library_candidates.find(
            (p) =>
              p.candidate_id === m.original_candidate_id &&
              p.pose_id === m.original_pose_id,
          );
          if (
            !original ||
            m.original_bvh_sha256 !== original.asset.bvh_sha256 ||
            original.pose_id === pid ||
            original.asset.bvh_sha256 === hash ||
            typeof m.family_id !== "string" ||
            !m.family_id ||
            m.family_id.length > 512 ||
            typeof m.is_mirror !== "boolean" ||
            !["left", "right"].includes(String(m.observed_side)) ||
            !["left", "right"].includes(String(m.reference_side)) ||
            m.observed_side === m.reference_side ||
            m.reason !== "opposite_hand_reference" ||
            m.matches_observed_side !== false ||
            c.rank_score !== null ||
            c.score_kind !== null ||
            c.score != null ||
            validation.not_exact_match !== true ||
            validation.constraints_satisfied !== false ||
            mirrorCamera.projection_matches_search !== false ||
            JSON.stringify({
              ...mirrorCamera,
              projection_matches_search: false,
            }) !==
              JSON.stringify({
                ...original.render_camera,
                projection_matches_search: false,
              })
          )
            throw Error("invalid_mirror_reference");
          comparison = {
            family_id: m.family_id,
            original_pose_id: original.pose_id!,
            original_bvh_sha256: original.asset.bvh_sha256,
            original_candidate_id: original.candidate_id,
            is_mirror: m.is_mirror,
            observed_side: m.observed_side as "left" | "right",
            reference_side: m.reference_side as "left" | "right",
            reason: "opposite_hand_reference",
            matches_observed_side: false,
          };
        } else if (c.mirror_comparison)
          throw Error("unexpected_mirror_reference");
        presentation[group].push({
          candidate_id: id,
          pose_id: pid as string | null,
          source: generated ? "generation" : "library",
          kind: String(c.kind),
          ...(comparison ? { mirror_comparison: comparison } : {}),
          rank: c.rank as number,
          camera_kind: requireCode(c.camera_kind),
          render_camera: validateRenderCamera(c.render_camera),
          score_kind: c.score_kind === "weighted_rrf" ? "weighted_rrf" : null,
          rank_score: c.rank_score as number | null,
          score_is_accuracy: false,
          asset: {
            transport: generated ? "inline_bvh" : "library_bvh",
            bvh_sha256: hash,
            preview_bvh_url: `/v1/analysis/jobs/${encodeURIComponent(jobId)}/people/${index}/pose-previews/${id}/${hash}`,
          },
          lookup_allowed: true,
          review_required: true,
          auto_apply_allowed: false,
          refine_allowed: false,
          export_allowed: false,
          release_allowed: false,
          actual_mesh_validated: false,
        });
      }
    }
    const pair = raw.mirror_comparison;
    if (
      presentation.review_candidates.some(
        (p) => p.kind === "mirror_reference",
      ) &&
      (!pair || object(pair).status !== "ready")
    )
      throw Error("invalid_mirror_status");
    if (pair !== null && pair !== undefined) {
      const m = object(pair);
      if (!["ready", "unavailable", "not_requested"].includes(String(m.status)))
        throw Error("invalid_mirror_status");
      if (
        m.status === "ready" &&
        (presentation.review_candidates.filter(
          (p) => p.kind === "mirror_reference",
        ).length !== 1 ||
          presentation.library_candidates.length > 4 ||
          presentation.library_candidates.length +
            presentation.review_candidates.length >
            5 ||
          presentation.generated_candidates.length ||
          ![null, "not_requested"].includes(presentation.generation_status))
      )
        throw Error("invalid_mirror_budget");
      presentation.mirror_comparison = {
        status: m.status as "ready" | "unavailable" | "not_requested",
        reason: code(m.reason),
      };
    }
    return { presentation, assets };
  } catch (error) {
    return {
      presentation: {
        ...empty,
        library_candidates: [],
        review_candidates: [],
        generated_candidates: [],
        issues: [
          error instanceof Error ? error.message : "invalid_presentation",
        ],
      },
      assets: {},
    };
  }
}
async function loadAssets(
  jobId: string,
  index: number,
): Promise<Record<string, PrivatePreviewAsset>> {
  const row = await queryOne<{ refine_context_json: string | null }>(
    "SELECT refine_context_json FROM analysis_people WHERE job_id=$1 AND person_index=$2",
    [jobId, index],
  );
  try {
    return (
      JSON.parse(row?.refine_context_json ?? "{}").posePresentationAssets ?? {}
    );
  } catch {
    return {};
  }
}
const defaults = {
  getPosePoster,
  getOwnedJob,
  loadAssets,
  getPoseBvh,
  enabled: () => config.bodySelectionEnabled && converterEnabled(),
  selection: bodyStore.selection,
  checkCharacter,
  getPreviewRuntime,
  convertFramed,
};
type PreviewDeps = typeof defaults;
/** Private source verification is shared by the skeleton and selected-body transports. */
async function readPreview(
  deps: PreviewDeps,
  owner: string,
  jobId: string,
  index: number,
  id: string,
  hash: string,
) {
  const job = await deps.getOwnedJob(jobId, owner);
  const person = job?.result?.candidatesByPerson.find(
    (p) => p.personIndex === index,
  );
  const p = person?.posePresentation;
  const candidate =
    p && groups.flatMap((g) => p[g]).find((x) => x.candidate_id === id);
  if (
    job?.status !== "completed" ||
    !candidate ||
    candidate.asset.bvh_sha256 !== hash
  )
    throw new BodyError("PREVIEW_UNAVAILABLE", 404);
  const a = (await deps.loadAssets(jobId, index))[id];
  if (
    !a ||
    a.bvh_sha256 !== hash ||
    a.transport !== candidate.asset.transport ||
    a.pose_id !== candidate.pose_id
  )
    throw new BodyError("PREVIEW_SOURCE_CHANGED", 409);
  let bytes: Uint8Array;
  if (a.transport === "inline_bvh") bytes = Buffer.from(a.bvh ?? "", "utf8");
  else {
    if (!a.pose_id) throw new BodyError("PREVIEW_UNAVAILABLE", 409);
    const response = await deps.getPoseBvh(a.pose_id);
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) > 2_000_000
    ) {
      await response.body?.cancel();
      throw new BodyError("PREVIEW_UNAVAILABLE", 409);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new BodyError("PREVIEW_UNAVAILABLE", 409);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const n = await reader.read();
        if (n.done) break;
        size += n.value.length;
        if (size > 2_000_000) throw new BodyError("PREVIEW_UNAVAILABLE", 409);
        chunks.push(n.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    bytes = Buffer.concat(chunks);
  }
  if (!bytes.length || bytes.length > 2_000_000 || sha(bytes) !== hash)
    throw new BodyError("PREVIEW_HASH_MISMATCH", 409);
  return { candidate, scope: resolvePersonOutputScope(person).resolved, bytes };
}
export function createPresentationRoutes(overrides: Partial<PreviewDeps> = {}) {
  const deps = { ...defaults, ...overrides },
    routes = new Hono<AppEnv>();
  const prefix = "/:jobId/people/:personIndex/pose-previews/:candidateId/:hash";
  routes.onError((error, c) =>
    c.json(
      errorEnvelope(
        error instanceof BodyError || error instanceof ConverterError
          ? error.code
          : "PREVIEW_UNAVAILABLE",
        "미리보기를 확인하지 못했습니다. 다시 시도해 주세요.",
        c.get("requestId"),
      ),
      error instanceof BodyError
        ? error.status
        : error instanceof ConverterError &&
            error.code === "CONVERTER_INTEGRITY"
          ? 409
          : 503,
    ),
  );
  for (const path of [prefix, `${prefix}/body/:revision`])
    routes.use(path, async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      if (!c.get("installationId"))
        return c.json(
          errorEnvelope(
            "UNAUTHORIZED",
            "설치 인증이 필요합니다.",
            c.get("requestId"),
          ),
          401,
        );
      if (
        !/^(0|[1-9]\d*)$/.test(c.req.param("personIndex")!) ||
        !Number.isSafeInteger(Number(c.req.param("personIndex"))) ||
        !/^preview_[a-f0-9]{64}$/.test(c.req.param("candidateId")!) ||
        !/^[a-f0-9]{64}$/.test(c.req.param("hash")!) ||
        Object.keys(c.req.query()).length
      )
        throw new BodyError("INVALID_SELECTION", 409);
      await next();
    });
  routes.get(prefix, async (c) => {
    const hash = c.req.param("hash");
    const { bytes } = await readPreview(
      deps,
      c.get("installationId")!,
      c.req.param("jobId"),
      Number(c.req.param("personIndex")),
      c.req.param("candidateId"),
      hash,
    );
    return new Response(bytes, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Standin-BVH-SHA256": hash,
      },
    });
  });
  // This PNG is reference-only. It never grants release/refine/export to presentation candidates.
  routes.get(`${prefix}/poster`, async (c) => {
    const owner = c.get("installationId")!, job = c.req.param("jobId"),
      index = Number(c.req.param("personIndex")), id = c.req.param("candidateId"), hash = c.req.param("hash");
    const preview = await readPreview(deps, owner, job, index, id, hash);
    if (!preview.candidate.pose_id || preview.candidate.asset.transport !== "library_bvh")
      throw new BodyError("PREVIEW_UNAVAILABLE", 404);
    const response = await verifiedPoster(preview.candidate.pose_id, hash, deps.getPosePoster, preview.scope);
    const current = await readPreview(deps, owner, job, index, id, hash);
    if (current.scope !== preview.scope || JSON.stringify(current.candidate) !== JSON.stringify(preview.candidate))
      throw new BodyError("PREVIEW_SOURCE_CHANGED", 409);
    return response;
  });
  routes.get(`${prefix}/body/:revision`, async (c) => {
    if (!deps.enabled()) throw new BodyError("BODY_SELECTION_DISABLED", 503);
    const owner = c.get("installationId")!,
      job = c.req.param("jobId"),
      index = Number(c.req.param("personIndex")),
      id = c.req.param("candidateId"),
      hash = c.req.param("hash"),
      rev = c.req.param("revision");
    if (!/^(0|[1-9]\d*)$/.test(rev) || !Number.isSafeInteger(Number(rev)))
      throw new BodyError("INVALID_INPUT", 400);
    const preview = await readPreview(deps, owner, job, index, id, hash);
    const selection = await deps.selection(owner, job, index);
    if (selection.selectionRevision !== Number(rev))
      throw new BodyError("BODY_PREVIEW_STALE", 409);
    if (
      !selection.previewOnly ||
      selection.resolutionStatus !== "ready" ||
      !selection.resolvedBody ||
      !shapeRenderable(selection)
    )
      throw new BodyError("BODY_PREVIEW_UNSUPPORTED", 409);
    const body = selection.resolvedBody;
    if ((await deps.checkCharacter(body.characterId)) !== "ok")
      throw new BodyError("BODY_UNAVAILABLE", 409);
    const scope = preview.scope;
    if (!isBodyScope(scope))
      throw new BodyError("BODY_PREVIEW_UNSUPPORTED", 409);
    const camera = validateRenderCamera(preview.candidate.render_camera),
      runtime = await deps.getPreviewRuntime();
    const binding = JSON.stringify([
      selection,
      preview.candidate,
      scope,
      runtime,
    ]);
    const artifact = await cameraArtifact(
      ["presentation-body-v1", owner, job, index, id, binding],
      {
        bvhBytes: preview.bytes,
        characterId: body.characterId,
        shape: selection.shape,
        shapeSource: selection.shapeSource,
        scope,
        cameraRotation: camera.rotation,
        expectedCharacterSha256: body.assetSha256,
        expectedPreviewRevision: runtime.previewRevision,
      },
      deps.convertFramed,
    );
    if (
      artifact.characterSha256 !== body.assetSha256 ||
      artifact.previewRevision !== runtime.previewRevision ||
      artifact.sourceBvhSha256 !== hash
    )
      throw new ConverterError(
        "CONVERTER_INTEGRITY",
        "presentation body mismatch",
      );
    // A late cached/render response must not win after body, camera, source, scope or runtime changes.
    const current = await readPreview(deps, owner, job, index, id, hash);
    const currentScope = current.scope;
    if (
      JSON.stringify([
        await deps.selection(owner, job, index),
        current.candidate,
        currentScope,
        await deps.getPreviewRuntime(),
      ]) !== binding
    )
      throw new BodyError("BODY_PREVIEW_STALE", 409);
    return new Response(artifact.preview, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, no-store",
        "X-Standin-Body-Revision": rev,
        "X-Standin-Output-Scope": scope,
        "X-Standin-Character-SHA256": body.assetSha256,
        "X-Standin-Shape-SHA256": selection.shape?.shapeSha256 ?? "none",
        "X-Standin-Source-BVH-SHA256": hash,
        "X-Standin-Artifact-SHA256": sha(artifact.preview),
        "X-Standin-Preview-Projection": "orthographic",
        "X-Standin-Preview-Only": "true",
      },
    });
  });
  return routes;
}
