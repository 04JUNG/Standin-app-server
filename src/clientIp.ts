// 요청의 실제 client IP 판별과 버킷 키 생성.
//
// 배포 체인은 [Client] → ALB → [ECS Fargate: 이 서버]다(Standin-infra).
// ALB가 자신이 관측한 client IP를 XFF 오른쪽 끝에 append하므로, 클라가 앞쪽 값을
// 위조해도 오른쪽 끝 주소는 신뢰할 수 있다.
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
 * hops는 실제 client IP 오른쪽에 있는 신뢰 프록시 주소 수다. ALB 직결은 ALB 자신을
 * XFF에 넣지 않으므로 0, CloudFront → ALB라면 CloudFront 주소 하나가 있어 1이다.
 * 음수면 신뢰 프록시가 없는 로컬 실행으로 보고 헤더를 통째로 무시한다.
 *
 * @param header X-Forwarded-For 원문
 * @param hops client IP 오른쪽의 신뢰 주소 수(ALB 직결=0, 프록시 없는 로컬=-1)
 * @returns 판별된 IP. 신뢰할 근거가 없으면 null(소켓 주소로 폴백)
 */
export function forwardedClientIp(header: string | undefined, hops: number): string | null {
  if (!header || !Number.isInteger(hops) || hops < 0) return null;
  const chain = header
    .split(",")
    .map((v) => stripPort(v.trim()))
    .filter(Boolean);
  if (chain.length === 0) return null;
  const index = chain.length - 1 - hops;
  // 기대한 프록시 주소보다 체인이 짧으면 설정 불일치다. 위조 가능한 왼쪽 값으로
  // 떨어지지 않고 소켓 주소를 사용한다.
  return index >= 0 ? (chain[index] ?? null) : null;
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
