import assert from "node:assert/strict";
import test from "node:test";
import { exceedsPixelBudget, readImageSize } from "./imageHeader.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** SOI + APP0(건너뛸 세그먼트) + SOF0(크기) */
function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]; // 길이 4 = 데이터 2바이트
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08];
  const bytes = [0xff, 0xd8, ...app0, ...sof0];
  bytes.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff);
  return Uint8Array.from(bytes);
}

function webpLossy(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
}

test("PNG IHDR에서 크기를 읽는다", () => {
  assert.deepEqual(readImageSize(png(1920, 1080), "image/png"), { width: 1920, height: 1080 });
});

test("JPEG는 중간 세그먼트를 건너뛰고 SOF에서 읽는다", () => {
  // APP0·EXIF 같은 세그먼트가 앞에 붙는 게 정상이라 마커를 훑어야 한다.
  assert.deepEqual(readImageSize(jpeg(800, 600), "image/jpeg"), { width: 800, height: 600 });
});

test("WebP는 청크 종류마다 크기 위치가 다르다", () => {
  assert.deepEqual(readImageSize(webpLossy(640, 480), "image/webp"), { width: 640, height: 480 });
  assert.deepEqual(readImageSize(webpExtended(4000, 3000), "image/webp"), {
    width: 4000,
    height: 3000,
  });
});

test("잘린 헤더는 크기를 지어내지 않고 null이다", () => {
  assert.equal(readImageSize(png(100, 100).slice(0, 18), "image/png"), null);
  assert.equal(readImageSize(Uint8Array.from([0xff, 0xd8]), "image/jpeg"), null);
  assert.equal(readImageSize(new Uint8Array(0), "image/webp"), null);
});

test("0 크기 헤더는 유효한 값으로 취급하지 않는다", () => {
  assert.equal(readImageSize(png(0, 100), "image/png"), null);
});

test("모르는 MIME은 null", () => {
  assert.equal(readImageSize(png(10, 10), "image/gif"), null);
});

test("픽셀 예산은 파일 크기와 별개로 폭탄을 막는다", () => {
  // 잘 압축된 20MB PNG가 60000x60000(36억 픽셀)을 선언할 수 있다.
  assert.equal(exceedsPixelBudget({ width: 60000, height: 60000 }, 50_000_000), true);
  assert.equal(exceedsPixelBudget({ width: 4000, height: 3000 }, 50_000_000), false);
});
