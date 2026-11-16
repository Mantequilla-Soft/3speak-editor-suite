// Render side of keyframes (utils/keyframes.js, shared with the preview): the
// filtergraph pieces services/ffmpeg.js adds for an animated clip.

import fs from 'fs/promises'
import { ffmpegKeyframeTransform, ffmpegOpacityGraph, hasVisualKeyframes, layerPivot } from './keyframes.js'

/**
 * Full-frame keyframe animation for a finished w x h layer (`graph` ends in
 * [outv]): the layer is moved / turned / scaled around (cx, cy) and its alpha
 * multiplied by the animated opacity. Returns the graph, unchanged when the
 * clip has no visual keyframes.
 */
export function withKeyframeTail(graph, clip, { w, h, fps, cx, cy, s = 1, duration }) {
  if (!hasVisualKeyframes(clip) || !/\[outv\]$/.test(graph)) return graph
  const move = ffmpegKeyframeTransform(clip, { w, h, fps, cx, cy, s })
  const fade = ffmpegOpacityGraph(clip, { w, h, fps, duration, inLabel: 'kfmoved', outLabel: 'outv', tag: 'x' })
  const parts = [graph.replace(/\[outv\]$/, '[kfpre]')]
  parts.push(`[kfpre]${move || 'format=rgba'}${fade.length ? '[kfmoved]' : '[outv]'}`)
  parts.push(...fade)
  return parts.join(';')
}

/**
 * A video clip with visual keyframes, in the composite step: its processed
 * frames are laid on a transparent full frame where the static overlay would
 * put them (`overlayPos`), animated there, then delayed to the clip's place on
 * the timeline (`delay`: a setpts filter or null). `inLabel` like '[3:v]'.
 * Returns { parts, label } (label = the pad to overlay at 0:0).
 */
export function videoKeyframeGraph(clip, inLabel, i, { w, h, fps, overlayPos, s = 1, delay = null }) {
  const duration = Math.max(0.04, (clip.endTime || 0) - (clip.startTime || 0))
  const pivot = layerPivot(clip, w, h, s)
  const move = ffmpegKeyframeTransform(clip, { w, h, fps, cx: pivot.x, cy: pivot.y, s })
  const fade = ffmpegOpacityGraph(clip, { w, h, fps, duration, inLabel: `kfm${i}`, outLabel: `kfo${i}`, tag: String(i) })
  const parts = [
    `color=c=black:s=${w}x${h}:r=${fps}:d=${Number(duration.toFixed(3))},format=rgba,colorchannelmixer=aa=0[kfbg${i}]`,
    `${inLabel}format=rgba[kfin${i}]`,
    `[kfbg${i}][kfin${i}]overlay=${overlayPos}:format=auto[kfpos${i}]`,
    `[kfpos${i}]${move || 'format=rgba'}[kfm${i}]`
  ]
  parts.push(...fade)
  const last = fade.length ? `kfo${i}` : `kfm${i}`
  parts.push(`[${last}]${delay || 'null'}[kv${i}]`)
  return { parts, label: `[kv${i}]` }
}

// One argument may not exceed 128 KiB on Linux: a long graph (many keyframes)
// goes to ffmpeg as a script file instead
const MAX_INLINE_GRAPH = 100 * 1024

/** ['-filter_complex', graph], or the script-file form for a long graph (written to `file`) */
export async function filterGraphArgs(graph, file) {
  if (graph.length <= MAX_INLINE_GRAPH) return ['-filter_complex', graph]
  await fs.writeFile(file, graph, 'utf8')
  return ['-filter_complex_script', file]
}
