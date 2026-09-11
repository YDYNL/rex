import { contextBridge, ipcRenderer } from 'electron'
import type { LlmMessage } from '../main/ipc/llm'

/**
 * 渲染进程可用的白名单 API（contextBridge 暴露）
 * 渲染层不直接触碰 Node 能力，全部经 IPC
 */
const api = {
  file: {
    /** 选择文件，返回路径数组或 null */
    openFileDialog: (): Promise<string[] | null> => ipcRenderer.invoke('dialog:openFile'),
    /** 选择文件夹作为导航根目录 */
    openFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
    /** 读取目录一级内容 */
    readDir: (p: string) => ipcRenderer.invoke('fs:readDir', p),
    /** 读取文本文件 */
    readText: (p: string) =>
      ipcRenderer.invoke('fs:readText', p) as Promise<{ ok: true; content: string } | { ok: false; error: string }>,
    /** 写入文本文件（编辑器保存） */
    writeText: (p: string, content: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('fs:writeText', p, content),
    /** 读取二进制文件（pdf 等） */
    readBuffer: (p: string) =>
      ipcRenderer.invoke('fs:readBuffer', p) as Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }>,
    /** 递归监听目录变化（文件/子目录增删改名） */
    watchDir: (p: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('fs:watchDir', p),
    /** 订阅目录树变化（主进程防抖推送），返回取消订阅函数 */
    onTreeChanged: (cb: (payload: { dir: string }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { dir: string }): void => cb(payload)
      ipcRenderer.on('fs:treeChanged', listener)
      return () => ipcRenderer.removeListener('fs:treeChanged', listener)
    }
  },
  office: {
    /** 检测本机 LibreOffice */
    detect: (): Promise<{ path: string | null }> => ipcRenderer.invoke('office:detect'),
    /** LibreOffice 转 PDF（旧版 Office/ODF/RTF 等） */
    convertToPdf: (p: string): Promise<{ ok: true; pdfPath: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('office:convertToPdf', p)
  },
  llm: {
    /** 拉取 OpenAI 兼容 /models 列表（连接检测 + 模型下拉） */
    listModels: (payload: {
      baseUrl: string
      apiKey?: string
    }): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke('llm:listModels', payload),
    /** 发起 OpenAI 兼容流式对话；增量经 onChunk 回调推送；network=true 表示网络级失败（可降级本地） */
    chat: (payload: {
      reqId: string
      baseUrl: string
      apiKey: string
      model: string
      messages: LlmMessage[]
      /** 关闭 Qwen3 思考模式（提速） */
      noThink?: boolean
    }): Promise<{ ok: true } | { ok: false; error: string; network?: boolean }> =>
      ipcRenderer.invoke('llm:chat', payload),
    /** 订阅流式增量（reasoning=true 为思考过程增量，UI 淡色展示） */
    onChunk: (cb: (chunk: { reqId: string; delta: string; reasoning?: boolean }) => void): (() => void) => {
      const listener = (_e: unknown, chunk: { reqId: string; delta: string; reasoning?: boolean }): void => cb(chunk)
      ipcRenderer.on('llm:chunk', listener)
      return () => ipcRenderer.removeListener('llm:chunk', listener)
    }
  },
  secure: {
    /** 密钥加密（safeStorage，密文 enc:/b64: 前缀） */
    encrypt: (plain: string): Promise<{ ok: true; cipher: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('secure:encrypt', plain),
    /** 密钥解密（无前缀视为明文，兼容旧数据） */
    decrypt: (cipher: string): Promise<{ ok: true; plain: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('secure:decrypt', cipher)
  },
  engine: {
    /** AI 引擎状态：external=外部Ollama / builtin=内置已拉起 / off=无引擎；hasBuiltin=本机装了增强包 */
    status: (): Promise<{ state: 'external' | 'builtin' | 'off'; hasBuiltin: boolean }> =>
      ipcRenderer.invoke('engine:status')
  },
  updater: {
    /** 手动触发检查更新 */
    check: (): Promise<unknown> => ipcRenderer.invoke('update:check'),
    /** 下载更新包（触发后经 onEvent 推送进度） */
    download: (): Promise<unknown> => ipcRenderer.invoke('update:download'),
    /** 退出并安装更新 */
    install: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
    /** 订阅更新事件（横幅/进度/完成），返回取消订阅函数 */
    onEvent: (cb: (e: unknown) => void): (() => void) => {
      const listener = (_e: unknown, payload: unknown): void => cb(payload)
      ipcRenderer.on('update:event', listener)
      return () => ipcRenderer.removeListener('update:event', listener)
    }
  }
}

export type RexApi = typeof api

contextBridge.exposeInMainWorld('rex', api)
