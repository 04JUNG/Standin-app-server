/** Hand quality is intentionally unchecked in this protocol, never falsely certified. */
export const INTERACTIVE_PROTOCOL_HEADER = "X-Standin-Interactive-Protocol";
export const INTERACTIVE_PROTOCOL = "pose-body-only-v1";
/** Optional client capability: it can read binary `/model` bytes (standin-binary-f64le-v2). */
export const BINARY_STATE_PROTOCOL = "solved-state-binary-v2";
/** The header is a comma-separated token list (exact, case-sensitive tokens; empty items ignored). */
export function protocolTokens(value: string | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set();
  return new Set(value.split(",").map((token) => token.trim()).filter(Boolean));
}
/** Required on every interactive route, exactly as before the token list existed. */
export const supportsPoseBodyProtocol = (value: string | undefined) =>
  protocolTokens(value).has(INTERACTIVE_PROTOCOL);
/** Only meaningful together with the required body protocol token. */
export const supportsBinaryState = (value: string | undefined) => {
  const tokens = protocolTokens(value);
  return tokens.has(INTERACTIVE_PROTOCOL) && tokens.has(BINARY_STATE_PROTOCOL);
};
