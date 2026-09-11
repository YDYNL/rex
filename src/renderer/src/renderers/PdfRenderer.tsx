import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { RendererProps } from './registry'
import { anchorTarget } from './anchor'
import { anchorOffsets, measureAnchorDot, rangeFromOffsets } from '../lib/anchorRange'
import { useAppStore } from '../stores/appStore'
import type { Anchor } from '../types'

// 配置 pdf.js worker（electron-vite/vite 以 ?url 引入本地 worker 资源）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>

/**
 * PDF 渲染器（性能优化版）：
 * - 首屏即显：先搭每页尺寸骨架（getPage 轻量），视口内的页立即渲染，不等全量文本抽取
 * - 视口懒渲染：IntersectionObserver 只渲染可视区前后约一屏的页面，大文件滚动流畅
 * - 后台全文抽取：文本抽取不阻塞渲染，与页面渲染共享 TextContent 缓存（不重复抽取）
 * - 单页容错：某页抽取/渲染失败仅该页占位，不中断整体
 */
export default function PdfRenderer({ doc, zoom, onBlockAnchorClick }: RendererProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string>('')
  /** 已渲染页数（驱动锚点紫点同步） */
  const [renderedPages, setRenderedPages] = useState(0)
  const hostRef = useRef<HTMLDivElement>(null)
  /** TextContent 缓存（跨 zoom 复用：文本内容与缩放无关），pdf 切换时重置 */
  const tcCacheRef = useRef(new Map<number, TextContent | null>())
  /** 全文抽取完成标记（避免 zoom 重建时重复抽取） */
  const extractedRef = useRef(false)
  const anchors = useAppStore((s) => s.anchors[doc.id] ?? [])
  const setDocContent = useAppStore((s) => s.setDocContent)
  const setDocError = useAppStore((s) => s.setDocError)

  // 加载文档
  useEffect(() => {
    let alive = true
    setPdf(null)
    setError('')
    setRenderedPages(0)
    tcCacheRef.current = new Map()
    extractedRef.current = false
    void window.rex.file.readBuffer(doc.path).then(async (r) => {
      if (!alive) return
      if (!r.ok) {
        setDocError(doc.id)
        setError(r.error)
        return
      }
      try {
        const task = pdfjsLib.getDocument({ data: r.data })
        const docProxy = await task.promise
        if (alive) setPdf(docProxy)
      } catch (e) {
        if (alive) {
          setDocError(doc.id)
          setError(`PDF 解析失败：${String(e)}`)
        }
      }
    })
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, doc.version, setDocError])

  // 渲染管线：骨架 + 视口懒渲染 + 后台全文抽取
  useEffect(() => {
    if (!pdf || !hostRef.current) return
    let cancelled = false
    const host = hostRef.current
    host.innerHTML = ''
    setRenderedPages(0)

    const scale = (zoom / 100) * 1.35 // 基准缩放系数
    const sheets: HTMLDivElement[] = []

    /** 取某页文本（优先缓存；渲染层与后台抽取共享，不重复抽取） */
    const getTextContent = async (pageNum: number): Promise<TextContent | null> => {
      const cached = tcCacheRef.current.get(pageNum)
      if (cached !== undefined) return cached
      try {
        const page = await pdf.getPage(pageNum)
        const tc = await page.getTextContent()
        tcCacheRef.current.set(pageNum, tc)
        return tc
      } catch {
        tcCacheRef.current.set(pageNum, null)
        return null
      }
    }

    /** 渲染单页：Canvas + 对齐文本层 */
    const renderPage = async (pageNum: number): Promise<void> => {
      const sheet = sheets[pageNum - 1]
      if (!sheet || sheet.dataset.rendered === '1' || cancelled) return
      sheet.dataset.rendered = '1'
      try {
        const page = await pdf.getPage(pageNum)
        const dpr = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale })

        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('无法创建画布')
        await page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
        }).promise

        const textContent = await getTextContent(pageNum)
        const textLayer = document.createElement('div')
        textLayer.className = 'pdf-text-layer'
        // 关键：pdf.js TextLayer 的 span 字号/定位按 var(--scale-factor) 计算，
        // 必须在容器注入当前缩放，否则字号回退继承值导致划词错位
        textLayer.style.setProperty('--scale-factor', String(viewport.scale))
        if (textContent) {
          try {
            const tl = new pdfjsLib.TextLayer({
              textContentSource: textContent,
              container: textLayer,
              viewport
            })
            await tl.render()
          } catch {
            // 兜底：按坐标手工摆 span（极少触发）
            for (const item of textContent.items as {
              str: string
              transform: number[]
              width: number
              height: number
            }[]) {
              if (!('str' in item) || !item.str) continue
              const span = document.createElement('span')
              const tx = item.transform
              span.textContent = item.str
              span.style.position = 'absolute'
              span.style.left = `${tx[4] * viewport.scale}px`
              span.style.top = `${(tx[5] - item.height) * viewport.scale}px`
              span.style.fontSize = `${item.height * viewport.scale}px`
              textLayer.appendChild(span)
            }
          }
        }

        if (cancelled) return
        sheet.appendChild(canvas)
        sheet.appendChild(textLayer)
        setRenderedPages((n) => n + 1)
      } catch {
        /* 单页渲染失败：占位提示，不中断其他页 */
        sheet.dataset.rendered = '2'
        const tip = document.createElement('div')
        tip.className = 'pdf-page-fallback'
        tip.textContent = '此页渲染失败'
        sheet.appendChild(tip)
      }
    }

    /** 后台全文抽取（AI 全文上下文；不阻塞渲染，单页失败不中断） */
    const extractAllText = async (): Promise<void> => {
      if (extractedRef.current) return
      const parts: string[] = []
      for (let p = 1; p <= pdf.numPages; p++) {
        if (cancelled) return
        const tc = await getTextContent(p)
        parts.push(
          tc ? (tc.items as { str?: string }[]).map((it) => it.str ?? '').join(' ') : ''
        )
      }
      if (cancelled) return
      extractedRef.current = true
      setDocContent(doc.id, parts.join('\n\n'))
    }

    void (async () => {
      /* ── 阶段一：搭骨架（每页取视口尺寸，轻量），首屏即显 ── */
      for (let p = 1; p <= pdf.numPages; p++) {
        if (cancelled) return
        try {
          const page = await pdf.getPage(p)
          const vp = page.getViewport({ scale })
          const sheet = document.createElement('div')
          sheet.className = 'pdf-page'
          sheet.dataset.blk = `page-${p - 1}`
          sheet.dataset.page = String(p)
          sheet.dataset.rendered = '0'
          sheet.style.width = `${Math.floor(vp.width)}px`
          sheet.style.height = `${Math.floor(vp.height)}px`
          host.appendChild(sheet)
          sheets.push(sheet)

          const num = document.createElement('div')
          num.className = 'page-num'
          num.textContent = `— ${p} / ${pdf.numPages} —`
          host.appendChild(num)
        } catch {
          /* 单页骨架失败：跳过 */
        }
      }
      if (cancelled || sheets.length === 0) return

      /* ── 阶段二：视口懒渲染（前后各约一屏） ── */
      const io = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (en.isIntersecting) void renderPage(Number((en.target as HTMLElement).dataset.page))
          }
        },
        { root: host.closest('.doc-scroll'), rootMargin: '120% 0px' }
      )
      sheets.forEach((s) => io.observe(s))

      /* ── 阶段三：后台全文抽取（与渲染并行） ── */
      void extractAllText()
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, zoom])

  /** 锚点紫点同步：anchors 变化 / 新页渲染完成时注入（与渲染管线解耦）。
   *  有效偏移（存储 or 快照定位）定位到划选文字首字上方；无法定位回退页角 */
  useEffect(() => {
    if (!pdf || renderedPages === 0) return
    const host = hostRef.current
    if (!host) return
    host.querySelectorAll('.anchor-dot').forEach((d) => d.remove())
    const byPage = new Map<string, Anchor[]>()
    for (const a of anchors) {
      const list = byPage.get(a.blkKey) ?? []
      list.push(a)
      byPage.set(a.blkKey, list)
    }
    for (const [blk, list] of byPage) {
      const sheet = host.querySelector(`[data-blk="${blk}"]`) as HTMLElement | null
      if (!sheet || sheet.dataset.rendered === '0') continue
      const resolved = list.map((a) => ({ a, off: anchorOffsets(sheet, a) }))
      const unlocated = resolved.filter((x) => !x.off)
      let cornerShown = false
      for (const { a, off } of resolved) {
        if (!off) {
          if (cornerShown) continue
          cornerShown = true
        }
        const dot = document.createElement('span')
        dot.className = `anchor-dot${off ? ' precise' : ''}`
        if (off) {
          const p = measureAnchorDot(sheet, off.start, off.end)
          if (p) {
            dot.style.left = `${p.left}px`
            dot.style.top = `${p.top - 5}px`
          }
          // 悬浮预览：hover 紫点 → 划选内容即时浅紫底纹
          const enter = (): void => {
            const r = rangeFromOffsets(sheet, off.start, off.end)
            if (!r) return
            const win = sheet.ownerDocument.defaultView as unknown as {
              Highlight?: new (...rs: AbstractRange[]) => AbstractRange
              CSS?: { highlights?: { set(k: string, v: unknown): unknown } }
            } | null
            if (!win?.Highlight || !win.CSS?.highlights) return
            win.CSS.highlights.set('rex-anchor-hover', new win.Highlight(r))
          }
          const leave = (): void => {
            const win = sheet.ownerDocument.defaultView as unknown as {
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
          onBlockAnchorClick(anchorTarget(a), blk, a.id)
        })
        if (!off && unlocated.length > 1) {
          const cnt = document.createElement('i')
          cnt.className = 'anchor-count'
          cnt.textContent = String(unlocated.length)
          dot.appendChild(cnt)
        }
        sheet.appendChild(dot)
      }
    }
  }, [anchors, pdf, renderedPages, onBlockAnchorClick])

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (!pdf) return <div className="sheet-loading">PDF 加载中…</div>

  return (
    <div className="pdf-host">
      <div ref={hostRef} />
    </div>
  )
}
