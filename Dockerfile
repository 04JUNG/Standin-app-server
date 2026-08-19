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

# 배포 버전을 이미지에 굽는다. 로그의 `version` 필드가 이 값이 된다.
#
# 태스크 정의 env로 주지 않는 이유: env가 이미지 ENV를 덮어쓰는데, 어느 커밋이
# 배포되는지 아는 것은 앱을 빌드한 워크플로뿐이다(CDK는 모른다). 이미지에 구우면
# 나중에 cdk deploy가 돌아도 값이 사라지지 않고, 이미지와 버전이 함께 움직인다.
#
# ⚠ 이 뒤의 레이어는 값이 바뀔 때마다 캐시가 깨진다. 그래서 빌드 맨 끝에 둔다.
ARG DEPLOYMENT_VERSION=development
ENV NODE_ENV=production \
    PORT=8080 \
    DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION
EXPOSE 8080

# DATABASE_URL은 실행 시 주입한다(compose / ECS 태스크 정의).
CMD ["node", "dist/index.js"]
