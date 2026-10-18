import { readFileSync } from "node:fs";
import { config } from "../config.js";
import type { BodyCatalog } from "./model.js";
import { validShapeSource, validShapeSpec } from "./shape.js";
import { validShapeRuntime } from "./shapeRuntime.js";
import { isRetiredCharacter } from "../characters/catalog.js";
export const emptyCatalog = (): BodyCatalog => ({
  version: "unavailable",
  defaultCharacterId: null,
  assets: [],
});
export function parseCatalog(value: unknown): BodyCatalog {
  const c = value as BodyCatalog | null;
  if (
    !c ||
    typeof c.version !== "string" ||
    !Array.isArray(c.assets) ||
    !(c.defaultCharacterId === null || typeof c.defaultCharacterId === "string")
  )
    throw new Error("invalid body catalog");
  const characters = new Set<string>(),
    bodies = new Set<string>();
  for (const a of c.assets) {
    if (
      !a ||
      ![
        a.bodyId,
        a.bodyVersion,
        a.characterId,
        a.rigVersion,
        a.measurementVersion,
      ].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 200,
      ) ||
      typeof a.assetSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(a.assetSha256) ||
      !Array.isArray(a.supportedPoseIds) ||
      !a.supportedPoseIds.every((v) => typeof v === "string" && v.length > 0) ||
      characters.has(a.characterId) ||
      bodies.has(a.bodyId)
    )
      throw new Error("invalid body asset");
    if (
      a.neutralPreview &&
      (!a.neutralPreview.path.startsWith("/") ||
        !/^[a-f0-9]{64}$/.test(a.neutralPreview.sha256) ||
        a.neutralPreview.characterSha256 !== a.assetSha256 ||
        !["t_pose", "attention"].includes(a.neutralPreview.pose) ||
        a.neutralPreview.framing !== "body-comparison.v1")
    )
      throw new Error("invalid neutral preview");
    if (a.shape !== undefined && !validShapeSpec(a.shape))
      throw new Error("invalid shape spec");
    if (a.shapeRuntime !== undefined && !validShapeRuntime(a.shapeRuntime, a.shape))
      throw new Error("invalid shape runtime");
    if (
      a.shapeSource !== undefined &&
      (a.shape === undefined || !validShapeSource(a.shapeSource))
    )
      throw new Error("invalid shape source");
    // The live preview must come from the same controller the converter bakes with:
    // a v2 runtime always names its source; any runtime next to a declared source must match it.
    if (
      (a.shapeRuntime?.format === "standin-shape-runtime.v2" || a.shapeSource) &&
      a.shapeRuntime &&
      a.shapeRuntime.rules !== a.shapeSource?.rules
    )
      throw new Error("shape runtime does not match shape source");
    if (
      a.displayName !== undefined &&
      (typeof a.displayName !== "string" ||
        !a.displayName ||
        a.displayName.length > 200)
    )
      throw new Error("invalid display name");
    characters.add(a.characterId);
    bodies.add(a.bodyId);
  }
  if (c.defaultCharacterId !== null && !characters.has(c.defaultCharacterId))
    throw new Error("unknown body default");
  // An old mounted manifest must not reintroduce retired fixed models into options,
  // recommendations, saved defaults or manual selections. Keep the input untouched.
  return {
    ...c,
    defaultCharacterId:
      c.defaultCharacterId && isRetiredCharacter(c.defaultCharacterId)
        ? null
        : c.defaultCharacterId,
    assets: c.assets.filter((a) => !isRetiredCharacter(a.characterId)),
  };
}
/** Only an operator-approved manifest belongs here. Failure closes selection, never invents assets. */
export function loadBodyCatalog(): BodyCatalog {
  try {
    return parseCatalog(
      JSON.parse(readFileSync(config.bodyCatalogPath, "utf8")),
    );
  } catch {
    return emptyCatalog();
  }
}
