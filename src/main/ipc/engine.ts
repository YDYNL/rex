import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app, ipcMain } from 'electron'

/**
 * AI 引擎托管：内置 Ollama 的生命周期管理（Windows / macOS 双平台）
 * - 启动探测：外部已有 Ollama（11434 在跑）→ 尊重外部实例不干预
 * - 内置拉起：增强包安装后存在 ollama 可执行文件时自动 spawn serve
 *   （模型目录随引擎目录，与外部实例隔离）
 * - 系统适配：mac 已安装 Ollama 但服务未运行 → 代为拉起系统 ollama（用系统默认模型目录）
 * - 退出清理：整树结束 ollama（serve 会派生 runner 子进程；win 用 taskkill /T，mac 用 pkill -P）
 */

const OLLAMA_URL = 'http://127.0.0.1:11434/api/tags'
const IS_WIN = process.platform === 'win32'
const OLLAMA_BIN = IS_WIN ? 'ollama.exe' : 'ollama'

/** 引擎来源状态：external=外部已运行 / builtin=由我们拉起（内置包或系统 ollama）/ off=无可用引擎 */
export type EngineState = 'external' | 'builtin' | 'off'

let child: ChildProcess | null = null
let state: EngineState = 'off'

/** 内置增强包安装位置（优先，固定目录、独立于 ReX 安装位置） */
function engineDirUser(): string {
  return IS_WIN
    ? join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'ReX', 'ai-engine')
    : join(app.getPath('userData'), 'ai-engine') // ~/Library/Application Support/ReX/ai-engine
}

/** 随包内置位置（次选，预留将来整包内置形态） */
function engineDirRes(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'ai-engine')
    : join(app.getAppPath(), 'resources', 'ai-engine')
}

/** 解析可用的内置引擎目录（含 ollama 可执行文件才算有效），无则 null */
function builtinEngineDir(): string | null {
  for (const d of [engineDirUser(), engineDirRes()]) {
    if (existsSync(join(d, OLLAMA_BIN))) return d
  }
  return null
}

/** 系统安装的 Ollama 可执行文件路径（用户单独安装、服务未在跑时用于代为拉起） */
function systemOllamaBin(): string | null {
  // 1) PATH 查找（win: where / mac: which）
  try {
    const cmd = IS_WIN ? 'where ollama' : 'which ollama'
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')[0]
      .trim()
    if (out && existsSync(out)) return out
  } catch {
    /* 未装或不在 PATH，走常见安装路径 */
  }
  // 2) 常见安装路径
  const guesses = IS_WIN
    ? [
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
        'C:\\Program Files\\Ollama\\ollama.exe'
      ]
    : [
        '/opt/homebrew/bin/ollama', // Apple Silicon Homebrew
        '/usr/local/bin/ollama', // Intel Homebrew / 官方脚本安装
        '/Applications/Ollama.app/Contents/Resources/ollama', // 官方 App 内置
        join(homedir(), '.local', 'bin', 'ollama')
      ]
  return guesses.find((p) => p && existsSync(p)) ?? null
}

/** 探测 11434 是否已有 Ollama 服务（短超时，启动检查用） */
async function probeOllama(timeoutMs = 1500): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const res = await fetch(OLLAMA_URL, { signal: ctl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

/** 拉起 ollama serve（extraEnv 传 OLLAMA_MODELS 隔离内置包模型；系统引擎用默认目录） */
function startServe(bin: string, extraEnv: Record<string, string>): void {
  child = spawn(bin, ['serve'], {
    cwd: undefined,
    windowsHide: true,
    env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', ...extraEnv }
  })
  child.on('exit', () => {
    child = null
    if (state === 'builtin') state = 'off'
  })
}

/** 启动时调用：外部运行优先 → 内置增强包 → 系统已装 ollama 代为拉起。幂等 */
export async function ensureEngine(): Promise<EngineState> {
  if (await probeOllama()) {
    state = 'external'
    return state
  }
  if (child) {
    state = 'builtin'
    return state
  }
  // 1) 内置增强包（模型随包，离线可用）
  const dir = builtinEngineDir()
  if (dir) {
    startServe(join(dir, OLLAMA_BIN), { OLLAMA_MODELS: join(dir, 'models') })
    state = 'builtin'
    return state
  }
  // 2) 系统已安装但服务未跑（如 mac 装了 Ollama App 未启动服务）：代为拉起，用系统默认模型目录
  const sys = systemOllamaBin()
  if (sys) {
    startServe(sys, {})
    state = 'builtin'
    return state
  }
  state = 'off'
  return state
}

/** 退出前调用：整树结束（serve 会派生 runner 子进程） */
export function stopEngine(): void {
  if (child?.pid) {
    if (IS_WIN) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      // mac：先杀子进程（runner）再结束 serve 本体
      spawn('pkill', ['-P', String(child.pid)])
      child.kill('SIGTERM')
    }
    child = null
  }
}

export function registerEngineIpc(): void {
  ipcMain.handle('engine:status', () => ({
    state,
    hasBuiltin: builtinEngineDir() != null
  }))
}
