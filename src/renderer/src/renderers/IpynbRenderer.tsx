import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js'
import type { RendererProps } from './registry'
import { AnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

interface NbCell {
  cell_type: string
  source: string[] | string
  outputs?: {
    output_type: string
    text?: string[] | string
    data?: Record<string, string[] | string>
  }[]
}

function srcText(src: string[] | string | undefined): string {
  if (!src) return ''
  return Array.isArray(src) ? src.join('') : src
}

/** Notebook 渲染器：ipynb 逐单元格还原（Markdown/代码/输出/图片） */
export default function IpynbRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const [cells, setCells] = useState<NbCell[]>([])
  const [error, setError] = useState('')
  const byBlk = useAnchorsByBlk(doc.id)
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    setCells([])
    setError('')
    void window.rex.file.readText(doc.path).then((r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      try {
        const nb = JSON.parse(r.content) as { cells?: NbCell[] }
        const list = Array.isArray(nb.cells) ? nb.cells : []
        setCells(list)
        const text = list
          .map((c, i) => {
            const src = srcText(c.source)
            return c.cell_type === 'markdown' ? src : `[代码 ${i}]\n${src}`
          })
          .join('\n\n')
        setDocContent(doc.id, text.slice(0, 400000))
      } catch (e) {
        setError(`Notebook 解析失败：${String(e)}`)
      }
    })
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, setDocContent])

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (cells.length === 0) return <div className="sheet-loading">Notebook 解析中…</div>

  return (
    <div className="page-sheet ipynb-sheet">
      <div className="sheet-title">{doc.name}</div>
      <div className="sheet-sub">Jupyter Notebook · {cells.length} 个单元格</div>
      {cells.map((c, i) => {
        const list = byBlk[`c${i}`]
        const src = srcText(c.source)
        return (
          <div key={i} className={`ipynb-cell ipynb-${c.cell_type}`} data-blk={`c${i}`}>
            {list && list.length > 0 && (
              <AnchorDots list={list} blkKey={`c${i}`} onBlockAnchorClick={onBlockAnchorClick} />
            )}
            {c.cell_type === 'markdown' ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{src}</ReactMarkdown>
            ) : c.cell_type === 'code' ? (
              <>
                <div className="ipynb-tag">In [{i}]</div>
                <pre className="ipynb-code">
                  <code
                    dangerouslySetInnerHTML={{
                      __html: hljs.highlight(src, { language: 'python', ignoreIllegals: true }).value
                    }}
                  />
                </pre>
                {(c.outputs ?? []).map((o, oi) => {
                  const png = o.data?.['image/png']
                  if (png) {
                    const b64 = srcText(png)
                    return (
                      <img
                        key={oi}
                        className="ipynb-img"
                        src={`data:image/png;base64,${b64}`}
                        alt={`输出图 ${oi + 1}`}
                      />
                    )
                  }
                  const txt = srcText(o.text ?? o.data?.['text/plain'])
                  if (!txt) return null
                  return (
                    <pre key={oi} className="ipynb-out">
                      <code>{txt}</code>
                    </pre>
                  )
                })}
              </>
            ) : (
              <pre className="ipynb-raw">{src}</pre>
            )}
          </div>
        )
      })}
    </div>
  )
}
