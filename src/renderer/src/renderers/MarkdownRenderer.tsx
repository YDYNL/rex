import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'
import type { RendererProps } from './registry'
import { AnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

/** 预览截断阈值：超过则只渲染前 50 万字符（AI 分析仍用全文） */
const MAX_PREVIEW = 500_000

/** Markdown 渲染器：react-markdown 真实解析，逐块打锚点标记 */
export default function MarkdownRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const [content, setContent] = useState<string>('')
  const [totalLen, setTotalLen] = useState(0)
  const [error, setError] = useState<string>('')
  const byBlk = useAnchorsByBlk(doc.id)
  const setDocContent = useAppStore((s) => s.setDocContent)
  const setDocError = useAppStore((s) => s.setDocError)

  useEffect(() => {
    let alive = true
    setContent('')
    setError('')
    void window.rex.file.readText(doc.path).then((r) => {
      if (!alive) return
      if (r.ok) {
        setTotalLen(r.content.length)
        setContent(r.content.length > MAX_PREVIEW ? r.content.slice(0, MAX_PREVIEW) : r.content)
        setDocContent(doc.id, r.content)
      } else {
        setDocError(doc.id)
        setError(r.error)
      }
    })
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, doc.version, setDocContent, setDocError])

  const blocks = useMemo(() => content.split(/\n\s*\n/), [content])

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (content === '') return <div className="sheet-loading">加载中…</div>

  return (
    <div className="md-sheet">
      {totalLen > MAX_PREVIEW && (
        <div className="truncate-banner">
          内容较大（{totalLen.toLocaleString()} 字符），预览已截断至前 50 万字符 · AI 分析仍基于全文
        </div>
      )}
      {blocks.map((blk, i) => {
        const list = byBlk[String(i)]
        return (
          <div key={i} className="md-blk" data-blk={String(i)}>
            {list && list.length > 0 && (
              <AnchorDots list={list} blkKey={String(i)} onBlockAnchorClick={onBlockAnchorClick} />
            )}
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {blk}
            </ReactMarkdown>
          </div>
        )
      })}
    </div>
  )
}
