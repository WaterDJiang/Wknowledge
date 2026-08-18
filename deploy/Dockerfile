FROM node:22.23.2-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN --network=host npm install --global pnpm@10.29.3 \
  && bootstrap_runtime_certificates() { \
    apt-get -o Acquire::Retries=3 update \
      && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates; \
  } \
  && install_runtime_dependencies() { \
    apt-get -o Acquire::Retries=3 update \
      && apt-get -o Acquire::Retries=3 install -y --no-install-recommends python3 python3-pip ffmpeg bubblewrap fonts-noto-cjk tesseract-ocr tesseract-ocr-chi-sim; \
  } \
  && sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g; s|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && if ! bootstrap_runtime_certificates; then \
    sed -i 's|http://mirrors.aliyun.com/debian|http://deb.debian.org/debian|g; s|http://mirrors.aliyun.com/debian-security|http://deb.debian.org/debian-security|g' /etc/apt/sources.list.d/debian.sources; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    bootstrap_runtime_certificates; \
  fi \
  && sed -i 's|http://mirrors.aliyun.com/debian|https://mirrors.aliyun.com/debian|g; s|http://mirrors.aliyun.com/debian-security|https://mirrors.aliyun.com/debian-security|g; s|http://deb.debian.org/debian|https://deb.debian.org/debian|g; s|http://deb.debian.org/debian-security|https://deb.debian.org/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && if ! install_runtime_dependencies; then \
    sed -i 's|https://mirrors.aliyun.com/debian|https://deb.debian.org/debian|g; s|https://mirrors.aliyun.com/debian-security|https://deb.debian.org/debian-security|g' /etc/apt/sources.list.d/debian.sources; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    install_runtime_dependencies; \
  fi \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY runtimes ./runtimes
COPY skills ./skills
COPY deploy ./deploy
COPY tsconfig.base.json eslint.config.mjs prettier.config.mjs vitest.config.ts ./

RUN --network=host pnpm install --frozen-lockfile \
  && pip3 install --break-system-packages --no-cache-dir -r runtimes/python/requirements.txt \
  && pnpm build

RUN mkdir -p /app/data/spaces /app/data/blobs \
  && useradd --create-home --uid 10001 wknowledge \
  && chown -R wknowledge:wknowledge /app

USER wknowledge
EXPOSE 3000
