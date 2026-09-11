# Datafab AGX — plan site + PDF renderer
# Debian slim + Node 22 + system Chromium (for /api/plan.pdf)

FROM node:22-slim

# Chromium and the fonts / libs it needs to render our page cleanly
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
      ca-certificates \
      curl \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# Copy source (there's no package.json — the server has no npm deps)
COPY . .

EXPOSE 8080

# dumb-init reaps zombie chromium processes cleanly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.mjs"]
