import { ipcMain, app } from 'electron'
import { execFile } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join, basename, extname } from 'path'
import { createHash } from 'crypto'

/** LibreOffice 可执行文件候选路径（Windows 常见安装位置 + PATH） */
const SOFFICE_CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice'
]

/** 检测 LibreOffice 是否安装 */
let cachedSoffice: string | null | undefined
function findSoffice(): string | null {
  if (cachedSoffice !== undefined) return cachedSoffice
  for (const p of SOFFICE_CANDIDATES) {
    if (existsSync(p)) {
      cachedSoffice = p
      return p
    }
  }
  // PATH 查找（soffice / soffice.com）
  const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of pathDirs) {
    if (!dir) continue
    for (const name of process.platform === 'win32' ? ['soffice.exe', 'soffice.com'] : ['soffice']) {
      const p = join(dir, name)
      if (existsSync(p)) {
        cachedSoffice = p
        return p
      }
    }
  }
  cachedSoffice = null
  return null
}

/** 转档缓存目录：userData/convert-cache/<pathHash>.pdf，按文件指纹失效 */
function cacheDir(): string {
  const d = join(app.getPath('userData'), 'convert-cache')
  if (!existsSync(d)) void fs.mkdir(d, { recursive: true })
  return d
}

/** 运行 soffice 转档（headless） */
function runConvert(soffice: string, src: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      soffice,
      ['--headless', '--convert-to', 'pdf', '--outdir', outDir, src],
      { timeout: 120_000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || String(err)))
        else resolve()
      }
    )
  })
}

export function registerOfficeIpc(): void {
  /** 检测本机 LibreOffice */
  ipcMain.handle('office:detect', () => {
    return { path: findSoffice() }
  })

  /** LibreOffice → PDF 转档（带指纹缓存；doc/ppt/xls/pptx/rtf/odt/ods/odp 等） */
  ipcMain.handle('office:convertToPdf', async (_e, filePath: string) => {
    try {
      const soffice = findSoffice()
      if (!soffice) {
        return {
          ok: false as const,
          error:
            '预览此格式需要 LibreOffice（免费开源）。安装后重启应用即可：https://www.libreoffice.org/download'
        }
      }
      const stat = await fs.stat(filePath)
      // 指纹 = 路径 + 大小 + 修改时间，文件未变则直接用缓存
      const fp = createHash('md5')
        .update(`${filePath}|${stat.size}|${stat.mtimeMs}`)
        .digest('hex')
        .slice(0, 16)
      const outDir = cacheDir()
      const targetBase = basename(filePath, extname(filePath)).replace(/[\\/:*?"<>|]/g, '_')
      const cached = join(outDir, `${fp}.pdf`)
      if (existsSync(cached)) {
        return { ok: true as const, pdfPath: cached }
      }
      // soffice 输出文件名与源同名换扩展；先转到缓存目录
      await runConvert(soffice, filePath, outDir)
      const produced = join(outDir, `${targetBase}.pdf`)
      if (!existsSync(produced)) {
        return { ok: false as const, error: '转换失败：LibreOffice 未产出 PDF（文件可能损坏或加密）' }
      }
      if (produced !== cached) {
        await fs.rename(produced, cached)
      }
      return { ok: true as const, pdfPath: cached }
    } catch (err) {
      return { ok: false as const, error: `转换失败：${String(err)}` }
    }
  })
}
