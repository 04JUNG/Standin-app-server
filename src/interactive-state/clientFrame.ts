/** Auxiliary canvas-only UI asset. This is never pose accuracy, file safety or release evidence. */
import { z } from "zod";
import { sha256Hex } from "../converter/client.js";
import { HTTP_SCHEMA, InteractiveError, SHA } from "./model.js";
import { checkPoster } from "./posters.js";
export const clientFrameSchema = z
  .object({
    schemaVersion: z.literal(HTTP_SCHEMA),
    revision: z.number().int().positive(),
    stateHash: z.string().regex(SHA),
    cameraHash: z.string().regex(SHA),
    rendererVersion: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    imageSha256: z.string().regex(SHA),
    pngBase64: z.string().min(32).max(1400000),
    source: z.literal("client-canvas-ui-auxiliary"),
  })
  .strict();
export type ClientFrame = z.infer<typeof clientFrameSchema>;
export function decodeFrame(frame: ClientFrame) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      frame.pngBase64,
    )
  )
    throw new InteractiveError("INVALID_INPUT", 400);
  const png = Buffer.from(frame.pngBase64, "base64");
  if (png.length > 1024 * 1024)
    throw new InteractiveError("PAYLOAD_TOO_LARGE", 413);
  checkPoster(png);
  if (sha256Hex(png) !== frame.imageSha256)
    throw new InteractiveError("CLIENT_FRAME_INTEGRITY");
  return png;
}
