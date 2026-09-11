/**
 * 全文搜索：基于 CSS Custom Highlight API 的命中高亮
 * - 零 DOM 注入（不向 React 渲染树插入元素，与各渲染器/pdf 文本层零冲突）
 * - 跨节点精准匹配：pdf 文本层是逐词 span，命中词常被拆开，
 *   采用「全局拼接文本 + 偏移映射回 Range」确保跨 span 命中不漏
 * - Chromium 不支持时优雅降级：仍可计数与跳转，只是不高亮
 */

interface HighlightLike extends AbstractRange {}
type HighlightCtor = new (...ranges: AbstractRange[]) => HighlightLike
interface RegistryLike {
  set(name: string, highlight: HighlightLike): unknown
  delete(name: string): boolean
}

const hlCtor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
const registry = (CSS as unknown as { highlights?: RegistryLike }).highlights
const SUPPORTED = typeof hlCtor === 'function' && !!registry

export interface SearchStats {
  total: number
  current: number // 从 1 开始
}

let ranges: Range[] = []
let current = -1

/** 跳过无搜索价值的文本节点 */
function skipNode(n: Node): boolean {
  const p = n.parentElement
  if (!p) return true
  const tag = p.tagName
  return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT'
}

/** 收集 root 下所有命中（大小写不敏感，跨文本节点可命中） */
function collect(root: HTMLElement, query: string): Range[] {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    undefined
  )
  const nodes: Text[] = []
  const starts: number[] = []
  let full = ''
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (skipNode(node)) continue
    starts.push(full.length)
    full += (node as Text).data
    nodes.push(node as Text)
  }
  const lower = full.toLowerCase()
  const q = query.toLowerCase()
  const out: Range[] = []
  if (q.length === 0 || nodes.length === 0) return out

  /** 偏移 → 所在文本节点（starts 有序，二分） */
  const locate = (offset: number): { node: Text; inner: number } | null => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return { node: nodes[lo], inner: offset - starts[lo] }
  }

  let idx = lower.indexOf(q)
  while (idx !== -1) {
    const end = idx + q.length
    const s = locate(idx)
    const e = locate(end - 1)
    if (s && e) {
      try {
        const r = document.createRange()
        r.setStart(s.node, s.inner)
        r.setEnd(e.node, e.inner + 1)
        out.push(r)
      } catch {
        /* 节点边界异常：跳过该命中 */
      }
    }
    idx = lower.indexOf(q, end)
  }
  return out
}

function clearHighlights(): void {
  if (SUPPORTED) {
    registry!.delete('rex-search')
    registry!.delete('rex-search-current')
  }
}

function jumpTo(i: number): void {
  current = i
  if (SUPPORTED) {
    if (i >= 0 && ranges[i]) registry!.set('rex-search-current', new hlCtor!(ranges[i]))
    else registry!.delete('rex-search-current')
  }
  const el = ranges[i]?.startContainer.parentElement
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/** 执行搜索（root=预览区 DOM），自动高亮并跳到第一个命中 */
export function runSearch(root: HTMLElement | null, query: string): SearchStats {
  clearHighlights()
  ranges = []
  current = -1
  const q = query.trim()
  if (!root || q.length === 0) return { total: 0, current: 0 }
  ranges = collect(root, q)
  if (SUPPORTED && ranges.length > 0) registry!.set('rex-search', new hlCtor!(...ranges))
  if (ranges.length > 0) jumpTo(0)
  return { total: ranges.length, current: ranges.length > 0 ? 1 : 0 }
}

/** 上/下一个命中（循环滚动），返回最新状态 */
export function jumpSearch(dir: 1 | -1): SearchStats {
  if (ranges.length === 0) return { total: 0, current: 0 }
  const i = (current + dir + ranges.length) % ranges.length
  jumpTo(i)
  return { total: ranges.length, current: i + 1 }
}

/** 清除搜索（文档切换 / 清空输入时） */
export function clearSearch(): void {
  ranges = []
  current = -1
  clearHighlights()
}
