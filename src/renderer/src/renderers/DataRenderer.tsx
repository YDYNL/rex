import { useEffect, useState } from 'react'
import type { RendererProps } from './registry'
import { AnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

interface TreeNodeProps {
  name: string
  value: Json
  path: string
  depth: number
  byBlk: Record<string, ReturnType<typeof useAnchorsByBlk>[string]>
  onBlockAnchorClick: RendererProps['onBlockAnchorClick']
}

/** 递归树节点：可折叠，叶子显示值，节点行支持锚点与划词 */
function TreeNode({ name, value, path, depth, byBlk, onBlockAnchorClick }: TreeNodeProps) {
  const [open, setOpen] = useState(depth < 2)
  const isBranch = value !== null && typeof value === 'object'
  const list = byBlk[path]

  const valuePreview = (v: Json): string => {
    if (v === null) return 'null'
    if (typeof v === 'string') return `"${v.length > 60 ? v.slice(0, 58) + '…' : v}"`
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v)) return `Array(${v.length})`
    return `Object{${Object.keys(v).length}}`
  }

  return (
    <div className="tree-node" data-blk={path}>
      {list && list.length > 0 && (
        <AnchorDots list={list} blkKey={path} onBlockAnchorClick={onBlockAnchorClick} />
      )}
      <div className="tree-row" style={{ paddingLeft: depth * 16 }} onClick={() => isBranch && setOpen((v) => !v)}>
        {isBranch ? (
          <span className={`tree-caret${open ? ' open' : ''}`}>▸</span>
        ) : (
          <span className="tree-caret ghost">·</span>
        )}
        <span className="tree-key">{name}</span>
        {!isBranch && (
          <>
            <span className="tree-colon">: </span>
            <span className={`tree-val v-${value === null ? 'null' : typeof value}`}>{valuePreview(value)}</span>
          </>
        )}
        {isBranch && <span className="tree-val v-branch">{valuePreview(value)}</span>}
      </div>
      {isBranch && open && (
        <div className="tree-children">
          {Array.isArray(value)
            ? value.map((v, i) => (
                <TreeNode
                  key={i}
                  name={`[${i}]`}
                  value={v}
                  path={`${path}[${i}]`}
                  depth={depth + 1}
                  byBlk={byBlk}
                  onBlockAnchorClick={onBlockAnchorClick}
                />
              ))
            : Object.entries(value as { [k: string]: Json }).map(([k, v]) => (
                <TreeNode
                  key={k}
                  name={k}
                  value={v}
                  path={`${path}.${k}`}
                  depth={depth + 1}
                  byBlk={byBlk}
                  onBlockAnchorClick={onBlockAnchorClick}
                />
              ))}
        </div>
      )}
    </div>
  )
}

/** 结构化数据渲染器：json/geojson 树形；xml/opml 标签树 */
export default function DataRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const [root, setRoot] = useState<{ name: string; value: Json } | null>(null)
  const [error, setError] = useState('')
  const byBlk = useAnchorsByBlk(doc.id)
  const setDocContent = useAppStore((s) => s.setDocContent)
  const setDocError = useAppStore((s) => s.setDocError)

  useEffect(() => {
    let alive = true
    setRoot(null)
    setError('')
    const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''
    void window.rex.file.readText(doc.path).then((r) => {
      if (!alive) return
      if (!r.ok) {
        setDocError(doc.id)
        setError(r.error)
        return
      }
      try {
        if (ext === 'xml' || ext === 'opml') {
          const parsed = new DOMParser().parseFromString(r.content, 'text/xml')
          if (parsed.querySelector('parsererror')) throw new Error('XML 语法错误')
          const toNode = (el: Element): Json => {
            const kids = Array.from(el.children)
            const text = (el.textContent ?? '').trim()
            if (kids.length === 0) return text
            const obj: { [k: string]: Json } = {}
            for (const k of kids) {
              const key = k.tagName
              obj[key] = Array.isArray(obj[key]) ? [...(obj[key] as Json[]), toNode(k)] : toNode(k)
            }
            if (text) obj['#text'] = text
            return obj
          }
          const docEl = parsed.documentElement
          setRoot({ name: docEl.tagName, value: toNode(docEl) })
          setDocContent(doc.id, r.content.slice(0, 400000))
        } else {
          const parsed = JSON.parse(r.content) as Json
          setRoot({ name: doc.name, value: parsed })
          setDocContent(doc.id, JSON.stringify(parsed, null, 2).slice(0, 400000))
        }
      } catch (e) {
        setDocError(doc.id)
        setError(`数据解析失败：${String(e)}`)
      }
    })
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, doc.name, doc.version, setDocContent, setDocError])

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (!root) return <div className="sheet-loading">数据解析中…</div>

  return (
    <div className="page-sheet data-view">
      <div className="sheet-title">{doc.name}</div>
      <div className="sheet-sub">结构化数据 · 可折叠树</div>
      <TreeNode
        name={root.name}
        value={root.value}
        path="$"
        depth={0}
        byBlk={byBlk}
        onBlockAnchorClick={onBlockAnchorClick}
      />
    </div>
  )
}
