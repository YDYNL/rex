import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import type { RendererProps } from './registry'
import { AnchorDots, useAnchorsByBlk } from './anchor'
import { useAppStore } from '../stores/appStore'

/** 行数上限（超大表截断展示，避免 DOM 爆炸） */
const MAX_ROWS = 1000

/** 表格渲染器：xlsx/xlsm/xltx/csv/tsv/dbf 真实表格预览（SheetJS 解析） */
export default function SheetRenderer({ doc, onBlockAnchorClick }: RendererProps) {
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [sheets, setSheets] = useState<Record<string, string[][]>>({})
  const [active, setActive] = useState('')
  const [error, setError] = useState('')
  const byBlk = useAnchorsByBlk(doc.id)
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    setSheetNames([])
    setSheets({})
    setError('')
    const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''

    const parseWb = (wb: XLSX.WorkBook): void => {
      if (!alive) return
      const grid: Record<string, string[][]> = {}
      const textParts: string[] = []
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name]
        grid[name] = (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as unknown as string[][])
          .slice(0, MAX_ROWS)
          .map((row) => row.map((c) => String(c ?? '')))
        textParts.push(`【工作表 ${name}】\n${XLSX.utils.sheet_to_csv(ws)}`)
      }
      setSheetNames(wb.SheetNames)
      setSheets(grid)
      setActive(wb.SheetNames[0] ?? '')
      setDocContent(doc.id, textParts.join('\n\n').slice(0, 400000))
    }

    if (ext === 'csv' || ext === 'tsv' || ext === 'dbf') {
      void window.rex.file.readText(doc.path).then((r) => {
        if (!alive) return
        if (!r.ok) {
          setError(r.error)
          return
        }
        try {
          parseWb(XLSX.read(r.content, { type: 'string', raw: false }))
        } catch (e) {
          setError(`表格解析失败：${String(e)}`)
        }
      })
    } else {
      void window.rex.file.readBuffer(doc.path).then((r) => {
        if (!alive) return
        if (!r.ok) {
          setError(r.error)
          return
        }
        try {
          parseWb(XLSX.read(r.data, { type: 'array' }))
        } catch (e) {
          setError(`表格解析失败：${String(e)}`)
        }
      })
    }
    return () => {
      alive = false
    }
  }, [doc.path, doc.id, doc.name, doc.version, setDocContent])

  const rows = useMemo(() => sheets[active] ?? [], [sheets, active])

  /**
   * 表格模型：裁剪全空尾部行列 + 识别标题行（合并单元格大标题）/表头行/合计行 + 数字列右对齐。
   * Excel 常见结构：第 0 行是跨列合并的大标题（仅首格有值），第 1 行才是真正的列标题。
   */
  const model = useMemo(() => {
    if (rows.length === 0) return null
    // 有效列：任一行有值的最后一列（去掉仅因格式残留的空尾列）
    let maxCol = 1
    for (const r of rows) {
      for (let i = r.length - 1; i >= 0; i--) {
        if (r[i] !== '') {
          if (i + 1 > maxCol) maxCol = i + 1
          break
        }
      }
    }
    // 有效行：最后一行有值的行
    let maxRow = 1
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].slice(0, maxCol).some((c) => c !== '')) {
        maxRow = i + 1
        break
      }
    }
    const body = rows.slice(0, maxRow).map((r) => {
      const cut = r.slice(0, maxCol)
      return cut.length < maxCol ? [...cut, ...Array(maxCol - cut.length).fill('')] : cut
    })
    // 表头探测：前 5 行中第一行"非空占比 ≥ 60% 且非空 ≥ 2"视为列标题行，其上方为标题行
    const headerIdx = (() => {
      for (let i = 0; i < Math.min(body.length, 5); i++) {
        const filled = body[i].filter((c) => c !== '').length
        if (filled >= 2 && filled / maxCol >= 0.6) return i
      }
      return 0
    })()
    // 数字列探测：数据区该列非空值 ≥ 3 且 80% 为数字（含千分位/百分号）→ 右对齐
    const numCols = new Set<number>()
    for (let c = 0; c < maxCol; c++) {
      const vals = body.slice(headerIdx + 1).map((r) => r[c]).filter((v) => v !== '')
      if (vals.length >= 3) {
        const nums = vals.filter((v) => /^[+-]?[\d,，.．]+%?$/.test(v.trim()))
        if (nums.length / vals.length >= 0.8) numCols.add(c)
      }
    }
    return { body, headerIdx, colCount: maxCol, numCols }
  }, [rows])

  if (error) return <div className="sheet-error">⚠️ {error}</div>
  if (!model) return <div className="sheet-loading">表格解析中…</div>

  const { body, headerIdx, colCount, numCols } = model
  const titleRows = body.slice(0, headerIdx)
  const headerRow = body[headerIdx] ?? []
  const dataRows = body.slice(headerIdx + 1)
  const truncated = rows.length >= MAX_ROWS

  return (
    <div className="page-sheet sheet-view">
      <div className="sheet-title">{doc.name}</div>
      <div className="sheet-sub">
        {sheetNames.length} 个工作表 · {dataRows.length} 行数据 · {colCount} 列
      </div>
      {sheetNames.length > 1 && (
        <div className="sheet-tabs">
          {sheetNames.map((n) => (
            <button
              key={n}
              className={`sheet-tab${n === active ? ' on' : ''}`}
              onClick={() => setActive(n)}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      <div className="table-scroll">
        <table className="grid-table">
          <tbody>
          {/* 合并单元格大标题：整行横幅（保留历史提问锚点） */}
          {titleRows.map((r, i) => {
            const list = byBlk[`r${i}`]
            return (
              <tr key={`t${i}`} className="grid-title" data-blk={`r${i}`}>
                <td className="grid-idx">
                  {list && list.length > 0 && (
                    <AnchorDots list={list} blkKey={`r${i}`} onBlockAnchorClick={onBlockAnchorClick} />
                  )}
                </td>
                <td colSpan={colCount}>{r.find((c) => c !== '') ?? ''}</td>
              </tr>
            )
          })}
          {/* 列标题行 */}
          <tr className="grid-head">
            <td className="grid-th grid-idx">#</td>
            {Array.from({ length: colCount }, (_, c) => (
              <td key={c} className="grid-th">
                {headerRow[c] ?? ''}
              </td>
            ))}
          </tr>
          {/* 数据行：斑马纹 + 合计行强调 + 数字列右对齐 + 锚点紫点 */}
          {dataRows.map((row, di) => {
            const ri = headerIdx + 1 + di // 绝对行号（与锚点 blkKey 对应）
            const list = byBlk[`r${ri}`]
            const isTotal = /^(合计|总计|小计|汇总)/.test((row[0] ?? '').trim())
            return (
              <tr
                key={ri}
                data-blk={`r${ri}`}
                className={`${di % 2 === 1 ? 'grid-alt' : ''}${isTotal ? ' grid-total' : ''}`}
              >
                <td className="grid-idx">
                  {list && list.length > 0 ? (
                    <AnchorDots list={list} blkKey={`r${ri}`} onBlockAnchorClick={onBlockAnchorClick} />
                  ) : (
                    ri + 1
                  )}
                </td>
                {Array.from({ length: colCount }, (_, c) => (
                  <td key={c} className={numCols.has(c) ? 'num' : undefined} title={row[c] ?? ''}>
                    {row[c] ?? ''}
                  </td>
                ))}
              </tr>
            )
          })}
          </tbody>
        </table>
      </div>
      {truncated && <div className="sheet-sub">已截断展示前 {MAX_ROWS} 行，完整内容仍可供 AI 引用</div>}
    </div>
  )
}
