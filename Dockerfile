# Standin BFF (Node/Hono).
# 네이티브 의존성은 argon2(@node-rs)뿐이고 prebuilt 바이너리가 npm ci에서 설치된다(빌드 툴 불필요).
# DB는 외부 PostgreSQL이라 컨테이너에 영속 디스크가 필요 없다 — ECS Fargate에 그대로 올라간다.
FROM node:20-slim

WORKDIR /app

# 의존성 먼저(레이어 캐시). package-lock 기준 재현 설치.
COPY package*.json ./
RUN npm ci

# 소스 복사 후 TS 컴파일
COPY . .
RUN npm run build

# 런타임에는 devDependencies가 필요 없다(이미지 축소).
RUN npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

# DATABASE_URL은 실행 시 주입한다(compose / ECS 태스크 정의).
CMD ["node", "dist/index.js"]
