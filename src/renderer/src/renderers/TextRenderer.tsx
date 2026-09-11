import { useEffect, useState } from 'react'
import type { RendererProps } from './registry'
import { AnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

/** 预览截断阈值：超过则只渲染前 50 万字符（AI 分析仍用全文） */
const MAX_PREVIEW = 500_000

/** 纯文本渲染器：txt/log/csv 等，按段落块打锚点 */
export default function TextRenderer({ doc, onBlockAnchorClick }: RendererProps) {
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

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (content === '') return <div className="sheet-loading">加载中…</div>

  const blocks = content.split(/\n\s*\n/)

  return (
    <div className="page-sheet">
      <div className="sheet-title">{doc.name}</div>
      <div className="sheet-sub">纯文本 · {totalLen.toLocaleString()} 字符</div>
      {totalLen > MAX_PREVIEW && (
        <div className="truncate-banner">
          内容较大（{totalLen.toLocaleString()} 字符），预览已截断至前 50 万字符 · AI 分析仍基于全文
        </div>
      )}
      {blocks.map((blk, i) => {
        const list = byBlk[String(i)]
        return (
          <div key={i} className="txt-blk" data-blk={String(i)}>
            {list && list.length > 0 && (
              <AnchorDots list={list} blkKey={String(i)} onBlockAnchorClick={onBlockAnchorClick} />
            )}
            <div className="txt-para">{blk}</div>
          </div>
        )
      })}
    </div>
  )
}
