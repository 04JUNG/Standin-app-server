import { config } from "../config.js";
import { hasSupporterAccess } from "./store.js";

export interface AccessStatus {
  required: boolean;
  allowed: boolean;
  role: "operator" | "supporter" | null;
}
export async function installationAccess(installationId: string): Promise<AccessStatus> {
  if (config.accessOperatorInstallations.has(installationId))
    return { required: config.accessGateEnabled, allowed: true, role: "operator" };
  if (!config.accessGateEnabled) return { required: false, allowed: true, role: null };
  const allowed = config.supporterAccessEnabled && await hasSupporterAccess(installationId);
  return { required: true, allowed, role: allowed ? "supporter" : null };
}

export function accessManagementRequest(method: string, path: string): boolean {
  if (method === "DELETE" && (path === "/v1/installations/current/data" ||
      /^\/v1\/replays(?:\/[a-f0-9-]{36})?$/.test(path))) return true;
  return (method === "GET" && path === "/v1/installations/current/access") ||
    (method === "POST" && path === "/v1/installations/current/access/redeem") ||
    (["GET", "PUT"].includes(method) && path === "/v1/installations/current/quality-consent");
}
