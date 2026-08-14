# Standin App Server (BFF)

Tauri 클라이언트와 도원 추론 서버 사이의 **얇은 앱 서버(BFF)**. Hono/TypeScript.

```
[Tauri 앱] ──/v1──> [이 서버: BFF] ──HTTP──> [도원 추론 서버 (Standin-server)]
클라 UI·상태          인증·Job·번역·엣지        VLM·검출·포즈·검색 (순수 추론)
```

BFF가 하는 일은 셋뿐이다 — ① 인증 ② 동기 추론(`/analyze`)을 비동기 Job으로 감싸기
③ 계약 번역(matchLevel·오류봉투·`/v1`). 추론 로직은 도원 서버가 소유하고, 이 서버는 HTTP로만 호출한다.

> **개발 지침**: [`CLAUDE.md`](CLAUDE.md) — 경계·명령·구조·규칙(구현 전 필독).
> **이 서버의 `/v1` 계약**: [`docs/API.md`](docs/API.md).
> **설계 단일 소스**: `Standin-server/docs/BFF_DESIGN.md` (+ `docs/DECISIONS.md` 결정 4).
> 추론 계약: `Standin-server/docs/API_CONTRACT.md`. 클라 계약: `Standin-client/docs/08_API_CONTRACT.md`.

## 실행

```bash
npm install
cp .env.example .env          # 필요 값 채우기(최소 INFERENCE_BASE_URL)
npm run dev                    # tsx watch → http://localhost:8080
# 헬스체크: GET /healthz → { ok, inference: <추론 서버 연결 여부> }
```

빌드/검사:

```bash
npm run typecheck             # tsc --noEmit
npm run build && npm start    # dist로 빌드 후 실행
```

## Docker — 전체 스택 실행 (inference + BFF)

추론 서버와 BFF를 함께 컨테이너로 띄운다. ⚠ 세 레포가 **형제 디렉터리**로 클론돼 있어야 한다(`../Standin-server`를 빌드 컨텍스트로 사용).

```bash
docker compose up --build      # postgres(5432) + inference(8000, 내부) + bff(8080, 공개)
# 확인: curl http://localhost:8080/healthz  → { "ok": true, "inference": true }
docker compose down            # 종료 (DB는 pg-data 볼륨에 유지)
```

- **클라(Standin-client)는 컨테이너 대상이 아니다** — Tauri 데스크톱 앱이라 네이티브로 실행한다.
  `npm run tauri dev` 후 클라 `.env`의 `VITE_API_BASE_URL=http://localhost:8080`(이 BFF)로 연결.
- 추론 서버는 내부 네트워크에서만 노출(무인증). 공개 포트는 BFF(8080)만.

## 엔드포인트 (현재 스캐폴드 상태)

🔒 = 인증 필요(`Authorization: Bearer <access>`)

| 메서드 | 경로 | 상태 |
|---|---|---|
| `GET` | `/healthz` | ✅ 동작(+추론 연결 확인) |
| `POST` | `/v1/auth/register` | ✅ 계정 생성 → 인증 메일(토큰 미발급) |
| `GET` | `/v1/auth/verify-email` | ✅ 이메일 인증 링크 처리 |
| `POST` | `/v1/auth/resend-verification` | ✅ 인증 메일 재발송 |
| `POST` | `/v1/auth/login` | ✅ 로그인(이메일 인증 필요) → access+refresh |
| `GET` | `/v1/auth/oauth/:provider/start` | ✅ 소셜 로그인 시작(google·kakao·naver) |
| `GET` | `/v1/auth/oauth/:provider/callback` | ✅ 소셜 콜백 → 토큰 |
| `POST` | `/v1/auth/refresh` | ✅ refresh 회전 |
| `POST` | `/v1/auth/logout` | ✅ refresh 폐기 |
| `GET` | `/v1/users/me` 🔒 | ✅ 현재 유저(세션 복원) |
| `POST` | `/v1/analysis/jobs` 🔒 | ✅ Job 생성 → `/analyze` 백그라운드 호출 (설치별 일일 쿼터 적용, 초과 시 `429`) |
| `GET` | `/v1/analysis/jobs/:id` 🔒 | ✅ 상태 폴링 |
| `GET` | `/v1/analysis/jobs/:id/result` 🔒 | ✅ 결과(+matchLevel 매핑) |
| `POST` | `/v1/analysis/jobs/:id/rerun` 🔒 | 🚧 Phase 2 stub(501) |
| `GET` | `/v1/pose-candidates/:id/export` 🔒 | ✅ BVH 프록시 |

## 사용량 제한

오픈베타는 로그인 없이 설치 단위로 쓰므로 서버가 사용량을 강제한다. 카운터 정본은
**PostgreSQL**(`usage_counters`)이다 — 인메모리로 세면 ECS 태스크 수만큼 한도가 늘어나고
배포마다 초기화된다. 값은 전부 env로 조정하며 **0 이하는 제한 없음**이다.

| env | 기본값 | 의미 |
|---|---:|---|
| `QUOTA_INSTALLATION_DAILY` | 10 | 설치별 일일 분석 횟수(KST 자정 리셋) |
| `QUOTA_GLOBAL_DAILY` | 0 | 서비스 전체 일일 분석 상한(비용 산정 전이라 기본 off) |
| `RATE_IP_REGISTER` / `_WINDOW` | 5 / 3600 | IP별 설치 발급 burst |
| `RATE_IP_ANALYZE` / `_WINDOW` | 5 / 60 | IP별 분석 요청 burst |
| `TRUSTED_PROXY_HOPS` | 1 | XFF 오른쪽에서 신뢰하는 프록시 홉 수 |
| `IP_HASH_SALT` | (`JWT_SECRET`) | IP 해시 솔트 |

초과하면 `429` + `Retry-After`와 함께 재시도 가능 시각을 준다 → `docs/API.md`의 「사용량 제한」.

⚠ `TRUSTED_PROXY_HOPS`는 배포 체인(`CloudFront → ALB → BFF`) 기준 **1**이고, 프록시가 없는
로컬은 **0**이다. `0`이면 `X-Forwarded-For`를 아예 읽지 않고 소켓 주소를 쓴다 — 앞에 프록시가
없으면 그 헤더는 클라가 직접 써 보낸 값이라 아무 것도 보장하지 않는다. `0`보다 크면 오른쪽에서
그만큼 세어 들어간 자리를 쓰고, 클라가 채울 수 있는 왼쪽은 믿지 않는다. **이 값을 실제 프록시
수보다 크게 잡으면 IP 제한이 통째로 우회된다.** IP는 원문 대신 `/64`(IPv6) 정규화 후 해시로만
저장한다.

## 구조

```
src/
├─ index.ts        Hono 앱·라우트 마운트·서버 기동
├─ config.ts       env(추론 URL·JWT·DB 경로)
├─ env.ts          Hono 컨텍스트 변수 타입(requestId)
├─ types.ts        클라 /v1 계약 타입(공유 대상)
├─ inference.ts    도원 추론 서버 호출 격리(analyze·getPoseBvh·health)
├─ mapping.ts      계약 번역(matchLevel·오류봉투)
├─ db.ts           PostgreSQL(pg): Pool·스키마 초기화(advisory lock)·쿼리 헬퍼
├─ limits/         사용량 제한(정책 계산·Postgres 카운터·429 번역)
├─ jobs/           Job 생성·폴링·백그라운드 러너(동기추론→Job 래핑, Postgres)
├─ auth/           routes(register/login/verify/refresh/logout) · tokens · users(Postgres) · mailer
│  └─ oauth/       소셜 로그인(google·kakao·naver) 레지스트리 + start/callback
├─ users/          GET /me
└─ pose/           BVH 프록시
```

## 로드맵 (Phase)

```
Phase 0 ✅  Job 래핑·BVH 프록시·헬스.
Phase 1 ✅  인증(JWT+refresh 회전·argon2·/users/me·보호 라우트) + 유저·refresh·Job **PostgreSQL 영속**.
Phase 2     rerun(excludeCandidateIds)·matchLevel 실데이터 보정·레이트리밋.
Phase 3     큐(SQS 등)로 Job 실행 분리, 필요 시 추론 단계 스트리밍.
```

## 알려진 TODO
- `matchLevel` 임계값은 시드값 → `Standin-server/docs/SEARCH_EVAL`로 보정 필요.
- 회원가입 하드닝: 레이트리밋·봇 방지 미포함(Phase 2). 이메일 인증은 구현됨.
- 소셜 로그인은 provider 키가 있어야 동작(없으면 `PROVIDER_UNAVAILABLE`). 데스크톱 토큰 전달은 `OAUTH_SUCCESS_REDIRECT`(딥링크) 필요.
- Job 실행이 아직 프로세스 내 fire-and-forget → 배포·재시작 시 진행 중 Job이 유실된다(큐로 교체 예정).
- 추론 서버는 **무인증·내부용** → 공개 노출 금지, BFF만 공개 엣지.
