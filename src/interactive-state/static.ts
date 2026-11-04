/** Current owned-job static asset negotiation. Missing coverage never runs a bake. */
import { z } from "zod";
import type { AnalysisPerson } from "../types.js";
import { getOwnedJob } from "../jobs/store.js";
import { bodyStore } from "../body-selection/store.js";
import { createInteractiveWorker } from "../converter/interactive.js";
import { sha256Hex } from "../converter/client.js";
import { resolvePersonOutputScope } from "../output-scope/model.js";
import { InteractiveError, type Location } from "./model.js";
import { candidateSourceBytes } from "../candidate-source.js";
import { getPoseBvh } from "../inference.js";
import { loadAssets } from "../pose-presentation.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  n = z.number().finite(),
  matrix = z.array(n).length(16);
const assetSchema = z
  .object({
    schemaVersion: z.literal("interactive-static-asset-v1"),
    sha256: digest,
    bytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
    sourceSha256: digest,
    characterId: z.string().min(1),
    characterSha256: digest,
    scope: z.enum(["full", "half", "bust", "head", "shoulder_head"]),
    revision: z.string().min(1),
    modelVersion: z.literal("posed-mesh-v1"),
    camera: z
      .object({
        schemaVersion: z.literal("interactive-camera-v1"),
        projection: z.enum(["orthographic", "perspective"]),
        viewMatrix: matrix,
        projectionMatrix: matrix,
        matrixLayout: z.literal("column-major"),
        basis: z.literal("right-handed-Y-up"),
        clipSpace: z.literal("webgl-minus-one-to-one"),
        origin: z.literal("hips"),
        units: z.literal("meters"),
        distanceTorso: n.positive(),
        torsoReferenceSha256: digest,
        target: z.tuple([n, n, n]),
        referenceAspect: n.positive(),
        framing: z.literal("projection-includes-center-scale-crop"),
        baked: z.literal("none"),
      })
      .strict(),
  })
  .strict();
const defaults = {
  getOwnedJob,
  selection: bodyStore.selection,
  candidateSourceBytes,
  getPoseBvh,
  loadAssets,
  transport: createInteractiveWorker() as Pick<ReturnType<typeof createInteractiveWorker>, "staticResolve" | "staticFile">,
};
export function createStaticPreviews(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };

  async function assets(
    person: AnalysisPerson,
    body: { characterId: string; assetSha256: string },
    jobId: string,
  ) {
    const scope = resolvePersonOutputScope(person).resolved;
    const requests = person.candidates.map((c) => ({
      identity: {
        sourceSha256:
          c.sourceBvhSha256 ??
          (c.camera as { source_bvh_sha256?: string } | undefined)
            ?.source_bvh_sha256,
        characterId: body.characterId,
        characterSha256: body.assetSha256,
        scope,
      },
      camera: c.camera,
    }));
    if (
      requests.some(
        (r) =>
          !r.identity.sourceSha256 ||
          (r.camera as { version?: string } | undefined)?.version !==
            "candidate-camera-v2",
      )
    )
      return new Map();
    const raw = await deps.transport.staticResolve(requests);
    if (!Array.isArray(raw) || raw.length !== requests.length)
      throw new InteractiveError("CONVERTER_INTEGRITY");
    const assets = new Map<
      string,
      z.infer<typeof assetSchema> & { url: string }
    >();
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === null) continue;
      const asset = assetSchema.parse(raw[i]),
        expected = requests[i].identity;
      if (
        asset.sourceSha256 !== expected.sourceSha256 ||
        asset.characterId !== expected.characterId ||
        asset.characterSha256 !== expected.characterSha256 ||
        asset.scope !== scope ||
        asset.camera.torsoReferenceSha256 !== expected.characterSha256
      )
        throw new InteractiveError("CONVERTER_INTEGRITY");
      assets.set(person.candidates[i].id, {
        ...asset,
        url: `/v1/analysis/jobs/${encodeURIComponent(jobId)}/people/${person.personIndex}/interactive-static/${encodeURIComponent(person.candidates[i].id)}/${asset.sha256}`,
      });
    }
    return assets;
  }
  async function file(
    location: Location,
    candidateId: string,
    sha: string,
    signal: AbortSignal,
  ) {
    const job = await deps.getOwnedJob(location.jobId, location.installationId);
    const person = job?.result?.candidatesByPerson.find(
      (p) => p.personIndex === location.personIndex,
    );
    if (
      !person ||
      job?.status !== "completed" ||
      !person.candidates.some((c) => c.id === candidateId)
    )
      throw new InteractiveError("NOT_FOUND", 404);
    const body = await deps.selection(
      location.installationId,
      location.jobId,
      location.personIndex,
    );
    if (
      !body.resolvedBody ||
      body.resolutionStatus !== "ready" ||
      body.previewOnly ||
      body.shape
    )
      throw new InteractiveError("BODY_PREVIEW_STALE");
    const available = await assets(person, body.resolvedBody, location.jobId);
    const asset = available.get(candidateId);
    if (!asset || asset.sha256 !== sha)
      throw new InteractiveError("NOT_FOUND", 404);
    const bytes = await deps.transport.staticFile(sha, signal);
    if (bytes.length !== asset.bytes || sha256Hex(bytes) !== sha)
      throw new InteractiveError("CONVERTER_INTEGRITY");
    // Ownership/body can change during the byte request. Re-read before delivery.
    const current = await deps.selection(
      location.installationId,
      location.jobId,
      location.personIndex,
    );
    const latestJob = await deps.getOwnedJob(
      location.jobId,
      location.installationId,
    );
    const latestPerson = latestJob?.result?.candidatesByPerson.find(
      (p) => p.personIndex === location.personIndex,
    );
    const candidate = latestPerson?.candidates.find(
      (c) => c.id === candidateId,
    );
    if (
      current.selectionRevision !== body.selectionRevision ||
      current.resolutionStatus !== "ready" ||
      current.previewOnly ||
      current.shape ||
      current.resolvedBody?.characterId !== asset.characterId ||
      current.resolvedBody?.assetSha256 !== asset.characterSha256 ||
      latestJob?.status !== "completed" ||
      !latestPerson ||
      !candidate ||
      resolvePersonOutputScope(latestPerson).resolved !== asset.scope
    )
      throw new InteractiveError("BODY_PREVIEW_STALE");
    // Current inference registry/quarantine/source is checked immediately before delivery.
    const source = await deps.candidateSourceBytes(
      location.jobId,
      latestPerson,
      candidate,
      deps.getPoseBvh,
      deps.loadAssets,
    );
    if (sha256Hex(source) !== asset.sourceSha256)
      throw new InteractiveError("CONVERTER_INTEGRITY");
    return bytes;
  }
  return { assets, file };
}
const previews = createStaticPreviews();
export const staticAssets = previews.assets;
export const staticFile = previews.file;
