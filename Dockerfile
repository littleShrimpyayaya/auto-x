FROM node:24-slim

RUN corepack enable

# Playwright Chromium 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libcups2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 安装 Chromium 浏览器
RUN npx playwright install chromium

COPY tsconfig.json ./
COPY src ./src

RUN pnpm build

EXPOSE 3000

CMD ["node", "dist/index.js"]
