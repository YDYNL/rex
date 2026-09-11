import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar, { toast } from './components/TopBar'
import Sidebar from './components/Sidebar'
import Viewer from './components/Viewer'
import AiPanel, { type AiPanelHandle } from './components/AiPanel'
import SettingsModal from './components/SettingsModal'
import { useAppStore } from './stores/appStore'
import { runSearch, jumpSearch, clearSearch } from './lib/search'
import type { SearchStatsView } from './components/Viewer'

/** 应用根组件：三栏布局 + 全局协调 */
export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchStats, setSearchStats] = useState<SearchStatsView>({ total: 0, current: 0 })
  const aiRef = useRef<AiPanelHandle>(null)
  const activeDocId = useAppStore((s) => s.activeDocId)
  const openDocs = useAppStore((s) => s.openDocs)
  const editingDocId = useAppStore((s) => s.editingDocId)
  const docParse = useAppStore((s) => s.docParse)
  const activeDoc = openDocs.find((d) => d.id === activeDocId) ?? null

  /** 执行全文搜索：高亮所有命中并跳到第一个 */
  const onSearch = useCallback(
    (q: string) => {
      if (!activeDoc) {
        if (q) toast('请先打开一个文档')
        return
      }
      /* 编辑模式：文档已切为编辑器，暂停搜索 */
      if (editingDocId === activeDoc.id) {
        if (q) toast('编辑模式下暂停搜索，保存后恢复')
        return
      }
      const root = document.querySelector<HTMLElement>('.view')
      const st = runSearch(root, q)
      setSearchStats(st)
      if (q && st.total === 0) {
        toast(
          docParse[activeDoc.id] === 'parsing'
            ? '文档仍在解析中，稍后重试搜索'
            : `未找到「${q}」`
        )
      }
    },
    [activeDoc, editingDocId, docParse]
  )

  const onSearchJump = useCallback((dir: 1 | -1) => {
    setSearchStats(jumpSearch(dir))
  }, [])

  const onSearchClear = useCallback(() => {
    clearSearch()
    setSearchStats({ total: 0, current: 0 })
  }, [])

  /* 文档切换：清除搜索高亮与状态 */
  useEffect(() => {
    onSearchClear()
  }, [activeDocId, onSearchClear])

  /* 沉浸全屏：Esc 退出（输入框聚焦时让位给搜索清空逻辑） */
  const viewerFullscreen = useAppStore((s) => s.viewerFullscreen)
  const setViewerFullscreen = useAppStore((s) => s.setViewerFullscreen)
  useEffect(() => {
    if (!viewerFullscreen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      setViewerFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewerFullscreen, setViewerFullscreen])

  /* HTML iframe 内划词动作：iframe 无法触发父窗口悬浮条，由渲染器转发事件 */
  useEffect(() => {
    const onIframeAction = (e: Event): void => {
      const type = (e as CustomEvent<{ type: string }>).detail?.type
      if (type === 'ask') aiRef.current?.focusInput()
      else if (type === 'explain') aiRef.current?.quickAction('explain')
      else if (type === 'translate') aiRef.current?.quickAction('translate')
    }
    window.addEventListener('rex-iframe-action', onIframeAction)
    return () => window.removeEventListener('rex-iframe-action', onIframeAction)
  }, [])

  return (
    <>
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />
      <div className={`main${viewerFullscreen ? ' fs' : ''}`}>
        <Sidebar />
        <Viewer
          onAskWithSelection={() => aiRef.current?.focusInput()}
          onQuickAction={(action) => aiRef.current?.quickAction(action)}
          onJumpToSession={(sessionId) => aiRef.current?.jumpToSession(sessionId)}
          onSearch={onSearch}
          onSearchJump={onSearchJump}
          onSearchClear={onSearchClear}
          searchStats={searchStats}
        />
        <AiPanel ref={aiRef} onOpenSettings={() => setSettingsOpen(true)} />
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <div className="toast" id="rex-toast" />
    </>
  )
}

