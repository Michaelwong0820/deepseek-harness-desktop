/**
 * 生成 DSH Desktop 图标（纯 Node 实现，无外部依赖）
 * - build/icon.png      512x512 应用图标（深蓝底 + 白色圆环，呼应 DSH）
 * - build/tray.png      32x32 托盘图标（深蓝底，跨平台通用）
 * - build/trayTemplate.png 16x16 macOS template 图标（黑色 + alpha）
 */
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

// ---------- 最小 PNG 编码器 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 绘制 ----------
const DEEP_BLUE = [18, 22, 46]    // #12162e
const WHITE = [255, 255, 255]

/** 绘制通用图标：圆角背景 + 白色圆环（左上缺口，形成 "D"-ish 视觉） */
function drawIcon(size, { template = false } = {}) {
  const buf = Buffer.alloc(size * size * 4)
  const bg = template ? [0, 0, 0] : DEEP_BLUE
  const fg = WHITE
  const radius = size * 0.22
  const cx = size / 2
  const cy = size / 2
  const ringR = size * 0.30
  const ringW = size * 0.075

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // 圆角矩形判定
      const dx = Math.max(Math.abs(x - cx) - (cx - radius), 0)
      const dy = Math.max(Math.abs(y - cy) - (cy - radius), 0)
      const inRounded = Math.hypot(dx, dy) <= radius
      if (!inRounded) {
        buf[i + 3] = 0
        continue
      }
      // 圆环判定（去掉左上 45° 缺口做 "D" 感）
      const dist = Math.hypot(x - cx, y - cy)
      const inRing = dist >= ringR - ringW && dist <= ringR + ringW
      // 缺口角度：-120° ~ 30° 区间挖掉
      const ang = Math.atan2(y - cy, x - cx)
      const isGap = ang > -2.1 && ang < 0.55
      if (inRing && !isGap) {
        buf[i] = fg[0]; buf[i + 1] = fg[1]; buf[i + 2] = fg[2]; buf[i + 3] = 255
      }
      else {
        buf[i] = bg[0]; buf[i + 1] = bg[1]; buf[i + 2] = bg[2]; buf[i + 3] = 255
      }
    }
  }
  return buf
}

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })

fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(512, 512, drawIcon(512)))
fs.writeFileSync(path.join(outDir, 'tray.png'), encodePNG(32, 32, drawIcon(32)))
fs.writeFileSync(path.join(outDir, 'trayTemplate.png'), encodePNG(16, 16, drawIcon(16, { template: true })))
console.log('icons generated in', outDir)
