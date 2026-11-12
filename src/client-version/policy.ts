/** Minimum supported desktop release. Prereleases of 0.2.0 are below the floor. */
export const MINIMUM_CLIENT_VERSION = "0.2.0";
export const CLIENT_VERSION_HEADER = "X-App-Version";

export function isSupportedClientVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return false;
  if (match[4]?.split(".").some((id) => /^0\d+$/.test(id))) return false;
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) return false;
  const floor = MINIMUM_CLIENT_VERSION.split(".").map(Number);
  for (let i = 0; i < floor.length; i++) {
    if (core[i] !== floor[i]) return core[i] > floor[i];
  }
  return !match[4];
}
