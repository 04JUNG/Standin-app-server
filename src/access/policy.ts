import { config } from "../config.js";
import { readAccessRegistration } from "./store.js";

export interface AccessStatus {
  required: boolean;
  allowed: boolean;
  role: "operator" | "supporter" | null;
  codeRegistered: boolean;
  showBetaEndedNotice: boolean;
}
export async function installationAccess(installationId: string): Promise<AccessStatus> {
  const hiddenNotice = { codeRegistered: false, showBetaEndedNotice: false };
  if (config.accessOperatorInstallations.has(installationId))
    return { required: config.accessGateEnabled, allowed: true, role: "operator", ...hiddenNotice };
  if (!config.accessGateEnabled) return { required: false, allowed: true, role: null, ...hiddenNotice };
  const registration = await readAccessRegistration(installationId);
  const allowed = config.supporterAccessEnabled && registration.active;
  const cutoff = Date.parse(config.openBetaEndedAt);
  const createdAt = registration.created_at ? Date.parse(registration.created_at) : NaN;
  return {
    required: true, allowed, role: allowed ? "supporter" : null,
    codeRegistered: registration.registered,
    showBetaEndedNotice: !registration.registered && Number.isFinite(cutoff) &&
      Number.isFinite(createdAt) && createdAt <= cutoff,
  };
}

export function accessManagementRequest(method: string, path: string): boolean {
  if (method === "DELETE" && (path === "/v1/installations/current/data" ||
      /^\/v1\/replays(?:\/[a-f0-9-]{36})?$/.test(path))) return true;
  return (method === "GET" && path === "/v1/installations/current/access") ||
    (method === "POST" && path === "/v1/installations/current/access/redeem") ||
    (["GET", "PUT"].includes(method) && path === "/v1/installations/current/quality-consent");
}
