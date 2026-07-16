# Standin App Server (BFF) — Claude 개발 지침

## 1. 무엇을 하는 코드인가

Tauri 클라이언트와 **도원 추론 서버**(`Standin-server`) 사이의 **얇은 앱 서버(BFF)**. Hono/TypeScript.

```
[Tauri 앱] ──/v1──> [이 서버: BFF] ──HTTP──> [도원 추론 서버]
클라 UI·상태          인증·Job·번역·엣지        VLM·검출·포즈·검색 (순수 추론)
```

BFF가 하는 일은 **셋뿐**이다:

1. **인증** — 로그인·토큰·유저·세션
2. **Job 래핑** — 동기 추론(`POST /analyze`)을 비동기 "제출→폴링" Job으로 감쌈
3. **계약 번역** — 원시 `distance` → `matchLevel` 라벨, `{detail}` → `{error:{code}}` 봉투, `/v1` 프리픽스

## 2. 반드시 지킬 경계 (하지 말 것)

- **추론 로직을 여기 넣지 않는다.** VLM·검출·포즈·검색은 도원 서버 소유. 이 서버는 `src/inference.ts`에서 HTTP로만 호출한다.
- **도원 추론 서버는 무인증·내부용** — 공개 노출 금지. BFF만 공개 엣지다.
- **비밀·토큰·비밀번호·원본 이미지를 로그에 남기지 않는다.**
- **Job 세분 진행단계를 지어내지 않는다.** 동기 추론이라 `queued→running→completed/failed`만 노출(클라 원칙: "서버가 안 주는 진행률 임의 생성 금지").
- `matchLevel` 임계값은 시드값 → 실데이터로 보정(`Standin-server/docs/SEARCH_EVAL`).

## 3. 설계 단일 소스 (구현 전 읽을 것)

- **`Standin-server/docs/BFF_DESIGN.md`** — 이 서버의 설계(스택·엔드포인트 매핑·Job 래핑·인증·Phase).
- `Standin-server/docs/DECISIONS.md` 결정 4 — 왜 BFF를 분리했나.
- `Standin-server/docs/API_CONTRACT.md` — 호출하는 추론 서버의 계약.
- `Standin-client/docs/08_API_CONTRACT.md` — 클라가 기대하는 `/v1` 계약.
- `docs/API.md` — 이 서버가 클라에 노출하는 `/v1` 계약(위 둘의 교집합).

## 4. 명령

```bash
npm install
npm run dev         # tsx watch → http://localhost:8080
npm run typecheck   # tsc --noEmit (변경 후 반드시)
npm run build       # dist로 컴파일
npm start           # node dist/index.js
```

env는 `.env.example` 복사 후 채운다. 최소 `INFERENCE_BASE_URL`.

## 5. 구조 (모듈 경계)

```
src/
├─ index.ts        Hono 앱·라우트 마운트·서버 기동
├─ config.ts       env 주입(추론 URL·JWT·DB 경로)
├─ env.ts          Hono 컨텍스트 변수 타입(requestId)
├─ types.ts        클라 /v1 계약 타입(⚠ 클라 endpoints.ts와 공유 목표)
├─ inference.ts    도원 추론 호출을 한 곳에 격리(계약 바뀌면 여기만 수정)
├─ mapping.ts      계약 번역(matchLevel·오류봉투)
├─ jobs/           store·runner·routes — 동기추론→Job 래핑
├─ auth/           middleware(JWT) + routes (Phase 1 stub)
└─ pose/           BVH 프록시
```

**추론 호출은 `inference.ts` 하나로만.** 다른 파일이 추론 서버를 직접 `fetch` 하지 않는다.

## 6. 코드 원칙

- TypeScript `any` 회피. 계약 타입은 `types.ts`에 명시.
- 실패 가능한 외부 호출(추론·DB)은 오류봉투로 사용자에게 복구 가능한 코드 반환.
- 하드코딩된 추론 URL·시크릿 금지(전부 `config.ts` 경유).
- Job 저장 인터페이스(`jobs/store.ts`)만 유지하면 인메모리↔SQLite↔Postgres 교체 가능하게.

## 7. 협업

- **`main` 직접 push 금지.** 기능별 `feat/*`·`chore/*`·`fix/*` 브랜치 → PR.
- Conventional Commits: `feat(jobs): ...`, `fix(auth): ...`, `docs: ...`, `chore: ...`.
- `.env`·`node_modules`·`dist`·`*.db` 커밋 금지(`.gitignore` 등록됨).
- 계약(`/v1` 또는 추론 호출) 변경 시 `docs/API.md`·관련 설계문서 동시 수정.

## 8. 로드맵 (Phase)

```
Phase 0 (현재)  Job 래핑·BVH 프록시·헬스 동작. Job 저장 인메모리.
Phase 1         인증(JWT+refresh 회전)·유저 DB·/v1/users/me. Job 저장 영속화.
Phase 2         rerun(excludeCandidateIds)·matchLevel 보정·레이트리밋.
Phase 3         큐 Redis 기반, 필요 시 추론 단계 스트리밍.
```
