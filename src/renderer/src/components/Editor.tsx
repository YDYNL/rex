import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import type { OpenDoc } from '../types'
import { toast } from './TopBar'

interface EditorProps {
  doc: OpenDoc
}

/**
 * 文档编辑器：纯文本类格式（txt/md/code/json 等）
 * - 编辑态下 AI 问答暂停（AiPanel 锁定）
 * - Ctrl+S 保存 → 写回原文件 → 自动重新解析全文 + 重新生成 AI 洞察
 * - 切换 Tab 自动备份草稿（未保存内容不丢）
 */
export default function Editor({ doc }: EditorProps) {
  const stopEdit = useAppStore((s) => s.stopEdit)
  const docSaved = useAppStore((s) => s.docSaved)

  const [text, setText] = useState('')
  const [origin, setOrigin] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const textRef = useRef('')
  /** 已保存/已放弃：卸载时不再备份草稿 */
  const discardedRef = useRef(false)

  textRef.current = text

  useEffect(() => {
    let alive = true
    const draft = useAppStore.getState().editDraft[doc.id]
    if (draft !== undefined) {
      setText(draft)
      setOrigin(draft)
      setLoading(false)
      return
    }
    void window.rex.file.readText(doc.path).then((r) => {
      if (!alive) return
      setLoading(false)
      if (r.ok) {
        setText(r.content)
        setOrigin(r.content)
      } else {
        setError(r.error)
      }
    })
    return () => {
      alive = false
      /* 卸载备份草稿：切 Tab 不丢未保存内容 */
      if (!discardedRef.current && textRef.current) {
        useAppStore.getState().setEditDraft(doc.id, textRef.current)
      }
    }
  }, [doc.path, doc.id])

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    const r = await window.rex.file.writeText(doc.path, textRef.current)
    setSaving(false)
    if (!r.ok) {
      toast(`保存失败：${r.error}`)
      return
    }
    discardedRef.current = true
    docSaved(doc.id)
    toast('已保存，正在重新解析全文…')
  }

  const cancel = (): void => {
    discardedRef.current = true
    stopEdit()
  }

  if (loading) return <div className="sheet-loading">载入文档…</div>
  if (error) return <div className="sheet-error">⚠️ {error}</div>

  const dirty = text !== origin

  return (
    <div className="doc-editor-wrap">
      <div className="editor-bar">
        <span className="editor-title">✏️ 编辑 {doc.name}</span>
        <span className={`editor-state${dirty ? ' dirty' : ''}`}>
          {dirty ? '● 有未保存更改' : '已同步'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={cancel} disabled={saving}>
          放弃更改
        </button>
        <button className="btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…' : '💾 保存（Ctrl+S）'}
        </button>
      </div>
      <textarea
        className="doc-editor"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            void save()
          }
        }}
      />
      <div className="editor-hint">
        编辑模式下 AI 问答与划词已暂停 · 保存后自动恢复问答并重新解析全文（AI 洞察同步更新）
      </div>
    </div>
  )
}
