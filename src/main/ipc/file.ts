import { ipcMain, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { promises as fs, type FSWatcher, watch } from 'fs'
import { join, basename, extname } from 'path'

/** 目录树节点（主进程仅提供基础属性，格式族由渲染端注册表判定） */
export interface FsNode {
  name: string
  path: string
  isDir: boolean
  ext: string
  size: number
}

/** 文本文件大小上限：超过则提示过大，避免一次性读入卡 UI */
const MAX_TEXT_SIZE = 20 * 1024 * 1024 // 20MB

/** 目录监听：单一 watcher（当前导航根），事件防抖后推送渲染端刷新 */
let dirWatcher: FSWatcher | null = null
let watchDebounce: NodeJS.Timeout | null = null
let watchTarget: string | null = null
let watchSender: WebContents | null = null

/** 关闭当前目录监听（切换根目录 / 退出时调用） */
export function stopDirWatch(): void {
  if (watchDebounce) {
    clearTimeout(watchDebounce)
    watchDebounce = null
  }
  if (dirWatcher) {
    try {
      dirWatcher.close()
    } catch {
      /* 已关闭 */
    }
    dirWatcher = null
  }
  watchTarget = null
}

export function registerFileIpc(): void {
  // 选择单个或多个文件
  ipcMain.handle('dialog:openFile', async () => {
    const r = await dialog.showOpenDialog({
      title: '打开文件',
      properties: ['openFile', 'multiSelections']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths
  })

  // 选择文件夹作为左侧导航根目录
  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog({
      title: '打开本地文件夹',
      properties: ['openDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths[0]
  })

  // 读取目录一级内容（懒加载）
  ipcMain.handle('fs:readDir', async (_e, dirPath: string): Promise<FsNode[]> => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const nodes: FsNode[] = []
      for (const entry of entries) {
        // 跳过隐藏文件与常见无关目录
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const full = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          nodes.push({ name: entry.name, path: full, isDir: true, ext: '', size: 0 })
        } else if (entry.isFile()) {
          let size = 0
          try {
            size = (await fs.stat(full)).size
          } catch {
            /* 无法取大小的文件照常显示 */
          }
          nodes.push({
            name: entry.name,
            path: full,
            isDir: false,
            ext: extname(entry.name).toLowerCase(),
            size
          })
        }
      }
      // 目录在前，按名称排序
      nodes.sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN') : a.isDir ? -1 : 1
      )
      return nodes
    } catch {
      return []
    }
  })

  // 写入文本文件（编辑器保存）
  ipcMain.handle('fs:writeText', async (_e, filePath: string, content: string) => {
    try {
      await fs.writeFile(filePath, content, 'utf-8')
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: `无法写入文件：${basename(filePath)}（${String(err)}）` }
    }
  })

  // 读取文本内容（md/txt/代码等）
  ipcMain.handle('fs:readText', async (_e, filePath: string) => {
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > MAX_TEXT_SIZE) {
        return { ok: false as const, error: `文件超过 20MB（当前 ${(stat.size / 1048576).toFixed(1)}MB），暂不支持打开` }
      }
      const content = await fs.readFile(filePath, 'utf-8')
      return { ok: true as const, content }
    } catch (err) {
      return { ok: false as const, error: `无法读取文件：${basename(filePath)}（${String(err)})` }
    }
  })

  // 读取二进制内容（pdf 等），返回 ArrayBuffer
  ipcMain.handle('fs:readBuffer', async (_e, filePath: string) => {
    try {
      const buf = await fs.readFile(filePath)
      return { ok: true as const, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
    } catch (err) {
      return { ok: false as const, error: `无法读取文件：${String(err)}` }
    }
  })

  // 递归监听导航根目录：文件/子目录增删改名实时同步到左栏
  ipcMain.handle('fs:watchDir', (e: IpcMainInvokeEvent, dirPath: string) => {
    try {
      stopDirWatch()
      watchTarget = dirPath
      watchSender = e.sender
      // Windows/macOS 支持原生递归监听；Linux 降级为仅根目录层（后续迭代换 chokidar）
      dirWatcher = watch(dirPath, { recursive: true }, () => {
        // 防抖 600ms：编辑器保存等操作会触发连续事件
        if (watchDebounce) clearTimeout(watchDebounce)
        watchDebounce = setTimeout(() => {
          const dir = watchTarget
          if (!dir || !watchSender || watchSender.isDestroyed()) return
          try {
            watchSender.send('fs:treeChanged', { dir })
          } catch {
            /* 窗口已关闭 */
          }
        }, 600)
      })
      return { ok: true as const }
    } catch (err) {
      dirWatcher = null
      watchTarget = null
      return { ok: false as const, error: `无法监听目录：${String(err)}` }
    }
  })
}
