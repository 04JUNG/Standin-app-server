# Standin BFF (Node/Hono). 단일 스테이지 — 네이티브 의존성(better-sqlite3·argon2)의
# prebuilt 바이너리가 npm ci에서 자동 설치된다(빌드 툴 불필요).
FROM node:20-slim

WORKDIR /app

# 의존성 먼저(레이어 캐시). package-lock 기준 재현 설치.
COPY package*.json ./
RUN npm ci

# 소스 복사 후 TS 컴파일
COPY . .
RUN npm run build

ENV PORT=8080 \
    DB_PATH=/app/data/bff.db
EXPOSE 8080

# SQLite 파일이 놓일 디렉터리(compose에서 볼륨 마운트)
CMD ["node", "dist/index.js"]
