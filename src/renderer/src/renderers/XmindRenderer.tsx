import { useEffect, useState } from 'react'
import JSZip from 'jszip'
import type { RendererProps } from './registry'
import { AnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

interface Topic {
  title: string
  children?: { attached?: Topic[] }
}

/** 递归思维导图大纲节点 */
function MindNode({ topic, depth, path, byBlk, onBlockAnchorClick }: {
  topic: Topic
  depth: number
  path: string
  byBlk: Record<string, ReturnType<typeof useAnchorsByBlk>[string]>
  onBlockAnchorClick: RendererProps['onBlockAnchorClick']
}) {
  const list = byBlk[path]
  const kids = topic.children?.attached ?? []
  return (
    <div className="mind-node" data-blk={path}>
      {list && list.length > 0 && (
        <AnchorDots list={list} blkKey={path} onBlockAnchorClick={onBlockAnchorClick} />
      )}
      <div className="mind-title" style={{ paddingLeft: depth * 18 }}>
        {depth > 0 && <span className="mind-branch">└</span>}
        {topic.title || '（空主题）'}
      </div>
      {kids.map((k, i) => (
        <MindNode
          key={i}
          topic={k}
          depth={depth + 1}
          path={`${path}.${i}`}
          byBlk={byBlk}
          onBlockAnchorClick={onBlockAnchorClick}
        />
      ))}
    </div>
  )
}

/** XMind 渲染器：解包 content.json，还原主题大纲树 */
export default function XmindRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const [root, setRoot] = useState<Topic | null>(null)
  const [error, setError] = useState('')
  const byBlk = useAnchorsByBlk(doc.id)
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    setRoot(null)
    setError('')
    void window.rex.file.readBuffer(doc.path).then(async (r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      try {
        const zip = await JSZip.loadAsync(r.data)
        const jsonFile = zip.file('content.json')
        if (jsonFile) {
          const raw = JSON.parse(await jsonFile.async('string')) as { rootTopic?: Topic }[]
          const topic = (Array.isArray(raw) ? raw[0] : raw)?.rootTopic
          if (!topic) throw new Error('未找到 rootTopic')
          setRoot(topic)
          const outline: string[] = []
          const walk = (t: Topic, d: number): void => {
            outline.push(`${'  '.repeat(d)}- ${t.title ?? ''}`)
            for (const k of t.children?.attached ?? []) walk(k, d + 1)
          }
          walk(topic, 0)
          setDocContent(doc.id, `[XMind 思维导图] ${doc.name}\n${outline.join('\n')}`.slice(0, 400000))
        } else {
          // 旧版 XMind：content.xml 文本兜底
          const xmlFile = zip.file('content.xml')
          if (!xmlFile) throw new Error('非有效 XMind 文件（缺少 content.json / content.xml）')
          const xml = await xmlFile.async('string')
          const titles = Array.from(xml.matchAll(/<title>([^<]*)<\/title>/g)).map((m) => m[1])
          const topic: Topic = { title: titles[0] ?? doc.name, children: { attached: titles.slice(1).map((t) => ({ title: t })) } }
          setRoot(topic)
          setDocContent(doc.id, `[XMind 思维导图] ${doc.name}\n${titles.map((t) => `- ${t}`).join('\n')}`.slice(0, 400000))
        }
      } catch (e) {
        setError(`XMind 解析失败：${String(e)}`)
      }
    })
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, doc.name, setDocContent])

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (!root) return <div className="sheet-loading">XMind 解析中…</div>

  return (
    <div className="page-sheet xmind-view">
      <div className="sheet-title">🧠 {doc.name}</div>
      <div className="sheet-sub">思维导图大纲</div>
      <MindNode topic={root} depth={0} path="t" byBlk={byBlk} onBlockAnchorClick={onBlockAnchorClick} />
    </div>
  )
}
