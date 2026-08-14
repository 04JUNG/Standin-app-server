// 요청의 실제 client IP 판별과 버킷 키 생성.
//
// 체인은 [Client] → CloudFront → ALB → [ECS Fargate: 이 서버]다(Standin-infra).
// CloudFront가 `X-Forwarded-For: <clientIp>`를 세우고 ALB가 CloudFront 엣지 IP를
// 덧붙이므로 이 서버가 보는 값은 `<clientIp>, <cfEdgeIp>` — 오른쪽 1홉이 신뢰 구간이다.
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "./config.js";
import type { AppEnv } from "./env.js";

/**
 * XFF에서 실제 client IP를 고른다.
 *
 * ⚠ 가장 왼쪽 항목을 그대로 믿으면 안 된다 — 클라가 헤더를 위조해 매 요청 다른 IP를
 * 주장하면 제한을 통째로 우회한다. 우리가 신뢰하는 프록시 홉 수만큼 **오른쪽에서**
 * 세어 들어간 자리가 우리가 검증할 수 있는 마지막 주소다.
 *
 * hops가 0이면 우리 앞에 프록시가 없다는 뜻이므로 **헤더를 통째로 무시한다** —
 * 그 경우 XFF는 클라가 직접 써 보낸 값이라 아무 것도 보장하지 않는다.
 *
 * @param header X-Forwarded-For 원문
 * @param hops 오른쪽에서 신뢰하는 프록시 수(배포=1, 프록시 없는 로컬=0)
 * @returns 판별된 IP. 신뢰할 근거가 없으면 null(소켓 주소로 폴백)
 */
export function forwardedClientIp(header: string | undefined, hops: number): string | null {
  if (!header || hops <= 0) return null;
  const chain = header
    .split(",")
    .map((v) => stripPort(v.trim()))
    .filter(Boolean);
  if (chain.length === 0) return null;
  const index = chain.length - 1 - hops;
  // 홉 수보다 체인이 짧으면(프록시 설정 불일치) 가장 왼쪽으로 떨어진다.
  return chain[Math.max(0, index)] ?? null;
}

/** `1.2.3.4:5678`·`[::1]:5678`·`[::1]` 형태를 주소만 남긴다. */
function stripPort(value: string): string {
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1]!;
  // IPv6는 콜론이 여러 개다. 하나뿐일 때만 포트로 본다.
  const colonCount = (value.match(/:/g) ?? []).length;
  if (colonCount === 1) return value.split(":")[0]!;
  return value;
}

/**
 * 제한 버킷 키로 쓸 형태로 정규화한다.
 *
 * IPv6는 한 사용자가 /64 안에서 주소를 바꿔가며 제한을 우회할 수 있으므로
 * `/64` 프리픽스 단위로 묶는다. IPv4는 주소 그대로 쓴다.
 */
export function normalizeIpKey(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(":")) return address;
  const expanded = expandIpv6(address);
  return expanded ? `${expanded.slice(0, 4).join(":")}::/64` : address;
}

/** `::` 축약을 풀어 8그룹으로 만든다. 실패하면 null. */
function expandIpv6(address: string): string[] | null {
  // IPv4 매핑(::ffff:1.2.3.4)은 그룹 수가 맞지 않으므로 원문을 그대로 쓴다.
  if (address.includes(".")) return null;
  const [head, tail, ...rest] = address.split("::");
  if (rest.length > 0) return null;
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail !== undefined ? (tail ? tail.split(":").filter(Boolean) : []) : null;
  if (right === null) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...Array<string>(fill).fill("0"), ...right];
}

/**
 * 저장·비교에 쓰는 해시 키.
 *
 * 원본 IP를 DB에 남기지 않는다 — 이 저장소는 device token·OAuth 코드도 해시만 보관하고
 * (`installations.token_hash`), 베타 데이터 수집 문서가 하드웨어 식별자 미수집을 명시한다.
 * 제한에는 "같은 IP인가"만 필요하므로 해시로 충분하다.
 */
export function ipBucketKey(ip: string): string {
  return createHash("sha256")
    .update(`${config.ipHashSalt}:${normalizeIpKey(ip)}`)
    .digest("hex")
    .slice(0, 32);
}

/** 요청에서 client IP를 뽑는다. XFF가 없으면 소켓 주소(로컬·직결)로 떨어진다. */
export function clientIp(c: Context<AppEnv>): string {
  const forwarded = forwardedClientIp(c.req.header("x-forwarded-for"), config.trustedProxyHops);
  if (forwarded) return forwarded;
  return getConnInfo(c).remote.address ?? "unknown";
}
