FROM node:18-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY gateway/package.json gateway/package-lock.json* ./

RUN npm ci --only=production 2>/dev/null || npm install --only=production

COPY gateway/src/ src/
COPY gateway/public/ public/

ENV NODE_ENV=production
ENV PORT=3200

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3200/health || exit 1

CMD ["node", "src/index.js"]
