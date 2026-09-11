import { useEffect, useState } from 'react'
import initSqlJs, { type Database } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { RendererProps } from './registry'
import { AnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

/** sql.js 引擎单例（wasm 仅加载一次） */
let enginePromise: Promise<SqlJsStatic> | null = null
interface SqlJsStatic {
  Database: new (data?: Uint8Array) => Database
}

function getEngine(): Promise<SqlJsStatic> {
  if (!enginePromise) {
    enginePromise = initSqlJs({ locateFile: () => wasmUrl }) as unknown as Promise<SqlJsStatic>
  }
  return enginePromise
}

/** SQLite 渲染器：sql.js（WebAssembly）真实读取库表 + 数据网格 */
export default function SqliteRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const [tables, setTables] = useState<string[]>([])
  const [active, setActive] = useState('')
  const [grid, setGrid] = useState<{ cols: string[]; rows: string[][] } | null>(null)
  const [error, setError] = useState('')
  const byBlk = useAnchorsByBlk(doc.id)
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    setTables([])
    setGrid(null)
    setError('')
    void window.rex.file.readBuffer(doc.path).then(async (r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      try {
        const SQL = await getEngine()
        const db = new SQL.Database(new Uint8Array(r.data))
        const master = db.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        const names = (master[0]?.values?.map((v) => String(v[0])) ?? []) as string[]
        setTables(names)
        setActive(names[0] ?? '')

        /* AI 上下文：schema + 各表前 20 行样例 */
        const parts: string[] = [`[SQLite 数据库] ${doc.name}，共 ${names.length} 张表。`]
        for (const t of names) {
          try {
            const schema = db.exec(`SELECT sql FROM sqlite_master WHERE name='${t}'`)
            if (schema[0]?.values?.[0]) parts.push(`表 ${t}：${String(schema[0].values[0][0])}`)
            const sample = db.exec(`SELECT * FROM "${t}" LIMIT 20`)
            if (sample[0]) {
              const cols = sample[0].columns.map(String)
              const rows = sample[0].values.map((row) => row.map((c) => String(c ?? 'NULL')))
              parts.push(`样例：${cols.join(' | ')}\n${rows.map((x) => x.join(' | ')).join('\n')}`)
            }
          } catch {
            /* 单表失败跳过 */
          }
        }
        db.close()
        setDocContent(doc.id, parts.join('\n\n').slice(0, 400000))
      } catch (e) {
        setError(`SQLite 解析失败：${String(e)}`)
      }
    })
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, doc.name, setDocContent])

  /* 切表：重新拉取数据（最多 300 行） */
  useEffect(() => {
    if (!active) return
    setGrid(null)
    void window.rex.file.readBuffer(doc.path).then(async (r) => {
      if (!r.ok) return
      try {
        const SQL = await getEngine()
        const db = new SQL.Database(new Uint8Array(r.data))
        const res = db.exec(`SELECT * FROM "${active}" LIMIT 300`)
        if (res[0]) {
          setGrid({
            cols: res[0].columns.map(String),
            rows: res[0].values.map((row) => row.map((c) => String(c ?? 'NULL')))
          })
        } else {
          setGrid({ cols: [], rows: [] })
        }
        db.close()
      } catch (e) {
        setError(`读取表失败：${String(e)}`)
      }
    })
  }, [active, doc.path])

  if (error && tables.length === 0) return <div className="sheet-error">⚠️ {error}</div>
  if (tables.length === 0) return <div className="sheet-loading">数据库解析中…</div>

  return (
    <div className="page-sheet sheet-view">
      <div className="sheet-title">{doc.name}</div>
      <div className="sheet-sub">SQLite · {tables.length} 张表</div>
      <div className="sheet-tabs">
        {tables.map((t) => (
          <button key={t} className={`sheet-tab${t === active ? ' on' : ''}`} onClick={() => setActive(t)}>
            🗄 {t}
          </button>
        ))}
      </div>
      {grid ? (
        <div className="table-scroll">
          <table className="grid-table">
            <tbody>
            <tr className="grid-head">
              <td className="grid-th grid-idx">#</td>
              {grid.cols.map((c, i) => (
                <td key={i} className="grid-th">
                  {c}
                </td>
              ))}
            </tr>
            {grid.rows.map((row, ri) => {
              const list = byBlk[`${active}:r${ri}`]
              return (
                <tr key={ri} data-blk={`${active}:r${ri}`}>
                  <td className="grid-idx">
                    {list && list.length > 0 ? (
                      <AnchorDots
                        list={list}
                        blkKey={`${active}:r${ri}`}
                        onBlockAnchorClick={onBlockAnchorClick}
                      />
                    ) : (
                      ri + 1
                    )}
                  </td>
                  {row.map((c, ci) => (
                    <td key={ci}>{c}</td>
                  ))}
                </tr>
              )
            })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="sheet-loading">读取表数据…</div>
      )}
    </div>
  )
}
