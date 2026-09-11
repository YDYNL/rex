import { useEffect, useRef, useState } from 'react'
import ePub from 'epubjs'
import type { Book, Rendition } from 'epubjs'
import type { RendererProps } from './registry'
import { useAppStore } from '../stores/appStore'

/** EPUB 渲染器：epub.js 真实排版翻页阅读 + 全文抽取供 AI 引用 */
export default function EpubRenderer({ doc }: RendererProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    let book: Book | null = null
    setError('')
    setReady(false)

    void window.rex.file.readBuffer(doc.path).then(async (r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      try {
        const host = hostRef.current
        if (!host) return
        book = ePub(r.data as unknown as ArrayBuffer)
        const rendition = book.renderTo(host, {
          width: '100%',
          height: '100%',
          spread: 'none'
        })
        renditionRef.current = rendition
        await rendition.display()

        /* 全文抽取：逐 spine 章节提取纯文本（AI 上下文） */
        const sections: unknown[] = []
        ;(book.spine as unknown as { each: (cb: (s: unknown) => void) => void }).each((s) =>
          sections.push(s)
        )
        const texts: string[] = []
        for (const raw of sections) {
          const sec = raw as {
            load: (fn: unknown) => Promise<Document>
            unload?: () => void
          }
          try {
            const d = await sec.load(book?.load.bind(book))
            const t = (d.body?.textContent ?? '').replace(/\s+\n/g, '\n').trim()
            if (t) texts.push(t)
            sec.unload?.()
          } catch {
            /* 单章失败跳过 */
          }
        }
        if (alive) {
          setDocContent(doc.id, texts.join('\n\n').slice(0, 400000))
          setReady(true)
        }
      } catch (e) {
        if (alive) setError(`EPUB 解析失败：${String(e)}`)
      }
    })

    return () => {
      alive = false
      try {
        renditionRef.current?.destroy()
      } catch {
        /* ignore */
      }
      renditionRef.current = null
    }
  }, [doc.path, doc.id, setDocContent])

  if (error) return <div className="sheet-error">⚠️ {error}</div>

  return (
    <div className="epub-view">
      <div className="epub-toolbar">
        <button
          className="epub-nav"
          onClick={() => void renditionRef.current?.prev()}
          title="上一页"
        >
          ‹ 上一页
        </button>
        <span className="sheet-sub" style={{ flex: 1, textAlign: 'center' }}>
          📗 {doc.name}
        </span>
        <button
          className="epub-nav"
          onClick={() => void renditionRef.current?.next()}
          title="下一页"
        >
          下一页 ›
        </button>
      </div>
      <div className="epub-host" ref={hostRef} />
      {!ready && <div className="sheet-loading">EPUB 全文抽取中（页面已可翻阅）…</div>}
    </div>
  )
}
