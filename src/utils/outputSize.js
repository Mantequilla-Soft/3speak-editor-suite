// The size the backend renders at, per aspect ratio. Shorts (9:16) come out at
// 1080x1920 (full HD portrait): the render reads the uploaded originals, not
// the 480p copies the preview plays (backend/src/utils/uploadFiles.js), so the
// extra pixels are real detail, not an upscale.
export const OUTPUT_SIZES = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '4:3': { width: 1440, height: 1080 },
  '1:1': { width: 1080, height: 1080 }
}

/** { width, height } for an aspect ratio ('16:9' for anything unknown). */
export function outputSize(ratio) {
  return { ...(OUTPUT_SIZES[ratio] || OUTPUT_SIZES['16:9']) }
}
