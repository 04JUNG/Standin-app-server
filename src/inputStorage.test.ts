import assert from "node:assert/strict";
import test from "node:test";
import { InvalidImageContentError, inspectInputImage } from "./inputStorage.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 8바이트 시그니처 + IHDR(길이·타입·width·height)까지만 채운 최소 PNG 헤더. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set(PNG_SIGNATURE, 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR 길이
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

test("validates image bytes instead of trusting the multipart MIME value", () => {
  inspectInputImage(pngHeader(1, 1), "image/png");

  assert.throws(
    () => inspectInputImage(Uint8Array.from([1, 2, 3]), "image/png"),
    InvalidImageContentError,
  );
});

test("reports the real pixel size from the header", () => {
  // 클라가 보낸 width·height는 검증되지 않는다. 헤더에서 읽은 값이 정본이다.
  assert.deepEqual(inspectInputImage(pngHeader(1920, 1080), "image/png").size, {
    width: 1920,
    height: 1080,
  });
});

test("signature only is valid but has no readable size", () => {
  // 시그니처만 있고 IHDR이 없으면 형식은 맞지만 크기를 알 수 없다.
  // 이때는 거절하지 않는다 — 크기 확인 불가와 위조는 다르다.
  assert.equal(inspectInputImage(Uint8Array.from(PNG_SIGNATURE), "image/png").size, null);
});
