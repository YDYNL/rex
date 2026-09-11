/**
 * 锚点精确选区：划词偏移的记录与还原
 * - 划词时计算选区边界在块内文本的字符偏移（rangeStart/rangeEnd，随 Anchor 持久化）
 * - 还原时把偏移映射回 DOM Range（复用全文搜索的「前缀和 + 二分」定位算法，跨文本节点可用）
 * - flashAnchorRange：点击紫点 → 滚动到划选内容 + CSS Custom Highlight 紫色底纹（2s 消退）
 *   只高亮划选的字符本身，不再点亮整个段落
 */

interface HighlightLike extends AbstractRange {}
type HighlightCtor = new (...ranges: AbstractRange[]) => HighlightLike
interface RegistryLike {
  set(name: string, highlight: HighlightLike): unknown
  delete(name: string): boolean
}

/** Highlight API 能力按文档解析（iframe 与主文档的 registry 相互独立） */
function hlFor(doc: Document): { ctor: HighlightCtor; registry: RegistryLike } | null {
  const win = doc.defaultView as unknown as {
    Highlight?: HighlightCtor
    CSS?: { highlights?: RegistryLike }
  } | null
  if (!win?.Highlight || !win.CSS?.highlights) return null
  return { ctor: win.Highlight, registry: win.CSS.highlights }
}

/** 块内全部文本节点（树序）与各自的前缀起始偏移 */
function textNodesIn(blk: Element): { nodes: Text[]; starts: number[] } {
  const walker = blk.ownerDocument.createTreeWalker(blk, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let acc = 0
  let n: Node | null
  while ((n = walker.nextNode())) {
    starts.push(acc)
    acc += (n as Text).data.length
    nodes.push(n as Text)
  }
  return { nodes, starts }
}

/** 块内字符偏移 → (文本节点, 节点内偏移)；starts 有序，二分 */
function locate(
  nodes: Text[],
  starts: number[],
  offset: number
): { node: Text; inner: number } | null {
  if (nodes.length === 0) return null
  const total = starts[starts.length - 1] + nodes[nodes.length - 1].data.length
  const off = Math.max(0, Math.min(offset, total))
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= off) lo = mid
    else hi = mid - 1
  }
  return { node: nodes[lo], inner: off - starts[lo] }
}

/** 块内字符偏移 [start, end) → DOM Range；块无文本或越界返回 null */
export function rangeFromOffsets(blk: Element, start: number, end: number): Range | null {
  const { nodes, starts } = textNodesIn(blk)
  if (nodes.length === 0 || end <= start) return null
  const s = locate(nodes, starts, start)
  const e = locate(nodes, starts, end)
  if (!s || !e) return null
  try {
    const r = blk.ownerDocument.createRange()
    r.setStart(s.node, s.inner)
    r.setEnd(e.node, e.inner)
    return r
  } catch {
    return null
  }
}

/** DOM Selection 边界点 (node, offset) → 块内文本字符偏移；不在块内返回 null */
export function blockTextOffset(blk: Element, node: Node, offset: number): number | null {
  if (!blk.contains(node)) return null
  const { nodes, starts } = textNodesIn(blk)
  if (nodes.length === 0) return null
  const probe = blk.ownerDocument.createRange()
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i]
    probe.setStart(t, 0)
    probe.setEnd(t, t.data.length)
    const cmp = probe.comparePoint(node, offset)
    if (cmp > 0) continue // 边界点在整节点之后
    if (cmp < 0) return starts[i] // 边界点在节点之前 → 即块内偏移 starts[i]
    // 边界点落在节点内部 → 二分节点内偏移
    let lo = 0
    let hi = t.data.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      probe.setEnd(t, mid)
      if (probe.comparePoint(node, offset) > 0) lo = mid + 1
      else hi = mid
    }
    return starts[i] + lo
  }
  // 边界点在最后一个文本节点之后（块末尾）
  return starts[starts.length - 1] + nodes[nodes.length - 1].data.length
}

/** 闪烁锚点划选内容：滚动到选区 + 紫色底纹高亮（2s 后自动消退）。成功返回 true */
export function flashAnchorRange(
  root: ParentNode,
  blkKey: string,
  start: number,
  end: number
): boolean {
  const blk = root.querySelector(`[data-blk="${blkKey}"]`)
  if (!blk) return false
  const r = rangeFromOffsets(blk, start, end)
  if (!r) return false
  const el = r.startContainer.parentElement
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const hl = hlFor(blk.ownerDocument)
  if (hl) {
    hl.registry.set('rex-anchor-flash', new hl.ctor(r))
    setTimeout(() => hl.registry.delete('rex-anchor-flash'), 2000)
  }
  return true
}

/** 紫点定位：选区起点相对块元素的像素坐标（自动除以 CSS zoom 折算布局像素）。
 *  用单字符探针 Range 测量（折叠 Range 在部分边界返回零矩形） */
export function measureAnchorDot(
  blk: Element,
  start: number,
  end?: number
): { left: number; top: number } | null {
  const { nodes, starts } = textNodesIn(blk)
  if (nodes.length === 0) return null
  const total = starts[starts.length - 1] + nodes[nodes.length - 1].data.length
  if (total === 0 || start >= total) return null
  const r = rangeFromOffsets(blk, start, Math.min(start + 1, end ?? start + 1))
  if (!r) return null
  const rect = r.getBoundingClientRect()
  const hostRect = blk.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  const z = parseFloat(getComputedStyle(blk).zoom) || 1
  return {
    left: (rect.left - hostRect.left) / z,
    top: (rect.top - hostRect.top) / z
  }
}

/** 块渲染文本 → 空白归一化文本 + 归一化索引 → 原始索引映射 */
function normalizedTextMap(blk: Element): { norm: string; map: number[] } {
  const { nodes } = textNodesIn(blk)
  let raw = ''
  for (const n of nodes) raw += n.data
  const chars: string[] = []
  const map: number[] = []
  let prevSpace = true // 行首空白跳过（等效 trim）
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (/\s/.test(ch)) {
      if (prevSpace) continue
      prevSpace = true
      chars.push(' ')
      map.push(i)
    } else {
      prevSpace = false
      chars.push(ch)
      map.push(i)
    }
  }
  while (chars.length > 0 && chars[chars.length - 1] === ' ') {
    chars.pop()
    map.pop()
  }
  return { norm: chars.join(''), map }
}

/** 旧锚点快照定位：在块渲染文本中匹配快照（空白归一化），返回原始字符偏移 */
export function locateSnapshot(
  blk: Element,
  snapshot: string
): { start: number; end: number } | null {
  const q = snapshot.replace(/\s+/g, ' ').trim()
  if (!q) return null
  const { norm, map } = normalizedTextMap(blk)
  const idx = norm.indexOf(q)
  if (idx === -1 || idx + q.length > map.length) return null
  return { start: map[idx], end: map[idx + q.length - 1] + 1 }
}

export interface AnchorLike {
  rangeStart?: number
  rangeEnd?: number
  snapshot: string
}

/** 锚点有效偏移：存储偏移（精确锚点）优先；旧锚点用快照文本定位升级；都失败返回 null */
export function anchorOffsets(blk: Element, a: AnchorLike): { start: number; end: number } | null {
  if (a.rangeStart != null && a.rangeEnd != null && a.rangeEnd > a.rangeStart) {
    return { start: a.rangeStart, end: a.rangeEnd }
  }
  return locateSnapshot(blk, a.snapshot)
}
