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

## 엔드포인트 (현재 스캐폴드 상태)

| 메서드 | 경로 | 상태 |
|---|---|---|
| `GET` | `/healthz` | ✅ 동작(+추론 연결 확인) |
| `POST` | `/v1/analysis/jobs` | ✅ Job 생성 → `/analyze` 백그라운드 호출 |
| `GET` | `/v1/analysis/jobs/:id` | ✅ 상태 폴링 |
| `GET` | `/v1/analysis/jobs/:id/result` | ✅ 결과(+matchLevel 매핑) |
| `POST` | `/v1/analysis/jobs/:id/rerun` | 🚧 Phase 2 stub(501) |
| `GET` | `/v1/pose-candidates/:id/export` | ✅ BVH 프록시 |
| `POST` | `/v1/auth/{login,refresh,logout}` | 🚧 Phase 1 stub(501) |

## 구조

```
src/
├─ index.ts        Hono 앱·라우트 마운트·서버 기동
├─ config.ts       env(추론 URL·JWT·DB 경로)
├─ env.ts          Hono 컨텍스트 변수 타입(requestId)
├─ types.ts        클라 /v1 계약 타입(공유 대상)
├─ inference.ts    도원 추론 서버 호출 격리(analyze·getPoseBvh·health)
├─ mapping.ts      계약 번역(matchLevel·오류봉투)
├─ jobs/           Job 생성·폴링·백그라운드 러너(동기추론→Job 래핑)
├─ auth/           JWT 미들웨어 + 라우트(Phase 1 stub)
└─ pose/           BVH 프록시
```

## 로드맵 (Phase)

```
Phase 0 (지금)  Job 래핑·BVH 프록시·헬스 동작. Job 저장은 인메모리.
Phase 1         인증(JWT+refresh 회전)·유저 DB·/v1/users/me. Job 저장을 SQLite/Postgres로.
Phase 2         rerun(excludeCandidateIds)·matchLevel 임계값 실데이터 보정·레이트리밋.
Phase 3         큐를 Redis 기반으로, 필요 시 추론 단계 스트리밍.
```

## 알려진 TODO
- Job 저장이 **인메모리**(재시작 시 소실) → SQLite(`node:sqlite`/better-sqlite3) 또는 Postgres.
- 인증 전체 미구현(Phase 1 stub).
- `matchLevel` 임계값은 시드값 → `Standin-server/docs/SEARCH_EVAL`로 보정 필요.
- 추론 서버는 **무인증·내부용** → 공개 노출 금지, BFF만 공개 엣지.
