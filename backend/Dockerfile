# Auto captions: whisper.cpp's CLI (speech to text with word times) and a
# multilingual model. Built on the render box itself (the deploy builds here),
# so the default native CPU flags fit it. WHISPER_MODEL: tiny | base | small
# (bigger = better and slower; base takes about 1 s per 10 s of speech on 2 threads).
FROM node:18-alpine AS whisper
ARG WHISPER_VERSION=v1.9.5
ARG WHISPER_MODEL=base
RUN apk add --no-cache build-base cmake git curl
RUN git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp /src && \
    cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF && \
    cmake --build /src/build -j"$(nproc)" --target whisper-cli && \
    mkdir -p /opt/whisper && cp /src/build/bin/whisper-cli /opt/whisper/ && \
    curl -fsSL --retry 3 -o "/opt/whisper/ggml-${WHISPER_MODEL}.bin" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin" && \
    /opt/whisper/whisper-cli --help >/dev/null 2>&1

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

# Auto captions (services/stt.js); libgomp: whisper's OpenMP threads
ARG WHISPER_MODEL=base
RUN apk add --no-cache libgomp
COPY --from=whisper /opt/whisper /opt/whisper
ENV WHISPER_BIN=/opt/whisper/whisper-cli
ENV WHISPER_MODEL=/opt/whisper/ggml-${WHISPER_MODEL}.bin

ENV NODE_ENV=production
ENV PORT=3102
ENV RENDERED_DIR=/app/rendered
ENV WORK_DIR=/app/work
ENV UPLOAD_DIR=/app/uploads

EXPOSE 3102

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3102/api/health || exit 1

CMD ["node", "src/index.js"]
