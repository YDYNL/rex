#!/usr/bin/env node
/**
 * ReX 一键发布脚本：版本号管理 → 构建双产物 → 拷贝升级文件到更新服务器
 * 用法：
 *   npm run release                    按当前版本发布
 *   npm run release -- 1.0.1           指定版本号发布
 *   npm run release -- --bump patch    版本号末位 +1 发布（minor/major 同理）
 *
 * 更新服务器目录：C:\rex-update-server（本地模拟方案C）
 * 正式环境：改为 https 服务器上传产物，electron-builder.yml 的 publish.url 同步替换，代码零改动
 */
import { execSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'

const ROOT = resolve(import.meta.dirname, '..')
const UPDATE_SERVER = process.env.REX_UPDATE_SERVER || 'C:\\rex-update-server'

/** 1. 版本号处理（显式版本 > --bump > 保持当前） */
const args = process.argv.slice(2)
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = pkg.version

const explicit = args.find((a) => /^\d+\.\d+\.\d+$/.test(a))
const bumpIdx = args.indexOf('--bump')
if (explicit) {
  pkg.version = explicit
} else if (bumpIdx >= 0) {
  const kind = args[bumpIdx + 1] || 'patch'
  const [ma, mi, pa] = current.split('.').map(Number)
  pkg.version =
    kind === 'major' ? `${ma + 1}.0.0` : kind === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`
}
if (pkg.version !== current) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`✓ 版本号：${current} → ${pkg.version}`)
} else {
  console.log(`✓ 版本号：${pkg.version}（未变，重复发布）`)
}
const version = pkg.version

/** 2. 构建双产物（NSIS 安装版 + 便携版 zip，含 latest.yml/blockmap 升级元数据） */
console.log('\n▶ 构建双产物（NSIS + 便携版）...')
execSync('npm run dist', { cwd: ROOT, stdio: 'inherit' })

/** 3. 拷贝升级产物到更新服务器（按平台：本机构建哪个平台就拷哪个） */
const distDir = join(ROOT, 'dist')
const winArtifacts = [
  join(distDir, `ReX-Setup-${version}.exe`),
  join(distDir, `ReX-Setup-${version}.exe.blockmap`),
  join(distDir, 'latest.yml')
]
const macArtifacts = [
  join(distDir, `ReX-${version}-mac.dmg`),
  join(distDir, `ReX-${version}-mac.zip`),
  join(distDir, 'latest-mac.yml')
]
const artifacts = winArtifacts.filter((f) => existsSync(f)).concat(macArtifacts.filter((f) => existsSync(f)))
if (artifacts.length === 0) {
  console.error(`✗ dist 下未找到任何平台产物（win/mac 均缺失）`)
  process.exit(1)
}
mkdirSync(UPDATE_SERVER, { recursive: true })
for (const f of artifacts) {
  copyFileSync(f, join(UPDATE_SERVER, basename(f)))
}

/** 4. 汇总 */
const portable = join(distDir, `ReX-Portable-${version}.zip`)
console.log('\n==================== 发布完成 ====================')
console.log(`  版本：v${version}`)
console.log(`  升级文件已就位：${UPDATE_SERVER}`)
for (const f of artifacts) console.log(`    - ${basename(f)}`)
if (existsSync(portable)) console.log(`  便携版（手动分发）：${portable}`)
console.log('==================================================')
console.log(`
验证自动升级流程：
  1. 安装并启动旧版本 ReX-Setup（本机已装的旧版即可）
  2. 本次发布版本号更高 → 旧版启动 5s 后顶栏弹出「发现新版本」横幅
  3. 点「立即更新」→ 下载进度 → 完成后点横幅「重启安装」→ 升级到 v${version}`)
