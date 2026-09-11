#!/usr/bin/env node
/**
 * 生成 macOS 图标 resources/icon.icns
 * ICNS 容器封装 PNG 条目（ic07=128 / ic08=256 / ic09=512 / ic10=1024，macOS 10.7+ 支持 PNG 载荷）
 * 数据源：resources/logo-src.png（原图，≥512 最佳）+ resources/png/*.png
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const RES = resolve(import.meta.dirname, '..', 'resources')

/** 读 PNG IHDR 宽高（字节 16-24，大端） */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/** 尺寸 → ICNS 条目类型（仅 PNG 载荷类型） */
const TYPE_BY_SIZE = { 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' }

/** 候选源：png/ 目录各尺寸 + logo-src.png 原图 */
const candidates = [
  join(RES, 'logo-src.png'),
  ...[1024, 512, 256, 128].map((s) => join(RES, 'png', `${s}.png`))
]

const entries = new Map() // size -> { type, data }
for (const p of candidates) {
  let buf
  try {
    buf = readFileSync(p)
  } catch {
    continue
  }
  const { w } = pngSize(buf)
  const type = TYPE_BY_SIZE[w]
  if (type && !entries.has(w)) entries.set(w, { type, data: buf })
}

if (entries.size === 0) {
  console.error('✗ 未找到 128/256/512/1024 任一尺寸的 PNG 源')
  process.exit(1)
}

/** 组装 ICNS：magic 'icns' + 总长 + [type + len + png] × n */
const chunks = []
let total = 8
for (const { type, data } of entries.values()) {
  const len = 8 + data.length
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(len, 4)
  chunks.push(head, data)
  total += len
}
const icns = Buffer.alloc(8)
icns.write('icns', 0, 'ascii')
icns.writeUInt32BE(total, 4)
const out = join(RES, 'icon.icns')
writeFileSync(out, Buffer.concat([icns, ...chunks]))
console.log(
  `✓ ${out}（${(total / 1024).toFixed(1)} KB，含 ${[...entries.keys()].sort((a, b) => b - a).join('/')}px）`
)
