import { useEffect, useState } from 'react'
import hljs from 'highlight.js'
import type { RendererProps } from './registry'
import { AnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

/** 语言映射：扩展名 → highlight.js 语言 */
const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  kt: 'kotlin',
  php: 'php',
  rb: 'ruby',
  sh: 'bash',
  bat: 'bat',
  ps1: 'powershell',
  sql: 'sql',
  css: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini'
}

/** 代码渲染器：真实语法高亮 + 行号，按行块打锚点 */
export default function CodeRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const [content, setContent] = useState<string>('')
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
        setContent(r.content)
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

  const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''
  const lang = LANG[ext] ?? 'plaintext'
  const lines = content.split('\n')

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (content === '') return <div className="sheet-loading">加载中…</div>

  const BLOCK = 10
  const blocks: { from: number; lines: string[] }[] = []
  for (let i = 0; i < lines.length; i += BLOCK) {
    blocks.push({ from: i, lines: lines.slice(i, i + BLOCK) })
  }

  return (
    <div className="page-sheet code-sheet">
      <div className="sheet-title">{doc.name}</div>
      <div className="sheet-sub">
        {lang} · {lines.length} 行 · 真实语法高亮
      </div>
      {blocks.map((b, bi) => {
        const list = byBlk[String(bi)]
        return (
          <div key={bi} className="code-blk" data-blk={String(bi)}>
            {list && list.length > 0 && (
              <AnchorDots list={list} blkKey={String(bi)} onBlockAnchorClick={onBlockAnchorClick} />
            )}
            {b.lines.map((line, li) => {
              const html = hljs.highlight(line, { language: lang, ignoreIllegals: true }).value
              return (
                <div className="code-lines" key={li}>
                  <div className="ln">{b.from + li + 1}</div>
                  <div dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
