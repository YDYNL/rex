import { create } from 'zustand'
import type {
  Anchor,
  DocInsight,
  LlmCustomCfg,
  LlmLocalCfg,
  ModelProfile,
  OpenDoc,
  QaMsg,
  QaSession,
  TextInfra
} from '../types'

/** 本地持久化键 */
const LS_ANCHORS = 'yueban.anchors.v1'
const LS_QA = 'yueban.qa.v1'
const LS_PROFILES = 'yueban.profiles.v1'
const LS_ACTIVE_MODEL = 'yueban.activeModel.v1'
/* 思考模式开关（qwen3 等：开=深度思考慢而全，关=快速直答） */
const LS_THINK_MODE = 'yueban.thinkMode.v1'
/* 旧版单模型配置键（迁移后清除） */
const LS_MODEL_OLD = 'yueban.model.v1'
const LS_LLM_CUSTOM_OLD = 'yueban.llmConfig.v1'
const LS_LLM_LOCAL_OLD = 'yueban.localLlm.v1'

const DEFAULT_LLM_CUSTOM: LlmCustomCfg = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat'
}
const DEFAULT_LLM_LOCAL: LlmLocalCfg = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3:4b'
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存储失败静默（正式版换 SQLite） */
  }
}
function removeLS(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** 旧版问答数据（Record<docId, QaMsg[]>）→ 会话模型迁移 */
function migrateQa(raw: unknown): Record<string, QaSession[]> {
  const result: Record<string, QaSession[]> = {}
  if (!raw || typeof raw !== 'object') return result
  for (const [docId, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(val)) continue
    // 新结构：元素含 messages 字段
    if (val.length > 0 && val.every((x) => x && typeof x === 'object' && 'messages' in x)) {
      result[docId] = val as QaSession[]
      continue
    }
    // 旧结构：QaMsg 平铺 → 包成一个会话
    const msgs = val as QaMsg[]
    if (msgs.length === 0) continue
    const firstUser = msgs.find((m) => m.role === 'user')
    result[docId] = [
      {
        id: `legacy-${docId}-${Date.now().toString(36)}`,
        docId,
        title: (firstUser?.text ?? '历史对话').slice(0, 24),
        createdAt: Date.now(),
        messages: msgs
      }
    ]
  }
  return result
}

/** 多 Profile 初始化：直接读取；旧版单配置首次自动迁移为双 Profile */
function initProfiles(): { profiles: ModelProfile[]; activeModelId: string } {
  const raw = load<ModelProfile[] | null>(LS_PROFILES, null)
  if (Array.isArray(raw) && raw.length > 0) {
    return { profiles: raw, activeModelId: load(LS_ACTIVE_MODEL, 'mock') }
  }
  const local = { ...DEFAULT_LLM_LOCAL, ...load(LS_LLM_LOCAL_OLD, {} as Partial<LlmLocalCfg>) }
  const custom = { ...DEFAULT_LLM_CUSTOM, ...load(LS_LLM_CUSTOM_OLD, {} as Partial<LlmCustomCfg>) }
  const profiles: ModelProfile[] = [
    { id: 'local-1', name: '本地 Ollama', kind: 'local', baseUrl: local.baseUrl, model: local.model },
    {
      id: 'api-1',
      name: '云端 API',
      kind: 'custom',
      baseUrl: custom.baseUrl,
      model: custom.model,
      ...(custom.apiKey ? { apiKey: custom.apiKey } : {})
    }
  ]
  const oldKey = load<string>(LS_MODEL_OLD, 'mock')
  const activeModelId = oldKey === 'local' ? 'local-1' : oldKey === 'custom' ? 'api-1' : 'mock'
  removeLS(LS_MODEL_OLD)
  removeLS(LS_LLM_CUSTOM_OLD)
  removeLS(LS_LLM_LOCAL_OLD)
  return { profiles, activeModelId }
}

/** 解析 Profile 中存储的密钥（enc:/b64: 前缀解密，明文原样返回） */
export async function resolveApiKey(key: string | undefined): Promise<string> {
  if (!key) return ''
  if (key.startsWith('enc:') || key.startsWith('b64:')) {
    const r = await window.rex.secure.decrypt(key)
    return r.ok ? r.plain : ''
  }
  return key
}

interface AppState {
  /* 左栏 */
  rootDir: string | null
  /* 中栏 */
  openDocs: OpenDoc[]
  activeDocId: string | null
  zoom: number
  /* 划词 */
  selection: TextInfra | null
  /* 锚点与问答（按文档归档） */
  anchors: Record<string, Anchor[]>
  qaLog: Record<string, QaSession[]>
  /* 各文档当前激活的会话 id（null = 下次提问新建会话） */
  activeSession: Record<string, string | null>
  /* 文档全文缓存（渲染器加载后写入，供 AI 全文上下文使用） */
  docContents: Record<string, string>
  /* 文档解析状态：parsing=原文抽取中 ready=抽取完成（AI 可用全文） */
  docParse: Record<string, 'parsing' | 'ready' | 'error'>
  /* 文档 AI 洞察（模型对全文的预解析理解，按文档缓存） */
  docInsights: Record<string, DocInsight>
  /* 多模型 Profile 列表 + 当前激活（'mock' 或 profile id） */
  profiles: ModelProfile[]
  activeModelId: string
  /* 每文档记忆的模型 id（切回文档自动恢复） */
  docModel: Record<string, string>
  /* 文档编辑：当前编辑中的文档 id（编辑态暂停 AI 问答） */
  editingDocId: string | null
  /* 编辑草稿备份（切 Tab 不丢未保存内容） */
  editDraft: Record<string, string>
  /* 思考模式（qwen3 等）：false=快速直答（默认），true=深度思考 */
  thinkMode: boolean
  /* 沉浸阅读全屏：隐藏左右栏，文档铺满窗口（Esc 退出） */
  viewerFullscreen: boolean

  /* actions */
  setRootDir: (dir: string | null) => void
  setDocContent: (docId: string, content: string) => void
  setDocError: (docId: string) => void
  openDoc: (doc: OpenDoc) => void
  closeDoc: (id: string) => void
  setActiveDoc: (id: string) => void
  setZoom: (z: number) => void
  setSelection: (s: TextInfra | null) => void
  addAnchor: (a: Anchor) => void
  /** 将锚点绑定到会话（划词续问时锚点先建后绑定，点击紫点跳转该会话） */
  bindAnchorSession: (anchorId: string | undefined, sessionId: string) => void
  /** 新建会话（划词提问时创建，返回会话 id） */
  addQaSession: (s: QaSession) => void
  /** 向指定会话追加消息 */
  addQa: (docId: string, sessionId: string, msg: QaMsg) => void
  /** 更新指定会话内某条消息 */
  patchQa: (docId: string, sessionId: string, msgId: string, patch: Partial<QaMsg>) => void
  /** 激活会话（锚点点击回看 / 新建对话置空） */
  setActiveSession: (docId: string, sessionId: string | null) => void
  /** 新增或更新模型 Profile */
  upsertProfile: (p: ModelProfile) => void
  /** 删除模型 Profile（若为当前激活则回落演示模式） */
  removeProfile: (id: string) => void
  /** 切换当前模型；rememberDoc 时同步写入该文档的模型记忆 */
  setActiveModel: (id: string, opts?: { rememberDoc?: string }) => void
  /** 进入文档编辑模式 */
  startEdit: (docId: string) => void
  /** 退出编辑模式（丢弃该文档编辑草稿） */
  stopEdit: () => void
  /** 编辑草稿备份（编辑器卸载时写入） */
  setEditDraft: (docId: string, text: string) => void
  /** 编辑保存完成：版本+1 驱动渲染器重载，重置解析/洞察，退出编辑 */
  docSaved: (docId: string) => void
  setDocInsight: (docId: string, insight: DocInsight) => void
  /** 切换思考模式（qwen3 等） */
  setThinkMode: (on: boolean) => void
  /** 沉浸阅读全屏开关 */
  setViewerFullscreen: (on: boolean) => void
}

const initialModels = initProfiles()

export const useAppStore = create<AppState>((set, get) => ({
  rootDir: null,
  openDocs: [],
  activeDocId: null,
  zoom: 100,
  selection: null,
  anchors: load(LS_ANCHORS, {} as Record<string, Anchor[]>),
  qaLog: migrateQa(load(LS_QA, null)),
  activeSession: {},
  docContents: {},
  docParse: {},
  docInsights: {},
  profiles: initialModels.profiles,
  activeModelId: initialModels.activeModelId,
  docModel: {},
  editingDocId: null,
  editDraft: {},
  thinkMode: load(LS_THINK_MODE, false),
  viewerFullscreen: false,

  setRootDir: (dir) => set({ rootDir: dir }),

  setDocContent: (docId, content) =>
    set((s) => ({
      docContents: { ...s.docContents, [docId]: content },
      docParse: { ...s.docParse, [docId]: 'ready' }
    })),

  setDocError: (docId) =>
    set((s) => ({ docParse: { ...s.docParse, [docId]: 'error' as const } })),

  openDoc: (doc) =>
    set((s) => ({
      openDocs: s.openDocs.some((d) => d.id === doc.id) ? s.openDocs : [...s.openDocs, doc],
      activeDocId: doc.id,
      selection: null,
      /* 首次打开进入解析中；已缓存全文的直接就绪 */
      docParse: s.docParse[doc.id]
        ? s.docParse
        : { ...s.docParse, [doc.id]: 'parsing' as const }
    })),

  closeDoc: (id) =>
    set((s) => {
      const openDocs = s.openDocs.filter((d) => d.id !== id)
      const { [id]: _draft, ...restDraft } = s.editDraft
      return {
        openDocs,
        activeDocId:
          s.activeDocId === id ? (openDocs.length > 0 ? openDocs[openDocs.length - 1].id : null) : s.activeDocId,
        selection: null,
        editingDocId: s.editingDocId === id ? null : s.editingDocId,
        editDraft: restDraft
      }
    }),

  setActiveDoc: (id) => set({ activeDocId: id, selection: null }),

  setZoom: (z) => set({ zoom: Math.min(400, Math.max(25, z)) }),

  setSelection: (sel) => set({ selection: sel }),

  addAnchor: (a) => {
    const next = { ...get().anchors, [a.docId]: [...(get().anchors[a.docId] ?? []), a] }
    save(LS_ANCHORS, next)
    set({ anchors: next })
  },

  bindAnchorSession: (anchorId, sessionId) => {
    if (!anchorId) return
    let changed = false
    const next: Record<string, Anchor[]> = {}
    for (const [docId, list] of Object.entries(get().anchors)) {
      next[docId] = list.map((a) => {
        if (a.id !== anchorId || a.sessionId === sessionId) return a
        changed = true
        return { ...a, sessionId }
      })
    }
    if (changed) {
      save(LS_ANCHORS, next)
      set({ anchors: next })
    }
  },

  addQaSession: (s) => {
    const next = { ...get().qaLog, [s.docId]: [...(get().qaLog[s.docId] ?? []), s] }
    save(LS_QA, next)
    set({ qaLog: next, activeSession: { ...get().activeSession, [s.docId]: s.id } })
  },

  addQa: (docId, sessionId, msg) => {
    const list = get().qaLog[docId] ?? []
    const next = {
      ...get().qaLog,
      [docId]: list.map((s) =>
        s.id === sessionId ? { ...s, messages: [...s.messages, msg] } : s
      )
    }
    save(LS_QA, next)
    set({ qaLog: next })
  },

  patchQa: (docId, sessionId, msgId, patch) => {
    const list = get().qaLog[docId] ?? []
    const next = {
      ...get().qaLog,
      [docId]: list.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              messages: s.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m))
            }
          : s
      )
    }
    save(LS_QA, next)
    set({ qaLog: next })
  },

  setActiveSession: (docId, sessionId) =>
    set((s) => ({ activeSession: { ...s.activeSession, [docId]: sessionId } })),

  upsertProfile: (p) => {
    const exists = get().profiles.some((x) => x.id === p.id)
    const profiles = exists
      ? get().profiles.map((x) => (x.id === p.id ? p : x))
      : [...get().profiles, p]
    save(LS_PROFILES, profiles)
    set({ profiles })
  },

  removeProfile: (id) => {
    const profiles = get().profiles.filter((p) => p.id !== id)
    save(LS_PROFILES, profiles)
    const docModel = Object.fromEntries(
      Object.entries(get().docModel).filter(([, v]) => v !== id)
    )
    set({
      profiles,
      docModel,
      activeModelId: get().activeModelId === id ? 'mock' : get().activeModelId
    })
  },

  setActiveModel: (id, opts) => {
    save(LS_ACTIVE_MODEL, id)
    set((s) => ({
      activeModelId: id,
      ...(opts?.rememberDoc ? { docModel: { ...s.docModel, [opts.rememberDoc]: id } } : {})
    }))
  },

  startEdit: (docId) =>
    set({ editingDocId: docId, selection: null }),

  stopEdit: () =>
    set((s) => {
      if (!s.editingDocId) return {}
      const { [s.editingDocId]: _draft, ...restDraft } = s.editDraft
      return { editingDocId: null, editDraft: restDraft }
    }),

  setEditDraft: (docId, text) =>
    set((s) => ({ editDraft: { ...s.editDraft, [docId]: text } })),

  docSaved: (docId) =>
    set((s) => {
      const { [docId]: _draft, ...restDraft } = s.editDraft
      return {
        openDocs: s.openDocs.map((d) => (d.id === docId ? { ...d, version: (d.version ?? 0) + 1 } : d)),
        docParse: { ...s.docParse, [docId]: 'parsing' as const },
        docInsights: Object.fromEntries(Object.entries(s.docInsights).filter(([k]) => k !== docId)),
        docContents: Object.fromEntries(Object.entries(s.docContents).filter(([k]) => k !== docId)),
        editingDocId: s.editingDocId === docId ? null : s.editingDocId,
        editDraft: restDraft,
        selection: null
      }
    }),

  setDocInsight: (docId, insight) =>
    set((s) => ({ docInsights: { ...s.docInsights, [docId]: insight } })),

  setThinkMode: (on) => {
    save(LS_THINK_MODE, on)
    set({ thinkMode: on })
  },

  setViewerFullscreen: (on) => set({ viewerFullscreen: on })
}))
