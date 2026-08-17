// 이미지 헤더에서 실제 크기를 읽는다(OB-04).
//
// 왜 필요한가:
// 1. 클라가 보낸 width·height를 그대로 DB에 넣고 있었다. 거짓말한 값이 실제 값을
//    영구히 이긴다(jobs/store.ts의 COALESCE 때문).
// 2. 파일 크기 상한만으로는 decompression bomb을 못 막는다. 20MB PNG가
//    60000x60000을 선언할 수 있고, 그걸 디코딩하는 건 추론 서버다.
//
// 라이브러리를 넣지 않는다 — 헤더 앞부분만 읽으면 되고, 이 저장소는 이미
// 매직바이트를 손으로 확인하고 있다(inputStorage.ts).

export interface ImageSize {
  width: number;
  height: number;
}

/** 지원하는 MIME. inputStorage의 시그니처 검증과 같은 집합이다. */
export type SupportedMime = "image/png" | "image/jpeg" | "image/webp";

function readUint32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>>
    0
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 > bytes.length) return null;
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

/** PNG: 8바이트 시그니처 뒤 첫 청크가 반드시 IHDR이고 width·height가 그 앞에 있다. */
function pngSize(bytes: Uint8Array): ImageSize | null {
  // 8(sig) + 4(len) + 4("IHDR") = 16부터 width, 20부터 height
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  return width && height ? { width, height } : null;
}

/**
 * JPEG: 마커를 훑어 SOF(Start of Frame)에서 크기를 읽는다.
 * SOF0~SOF15 중 DHT(C4)·JPG(C8)·DAC(CC)는 프레임 마커가 아니라 제외한다.
 */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  let offset = 2; // FF D8 다음부터
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null; // 마커 정렬이 깨졌다 = 신뢰할 수 없다
    const marker = bytes[offset + 1]!;
    // 패딩(FF FF)과 독립 마커(RSTn·SOI·EOI)는 길이 필드가 없다.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = readUint16BE(bytes, offset + 2);
    if (length === null || length < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // SOF: [len(2)][precision(1)][height(2)][width(2)]
      const height = readUint16BE(bytes, offset + 5);
      const width = readUint16BE(bytes, offset + 7);
      return width && height ? { width, height } : null;
    }
    // SOS 이후는 엔트로피 코딩 데이터라 마커 스캔이 의미 없다.
    if (marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

/** WebP: RIFF 컨테이너의 청크 종류(VP8 / VP8L / VP8X)마다 크기 위치가 다르다. */
function webpSize(bytes: Uint8Array): ImageSize | null {
  const chunk = String.fromCharCode(...bytes.slice(12, 16));

  if (chunk === "VP8 ") {
    // 손실: 청크 헤더(8) + frame tag(3) + sync code(3) = 26부터 14비트씩
    const w = readUint16LE(bytes, 26);
    const h = readUint16LE(bytes, 28);
    return w && h ? { width: w & 0x3fff, height: h & 0x3fff } : null;
  }

  if (chunk === "VP8L") {
    // 무손실: signature(0x2f) 다음 4바이트에 (width-1) 14비트, (height-1) 14비트가
    // 리틀엔디언 비트 순서로 들어간다.
    if (bytes[20] !== 0x2f || bytes.length < 25) return null;
    const bits =
      (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }

  if (chunk === "VP8X") {
    // 확장: 청크 헤더(8) + flags(4) = 24부터 (width-1)·(height-1)이 24비트 LE
    const w = readUint24LE(bytes, 24);
    const h = readUint24LE(bytes, 27);
    return w !== null && h !== null ? { width: w + 1, height: h + 1 } : null;
  }

  return null;
}

/**
 * 헤더에서 실제 픽셀 크기를 읽는다. 형식을 못 읽으면 null.
 *
 * null은 "위조"가 아니라 "확인 불가"다 — 호출부가 정책을 정한다.
 */
export function readImageSize(bytes: Uint8Array, mime: string): ImageSize | null {
  const size =
    mime === "image/png"
      ? pngSize(bytes)
      : mime === "image/jpeg"
        ? jpegSize(bytes)
        : mime === "image/webp"
          ? webpSize(bytes)
          : null;
  if (!size) return null;
  // 0이나 음수는 헤더가 깨진 것이다.
  return size.width > 0 && size.height > 0 ? size : null;
}

/**
 * 디코딩 비용이 감당 가능한 크기인가.
 *
 * 파일 크기 상한과 별개다 — 압축이 잘 되는 이미지는 20MB 안에서도 수십억 픽셀을
 * 선언할 수 있고, 그걸 실제로 펼치는 건 이 서버 뒤의 추론 서버다.
 */
export function exceedsPixelBudget(size: ImageSize, maxPixels: number): boolean {
  return size.width * size.height > maxPixels;
}
