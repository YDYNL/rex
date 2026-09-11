import { useCallback, useEffect, useRef, useState } from 'react'
import type { RendererProps } from './registry'
import { useAppStore } from '../stores/appStore'
import {
  anchorOffsets,
  blockTextOffset,
  flashAnchorRange,
  measureAnchorDot,
  rangeFromOffsets
} from '../lib/anchorRange'

/** 注入 iframe 的交互样式：紫点 / 划词悬浮条 / 锚点闪烁 */
const INJECT_CSS = `
  [data-blk] { position: relative; }
  .rex-dot {
    position: absolute; top: 6px; right: -6px; transform: translateX(100%);
    cursor: pointer; color: #8b5cf6; font-size: 7px; line-height: 1; font-weight: 700;
    text-shadow: 0 0 5px rgba(139, 92, 246, 0.9); z-index: 9999; user-select: none;
  }
  .rex-dot:hover { color: #a78bfa; }
  .rex-dot.precise { top: -5px; right: auto; transform: none; font-size: 6px; }
  .rex-flash { animation: rexflash 1.2s ease-out; }
  @keyframes rexflash { 0% { background: rgba(139, 92, 246, 0.28); } 100% { background: transparent; } }
  ::highlight(rex-anchor-flash) { background: rgba(130, 49, 142, 0.32); }
  ::highlight(rex-anchor-hover) { background: rgba(130, 49, 142, 0.22); }
  #rex-floatbar {
    position: fixed; z-index: 99999; display: flex; gap: 2px; padding: 4px;
    transform: translate(-50%, -100%);
    background: rgba(30, 28, 44, 0.92); border: 1px solid rgba(139, 92, 246, 0.45);
    border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px);
  }
  #rex-floatbar button {
    border: 0; background: transparent; color: #d4d0e4; font-size: 12px;
    padding: 5px 10px; border-radius: 7px; cursor: pointer; white-space: nowrap;
  }
  #rex-floatbar button:hover { background: rgba(139, 92, 246, 0.25); color: #fff; }
  #rex-floatbar button.p { background: #8b5cf6; color: #fff; font-weight: 600; }
  #rex-floatbar button.p:hover { background: #7c3aed; }
`

/** iframe 内悬浮条按钮配置 */
const FLOAT_BTNS: Array<{ t: string; label: string; primary?: boolean }> = [
  { t: 'explain', label: '💡 解释' },
  { t: 'translate', label: '🌐 翻译' },
  { t: 'ask', label: '🔍 划词提问', primary: true }
]

/** 清理 HTML：剥离脚本/嵌套框架/事件属性，顶层块打 data-blk 标记 */
function sanitizeHtml(src: string): { html: string; text: string; blocks: number } {
  const parsed = new DOMParser().parseFromString(src, 'text/html')
  parsed.querySelectorAll('script, iframe, object, embed, noscript').forEach((el) => el.remove())
  parsed.querySelectorAll('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name)
      else if ((a.name === 'href' || a.name === 'src') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name)
    }
  })
  const body = parsed.body
  const text = (body?.textContent ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const kids = body ? (Array.from(body.children) as HTMLElement[]) : []
  kids.forEach((k, i) => k.setAttribute('data-blk', `h${i}`))
  return {
    html: `<!DOCTYPE html>${parsed.documentElement?.outerHTML ?? '<html><body></body></html>'}`,
    text,
    blocks: kids.length
  }
}

/**
 * HTML 渲染器（iframe 沙箱真实还原版）：
 * - 保留原页样式与布局，白底卡片呈现，接近浏览器原生观感
 * - 安全：sandbox 禁脚本执行；剥离 script/iframe/embed 与 on* 事件属性
 * - 划词提问：iframe 内选中文本 → iframe 内悬浮条 → 通知父窗口 AI 动作
 * - 锚点紫点：注入 iframe 顶层块，点击跳转右栏对应会话
 */
export default function HtmlRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const [srcdoc, setSrcdoc] = useState('')
  const [blockCount, setBlockCount] = useState(0)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const setDocContent = useAppStore((s) => s.setDocContent)
  const setDocError = useAppStore((s) => s.setDocError)
  const anchors = useAppStore((s) => s.anchors[doc.id] ?? [])

  /* 解析与清理（编辑保存后 version 变化触发重载） */
  useEffect(() => {
    let alive = true
    setSrcdoc('')
    setError('')
    setReady(false)
    void window.rex.file.readText(doc.path).then((r) => {
      if (!alive) return
      if (!r.ok) {
        setDocError(doc.id)
        setError(r.error)
        return
      }
      try {
        const { html, text, blocks } = sanitizeHtml(r.content)
        setSrcdoc(html)
        setBlockCount(blocks)
        setDocContent(doc.id, text.slice(0, 400000))
      } catch (e) {
        setDocError(doc.id)
        setError(`HTML 解析失败：${String(e)}`)
      }
    })
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, doc.version, setDocContent, setDocError])

  /** iframe 内显示划词悬浮条（本文档编辑态才禁用） */
  const showFloatbar = useCallback((fdoc: Document, x: number, y: number): void => {
    if (useAppStore.getState().editingDocId === doc.id) return
    fdoc.getElementById('rex-floatbar')?.remove()
    const bar = fdoc.createElement('div')
    bar.id = 'rex-floatbar'
    bar.style.left = `${Math.max(90, Math.min(x, (fdoc.defaultView?.innerWidth ?? 800) - 90))}px`
    bar.style.top = `${Math.max(4, y - 8)}px`
    for (const b of FLOAT_BTNS) {
      const btn = fdoc.createElement('button')
      btn.textContent = b.label
      if (b.primary) btn.className = 'p'
      btn.addEventListener('click', () => {
        window.parent.dispatchEvent(new CustomEvent('rex-iframe-action', { detail: { type: b.t } }))
        bar.remove()
      })
      bar.appendChild(btn)
    }
    fdoc.body.appendChild(bar)
  }, [doc.id])

  /** iframe 高度自适应内容（图片等异步资源加载后再同步） */
  const syncHeight = useCallback((): void => {
    const frame = frameRef.current
    const fdoc = frame?.contentDocument
    if (!frame || !fdoc) return
    const h = Math.max(fdoc.documentElement.scrollHeight, fdoc.body?.scrollHeight ?? 0)
    frame.style.height = `${Math.min(Math.max(h + 4, 240), 60000)}px`
  }, [])

  /** iframe 加载完成：注入样式 + 拦截导航 + 划词监听 + 高度自适应 */
  const onFrameLoad = useCallback((): void => {
    const fdoc = frameRef.current?.contentDocument
    if (!fdoc || !fdoc.body) return

    // 基础样式（紫点/悬浮条/闪烁）
    if (!fdoc.getElementById('rex-inject-style')) {
      const st = fdoc.createElement('style')
      st.id = 'rex-inject-style'
      st.textContent = INJECT_CSS
      fdoc.head.appendChild(st)
    }

    // 拦截链接导航（快照浏览，不跳转）
    fdoc.addEventListener(
      'click',
      (e) => {
        const t = e.target as HTMLElement | null
        if (t?.closest?.('a')) e.preventDefault()
      },
      true
    )

    // 划词 → 悬浮条
    fdoc.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = fdoc.getSelection()
        const bar = fdoc.getElementById('rex-floatbar')
        if (!sel || sel.isCollapsed || useAppStore.getState().editingDocId === doc.id) {
          bar?.remove()
          return
        }
        const text = sel.toString().replace(/\s+/g, ' ').trim()
        if (text.length < 2 || text.length > 2000) {
          bar?.remove()
          return
        }
        const range = sel.getRangeAt(0)
        const node = range.commonAncestorContainer
        const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement
        const blkEl = el?.closest('[data-blk]') ?? null
        const blkKey = blkEl?.getAttribute('data-blk') ?? null
        // 计算划选内容在块内文本的字符偏移（精确锚点；blockTextOffset 基于 blk.ownerDocument，iframe 内同样可用）
        let rangeStart: number | undefined
        let rangeEnd: number | undefined
        if (blkEl) {
          const s = blockTextOffset(blkEl, range.startContainer, range.startOffset)
          const e = s != null ? blockTextOffset(blkEl, range.endContainer, range.endOffset) : null
          if (s != null && e != null && e > s) {
            rangeStart = s
            rangeEnd = e
          }
        }
        useAppStore
          .getState()
          .setSelection({ docId: doc.id, snapshot: text, blkKey, pageIndex: 0, rangeStart, rangeEnd })
        const rect = range.getBoundingClientRect()
        showFloatbar(fdoc, rect.left + rect.width / 2, rect.top)
      }, 10)
    })

    // 高度自适应：初次 + 监听内容尺寸变化
    syncHeight()
    try {
      const ro = new ResizeObserver(() => syncHeight())
      ro.observe(fdoc.body)
      ro.observe(fdoc.documentElement)
    } catch {
      /* ResizeObserver 不可用时退化为定时同步 */
      let n = 0
      const timer = setInterval(() => {
        syncHeight()
        if (++n > 20) clearInterval(timer)
      }, 500)
    }

    setReady(true)
  }, [doc.id, showFloatbar, syncHeight])

  /* 锚点紫点注入（anchors 变化时重注入）：有效偏移（存储 or 快照定位）定位到划选文字处 */
  useEffect(() => {
    if (!ready) return
    const fdoc = frameRef.current?.contentDocument
    if (!fdoc?.body) return
    fdoc.querySelectorAll('.rex-dot').forEach((d) => d.remove())
    for (const a of anchors) {
      if (!a.blkKey) continue
      const host = fdoc.querySelector(`[data-blk="${a.blkKey}"]`)
      if (!host) continue
      const off = anchorOffsets(host, a)
      const dot = fdoc.createElement('span')
      dot.className = `rex-dot${off ? ' precise' : ''}`
      dot.textContent = '●'
      if (off) {
        const p = measureAnchorDot(host, off.start, off.end)
        if (p) {
          dot.style.left = `${p.left}px`
          dot.style.top = `${p.top - 5}px`
        }
        // 悬浮预览：hover 紫点 → 划选内容即时浅紫底纹（iframe 文档内注册）
        const enter = (): void => {
          const r = rangeFromOffsets(host, off.start, off.end)
          if (!r) return
          const win = host.ownerDocument.defaultView as unknown as {
            Highlight?: new (...rs: AbstractRange[]) => AbstractRange
            CSS?: { highlights?: { set(k: string, v: unknown): unknown } }
          } | null
          if (!win?.Highlight || !win.CSS?.highlights) return
          win.CSS.highlights.set('rex-anchor-hover', new win.Highlight(r))
        }
        const leave = (): void => {
          const win = host.ownerDocument.defaultView as unknown as {
            CSS?: { highlights?: { delete(k: string): boolean } }
          } | null
          win?.CSS?.highlights?.delete('rex-anchor-hover')
        }
        dot.addEventListener('mouseenter', enter)
        dot.addEventListener('mouseleave', leave)
      }
      dot.title = `查看此处的提问：${a.snapshot.slice(0, 40)}${a.snapshot.length > 40 ? '…' : ''}`
      dot.addEventListener('click', (e) => {
        e.stopPropagation()
        // 有效偏移：只闪烁划选内容（iframe 文档内注册 Highlight）
        if (off && flashAnchorRange(fdoc, a.blkKey!, off.start, off.end)) {
          onBlockAnchorClick(a.sessionId ?? a.qaId, a.blkKey!, a.id)
          return
        }
        host.classList.remove('rex-flash')
        void (host as HTMLElement).offsetWidth
        host.classList.add('rex-flash')
        onBlockAnchorClick(a.sessionId ?? a.qaId, a.blkKey!, a.id)
      })
      host.appendChild(dot)
    }
  }, [ready, anchors, onBlockAnchorClick])

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (!srcdoc) return <div className="sheet-loading">HTML 解析中…</div>

  return (
    <div className="html-frame-sheet page-sheet">
      <div className="sheet-title">{doc.name}</div>
      <div className="sheet-sub">
        网页快照 · 真实还原渲染{blockCount > 0 ? ` · ${blockCount} 个内容块` : ''}
      </div>
      <iframe
        ref={frameRef}
        className="html-frame"
        sandbox="allow-same-origin"
        srcDoc={srcdoc}
        onLoad={onFrameLoad}
        title={doc.name}
      />
    </div>
  )
}
