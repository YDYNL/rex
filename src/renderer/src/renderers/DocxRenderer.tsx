import { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import type { RendererProps } from './registry'
import { attachAnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

/** DOCX 渲染器：docx-preview 高保真排版，段落级锚点块 */
export default function DocxRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const byBlk = useAnchorsByBlk(doc.id)
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    setError('')
    setReady(false)
    void window.rex.file.readBuffer(doc.path).then(async (r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      const host = hostRef.current
      if (!host) return
      try {
        host.innerHTML = ''
        await renderAsync(r.data, host, undefined, {
          inWrapper: false,
          ignoreWidth: false,
          ignoreHeight: false
        })
        // 段落级锚点块：为渲染出的段落/标题/表格标记稳定 blkKey
        const paras = host.querySelectorAll('p, h1, h2, h3, h4, h5, h6, table, li')
        paras.forEach((el, i) => el.setAttribute('data-blk', `p${i}`))
        attachAnchorDots(host, byBlk, onBlockAnchorClick)
        setDocContent(doc.id, (host.innerText ?? '').slice(0, 400000))
        if (alive) setReady(true)
      } catch (e) {
        if (alive) setError(`DOCX 解析失败：${String(e)}`)
      }
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, doc.id, setDocContent])

  // 锚点变化时重挂紫点（不重渲染文档）
  useEffect(() => {
    if (ready && hostRef.current) {
      attachAnchorDots(hostRef.current, byBlk, onBlockAnchorClick)
    }
  }, [byBlk, ready, onBlockAnchorClick])

  if (error) return <div className="sheet-error">⚠️ {error}</div>

  return (
    <div className="docx-sheet">
      {!ready && <div className="sheet-loading">DOCX 渲染中…</div>}
      <div ref={hostRef} className="docx-host" />
    </div>
  )
}
