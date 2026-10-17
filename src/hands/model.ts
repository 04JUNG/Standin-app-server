/** Character-relative hands. Never infer selection from candidates[0]. */
export const SIDES = ["left", "right"] as const;
export const PRESET = /^[a-z][a-z0-9_]{0,63}$/;
export const SHA = /^[a-f0-9]{64}$/;
export type Side = (typeof SIDES)[number];
export interface HandChoice {
  preset: string;
  source: "vlm" | "default";
  confidence: "high" | "low" | null;
  visible: boolean | null;
  candidates: string[];
}
export interface PersonHands {
  left: HandChoice;
  right: HandChoice;
  library_version: string;
  status: "vlm" | "not_requested" | "unavailable";
}
export interface HandCatalog {
  schema_version: 1;
  library_version: string;
  library_sha256: string;
  default_preset: string;
  fallback_order: string[];
  thumbnails_available: boolean;
  categories: Array<{
    id: string;
    label: string;
    presets: Array<{
      id: string;
      label: string;
      description: string;
      thumbnails: Record<Side, string> | null;
    }>;
  }>;
}
export interface HandSelection {
  personIndex: number;
  left: string;
  right: string;
  recommended: Record<Side, string>;
  observation: PersonHands;
  library_version: string;
  library_sha256: string;
  revision: number;
  changed: Side[];
}
export interface HandBake {
  left: string;
  right: string;
  library_version: string;
  library_sha256: string;
  revision: number;
}
export class HandError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function readHands(value: unknown): PersonHands {
  const raw = record(value);
  const choice = (side: Side): HandChoice => {
    const v = record(raw[side]);
    return {
      preset:
        typeof v.preset === "string" && PRESET.test(v.preset)
          ? v.preset
          : "relaxed",
      source: v.source === "vlm" ? "vlm" : "default",
      confidence:
        v.confidence === "high" || v.confidence === "low" ? v.confidence : null,
      visible: typeof v.visible === "boolean" ? v.visible : null,
      candidates: Array.isArray(v.candidates)
        ? [
            ...new Set(
              v.candidates.filter(
                (id): id is string => typeof id === "string" && PRESET.test(id),
              ),
            ),
          ].slice(0, 4)
        : [],
    };
  };
  return {
    left: choice("left"),
    right: choice("right"),
    library_version:
      typeof raw.library_version === "string" ? raw.library_version : "",
    status:
      raw.status === "vlm" || raw.status === "unavailable"
        ? raw.status
        : "not_requested",
  };
}
export function parseCatalog(value: unknown): HandCatalog {
  const v = record(value);
  const invalid = () =>
    new HandError("HANDS_UNAVAILABLE", 503, "손 목록을 확인하지 못했습니다.");
  if (
    v.schema_version !== 1 ||
    typeof v.library_version !== "string" ||
    typeof v.library_sha256 !== "string" ||
    !SHA.test(v.library_sha256) ||
    typeof v.default_preset !== "string" ||
    !Array.isArray(v.categories) ||
    !v.categories.length ||
    v.categories.length > 50
  )
    throw invalid();
  const ids = new Set<string>();
  const categories = v.categories.map((raw) => {
    const c = record(raw);
    if (
      typeof c.id !== "string" ||
      !PRESET.test(c.id) ||
      typeof c.label !== "string" ||
      !Array.isArray(c.presets) ||
      c.presets.length > 200
    )
      throw invalid();
    return {
      id: c.id,
      label: c.label,
      presets: c.presets.map((rawPreset) => {
        const p = record(rawPreset);
        if (
          typeof p.id !== "string" ||
          !PRESET.test(p.id) ||
          ids.has(p.id) ||
          typeof p.label !== "string" ||
          typeof p.description !== "string"
        )
          throw invalid();
        ids.add(p.id);
        return {
          id: p.id,
          label: p.label,
          description: p.description,
          thumbnails:
            v.thumbnails_available === true && p.thumbnails != null
              ? {
                  left: `/v1/hands/${p.id}/thumbnail?side=left`,
                  right: `/v1/hands/${p.id}/thumbnail?side=right`,
                }
              : null,
        };
      }),
    };
  });
  if (!ids.has(v.default_preset)) throw invalid();
  return {
    schema_version: 1,
    library_version: v.library_version,
    library_sha256: v.library_sha256,
    default_preset: v.default_preset,
    thumbnails_available: v.thumbnails_available === true,
    fallback_order: Array.isArray(v.fallback_order)
      ? v.fallback_order.filter(
          (id): id is string => typeof id === "string" && ids.has(id),
        )
      : [],
    categories,
  };
}
