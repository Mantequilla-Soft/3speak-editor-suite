# Stage 1: Build the React app
FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
# the build's FFmpeg.wasm plugin (only this file: scripts/ also holds the music library)
COPY scripts/viteFfmpegCore.js scripts/
COPY .env* ./
COPY src/ src/
COPY public/ public/
# MediaPipe wasm into public/vision (prebuild runs it; no CDN at run time)
COPY scripts/vision/ scripts/vision/

RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

RUN rm /etc/nginx/conf.d/default.conf

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

RUN mkdir -p /usr/share/nginx/rendered

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
