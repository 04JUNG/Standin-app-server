import assert from "node:assert/strict";
import test from "node:test";
import { InvalidImageContentError, validateInputImage } from "./inputStorage.js";

test("validates image bytes instead of trusting the multipart MIME value", async () => {
  const pngHeader = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await validateInputImage(new Blob([pngHeader], { type: "image/png" }));

  await assert.rejects(
    validateInputImage(new Blob([Uint8Array.from([1, 2, 3])], { type: "image/png" })),
    InvalidImageContentError,
  );
});
