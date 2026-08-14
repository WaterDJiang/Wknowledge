FROM node:22.12-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN --network=host corepack enable \
  && sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g; s|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=3 update \
  && apt-get -o Acquire::Retries=3 install -y --no-install-recommends python3 python3-pip ffmpeg bubblewrap fonts-noto-cjk tesseract-ocr tesseract-ocr-chi-sim \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY runtimes ./runtimes
COPY skills ./skills
COPY deploy ./deploy
COPY tsconfig.base.json eslint.config.mjs prettier.config.mjs vitest.config.ts ./

RUN pnpm install --frozen-lockfile \
  && pip3 install --break-system-packages --no-cache-dir -r runtimes/python/requirements.txt \
  && pnpm build

RUN mkdir -p /app/data/spaces /app/data/blobs \
  && useradd --create-home --uid 10001 wknowledge \
  && chown -R wknowledge:wknowledge /app/data

USER wknowledge
EXPOSE 3000
