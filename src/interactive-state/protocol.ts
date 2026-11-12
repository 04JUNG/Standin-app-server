/** Hand quality is intentionally unchecked in this protocol, never falsely certified. */
export const INTERACTIVE_PROTOCOL_HEADER = "X-Standin-Interactive-Protocol";
export const INTERACTIVE_PROTOCOL = "pose-body-only-v1";
export const supportsPoseBodyProtocol = (value: string | undefined) => value === INTERACTIVE_PROTOCOL;
