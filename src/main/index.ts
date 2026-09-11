import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerFileIpc, stopDirWatch } from './ipc/file'
import { registerLlmIpc } from './ipc/llm'
import { registerOfficeIpc } from './ipc/office'
import { registerSecureIpc } from './ipc/secure'
import { ensureEngine, registerEngineIpc, stopEngine } from './ipc/engine'
import { registerUpdaterIpc } from './ipc/updater'

// Windows 任务栏按 AppUserModelID 分组显示窗口图标（不设置会归到 electron.exe 默认图标）
if (process.platform === 'win32') app.setAppUserModelId('com.rex.app')

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#F7F6FB',
    title: 'ReX',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.ico')
      : join(app.getAppPath(), 'resources', 'icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => win.show())

  // 外部链接交给系统浏览器，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerFileIpc()
  registerLlmIpc()
  registerOfficeIpc()
  registerSecureIpc()
  registerEngineIpc()
  registerUpdaterIpc(() => mainWindow)
  createWindow()
  // AI 引擎：外部优先，无外部服务且有增强包则自动拉起内置 Ollama
  void ensureEngine()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopDirWatch()
  stopEngine()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
