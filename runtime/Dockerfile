FROM node:24.8.0-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates python3 python3-pip python3-venv ripgrep \
    build-essential iproute2 iptables procps util-linux jq unzip zsh \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@0.156.1 @anthropic-ai/claude-code@2.1.282 playwright@1.62.1 \
    && npx playwright install --with-deps chromium
RUN mkdir -p /opt/cursor \
    && curl -fsSL https://downloads.cursor.com/lab/2026.09.23-86fc751/linux/arm64/agent-cli-package.tar.gz \
       | tar -xz --strip-components=1 -C /opt/cursor \
    && ln -s /opt/cursor/cursor-agent /usr/local/bin/cursor-agent
COPY relay.py /opt/crucible/relay.py
RUN usermod -l agent node && groupmod -n agent node && usermod -d /home/agent -m agent \
    && chmod -R a+rX /root/.cache/ms-playwright \
    && mv /root/.cache/ms-playwright /opt/playwright \
    && mkdir -p /workspace && chown agent:agent /workspace
ENV NODE_PATH=/usr/local/lib/node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
ENV PATH=/usr/local/bin:/usr/bin:/bin
WORKDIR /workspace
