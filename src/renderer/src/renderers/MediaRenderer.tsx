import { useEffect, useState } from 'react'
import type { RendererProps } from './registry'
import { useAppStore } from '../stores/appStore'

/** 扩展名 → MIME */
const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime'
}

/** 音视频渲染器：本地 objectURL 播放（媒体内容不出本机） */
export default function MediaRenderer({ doc }: RendererProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const setDocContent = useAppStore((s) => s.setDocContent)

  const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''
  const isVideo = ['mp4', 'webm', 'mov'].includes(ext)

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    setUrl(null)
    setError('')
    void window.rex.file.readBuffer(doc.path).then((r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        setDocContent(doc.id, `[媒体文件] ${doc.name}（读取失败）`)
        return
      }
      objectUrl = URL.createObjectURL(new Blob([r.data], { type: MIME[ext] ?? 'application/octet-stream' }))
      setUrl(objectUrl)
      setDocContent(
        doc.id,
        `[${isVideo ? '视频' : '音频'}文件] ${doc.name}，大小 ${(r.data.byteLength / 1024 / 1024).toFixed(2)} MB。（音视频内容暂无法提取文字，可就文件名与元信息提问）`
      )
    })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, doc.name])

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (!url) return <div className="sheet-loading">媒体加载中…</div>

  return (
    <div className="media-view" data-blk="media">
      {isVideo ? (
        <video src={url} controls className="media-player" />
      ) : (
        <audio src={url} controls className="media-audio" />
      )}
      <div className="sheet-sub">
        {isVideo ? '🎬 视频' : '🎵 音频'} · {doc.name} · 本地播放，不上传
      </div>
    </div>
  )
}
