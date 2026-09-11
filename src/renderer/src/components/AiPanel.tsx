import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useAppStore, resolveApiKey } from '../stores/appStore'
import type { QaMsg, QaSession } from '../types'
import type { LlmMessage } from '../../../main/ipc/llm'
import { QA_SYSTEM_PROMPT, buildInsightPlan, buildQuestionMessages } from '../lib/llmContext'
import { anchorOffsets, flashAnchorRange } from '../lib/anchorRange'
import { toast } from './TopBar'

/** 演示模式的模拟回答（无 API 配置时的离线兜底） */
function mockAnswer(mode: 'selection' | 'full', action: string, snapshot: string): string {
  if (action === 'explain') {
    return `【演示模式回答】针对「${snapshot.slice(0, 40)}${snapshot.length > 40 ? '…' : ''}」的解释：\n\n这段内容是文档的关键片段。当前处于演示模式（未配置模型），回答为本地模拟。配置模型后，此处将给出基于文档上下文的真实解释，并引用原文位置。`
  }
  if (action === 'translate') {
    return `【演示模式回答】翻译结果（模拟）：\n\n「${snapshot.slice(0, 60)}${snapshot.length > 60 ? '…' : ''}」\n\n配置模型后，这里将输出基于当前模型的中英对照翻译。`
  }
  if (mode === 'selection') {
    return `【演示模式回答】基于选中文本的回答：\n\n你针对「${snapshot.slice(0, 40)}${snapshot.length > 40 ? '…' : ''}」提出了问题。演示模式下此回答为本地模拟生成；配置模型后，将基于该选中文本与文档上下文给出真实回答。\n\n💡 本条问答已在原文处生成锚点标记，点击紫点可回看。`
  }
  return '【演示模式回答】基于全文的回答（模拟）。配置模型后，这里将基于当前文档的全部解析内容给出结构化回答。'
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

export interface AiPanelHandle {
  quickAction: (action: 'explain' | 'translate') => void
  focusInput: () => void
  /** 跳转到历史会话（锚点紫点点击触发） */
  jumpToSession: (sessionIdOrQaId: string) => void
}

interface AiPanelProps {
  onOpenSettings: () => void
}

let msgSeq = 0
const nid = (): string => `m${Date.now().toString(36)}${(msgSeq++).toString(36)}`

/** 右栏：AI 伴读（多模型 Profile + 会话模型 + 划词/全文上下文 + 流式输出 + 锚点联动 + 编辑锁定） */
const AiPanel = forwardRef<AiPanelHandle, AiPanelProps>(function AiPanel({ onOpenSettings }, ref) {
  const activeDocId = useAppStore((s) => s.activeDocId)
  const openDocs = useAppStore((s) => s.openDocs)
  const selection = useAppStore((s) => s.selection)
  const setSelection = useAppStore((s) => s.setSelection)
  const qaLog = useAppStore((s) => s.qaLog)
  const activeSessionMap = useAppStore((s) => s.activeSession)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const anchors = useAppStore((s) => s.anchors)
  const docContents = useAppStore((s) => s.docContents)
  const docParse = useAppStore((s) => s.docParse)
  const docInsights = useAppStore((s) => s.docInsights)
  const setDocInsight = useAppStore((s) => s.setDocInsight)
  const profiles = useAppStore((s) => s.profiles)
  const activeModelId = useAppStore((s) => s.activeModelId)
  const editingDocId = useAppStore((s) => s.editingDocId)
  const addQaSession = useAppStore((s) => s.addQaSession)
  const addQa = useAppStore((s) => s.addQa)
  const patchQa = useAppStore((s) => s.patchQa)
  const addAnchor = useAppStore((s) => s.addAnchor)

  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  /* 本地服务连接状态（针对当前激活的 local profile）：null=未检测 true=在线 false=离线 */
  const [localOk, setLocalOk] = useState<boolean | null>(null)
  const [detecting, setDetecting] = useState(false)
  /* 慢响应提示：提问 8 秒仍无任何输出时显示安抚文案 */
  const [slowHint, setSlowHint] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const activeDoc = openDocs.find((d) => d.id === activeDocId) ?? null
  const sessions = activeDocId ? qaLog[activeDocId] ?? [] : []
  const activeSessionId = activeDocId ? activeSessionMap[activeDocId] ?? null : null
  const currentSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const messages = currentSession?.messages ?? []
  const parseStatus = activeDocId ? (docParse[activeDocId] ?? 'parsing') : null
  const insight = activeDocId ? docInsights[activeDocId] : undefined
  const insightText = insight?.status === 'done' ? insight.text : undefined

  /** 当前激活的模型 Profile（null = 演示模式） */
  const activeProfile = profiles.find((p) => p.id === activeModelId) ?? null
  const editing = !!activeDocId && editingDocId === activeDocId

  /* 切换文档：恢复该文档记忆的模型 */
  useEffect(() => {
    if (!activeDocId) return
    const st = useAppStore.getState()
    const remembered = st.docModel[activeDocId]
    if (remembered && remembered !== st.activeModelId) {
      if (remembered === 'mock' || st.profiles.some((p) => p.id === remembered)) {
        st.setActiveModel(remembered)
      }
    }
  }, [activeDocId])

  /* 检测当前激活的本地模型服务（仅供状态条展示在线/离线） */
  const detectLocal = useCallback(async () => {
    const st = useAppStore.getState()
    const p = st.profiles.find((x) => x.id === st.activeModelId)
    if (!p || p.kind !== 'local') return
    setDetecting(true)
    const r = await window.rex.llm.listModels({ baseUrl: p.baseUrl })
    setDetecting(false)
    setLocalOk(r.ok)
  }, [])

  const detectRef = useRef(detectLocal)
  detectRef.current = detectLocal
  useEffect(() => {
    setLocalOk(null)
    if (activeProfile?.kind === 'local') void detectRef.current()
  }, [activeModelId, activeProfile?.kind])

  /* 切换文档时收起历史面板 */
  useEffect(() => {
    setShowHistory(false)
  }, [activeDocId])

  /* ── 通用流式对话：从 store 实时取当前模型；API 网络级失败自动降级本地 ── */
  const streamChat = useCallback(
    async (opts: {
      messages: LlmMessage[]
      onDelta?: (delta: string) => void
      /** 思考增量回调（Qwen3 等思考模型的推理过程） */
      onReasoning?: (delta: string) => void
      /** 关闭思考模式（提速；洞察等后台任务强制关闭） */
      noThink?: boolean
    }): Promise<{ ok: true; text: string } | { ok: false; text: string; error: string }> => {
      const attempt = async (cfg: {
        baseUrl: string
        apiKey: string
        model: string
        noThink?: boolean
      }): Promise<
        { ok: true; text: string } | { ok: false; text: string; error: string; network?: boolean }
      > => {
        const reqId = nid()
        let acc = ''
        const unsub = window.rex.llm.onChunk((chunk) => {
          if (chunk.reqId !== reqId) return
          if (chunk.reasoning) {
            opts.onReasoning?.(chunk.delta)
          } else {
            acc += chunk.delta
            opts.onDelta?.(chunk.delta)
          }
        })
        const r = await window.rex.llm.chat({ reqId, ...cfg, messages: opts.messages })
        unsub()
        return r.ok ? { ok: true, text: acc } : { ok: false, text: acc, error: r.error, network: r.network }
      }

      const st = useAppStore.getState()
      const p = st.profiles.find((x) => x.id === st.activeModelId)
      if (!p) return { ok: false, text: '', error: '当前为演示模式，请先配置模型' }
      const apiKey = p.kind === 'custom' ? await resolveApiKey(p.apiKey) : ''
      const r = await attempt({ baseUrl: p.baseUrl, apiKey, model: p.model, noThink: opts.noThink })

      /* 离线降级：云端 API 网络不可达 → 自动切换本地模型重试一次 */
      if (!r.ok && r.network && p.kind === 'custom') {
        const st2 = useAppStore.getState()
        const localP = st2.profiles.find((x) => x.kind === 'local')
        if (localP) {
          st2.setActiveModel(localP.id)
          toast(`API 模型不可达，已自动切换本地模型（${localP.model}）`)
          return attempt({ baseUrl: localP.baseUrl, apiKey: '', model: localP.model, noThink: opts.noThink })
        }
      }
      return r.ok ? r : { ok: false, text: r.text, error: r.error }
    },
    []
  )

  /* ── 后台文档洞察：模型对全文的预解析理解（问答时作为核心上下文） ── */
  const insightBusyRef = useRef<string | null>(null)

  const generateInsight = useCallback(
    async (docId: string, fullText: string) => {
      if (insightBusyRef.current) return
      insightBusyRef.current = docId
      setDocInsight(docId, { status: 'working', text: '' })
      try {
        const plan = buildInsightPlan(fullText)
        const summaries: string[] = []
        for (const step of plan.mapSteps) {
          /* 洞察为后台批量任务：强制关闭思考模式提速 */
          const r = await streamChat({ messages: step, noThink: true })
          if (!r.ok) throw new Error(r.error)
          summaries.push(r.text.trim())
        }
        let finalText = summaries[0] ?? ''
        if (plan.buildReduce) {
          const r = await streamChat({ messages: plan.buildReduce(summaries), noThink: true })
          if (!r.ok) throw new Error(r.error)
          finalText = r.text.trim()
        }
        if (insightBusyRef.current === docId) {
          const st = useAppStore.getState()
          const modelName = st.profiles.find((x) => x.id === st.activeModelId)?.model
          setDocInsight(docId, {
            status: 'done',
            text: finalText,
            model: modelName,
            updatedAt: Date.now()
          })
        }
      } catch {
        if (insightBusyRef.current === docId) {
          setDocInsight(docId, { status: 'error', text: '' })
        }
      } finally {
        if (insightBusyRef.current === docId) insightBusyRef.current = null
      }
    },
    [streamChat, setDocInsight]
  )

  /* 触发条件：当前文档 + 原文抽取完成 + 真实模型可用 + 尚无洞察（失败不自动重试，避免循环） */
  useEffect(() => {
    if (!activeDocId || !activeProfile) return
    if (parseStatus !== 'ready') return
    if (insight) return
    if (insightBusyRef.current === activeDocId) return
    const fullText = docContents[activeDocId] ?? ''
    if (fullText.trim().length < 200) return
    if (activeProfile.kind === 'custom' && !activeProfile.apiKey) return
    if (activeProfile.kind === 'local' && localOk === false) return
    void generateInsight(activeDocId, fullText)
  }, [
    activeDocId,
    activeProfile,
    parseStatus,
    insight,
    docContents,
    localOk,
    generateInsight
  ])

  /** 跳转历史会话：激活会话 + 滚动 + 闪烁提示（兼容旧锚点传 qaId） */
  const jumpToSession = useCallback(
    (sessionIdOrQaId: string) => {
      if (!activeDocId) return
      let sid = sessionIdOrQaId
      // 旧数据兜底：按消息 id 反查所在会话
      if (!sessions.some((s) => s.id === sessionIdOrQaId)) {
        const hit = sessions.find((s) => s.messages.some((m) => m.id === sessionIdOrQaId))
        if (!hit) return
        sid = hit.id
      }
      setActiveSession(activeDocId, sid)
      setShowHistory(false)
      setTimeout(() => {
        const b = bodyRef.current
        if (b) b.scrollTop = b.scrollHeight
        const node = b?.querySelector('.session-view')
        if (node) {
          node.classList.remove('flash-outline')
          void (node as HTMLElement).offsetWidth
          node.classList.add('flash-outline')
          setTimeout(() => node.classList.remove('flash-outline'), 1800)
        }
      }, 60)
    },
    [activeDocId, sessions, setActiveSession]
  )

  useImperativeHandle(ref, () => ({
    quickAction: (action) => {
      if (!selection || !activeDocId) return
      if (editing) {
        toast('编辑模式下暂停问答，保存后恢复')
        return
      }
      void ask(action === 'explain' ? '请解释这段内容' : '请将这段内容翻译为中文（原文为中文则译为英文）', selection)
    },
    focusInput: () => inputRef.current?.focus(),
    jumpToSession
  }))

  // 消息变化自动滚到底（流式期间）
  useEffect(() => {
    const b = bodyRef.current
    if (b) b.scrollTop = b.scrollHeight
  }, [messages, currentSession?.id])

  /** 发起一次问答：定位/新建会话 → 写入消息 → 划词新建锚点 → 流式填充回答 */
  const ask = useCallback(
    async (question: string, sel = selection) => {
      if (!activeDocId || !activeDoc) return
      if (busy) return
      if (editingDocId === activeDocId) {
        toast('编辑模式下暂停问答，保存文档后恢复')
        return
      }

      const mode: 'selection' | 'full' = sel ? 'selection' : 'full'

      // 基于全文的提问：解析未完成/失败时拦截（此时全文为空，模型收不到任何原文，答非所问）
      if (mode === 'full' && parseStatus !== 'ready') {
        toast(
          parseStatus === 'error'
            ? '文档解析失败，暂时无法基于全文回答'
            : '文档正在解析中，请等上方加载完成后基于全文提问'
        )
        return
      }

      setBusy(true)

      const refText = sel
        ? sel.snapshot.length > 52
          ? sel.snapshot.slice(0, 49) + '…'
          : sel.snapshot
        : undefined

      // 从 store 实时取会话状态（避免闭包过期）
      const st = useAppStore.getState()
      const cur =
        (st.qaLog[activeDocId] ?? []).find((s) => s.id === st.activeSession[activeDocId]) ?? null

      const userMsg: QaMsg = { id: nid(), role: 'user', text: question, mode }

      /* 1. 会话：已有激活会话则多轮续问；否则新建（会话沉淀快照，锚点与续问无关） */
      let sessionId: string
      let anchorId: string | undefined
      // 划词提问一律落锚点（新会话/续问不区分）：被提问的段落都要有紫点标识
      if (mode === 'selection' && sel?.blkKey) {
        anchorId = nid()
        st.addAnchor({
          id: anchorId,
          docId: activeDocId,
          blkKey: sel.blkKey,
          snapshot: sel.snapshot,
          qaId: userMsg.id,
          sessionId: undefined,
          createdAt: Date.now(),
          rangeStart: sel.rangeStart,
          rangeEnd: sel.rangeEnd
        })
      }
      if (cur) {
        sessionId = cur.id
        // 锚点归属当前续问的会话（点击紫点跳到这里）
        st.bindAnchorSession(anchorId, sessionId)
      } else {
        sessionId = nid()
        st.bindAnchorSession(anchorId, sessionId)
        const session: QaSession = {
          id: sessionId,
          docId: activeDocId,
          title: question.slice(0, 24),
          createdAt: Date.now(),
          anchorId,
          blkKey: sel?.blkKey ?? undefined,
          snapshot: sel?.snapshot,
          messages: []
        }
        st.addQaSession(session)
      }

      /* 2. 用户消息 */
      st.addQa(activeDocId, sessionId, userMsg)

      /* 3. assistant 占位（流式） */
      const modelState = useAppStore.getState()
      const p = modelState.profiles.find((x) => x.id === modelState.activeModelId)
      const aiMsg: QaMsg = {
        id: nid(),
        role: 'assistant',
        text: '',
        mode,
        refText,
        anchorId,
        model: p ? p.model : '演示模式（离线）',
        streaming: true,
        offline: !p || p.kind === 'local'
      }
      st.addQa(activeDocId, sessionId, aiMsg)

      /* 4. 流式生成（多轮：携带本会话最近历史） */
      const readMsg = (): QaMsg | undefined => {
        const list = useAppStore.getState().qaLog[activeDocId] ?? []
        return list.find((s) => s.id === sessionId)?.messages.find((m) => m.id === aiMsg.id)
      }
      const fill = (delta: string): void => {
        patchQa(activeDocId, sessionId, aiMsg.id, { text: (readMsg()?.text ?? '') + delta })
      }
      const fillReasoning = (delta: string): void => {
        patchQa(activeDocId, sessionId, aiMsg.id, {
          reasoning: (readMsg()?.reasoning ?? '') + delta
        })
      }

      /* 慢响应提示：8 秒无任何输出 → 气泡显示安抚文案（本地大模型首次提问需加载权重） */
      let gotFirst = false
      setSlowHint(false)
      const slowTimer = setTimeout(() => {
        if (!gotFirst) setSlowHint(true)
      }, 8000)

      try {
        if (!p) {
          // 演示模式：本地模拟逐字输出
          const answer = mockAnswer(
            mode,
            question.includes('解释') ? 'explain' : question.includes('翻译') ? 'translate' : '',
            sel?.snapshot ?? ''
          )
          let i = 0
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              i += 2
              patchQa(activeDocId, sessionId, aiMsg.id, { text: answer.slice(0, i) })
              if (i >= answer.length) {
                clearInterval(timer)
                resolve()
              }
            }, 20)
          })
        } else {
          // 真实模式：上下文 = 会话历史 + AI 全文理解（洞察）+ 选中片段 / 智能检索的相关原文
          const fullText = docContents[activeDocId] ?? ''
          const history: LlmMessage[] = (cur?.messages ?? [])
            .filter((m) => !m.error && m.text.trim())
            .slice(-8)
            .map((m) => ({ role: m.role, content: m.text }))
          const qaMessages: LlmMessage[] = [
            { role: 'system', content: QA_SYSTEM_PROMPT },
            ...history,
            ...buildQuestionMessages({
              question,
              insight: insightText,
              selection: mode === 'selection' ? sel?.snapshot : undefined,
              fullText: mode === 'full' ? fullText : undefined
            })
          ]
          const r = await streamChat({
            messages: qaMessages,
            onDelta: (delta) => {
              gotFirst = true
              setSlowHint(false)
              fill(delta)
            },
            onReasoning: (delta) => {
              gotFirst = true
              setSlowHint(false)
              fillReasoning(delta)
            },
            /* 思考模式开关（qwen3 等）：默认关闭快速直答，🧠 开启深度思考 */
            noThink: !useAppStore.getState().thinkMode
          })
          if (!r.ok) {
            patchQa(activeDocId, sessionId, aiMsg.id, { text: '', error: r.error, streaming: false })
            toast(r.error)
          }
        }
      } catch (e) {
        patchQa(activeDocId, sessionId, aiMsg.id, { error: String(e), streaming: false })
      } finally {
        clearTimeout(slowTimer)
        setSlowHint(false)
        patchQa(activeDocId, sessionId, aiMsg.id, { streaming: false })
        setBusy(false)
      }
    },
    [activeDocId, activeDoc, busy, editingDocId, parseStatus, insightText, docContents, streamChat, selection, patchQa]
  )

  const send = (): void => {
    const v = input.trim()
    if (!v) return
    if (!activeDocId) {
      toast('请先在左侧打开一个文档')
      return
    }
    if (editing) {
      toast('编辑模式下暂停问答，保存文档后恢复')
      return
    }
    setInput('')
    const sel = selection
    setSelection(null)
    void ask(v, sel)
  }

  /** 新建对话：置空激活会话，下一次提问开启新会话 */
  const newSession = (): void => {
    if (!activeDocId) return
    setActiveSession(activeDocId, null)
    setShowHistory(false)
    inputRef.current?.focus()
  }

  const locateAnchor = (a: {
    blkKey: string
    rangeStart?: number
    rangeEnd?: number
    snapshot: string
  }): void => {
    const blk = document.querySelector(`[data-blk="${a.blkKey}"]`)
    if (!blk) return
    // 有效偏移（存储 or 快照定位）：只闪烁划选的内容（紫色底纹 2s），不再点亮整个段落
    const off = anchorOffsets(blk, a)
    if (off && flashAnchorRange(document, a.blkKey, off.start, off.end)) return
    // 回退：块级滚动 + 闪烁
    blk.scrollIntoView({ behavior: 'smooth', block: 'center' })
    blk.classList.remove('flash')
    void (blk as HTMLElement).offsetWidth
    blk.classList.add('flash')
  }

  /** 模型状态标签 */
  const modelStatus = (): { text: string; off: boolean } => {
    if (!activeProfile) return { text: '演示模式 · 离线', off: true }
    if (activeProfile.kind === 'local') {
      if (detecting) return { text: '正在连接本地服务…', off: true }
      if (localOk === false) return { text: '本地服务未连接', off: true }
      return { text: `${activeProfile.model} · 本地在线`, off: false }
    }
    if (!activeProfile.apiKey) return { text: `${activeProfile.model} · 未配置密钥`, off: true }
    return { text: `${activeProfile.model} · 在线`, off: false }
  }
  const status = modelStatus()

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <div className="ai-head-top">
          <div className="ai-title">
            <span className="spark">✦</span> AI 伴读
          </div>
          <div className="ai-head-actions">
            {sessions.length > 0 && (
              <button
                className={`icon-mini${showHistory ? ' on' : ''}`}
                title="历史会话"
                onClick={() => setShowHistory((v) => !v)}
              >
                🕘
              </button>
            )}
            <button className="icon-mini new-session-btn" title="新建对话" onClick={newSession}>
              ＋
            </button>
          </div>
        </div>
        {/* 轻状态条：当前模型 + 在线状态（只读，点击打开设置配置模型） */}
        <button
          className={`ai-status-chip${status.off ? ' off' : ''}`}
          title="点击打开模型设置"
          onClick={onOpenSettings}
        >
          <span className="dot" />
          <span className="txt">{status.text}</span>
          <span className="gear">⚙</span>
        </button>
      </div>

      {/* 历史会话下拉 */}
      {showHistory && (
        <div className="history-pop">
          {sessions.length === 0 ? (
            <div className="history-empty">暂无历史会话</div>
          ) : (
            sessions
              .slice()
              .reverse()
              .map((s) => (
                <div
                  key={s.id}
                  className={`history-item${s.id === activeSessionId ? ' on' : ''}`}
                  onClick={() => jumpToSession(s.id)}
                >
                  <div className="t">
                    {s.snapshot ? '📌 ' : '💬 '}
                    {s.title || '未命名会话'}
                  </div>
                  <div className="m">
                    {s.messages.length} 条对话 · {fmtTime(s.createdAt)}
                  </div>
                </div>
              ))
          )}
        </div>
      )}

      <div className="ai-body" ref={bodyRef}>
        {currentSession ? (
          <div className="session-view" data-session={currentSession.id}>
            {currentSession.snapshot && (
              <div className="session-snapshot">
                <span className="lbl">📌 本会话划选</span>
                {currentSession.snapshot.length > 80
                  ? currentSession.snapshot.slice(0, 78) + '…'
                  : currentSession.snapshot}
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`msg ${m.role === 'user' ? 'msg-user' : 'msg-ai'}`}
                data-msg={m.id}
              >
                {/* 思考过程（思考模型专属）：流式时实时滚动，完成后保留摘要 */}
                {m.role === 'assistant' && !m.error && m.reasoning && (
                  <div className={`reasoning-box${m.streaming ? ' streaming' : ''}`}>
                    <span className="lbl">💭 思考过程{m.streaming && !m.text ? '…' : ''}</span>
                    <div className="r-text">{m.reasoning.slice(-800)}</div>
                  </div>
                )}
                <div className={`bubble${m.streaming && !m.error ? ' cursor' : ''}`}>
                  {m.error ? (
                    `⚠️ ${m.error}`
                  ) : m.text ? (
                    m.text
                  ) : m.streaming ? (
                    slowHint && !m.reasoning ? (
                      /* 8 秒无输出：安抚提示（本地大模型首次提问需加载权重） */
                      <span className="thinking-dots">
                        正在等待模型响应<span className="dot" />
                        <span className="dot" />
                        <span className="dot" />
                        <div className="slow-tip">本地模型首次提问需要加载，请稍候…</div>
                      </span>
                    ) : (
                      <span className="thinking-dots">
                        {m.reasoning ? '正在组织答案' : '正在思考'}
                        <span className="dot" />
                        <span className="dot" />
                        <span className="dot" />
                      </span>
                    )
                  ) : (
                    m.text
                  )}
                </div>
                {m.refText && (
                  <div className="ref-quote">
                    <span className="lbl">📌 引用原文 {m.anchorId ? '· 已标注锚点' : ''}</span>
                    {m.refText}
                  </div>
                )}
                {m.role === 'assistant' && !m.streaming && (
                  <div className="msg-actions">
                    <button className="action-btn" onClick={() => toast('已收藏到问答记录库')}>
                      ★ 收藏
                    </button>
                    {m.anchorId && (
                      <button
                        className="action-btn"
                        onClick={() => {
                          const a = (anchors[activeDocId ?? ''] ?? []).find(
                            (x) => x.id === m.anchorId
                          )
                          if (a) locateAnchor(a)
                        }}
                      >
                        ⤴ 定位原文
                      </button>
                    )}
                  </div>
                )}
                <div className="meta">
                  <span>{m.role === 'user' ? '你' : m.model ?? ''}</span>
                  {m.mode === 'selection' ? (
                    <span className="tag tag-sel">基于选中</span>
                  ) : (
                    <span className="tag tag-full">基于全文</span>
                  )}
                  {m.offline && <span className="tag tag-off">离线</span>}
                  {m.error && <span className="tag tag-err">失败</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mode-hint">
            ✨ 新对话
            <br />
            在文档中<b>划词</b>后点击「划词提问」，或直接输入问题让 AI <b>基于全文</b>回答。
            {sessions.length > 0 && (
              <>
                <br />
                <br />
                点击右上角 <b>🕘</b> 可回看历史会话。
              </>
            )}
          </div>
        )}
      </div>

      <div className="ai-input">
        {/* 划选内容卡：划词提问后自动显示所选内容 */}
        {selection && !editing && (
          <div className="selection-card">
            <span className="lbl">📌 已选中</span>
            <div className="txt">
              {selection.snapshot.length > 120
                ? selection.snapshot.slice(0, 118) + '…'
                : selection.snapshot}
            </div>
            <button className="sel-close" title="取消引用该片段" onClick={() => setSelection(null)}>
              ×
            </button>
          </div>
        )}
        {editing && <div className="edit-lock">📝 文档编辑中：保存后恢复 AI 问答</div>}
        <div className="chips">
          <button
            className="chip"
            disabled={editing}
            onClick={() => void ask('用三点总结当前文档的核心内容', null)}
          >
            总结全文
          </button>
          <button
            className="chip"
            disabled={editing}
            onClick={() => void ask('本文的主要论点是什么？', null)}
          >
            核心论点
          </button>
        </div>
        <div className="input-box">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={editing ? '📝 编辑模式中，保存文档后可继续提问…' : currentSession ? '继续提问…' : '输入问题，或先在文档中划词…'}
            value={input}
            disabled={editing}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button className="send-btn" onClick={send} disabled={busy || editing}>
            ➤
          </button>
        </div>
        <div className="ctx-bar">
          {editing
            ? '📝 编辑模式：AI 问答已暂停，保存后自动重新解析全文并恢复问答'
            : parseStatus === 'parsing'
            ? '📖 正在解析文档原文，完成后 AI 可引用全文…'
            : parseStatus === 'error'
              ? '⚠️ 文档解析失败，AI 将无法引用全文'
              : insight?.status === 'working'
              ? '🧠 AI 正在后台深度理解全文（可先提问，理解完成后回答更准）…'
              : insight?.status === 'done'
                ? `🧠 已深度理解全文${insight.model ? `（${insight.model}）` : ''}，回答将结合理解与模型知识`
                : insight?.status === 'error'
                  ? '⚠️ 全文理解失败'
                  : selection
                    ? `上下文：选中「${selection.snapshot.slice(0, 18)}${selection.snapshot.length > 18 ? '…' : ''}」，将优先引用该片段回答`
                    : currentSession
                      ? `上下文：会话「${currentSession.title}」${currentSession.snapshot ? ' · 划选片段' : ' · 全文'}` 
                      : '上下文：无选中，将基于全文理解回答'}
          {insight?.status === 'error' && (
            <button
              className="action-btn"
              style={{ marginLeft: 6 }}
              onClick={() => {
                if (!activeDocId) return
                const fullText = docContents[activeDocId] ?? ''
                if (fullText.trim()) void generateInsight(activeDocId, fullText)
              }}
            >
              重试
            </button>
          )}
        </div>
      </div>
    </aside>
  )
})

export default AiPanel
