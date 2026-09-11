import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import type { RendererProps } from './registry'
import { AnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

interface ZipEntry {
  name: string
  dir: boolean
  size: number
}

/** 判定文本类条目（供点击预览） */
const TEXT_EXT = new Set([
  'txt', 'md', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'py', 'java', 'c', 'cpp',
  'h', 'sh', 'bat', 'ps1', 'yml', 'yaml', 'toml', 'ini', 'csv', 'tsv', 'log', 'srt', 'vtt'
])

/** 解析 tar 头（512 字节块：name@0 size@124(octal) typeflag@156） */
function parseTar(buf: ArrayBuffer): ZipEntry[] {
  const out: ZipEntry[] = []
  const view = new DataView(buf)
  let off = 0
  while (off + 512 <= buf.byteLength) {
    let name = ''
    for (let i = off; i < off + 100 && view.getUint8(i) !== 0; i++) {
      name += String.fromCharCode(view.getUint8(i))
    }
    if (!name) break
    let size = 0
    for (let i = off + 124; i < off + 136; i++) {
      const c = view.getUint8(i)
      if (c === 0 || c === 32) continue
      size = size * 8 + (c - 48)
    }
    const type = String.fromCharCode(view.getUint8(off + 156) || 48)
    out.push({ name, dir: type === '5', size })
    off += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

/** 压缩包渲染器：zip/cbz/kmz/tar 列表浏览 + 文本条目内联预览 */
export default function ArchiveRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const [entries, setEntries] = useState<ZipEntry[]>([])
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null)
  const [error, setError] = useState('')
  const zipRef = useRef<JSZip | null>(null)
  const byBlk = useAnchorsByBlk(doc.id)
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    setEntries([])
    setPreview(null)
    setError('')
    zipRef.current = null
    const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''

    void window.rex.file.readBuffer(doc.path).then(async (r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      try {
        if (ext === 'tar') {
          const list = parseTar(r.data)
          setEntries(list)
          setDocContent(
            doc.id,
            `[压缩包] ${doc.name}（tar），${list.length} 个条目：\n${list.map((e) => e.name).join('\n')}`.slice(0, 100000)
          )
        } else {
          const zip = await JSZip.loadAsync(r.data)
          if (!alive) return
          zipRef.current = zip
          const list: ZipEntry[] = []
          zip.forEach((path, file) => {
            const meta = (file as unknown as { _data?: { uncompressedSize?: number } })._data
            list.push({ name: path, dir: file.dir, size: meta?.uncompressedSize ?? 0 })
          })
          list.sort((a, b) => a.name.localeCompare(b.name))
          setEntries(list)
          setDocContent(
            doc.id,
            `[压缩包] ${doc.name}（zip），${list.length} 个条目：\n${list.map((e) => e.name).join('\n')}`.slice(0, 100000)
          )
        }
      } catch (e) {
        setError(`压缩包解析失败：${String(e)}`)
      }
    })
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, doc.name, setDocContent])

  const openEntry = (e: ZipEntry): void => {
    if (e.dir) return
    const ext = e.name.split('.').pop()?.toLowerCase() ?? ''
    if (!TEXT_EXT.has(ext)) {
      setPreview({ name: e.name, text: `（二进制条目，暂不支持内联预览：${e.name}）` })
      return
    }
    const file = zipRef.current?.file(e.name)
    if (!file) {
      setPreview({ name: e.name, text: '（tar 条目暂不支持内联预览）' })
      return
    }
    void file.async('string').then((text) => {
      setPreview({ name: e.name, text: text.slice(0, 100000) })
    })
  }

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (entries.length === 0) return <div className="sheet-loading">压缩包解析中…</div>

  return (
    <div className="page-sheet archive-view">
      <div className="sheet-title">{doc.name}</div>
      <div className="sheet-sub">压缩包 · {entries.length} 个条目 · 点击文本条目可预览</div>
      <div className="table-scroll">
        <table className="grid-table archive-table">
          <tbody>
          {entries.slice(0, 2000).map((e, i) => {
            const list = byBlk[`e${i}`]
            return (
              <tr key={e.name} data-blk={`e${i}`} onClick={() => openEntry(e)}>
                <td className="grid-idx">
                  {list && list.length > 0 ? (
                    <AnchorDots list={list} blkKey={`e${i}`} onBlockAnchorClick={onBlockAnchorClick} />
                  ) : (
                    i + 1
                  )}
                </td>
                <td className="archive-name">
                  {e.dir ? '📁' : '📄'} {e.name}
                </td>
                <td className="archive-size">{e.dir ? '—' : `${(e.size / 1024).toFixed(1)} KB`}</td>
              </tr>
            )
          })}
          </tbody>
        </table>
      </div>
      {entries.length > 2000 && <div className="sheet-sub">仅展示前 2000 个条目</div>}
      {preview && (
        <div className="archive-preview">
          <div className="sheet-sub">📄 {preview.name}</div>
          <pre className="archive-pre">{preview.text}</pre>
        </div>
      )}
    </div>
  )
}
