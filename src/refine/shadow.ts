/** Private, bounded server envelope. Authenticity is verified by inference. */
export interface RefineShadowEnvelope {
  payload: Record<string, unknown>;
  signature: string;
}

export function readRefineShadow(value: unknown): RefineShadowEnvelope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "payload,signature" ||
      typeof data.signature !== "string" || !/^[0-9a-f]{64}$/.test(data.signature) ||
      !data.payload || typeof data.payload !== "object" || Array.isArray(data.payload)) return undefined;
  try {
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > 65536) return undefined;
    const detached = JSON.parse(json) as RefineShadowEnvelope;
    return detached.payload.version === "refine-shadow-v1" ? detached : undefined;
  } catch { return undefined; }
}
