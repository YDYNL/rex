import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { EDITABLE_FAMILIES, FAMILY_META, getRendererLoader } from '../renderers/registry'
import type { RendererProps } from '../renderers/registry'
import type { TextInfra } from '../types'
import { anchorOffsets, blockTextOffset, flashAnchorRange } from '../lib/anchorRange'
import Editor from './Editor'

/** 懒加载各格式渲染器 */
const lazyRenderers: Record<string, React.LazyExoticComponent<React.ComponentType<RendererProps>>> = {}
function getRenderer(family: string): React.LazyExoticComponent<React.ComponentType<RendererProps>> | null {
  if (!lazyRenderers[family]) {
    const loader = getRendererLoader(family)
    if (!loader) return null
    lazyRenderers[family] = lazy(loader)
  }
  return lazyRenderers[family]
}

export interface SearchStatsView {
  total: number
  current: number
}

interface ViewerProps {
  onAskWithSelection: () => void
  onQuickAction: (action: 'explain' | 'translate') => void
  /** 锚点紫点点击 → 右栏跳转到对应历史会话 */
  onJumpToSession: (sessionIdOrQaId: string) => void
  /** 执行搜索（空串=清除） */
  onSearch: (q: string) => void
  /** 命中导航：1=下一个 -1=上一个 */
  onSearchJump: (dir: 1 | -1) => void
  /** 清空搜索并清除高亮 */
  onSearchClear: () => void
  searchStats: SearchStatsView
}

/** 中栏：Tab + 工具栏（含悬浮展开搜索） + 渲染器路由 + 划词交互 */
export default function Viewer({
  onAskWithSelection,
  onQuickAction,
  onJumpToSession,
  onSearch,
  onSearchJump,
  onSearchClear,
  searchStats
}: ViewerProps) {
  const openDocs = useAppStore((s) => s.openDocs)
  const activeDocId = useAppStore((s) => s.activeDocId)
  const closeDoc = useAppStore((s) => s.closeDoc)
  const setActiveDoc = useAppStore((s) => s.setActiveDoc)
  const zoom = useAppStore((s) => s.zoom)
  const setZoom = useAppStore((s) => s.setZoom)
  const setSelection = useAppStore((s) => s.setSelection)
  const anchors = useAppStore((s) => s.anchors)
  const docParse = useAppStore((s) => s.docParse)
  const docInsights = useAppStore((s) => s.docInsights)
  const editingDocId = useAppStore((s) => s.editingDocId)
  const startEdit = useAppStore((s) => s.startEdit)
  const viewerFullscreen = useAppStore((s) => s.viewerFullscreen)
  const setViewerFullscreen = useAppStore((s) => s.setViewerFullscreen)

  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)

  /* ── 搜索：默认图标，悬浮/聚焦展开；有内容保持展开 ── */
  const [q, setQ] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const lastSearched = useRef('')

  /* 切换文档：清空搜索 */
  useEffect(() => {
    setQ('')
    lastSearched.current = ''
  }, [activeDocId])

  /* 输入防抖 350ms 实时搜索 */
  useEffect(() => {
    const t = setTimeout(() => {
      const query = q.trim()
      if (query === lastSearched.current) return
      lastSearched.current = query
      onSearch(query)
    }, 350)
    return () => clearTimeout(t)
  }, [q, onSearch])

  const activeDoc = openDocs.find((d) => d.id === activeDocId) ?? null
  /** 编辑态：当前文档进入编辑模式（问答/划词暂停） */
  const editing = !!activeDoc && editingDocId === activeDoc.id
  const editable = !!activeDoc && EDITABLE_FAMILIES.has(activeDoc.family)
  const hasQuery = q.trim().length > 0
  const hasHits = searchStats.total > 0

  /** 划词捕获：mouseup 后从 DOM Selection 提取 TextInfra */
  const captureSelection = useCallback((): TextInfra | null => {
    if (!activeDocId) return null
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return null
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (text.length < 2 || text.length > 2000) return null
    // 校验选区位于当前文档视图内
    const range = sel.getRangeAt(0)
    const node =
      range.commonAncestorContainer.nodeType === 1
        ? (range.commonAncestorContainer as HTMLElement)
        : range.commonAncestorContainer.parentElement
    if (!node || !viewRef.current || !viewRef.current.contains(node)) return null
    // 定位所在渲染块（data-blk）
    const blkEl = node.closest('[data-blk]')
    const blkKey = blkEl?.getAttribute('data-blk') ?? null
    // 计算划选内容在块内文本的字符偏移（精确锚点：紫点定位 + 点击只闪烁划选文字）
    let rangeStart: number | undefined
    let rangeEnd: number | undefined
    if (blkEl) {
      const r = sel.getRangeAt(0)
      const s = blockTextOffset(blkEl, r.startContainer, r.startOffset)
      const e = s != null ? blockTextOffset(blkEl, r.endContainer, r.endOffset) : null
      if (s != null && e != null && e > s) {
        rangeStart = s
        rangeEnd = e
      }
    }
    return { docId: activeDocId, snapshot: text, blkKey, pageIndex: 0, rangeStart, rangeEnd }
  }, [activeDocId])

  // 文本选区 → 悬浮操作条（当前文档编辑态才暂停划词；其他 Tab 编辑不影响本文档）
  useEffect(() => {
    const onUp = (): void => {
      const st = useAppStore.getState()
      if (st.editingDocId && st.editingDocId === st.activeDocId) {
        setFloatPos(null)
        return
      }
      // 延迟到浏览器完成选区更新
      setTimeout(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed) {
          setFloatPos(null)
          return
        }
        const infra = captureSelection()
        if (!infra) {
          setFloatPos(null)
          return
        }
        setSelection(infra)
        const rect = sel.getRangeAt(0).getBoundingClientRect()
        setFloatPos({ x: rect.left + rect.width / 2, y: rect.top - 44 })
      }, 10)
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [captureSelection, setSelection])

  const clearFloat = useCallback((): void => {
    setFloatPos(null)
    setSelection(null)
  }, [setSelection])

  const docAnchors = activeDoc ? anchors[activeDoc.id] ?? [] : []

  /** 锚点紫点点击：闪烁划选内容（存储偏移 or 快照定位）后右栏跳转对应历史会话；无法定位回退块级闪烁 */
  const handleBlockAnchorClick = useCallback(
    (sessionId: string, blkKey: string, anchorId?: string) => {
      const blk = viewRef.current?.querySelector(`[data-blk="${blkKey}"]`)
      const a = anchorId ? docAnchors.find((x) => x.id === anchorId) : undefined
      if (a && blk && viewRef.current) {
        const off = anchorOffsets(blk, a)
        if (off && flashAnchorRange(viewRef.current, blkKey, off.start, off.end)) {
          onJumpToSession(sessionId)
          return
        }
      }
      if (blk) {
        blk.classList.remove('flash')
        void (blk as HTMLElement).offsetWidth
        blk.classList.add('flash')
      }
      onJumpToSession(sessionId)
    },
    [onJumpToSession, docAnchors]
  )

  const Renderer = activeDoc ? getRenderer(activeDoc.family) : null

  return (
    <section className="center">
      <div className="center-topbar">
        <div className="tabs">
          {openDocs.map((t) => {
            /* 文件卡片加载态：原文抽取中 / AI 深度理解中 */
            const parsing = docParse[t.id] === 'parsing'
            const understanding = docInsights[t.id]?.status === 'working'
            const busy = parsing || understanding
            return (
              <div
                key={t.id}
                className={`tab${t.id === activeDocId ? ' active' : ''}`}
                title={busy ? (parsing ? '正在解析文档原文…' : 'AI 正在深度理解全文…') : t.name}
                onClick={() => setActiveDoc(t.id)}
              >
                {busy ? (
                  <span className={`tab-spinner${parsing ? '' : ' understand'}`} />
                ) : editingDocId === t.id ? (
                  <span title="编辑中（保存或放弃后恢复阅读与问答）">✏️</span>
                ) : (
                  FAMILY_META[t.family]?.icon ?? '📄'
                )}
                <span>{t.name}</span>
                <span
                  className="close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeDoc(t.id)
                  }}
                >
                  ×
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* 中栏内部顶部悬浮路径条：透明背景，不占布局空间 */}
      {activeDoc && (
        <div className="path-float" title={activeDoc.path}>
          本地 <span className="sep">/</span> {activeDoc.name}
        </div>
      )}

      <div className="view" ref={viewRef} onMouseDown={(e) => {
        // 点击空白处清除悬浮条（点悬浮条本身除外）
        if (!(e.target as HTMLElement).closest('.float-bar')) setFloatPos(null)
      }}>
        {activeDoc && editing ? (
          <Editor doc={activeDoc} />
        ) : activeDoc && Renderer ? (
          <div className="doc-scroll" style={{ zoom: activeDoc.family === 'pdf' ? 1 : zoom / 100 }}>
            <Suspense fallback={<div className="sheet-loading">渲染器加载中…</div>}>
              <Renderer doc={activeDoc} zoom={zoom} onBlockAnchorClick={handleBlockAnchorClick} />
            </Suspense>
          </div>
        ) : (
          <div className="empty-state">
            <div className="big">📖</div>
            <div>从左侧打开文档，开始阅读与划词提问</div>
          </div>
        )}
      </div>

      {/* 划词悬浮操作条 */}
      <div
        className={`float-bar${floatPos ? ' show' : ''}`}
        style={floatPos ? { left: floatPos.x, top: floatPos.y } : undefined}
      >
        <button className="float-btn" onClick={() => { onQuickAction('explain'); clearFloat(); }}>
          💡 解释
        </button>
        <button className="float-btn" onClick={() => { onQuickAction('translate'); clearFloat(); }}>
          🌐 翻译
        </button>
        <button
          className="float-btn primary"
          onClick={() => {
            onAskWithSelection()
            setFloatPos(null)
          }}
        >
          🔍 划词提问
        </button>
      </div>

      {/* 右下角悬浮工具条：搜索 / 锚点数 / 编辑 / 缩放 / 沉浸全屏（编辑模式隐藏） */}
      {!editing && (
        <div className="view-dock">
          <div className={`search-fab${hasQuery || hasHits ? ' pinned' : ''}`}>
            <span className="sf-icon">🔍</span>
            <input
              ref={searchRef}
              placeholder={activeDoc ? `在 ${activeDoc.name} 中搜索…` : '搜索当前文档…'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQ('')
                  lastSearched.current = ''
                  onSearchClear()
                  searchRef.current?.blur()
                }
                if (e.key === 'Enter' && q.trim()) {
                  const query = q.trim()
                  if (query !== lastSearched.current) {
                    lastSearched.current = query
                    onSearch(query)
                  } else {
                    onSearchJump(e.shiftKey ? -1 : 1)
                  }
                }
              }}
            />
            {hasQuery && (
              <>
                <span className={`sf-badge${hasHits ? '' : ' miss'}`}>
                  {hasHits ? `${searchStats.current}/${searchStats.total}` : '0'}
                </span>
                <button
                  className="sf-nav"
                  title="上一个命中（Shift+Enter）"
                  disabled={!hasHits}
                  onClick={() => onSearchJump(-1)}
                >
                  ▲
                </button>
                <button
                  className="sf-nav"
                  title="下一个命中（Enter）"
                  disabled={!hasHits}
                  onClick={() => onSearchJump(1)}
                >
                  ▼
                </button>
                <button
                  className="sf-nav close"
                  title="清除搜索（Esc）"
                  onClick={() => {
                    setQ('')
                    lastSearched.current = ''
                    onSearchClear()
                  }}
                >
                  ×
                </button>
              </>
            )}
          </div>
          {activeDoc && docAnchors.length > 0 && (
            <span className="dock-chip" title="本文档问答锚点数">
              ● {docAnchors.length}
            </span>
          )}
          {editable && activeDoc && (
            <button
              className="dock-btn"
              title="编辑此文档（编辑时暂停问答，保存后恢复）"
              onClick={() => startEdit(activeDoc.id)}
            >
              ✏️
            </button>
          )}
          <span className="dock-sep" />
          <button className="dock-btn" title="缩小" onClick={() => setZoom(zoom - 10)}>
            －
          </button>
          <span className="zoom-val">{zoom}%</span>
          <button className="dock-btn" title="放大" onClick={() => setZoom(zoom + 10)}>
            ＋
          </button>
          <button
            className={`dock-btn${viewerFullscreen ? ' on' : ''}`}
            title={viewerFullscreen ? '退出全屏（Esc）' : '沉浸全屏：隐藏左右栏，专注阅读'}
            onClick={() => setViewerFullscreen(!viewerFullscreen)}
          >
            ⛶
          </button>
        </div>
      )}
    </section>
  )
}
