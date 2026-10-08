import { readFileSync } from "node:fs";
import { config } from "../config.js";
import type { BodyCatalog } from "./model.js";
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
    characters.add(a.characterId);
    bodies.add(a.bodyId);
  }
  if (c.defaultCharacterId !== null && !characters.has(c.defaultCharacterId))
    throw new Error("unknown body default");
  return c;
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
