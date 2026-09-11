// 阅伴 · 锚点数据结构示例（用于演示代码渲染与划词提问）

/** 锚点：一次问答在原文处的沉淀 */
interface Anchor {
  docId: string                 // 文档 ID（内容哈希）
  pageIndex: number             // 物理页或逻辑块
  charRange: [number, number]   // 字符偏移区间
  snapshot: string              // 原文快照
  qaId: string                  // 关联问答记录
}

/** 将字符区间映射回原文位置 */
function locate(doc: { id: string }, range: [number, number]): string {
  return `doc=${doc.id} page#? offset#${range[0]}..${range[1]}`
}

/** 重建锚点：按 哈希+页码+坐标 恢复标记 */
function restoreAnchors(docId: string, list: Anchor[]): Anchor[] {
  return list.filter((a) => a.docId === docId)
}

export { locate, restoreAnchors }
export type { Anchor }
