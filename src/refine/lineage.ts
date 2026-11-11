/** Persist only bounded hashes/version from the actual inference response. */
export interface RefineLineage {
  version: string;
  configSha256: string;
  baseSha256: string;
}
export function refineLineage(
  version: unknown,
  diagnostics: unknown,
): RefineLineage | null {
  const d = diagnostics as {
    context?: { refine_config_sha256?: unknown; base_bvh_sha256?: unknown };
  } | null;
  const config = d?.context?.refine_config_sha256,
    base = d?.context?.base_bvh_sha256;
  return typeof version === "string" &&
    version.length > 0 &&
    version.length <= 100 &&
    typeof config === "string" &&
    /^[a-f0-9]{64}$/.test(config) &&
    typeof base === "string" &&
    /^[a-f0-9]{64}$/.test(base)
    ? { version, configSha256: config, baseSha256: base }
    : null;
}
