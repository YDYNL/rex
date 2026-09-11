import type { LlmMessage } from '../../../main/ipc/llm'

/** 渲染进程可用的 preload API 类型（window.rex） */
export interface RexApi {
  file: {
    openFileDialog: () => Promise<string[] | null>
    openFolderDialog: () => Promise<string | null>
    readDir: (p: string) => Promise<
      { name: string; path: string; isDir: boolean; ext: string; size: number }[]
    >
    readText: (
      p: string
    ) => Promise<{ ok: true; content: string } | { ok: false; error: string }>
    /** 写入文本文件（编辑器保存） */
    writeText: (
      p: string,
      content: string
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    readBuffer: (
      p: string
    ) => Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }>
    /** 递归监听目录变化（增/删/改名），变化经 onTreeChanged 推送 */
    watchDir: (p: string) => Promise<{ ok: true } | { ok: false; error: string }>
    /** 目录树变化订阅（主进程防抖后推送），返回取消订阅函数 */
    onTreeChanged: (cb: (payload: { dir: string }) => void) => () => void
  }
  office: {
    /** 检测本机 LibreOffice（返回可执行文件路径或 null） */
    detect: () => Promise<{ path: string | null }>
    /** LibreOffice 转 PDF（doc/ppt/xls/rtf/odf 等），返回转换后 PDF 路径 */
    convertToPdf: (
      p: string
    ) => Promise<{ ok: true; pdfPath: string } | { ok: false; error: string }>
  }
  llm: {
    listModels: (payload: {
      baseUrl: string
      apiKey?: string
    }) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>
    /** network=true 表示网络级失败（断网/不可达），渲染端可自动降级本地模型 */
    chat: (payload: {
      reqId: string
      baseUrl: string
      apiKey: string
      model: string
      messages: LlmMessage[]
      /** 关闭 Qwen3 思考模式（提速） */
      noThink?: boolean
    }) => Promise<{ ok: true } | { ok: false; error: string; network?: boolean }>
    onChunk: (
      cb: (chunk: { reqId: string; delta: string; reasoning?: boolean }) => void
    ) => () => void
  }
  secure: {
    /** 密钥加密（safeStorage，密文 enc:/b64: 前缀） */
    encrypt: (plain: string) => Promise<{ ok: true; cipher: string } | { ok: false; error: string }>
    /** 密钥解密（无前缀视为明文，兼容旧数据） */
    decrypt: (cipher: string) => Promise<{ ok: true; plain: string } | { ok: false; error: string }>
  }
  engine: {
    /** AI 引擎状态：external=外部Ollama / builtin=内置已拉起 / off=无引擎；hasBuiltin=本机装了增强包 */
    status: () => Promise<{ state: 'external' | 'builtin' | 'off'; hasBuiltin: boolean }>
  }
  updater: {
    /** 手动触发检查更新 */
    check: () => Promise<unknown>
    /** 下载更新包（进度经 onEvent 推送） */
    download: () => Promise<unknown>
    /** 退出并安装更新 */
    install: () => Promise<boolean>
    /** 订阅更新事件（横幅/进度/完成），返回取消订阅函数 */
    onEvent: (cb: (e: unknown) => void) => () => void
  }
}

/** 自动升级事件（主进程 → 渲染层） */
export type UpdaterEvent =
  | { type: 'available'; version: string; notes: string }
  | { type: 'none' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded' }
  | { type: 'error'; message: string }

declare global {
  interface Window {
    rex: RexApi
  }
}

/** 带坐标的文本层引用（锚点统一结构，M0 以块为定位粒度） */
export interface TextInfra {
  docId: string
  snapshot: string // 原文快照（选中文本）
  blkKey: string | null // 所在渲染块的稳定 key（渲染器生成）
  pageIndex: number // 物理页或逻辑块序号
  /** 划选内容在块内文本的字符偏移（闭区间映射用，精确锚点） */
  rangeStart?: number
  rangeEnd?: number
}

/** 锚点标记：一次问答在原文处的沉淀 */
export interface Anchor {
  id: string
  docId: string
  blkKey: string
  snapshot: string
  qaId: string
  sessionId?: string // 关联问答会话（点击紫点跳转回看）
  createdAt: number
  /** 划选内容在块内文本的字符偏移（精确锚点；旧数据无此字段回退块级） */
  rangeStart?: number
  rangeEnd?: number
}

/** 一条问答消息 */
export interface QaMsg {
  id: string
  role: 'user' | 'assistant'
  text: string
  mode: 'selection' | 'full' // 基于选中 / 基于全文
  refText?: string // 引用原文片段
  anchorId?: string // 关联锚点
  model?: string
  streaming?: boolean // 是否流式输出中
  offline?: boolean // 本地模型标记
  error?: string
  reasoning?: string // 思考过程（Qwen3 等思考模型，淡色展示）
}

/** 一次对话会话：从某次提问（常带划词锚点）开始的多轮问答 */
export interface QaSession {
  id: string
  docId: string
  title: string // 会话标题（首个问题截断）
  createdAt: number
  anchorId?: string // 划词会话关联的原文锚点
  blkKey?: string // 提问发起的原文块
  snapshot?: string // 划选的原文快照
  messages: QaMsg[]
}

/** 已打开文档 */
export interface OpenDoc {
  id: string // 使用路径作为 id（M0 简化；正式版换内容哈希）
  name: string
  path: string
  family: string // 格式族：pdf/md/code/txt/image...
  version?: number // 内容版本：编辑保存后 +1，驱动渲染器重载
}

/** 模型配置（多 Profile）：本地 Ollama 或 OpenAI 兼容云端 API */
export interface ModelProfile {
  id: string
  name: string
  kind: 'local' | 'custom'
  baseUrl: string
  model: string
  apiKey?: string // 仅 custom；存储为 enc:/b64: 密文（safeStorage），旧明文兼容
}

/** 模型配置 */
export interface ModelConfig {
  key: 'mock' | 'local' | 'custom'
  label: string
  baseUrl: string
  model: string
  offline: boolean // 本地模型（Ollama）标记
}

/** 自定义 API 模型配置（OpenAI 兼容） */
export interface LlmCustomCfg {
  baseUrl: string
  apiKey: string
  model: string
}

/** 本地模型配置（Ollama，无需 apiKey） */
export interface LlmLocalCfg {
  baseUrl: string
  model: string
}

/** 文档 AI 洞察：模型对全文的预解析理解（后台生成，按文档缓存） */
export interface DocInsight {
  status: 'working' | 'done' | 'error'
  text: string
  model?: string
  updatedAt?: number
}
