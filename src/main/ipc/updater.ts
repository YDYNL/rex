import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * 自动升级（electron-updater · generic provider）
 * - 启动后 5s 静默检查 + 每 6 小时例行检查
 * - 检测到新版本 → 通知渲染层（顶栏横幅），用户点击才下载（autoDownload=false）
 * - 下载带进度 → 「重启安装」quitAndInstall；autoInstallOnAppQuit 兜底（退出时装）
 * - 更新源：electron-builder.yml publish 配置（当前 file:///C:/rex-update-server 本地模拟，
 *   正式发布改为 https 服务器即可，代码零改动）
 */

export type UpdaterEvent =
  | { type: 'available'; version: string; notes: string }
  | { type: 'none' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded' }
  | { type: 'error'; message: string }

export function registerUpdaterIpc(getWin: () => BrowserWindow | null): void {
  // 开发模式无 app-update.yml，显式指定更新源（与 electron-builder.yml 一致）
  if (!app.isPackaged) {
    autoUpdater.setFeedURL({ provider: 'generic', url: 'file:///C:/rex-update-server' })
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  const send = (payload: UpdaterEvent): void => {
    const win = getWin()
    if (win && !win.isDestroyed()) win.webContents.send('update:event', payload)
  }

  autoUpdater.on('update-available', (info) => {
    const notes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note ?? '')).join('\n')
          : ''
    send({ type: 'available', version: info.version, notes })
  })
  autoUpdater.on('update-not-available', () => send({ type: 'none' }))
  autoUpdater.on('download-progress', (p) => send({ type: 'progress', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', () => send({ type: 'downloaded' }))
  autoUpdater.on('error', (e) => send({ type: 'error', message: String(e) }))

  ipcMain.handle('update:check', () => autoUpdater.checkForUpdates())
  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate())
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true)
    return true
  })

  // 启动 5s 后首查 + 每 6 小时例行（用户在用也能收到推送）
  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(() => send({ type: 'error', message: '检查更新失败' }))
  }
  setTimeout(check, 5000)
  setInterval(check, 6 * 60 * 60 * 1000)
}
