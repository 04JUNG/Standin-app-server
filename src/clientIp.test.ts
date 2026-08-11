import { strict as assert } from "node:assert";
import test from "node:test";
import { forwardedClientIp, ipBucketKey, normalizeIpKey } from "./clientIp.js";

test("배포 체인(CloudFront→ALB)에서는 오른쪽 1홉을 신뢰한다", () => {
  // CloudFront가 client IP를 쓰고 ALB가 CloudFront 엣지 IP를 덧붙인다.
  assert.equal(forwardedClientIp("203.0.113.7, 130.176.1.9", 1), "203.0.113.7");
});

test("XFF를 위조해도 실제 IP가 선택된다", () => {
  // 클라가 앞에 가짜 주소를 끼워 넣어도 신뢰 홉 기준 자리는 그대로다.
  const spoofed = "1.1.1.1, 2.2.2.2, 203.0.113.7, 130.176.1.9";
  assert.equal(forwardedClientIp(spoofed, 1), "203.0.113.7");
  // 매 요청 앞쪽만 바꿔 봐야 버킷 키가 달라지지 않는다.
  const a = forwardedClientIp("9.9.9.9, 203.0.113.7, 130.176.1.9", 1)!;
  const b = forwardedClientIp("8.8.8.8, 203.0.113.7, 130.176.1.9", 1)!;
  assert.equal(ipBucketKey(a), ipBucketKey(b));
});

test("프록시가 없으면 홉 0으로 가장 오른쪽을 쓴다", () => {
  assert.equal(forwardedClientIp("203.0.113.7", 0), "203.0.113.7");
  assert.equal(forwardedClientIp("1.1.1.1, 203.0.113.7", 0), "203.0.113.7");
});

test("체인이 홉 수보다 짧으면 가장 왼쪽으로 떨어진다", () => {
  assert.equal(forwardedClientIp("203.0.113.7", 3), "203.0.113.7");
});

test("헤더가 없거나 비어 있으면 null(소켓 주소로 폴백)", () => {
  assert.equal(forwardedClientIp(undefined, 1), null);
  assert.equal(forwardedClientIp("", 1), null);
  assert.equal(forwardedClientIp(" , , ", 1), null);
});

test("공백과 포트가 붙어 있어도 주소만 남긴다", () => {
  assert.equal(forwardedClientIp("  203.0.113.7:44321 , 130.176.1.9 ", 1), "203.0.113.7");
  assert.equal(forwardedClientIp("[2001:db8::1]:44321, 130.176.1.9", 1), "2001:db8::1");
});

test("IPv6는 /64로 묶어 주소 갈아타기 우회를 막는다", () => {
  const a = normalizeIpKey("2001:db8:abcd:1234:1::1");
  const b = normalizeIpKey("2001:db8:abcd:1234:ffff:ffff:ffff:ffff");
  assert.equal(a, b);
  assert.equal(a, "2001:db8:abcd:1234::/64");
  // 다른 /64는 다른 버킷이다.
  assert.notEqual(a, normalizeIpKey("2001:db8:abcd:9999::1"));
});

test("축약된 IPv6도 같은 /64로 모인다", () => {
  assert.equal(normalizeIpKey("2001:db8::1"), normalizeIpKey("2001:db8:0:0:5:6:7:8"));
  assert.equal(normalizeIpKey("2001:DB8::1"), normalizeIpKey("2001:db8::2"));
});

test("IPv4는 주소 그대로 구분한다", () => {
  assert.equal(normalizeIpKey("203.0.113.7"), "203.0.113.7");
  assert.notEqual(ipBucketKey("203.0.113.7"), ipBucketKey("203.0.113.8"));
});

test("버킷 키는 원본 IP를 드러내지 않는다", () => {
  const key = ipBucketKey("203.0.113.7");
  assert.equal(key.includes("203.0.113.7"), false);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(key, ipBucketKey("203.0.113.7"));
});
