// 조정본 BVH의 영속 저장(INF-03, OPS-01).
//
// 추론 서버가 만든 조정본은 그 태스크의 **로컬 디스크**에만 있다. desiredCount가 1이어도
// 배포·헬스체크 재시작으로 태스크가 바뀌면 파일이 사라져 다운로드가 404가 된다. 그래서
// BFF가 /refine 직후 바이트를 받아 여기로 옮기고, 이후 export는 S3만 본다.
//
// 저장 위치를 `installations/{id}/` 아래로 잡는 것이 핵심이다. 그러면 inputStorage의
// deleteInstallationObjects() 삭제 스윕과 버킷 전체 90일 lifecycle이 **수정 없이** 그대로
// 적용된다 — 조정본도 사용자 입력에서 파생된 private artifact이므로 같은 정책이어야 한다.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";

const client = new S3Client({});

/** BVH 본문에 쓸 수 없는 문자가 key로 새지 않게 막는다(candidateId는 `pose::view` 형태). */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export interface RefinedArtifactLocation {
  installationId: string;
  jobId: string;
  personIndex: number;
  candidateId: string;
}

function refinedKeyPrefix(input: RefinedArtifactLocation): string {
  return (
    `installations/${safeSegment(input.installationId)}` +
    `/jobs/${safeSegment(input.jobId)}` +
    `/refined/${input.personIndex}/${safeSegment(input.candidateId)}`
  );
}

export function refinedObjectKey(input: RefinedArtifactLocation): string {
  return `${refinedKeyPrefix(input)}.bvh`;
}

/**
 * 확인 화면 미리보기 PNG의 key.
 *
 * BVH와 **다른 확장자로 나란히** 둔다. 같은 prefix를 쓰므로 삭제 스윕과 lifecycle이
 * 그대로 적용되고, 조정본을 지울 때 그림만 남는 일도 없다.
 */
export function refinedThumbnailObjectKey(input: RefinedArtifactLocation): string {
  return `${refinedKeyPrefix(input)}.png`;
}

/** 저장소가 없으면 조정본을 보관할 수 없다 → refine을 적용했다고 기록하면 안 된다. */
export function refinedStorageAvailable(): boolean {
  return Boolean(config.betaDataBucket);
}

export async function putRefinedBvh(key: string, body: Uint8Array): Promise<void> {
  if (!config.betaDataBucket) {
    throw new Error("BETA_DATA_BUCKET is required to persist refined BVH");
  }
  await client.send(
    new PutObjectCommand({
      Bucket: config.betaDataBucket,
      Key: key,
      Body: body,
      ContentType: "application/octet-stream",
    }),
  );
}

/**
 * 미리보기 PNG를 보관한다.
 *
 * 호출측이 실패를 삼킨다 — 그림이 없어도 저장 흐름은 그대로 굴러가야 하기 때문이다.
 * 조정본 BVH와 달리 이 실패는 `refined` 판정에 영향을 주지 않는다.
 */
export async function putRefinedThumbnail(key: string, body: Uint8Array): Promise<void> {
  if (!config.betaDataBucket) {
    throw new Error("BETA_DATA_BUCKET is required to persist refined thumbnail");
  }
  await client.send(
    new PutObjectCommand({
      Bucket: config.betaDataBucket,
      Key: key,
      Body: body,
      ContentType: "image/png",
    }),
  );
}

/** 조정본을 읽는다. 객체가 없거나 읽지 못하면 null — 호출측이 베이스로 안전 전환한다. */
export async function getRefinedBvh(key: string): Promise<Uint8Array | null> {
  return getObjectBytes(key);
}

/** 미리보기 PNG를 읽는다. 없으면 null — 화면은 후보 썸네일로 폴백한다. */
export async function getRefinedThumbnail(key: string): Promise<Uint8Array | null> {
  return getObjectBytes(key);
}

async function getObjectBytes(key: string): Promise<Uint8Array | null> {
  if (!config.betaDataBucket) return null;
  try {
    const res = await client.send(
      new GetObjectCommand({ Bucket: config.betaDataBucket, Key: key }),
    );
    const bytes = await res.Body?.transformToByteArray();
    return bytes ?? null;
  } catch {
    return null;
  }
}
