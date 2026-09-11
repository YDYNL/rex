import { useEffect, useState } from 'react'
import type { RendererProps } from './registry'
import { useAppStore } from '../stores/appStore'

/** 扩展名 → MIME */
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp'
}

/** 图片渲染器：objectURL 高保真展示 + 缩放 */
export default function ImageRenderer({ doc, zoom }: RendererProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    setUrl(null)
    setError('')
    setSize(null)
    const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''
    void window.rex.file.readBuffer(doc.path).then((r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      objectUrl = URL.createObjectURL(new Blob([r.data], { type: MIME[ext] ?? 'image/png' }))
      setUrl(objectUrl)
    })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [doc.path, doc.name])

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (!url) return <div className="sheet-loading">图片加载中…</div>

  return (
    <div className="img-view" data-blk="img">
      <img
        src={url}
        alt={doc.name}
        style={{ width: `${Math.min(1600, zoom * 8)}px`, maxWidth: '100%' }}
        onLoad={(e) => {
          const el = e.currentTarget
          const w = el.naturalWidth
          const h = el.naturalHeight
          setSize({ w, h })
          setDocContent(doc.id, `[图片文件] ${doc.name}，原始分辨率 ${w}×${h} 像素。（图片内容需视觉模型支持，暂以元信息提供）`)
        }}
      />
      {size && (
        <div className="sheet-sub">
          {doc.name} · {size.w}×{size.h} px
        </div>
      )}
    </div>
  )
}
