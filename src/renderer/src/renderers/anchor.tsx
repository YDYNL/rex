import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Anchor } from '../types'
import { useAppStore } from '../stores/appStore'
import { anchorOffsets, measureAnchorDot, rangeFromOffsets } from '../lib/anchorRange'
import type { RendererProps } from './registry'

/** 按块聚合当前文档的锚点（blkKey → anchors） */
export function useAnchorsByBlk(docId: string): Record<string, Anchor[]> {
  const anchors = useAppStore((s) => s.anchors[docId] ?? [])
  return useMemo(() => {
    const m: Record<string, Anchor[]> = {}
    for (const a of anchors) (m[a.blkKey] ??= []).push(a)
    return m
  }, [anchors])
}

/** 锚点跳转目标：优先会话 id（新数据），回退 qaId（旧数据由 AiPanel 兜底查找） */
export function anchorTarget(a: Anchor): string {
  return a.sessionId ?? a.qaId
}

interface AnchorDotProps {
  anchor: Anchor
  blkKey: string
  onBlockAnchorClick: RendererProps['onBlockAnchorClick']
}

/** 锚点紫点（React 形态）：
 *  有效偏移（存储偏移 or 快照文本定位，旧锚点自动升级）→ 紫点悬在划选文字首字上方
 *  无法定位（内容已变更）→ 回退块角定位
 *  ResizeObserver 跟随块尺寸变化（缩放/字体加载/窗口调整）自动重测位置 */
export function AnchorDot({ anchor, blkKey, onBlockAnchorClick }: AnchorDotProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    const blk = el?.closest('[data-blk]')
    if (!el || !blk) return
    let alive = true
    const resolve = (): void => {
      if (!alive) return
      const off = anchorOffsets(blk, anchor)
      setPos(off ? measureAnchorDot(blk, off.start, off.end) : null)
    }
    resolve()
    let ro: ResizeObserver | null = null
    try {
      ro = new ResizeObserver(() => resolve())
      ro.observe(blk)
    } catch {
      /* ResizeObserver 不可用时仅首测 */
    }
    return () => {
      alive = false
      ro?.disconnect()
    }
  }, [anchor])

  const precise = pos != null

  // 悬浮预览：hover 紫点 → 划选内容即时浅紫底纹（Highlight API），离开即消
  useAnchorHover(ref, anchor, precise)

  return (
    <span
      ref={ref}
      className={`anchor-dot${precise ? ' precise' : ''}`}
      style={pos ? { left: pos.left, top: pos.top - 5 } : undefined}
      title={`查看此处的提问：${anchor.snapshot.slice(0, 40)}${anchor.snapshot.length > 40 ? '…' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onBlockAnchorClick(anchorTarget(anchor), blkKey, anchor.id)
      }}
    />
  )
}

/** hover 紫点 → Highlight API 给划选内容打浅紫底纹（hover 预览，独立注册表项） */
function useAnchorHover(
  ref: React.RefObject<HTMLSpanElement | null>,
  anchor: Anchor,
  precise: boolean
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !precise) return
    const enter = (): void => {
      const blk = el.closest('[data-blk]')
      if (!blk) return
      const off = anchorOffsets(blk, anchor)
      if (!off) return
      const r = rangeFromOffsets(blk, off.start, off.end)
      if (!r) return
      const win = blk.ownerDocument.defaultView as unknown as {
        Highlight?: new (...rs: AbstractRange[]) => AbstractRange
        CSS?: { highlights?: { set(k: string, v: unknown): unknown; delete(k: string): boolean } }
      } | null
      if (!win?.Highlight || !win.CSS?.highlights) return
      win.CSS.highlights.set('rex-anchor-hover', new win.Highlight(r))
    }
    const leave = (): void => {
      const doc = el.ownerDocument
      const win = doc.defaultView as unknown as {
        CSS?: { highlights?: { delete(k: string): boolean } }
      } | null
      win?.CSS?.highlights?.delete('rex-anchor-hover')
    }
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    return () => {
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mouseleave', leave)
      leave()
    }
  }, [ref, anchor, precise])
}

/** 一个块的全部锚点：每个锚点独立定位到各自划选文字处（快照定位让旧锚点也精确） */
export function AnchorDots({
  list,
  blkKey,
  onBlockAnchorClick
}: {
  list: Anchor[]
  blkKey: string
  onBlockAnchorClick: RendererProps['onBlockAnchorClick']
}) {
  return (
    <>
      {list.map((a) => (
        <AnchorDot key={a.id} anchor={a} blkKey={blkKey} onBlockAnchorClick={onBlockAnchorClick} />
      ))}
    </>
  )
}

/** 锚点紫点（DOM 注入形态）：docx-preview / pdf.js 等命令式渲染容器使用。
 *  每次全量重建块内紫点：有效偏移（存储 or 快照定位）定位到划选文字处；
 *  无法定位的旧锚点回退块角 + 计数 */
export function attachAnchorDots(
  host: HTMLElement,
  byBlk: Record<string, Anchor[]>,
  onBlockAnchorClick: (sessionId: string, blkKey: string, anchorId?: string) => void
): void {
  for (const [blkKey, list] of Object.entries(byBlk)) {
    const blk = host.querySelector(`[data-blk="${blkKey}"]`)
    if (!blk) continue
    blk.querySelectorAll(':scope > .anchor-dot').forEach((d) => d.remove())

    const resolved = list.map((a) => ({ a, off: anchorOffsets(blk, a) }))
    const unlocated = resolved.filter((x) => !x.off)
    let cornerShown = false
    for (const { a, off } of resolved) {
      if (!off) {
        if (cornerShown) continue // 无法定位的仅展示一枚（带计数）
        cornerShown = true
      }
      const dot = document.createElement('span')
      dot.className = `anchor-dot${off ? ' precise' : ''}`
      if (off) {
        const p = measureAnchorDot(blk, off.start, off.end)
        if (p) {
          dot.style.left = `${p.left}px`
          dot.style.top = `${p.top - 5}px`
        }
        // 悬浮预览：hover 紫点 → 划选内容即时浅紫底纹
        const enter = (): void => {
          const r = rangeFromOffsets(blk, off.start, off.end)
          if (!r) return
          const win = blk.ownerDocument.defaultView as unknown as {
            Highlight?: new (...rs: AbstractRange[]) => AbstractRange
            CSS?: { highlights?: { set(k: string, v: unknown): unknown } }
          } | null
          if (!win?.Highlight || !win.CSS?.highlights) return
          win.CSS.highlights.set('rex-anchor-hover', new win.Highlight(r))
        }
        const leave = (): void => {
          const win = blk.ownerDocument.defaultView as unknown as {
            CSS?: { highlights?: { delete(k: string): boolean } }
          } | null
          win?.CSS?.highlights?.delete('rex-anchor-hover')
        }
        dot.addEventListener('mouseenter', enter)
        dot.addEventListener('mouseleave', leave)
      }
      dot.title = `查看此处的提问：${a.snapshot.slice(0, 40)}${a.snapshot.length > 40 ? '…' : ''}`
      dot.addEventListener('click', (e) => {
        e.stopPropagation()
        onBlockAnchorClick(anchorTarget(a), blkKey, a.id)
      })
      if (!off && unlocated.length > 1) {
        const cnt = document.createElement('i')
        cnt.className = 'anchor-count'
        cnt.textContent = String(unlocated.length)
        dot.appendChild(cnt)
      }
      blk.appendChild(dot)
    }
  }
}
