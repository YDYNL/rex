#!/usr/bin/env node
/**
 * ReX AI 引擎增强包生成脚本（离线一键部署用）
 * 从本机抽取 Ollama 运行时 + 指定模型，打成 zip 分发包：
 *   npm run engine:pack              → 默认打包 qwen3:4b
 *   npm run engine:pack -- --all     → 打包本机全部模型
 *   npm run engine:pack -- qwen2.5:7b → 打包指定模型
 *
 * 产物：dist/ReX-AIEngine-Pack-<version>.zip
 * 用户在目标机解压后双击 install.bat → 拷贝到 %LOCALAPPDATA%\ReX\ai-engine
 * ReX 启动时自动探测并拉起内置引擎，无需安装 Ollama、无需联网
 */
import { execSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')

const ROOT = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const OUT_DIR = join(ROOT, 'dist')
const STAGE = join(ROOT, 'build', 'engine-pack')

/** 参数：--all 全部模型，否则取位置参数（默认 qwen3:4b） */
const args = process.argv.slice(2)
const allModels = args.includes('--all')
const wantedModels = args.filter((a) => !a.startsWith('--'))
const MODEL_FILTER = allModels ? null : wantedModels.length > 0 ? wantedModels : ['qwen3:4b']

/** 1. 定位本机 Ollama：where ollama → 逐级回退猜测 */
function locateOllama() {
  try {
    const out = execSync('where ollama', { encoding: 'utf8' }).trim().split('\n')[0].trim()
    // ollama.exe 通常在 <install>/lib/ollama/ollama.exe 或 <install>/ollama.exe
    const dir = resolve(out, '..')
    if (/lib[\\/]ollama$/i.test(dir)) return resolve(dir, '..')
    return dir
  } catch {
    for (const guess of [
      join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama'),
      'C:\\Program Files\\Ollama',
      'C:\\Users\\Default\\AppData\\Local\\Programs\\Ollama'
    ]) {
      if (guess && existsSync(join(guess, 'ollama.exe'))) return guess
    }
    return null
  }
}

const ollamaDir = locateOllama()
if (!ollamaDir || !existsSync(join(ollamaDir, 'ollama.exe'))) {
  console.error('✗ 未找到本机 Ollama 安装（where ollama / 默认路径均失败），请先安装 Ollama')
  process.exit(1)
}
const modelsDir = process.env.OLLAMA_MODELS || join(process.env.USERPROFILE || '', '.ollama', 'models')
if (!existsSync(modelsDir)) {
  console.error(`✗ 未找到模型目录：${modelsDir}`)
  process.exit(1)
}
console.log(`✓ Ollama 运行时：${ollamaDir}`)
console.log(`✓ 模型目录：${modelsDir}`)

/** 2. 清空暂存并拷贝运行时（exe + lib，跳过卸载器等无关文件） */
rmSync(STAGE, { recursive: true, force: true })
const engineDir = join(STAGE, 'ai-engine')
mkdirSync(engineDir, { recursive: true })
cpSync(join(ollamaDir, 'ollama.exe'), join(engineDir, 'ollama.exe'))
for (const sub of ['lib', 'bin']) {
  const src = join(ollamaDir, sub)
  if (existsSync(src)) cpSync(src, join(engineDir, sub), { recursive: true })
}

/** 3. 拷贝模型：解析 manifests 只取所需 blobs（按 digest 精确抽取） */
const manifestsRoot = join(modelsDir, 'manifests')
const blobsDir = join(modelsDir, 'blobs')
const copiedBlobs = new Set()

/** 拷单个 manifest 及其全部 blob 依赖 */
function copyModel(manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const digests = [m.config?.digest, ...(m.layers ?? []).map((l) => l.digest)].filter(Boolean)
  for (const d of digests) {
    const src = join(blobsDir, d.replace(':', '-'))
    if (!existsSync(src)) {
      console.warn(`  ⚠ 缺 blob：${d}（模型可能已损坏，跳过）`)
      return false
    }
    if (!copiedBlobs.has(d)) {
      cpSync(src, join(engineDir, 'models', 'blobs', d.replace(':', '-')))
      copiedBlobs.add(d)
    }
  }
  // manifest 按原 registry 路径存放（ollama 按此路径识别模型名）
  const rel = manifestPath.slice(manifestsRoot.length + 1)
  const dest = join(engineDir, 'models', 'manifests', rel)
  mkdirSync(dest.slice(0, dest.lastIndexOf('\\') + 1), { recursive: true })
  cpSync(manifestPath, dest)
  console.log(`  ✓ ${rel.replace(/\\/g, '/')}`)
  return true
}

console.log(`\n抽取模型（${MODEL_FILTER ? MODEL_FILTER.join(', ') : '全部'}）：`)
let found = 0
function walkManifests(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkManifests(p)
    else {
      const rel = p.slice(manifestsRoot.length + 1).replace(/\\/g, '/')
      const tag = rel.replace(/^.*manifests\//, '').replace(/\//g, ':').replace(/^([^:]+):([^:]+)$/, '$1/$2')
      // rel 形如 registry.ollama.ai/library/qwen3/4b → 模型名 library/qwen3:4b
      const parts = rel.split('/')
      const modelName = parts.slice(1, -1).join('/') + ':' + parts[parts.length - 1]
      const alias = modelName.split('/').pop() // qwen3:4b
      if (!MODEL_FILTER || MODEL_FILTER.some((w) => modelName === w || alias === w)) {
        if (copyModel(p)) found++
      }
    }
  }
}
walkManifests(manifestsRoot)
if (found === 0) {
  console.error(`✗ 未找到目标模型（${MODEL_FILTER.join(', ')}），请先 ollama pull`)
  process.exit(1)
}

/** 4. 生成安装脚本与说明 */
writeFileSync(
  join(STAGE, 'install.bat'),
  [
    '@echo off',
    'chcp 65001 >nul',
    'set DEST=%LOCALAPPDATA%\\ReX\\ai-engine',
    'echo [ReX AI 引擎增强包] 开始安装...',
    'robocopy "%~dp0ai-engine" "%DEST%" /E /NFL /NDL /NJH /NJS /NP',
    'if %errorlevel% GEQ 8 (',
    '  echo 安装失败：请检查磁盘空间与权限后重试。',
    ') else (',
    '  echo 安装完成！启动 ReX 即自动启用本地 AI 引擎。',
    ')',
    'pause'
  ].join('\r\n')
)
writeFileSync(
  join(STAGE, 'README.txt'),
  [
    'ReX AI 引擎增强包 v' + version,
    '================================',
    '',
    '内容：Ollama 运行时 + ' + (MODEL_FILTER ? MODEL_FILTER.join(', ') : '全部') + ' 模型（离线可用）',
    '',
    '安装方法：双击 install.bat（拷贝到 %LOCALAPPDATA%\\ReX\\ai-engine）',
    '启动 ReX 后自动检测并拉起内置引擎，无需单独安装 Ollama。',
    '',
    '说明：已安装外部 Ollama 的机器会优先使用外部实例，互不影响。'
  ].join('\r\n')
)

/** 5. 打 zip */
const zip = new JSZip()
function addDir(zipDir, dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) addDir(zipDir.folder(name), p)
    else zipDir.file(name, readFileSync(p))
  }
}
const rootZip = zip.folder('ReX-AIEngine-Pack')
addDir(rootZip, STAGE)

const outPath = join(OUT_DIR, `ReX-AIEngine-Pack-${version}.zip`)
mkdirSync(OUT_DIR, { recursive: true })
const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
writeFileSync(outPath, buf)

/** 汇总 */
function dirSize(d) {
  let s = 0
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    s += statSync(p).isDirectory() ? dirSize(p) : statSync(p).size
  }
  return s
}
const sizeGB = (dirSize(engineDir) / 1024 / 1024 / 1024).toFixed(2)
console.log(`\n✓ 增强包已生成：${outPath}`)
console.log(`  引擎体积：${sizeGB} GB（含 ${found} 个模型）`)
