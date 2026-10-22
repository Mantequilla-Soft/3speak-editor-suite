FROM node:18-alpine

RUN apk add --no-cache ffmpeg curl fontconfig ttf-dejavu ttf-liberation font-opensans font-freefont git rsvg-convert

# Ad Wizard scene render: headless Chromium (driven by playwright-core) + emoji/CJK-capable fonts
RUN apk add --no-cache chromium nss harfbuzz ca-certificates font-noto font-noto-emoji
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

# Install Google Fonts used by the editor frontend
RUN mkdir -p /usr/share/fonts/google && \
    cd /tmp && \
    git clone --depth 1 --filter=blob:none --sparse https://github.com/google/fonts.git gfonts && \
    cd gfonts && \
    git sparse-checkout set \
      ofl/roboto ofl/opensans ofl/lato ofl/montserrat ofl/poppins \
      ofl/oswald ofl/playfairdisplay ofl/merriweather ofl/robotomono \
      ofl/bebasneue ofl/bangers apache/permanentmarker \
      ofl/nunito ofl/raleway ofl/inter ofl/lora \
      ofl/anton ofl/archivoblack ofl/righteous ofl/titanone ofl/fredoka \
      ofl/lobster ofl/dancingscript ofl/pacifico ofl/caveat \
      ofl/pressstart2p && \
    find . -name "*.ttf" -exec cp {} /usr/share/fonts/google/ \; && \
    cd / && rm -rf /tmp/gfonts && \
    fc-cache -f

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./

RUN npm ci --only=production 2>/dev/null || npm install --only=production

COPY backend/src/ src/
COPY backend/scene-engine/ scene-engine/

RUN mkdir -p /app/rendered /app/work /app/uploads && chmod 777 /app/rendered /app/work /app/uploads

ENV NODE_ENV=production
ENV PORT=3102
ENV RENDERED_DIR=/app/rendered
ENV WORK_DIR=/app/work
ENV UPLOAD_DIR=/app/uploads

EXPOSE 3102

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3102/api/health || exit 1

CMD ["node", "src/index.js"]
