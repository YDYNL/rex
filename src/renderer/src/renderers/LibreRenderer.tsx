import { useEffect, useState } from 'react'
import type { RendererProps } from './registry'
import PdfRenderer from './PdfRenderer'
import { useAppStore } from '../stores/appStore'

/** LibreOffice 转档渲染器：doc/ppt/xls/pptx/rtf/odt/ods/odp 等 → PDF 高保真预览 */
export default function LibreRenderer({ doc, zoom, onBlockAnchorClick }: RendererProps) {
  const [pdfPath, setPdfPath] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [converting, setConverting] = useState(true)
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    setPdfPath(null)
    setError('')
    setConverting(true)
    void window.rex.office.convertToPdf(doc.path).then((r) => {
      if (!alive) return
      setConverting(false)
      if (r.ok) {
        setPdfPath(r.pdfPath)
      } else {
        setError(r.error)
        // 解析态收尾：失败也标记 ready，避免文件卡片转圈
        setDocContent(doc.id, `[格式转档失败] ${r.error}`)
      }
    })
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, setDocContent])

  if (converting) {
    return (
      <div className="sheet-loading">
        <div style={{ marginBottom: 10 }}>⚙️ 正在通过 LibreOffice 转换为 PDF 预览…</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>首次转换需要一些时间，转换结果会缓存</div>
      </div>
    )
  }
  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (pdfPath) {
    return (
      <PdfRenderer doc={{ ...doc, path: pdfPath }} zoom={zoom} onBlockAnchorClick={onBlockAnchorClick} />
    )
  }
  return null
}
