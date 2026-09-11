import type { LlmMessage } from '../../../main/ipc/llm'

/** 模型上下文字符预算（字符数）：本地 4B 模型默认 4096 token 上下文，预留回答空间 */
const CTX_BUDGET_CHARS = 3600
/** 洞察分块大小（map 阶段每块输入） */
const INSIGHT_CHUNK = 3000
/** map 阶段最多块数（超长文档截断覆盖前 N 块 + 末块） */
const INSIGHT_MAX_CHUNKS = 8

/** 将全文按段落边界切成约 size 字符的块 */
export function splitChunks(text: string, size: number): string[] {
  const paras = text.split(/\n\s*\n/)
  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    if (cur && (cur.length + p.length) > size) {
      chunks.push(cur)
      cur = p
    } else {
      cur = cur ? `${cur}\n\n${p}` : p
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

/** 从查询中提取检索关键词：CJK 二元组 + 拉丁词 */
function extractTerms(query: string): Set<string> {
  const terms = new Set<string>()
  const cjk = query.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const seg of cjk) {
    if (seg.length === 1) {
      terms.add(seg)
    } else {
      for (let i = 0; i < seg.length - 1; i++) terms.add(seg.slice(i, i + 2))
    }
  }
  const latin = query.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []
  for (const w of latin) terms.add(w)
  return terms
}

/** 按与问题的相关度挑选原文片段；短文档直接返回全文 */
export function pickRelevantChunks(fullText: string, query: string, budget = CTX_BUDGET_CHARS): string {
  const text = fullText.trim()
  if (!text) return ''
  if (text.length <= budget) return text

  const terms = extractTerms(query)
  const chunks = splitChunks(text, 1200)
  const scored = chunks.map((c, i) => {
    const lower = c.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (lower.includes(t)) score += t.length >= 2 ? 2 : 1
    }
    return { c, i, score }
  })

  // 相关块优先；无命中时取首尾（保证概要信息）
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.i - b.i)
  const picked: { c: string; i: number }[] = []
  let used = 0
  for (const item of ranked) {
    if (item.score === 0) break
    if (used + item.c.length > budget) continue
    picked.push(item)
    used += item.c.length
    if (used > budget * 0.9) break
  }
  if (picked.length === 0) {
    picked.push(scored[0])
    used = scored[0].c.length
    const last = scored[scored.length - 1]
    if (last && last.i !== 0 && used + last.c.length <= budget) picked.push(last)
  }
  picked.sort((a, b) => a.i - b.i)

  const parts = picked.map((p) => p.c)
  // 拼接后仍有余量则补充开头未被选中的块
  for (const item of scored) {
    if (used >= budget) break
    if (picked.some((p) => p.i === item.i)) continue
    if (used + item.c.length > budget) continue
    parts.push(item.c)
    used += item.c.length
  }
  return parts.join('\n\n')
}

/** 洞察生成的系统提示词 */
const INSIGHT_SYS =
  '你是文档理解引擎。请通读给出的文档内容，输出结构化理解：主题、核心论点/内容、章节结构与各部分要点、关键术语。直接输出理解结果，不要复述原文，不要寒暄。'

/** 洞察生成计划：短文单步直读；长文 map-reduce（分段摘要 → 汇总理解） */
export interface InsightPlan {
  mapSteps: LlmMessage[][]
  /** reduce：接收各分段摘要，产出最终理解（无则 mapSteps 仅一步且无需汇总） */
  buildReduce?: (summaries: string[]) => LlmMessage[]
}

/** 构建洞察生成计划 */
export function buildInsightPlan(fullText: string): InsightPlan {
  const text = fullText.trim()
  if (text.length <= INSIGHT_CHUNK) {
    return {
      mapSteps: [
        [
          { role: 'system', content: INSIGHT_SYS },
          { role: 'user', content: `【文档全文】\n${text}` }
        ]
      ]
    }
  }

  const all = splitChunks(text, INSIGHT_CHUNK)
  const chunks =
    all.length > INSIGHT_MAX_CHUNKS
      ? [...all.slice(0, INSIGHT_MAX_CHUNKS - 1), all[all.length - 1]]
      : all

  const mapSteps: LlmMessage[][] = chunks.map((c, i) => [
    { role: 'system', content: '你是文档理解引擎。用不超过120字概括给出片段的核心内容，直接输出要点，不要寒暄。' },
    { role: 'user', content: `【文档片段 ${i + 1}/${chunks.length}】\n${c}` }
  ])

  return {
    mapSteps,
    buildReduce: (summaries) => [
      { role: 'system', content: INSIGHT_SYS },
      {
        role: 'user',
        content: `【全文分段摘要（按顺序）】\n${summaries
          .map((s, i) => `[片段${i + 1}] ${s}`)
          .join('\n')}\n\n请综合以上分段摘要，输出对整篇文档的结构化理解（主题、核心论点、章节结构、关键术语），不超过500字。`
      }
    ]
  }
}

/** 问答系统提示词：强调"原文理解 + 自身知识"双来源 */
export const QA_SYSTEM_PROMPT = `你是"ReX"文档伴读助手。回答规则：
1. 优先依据【文档整体理解】与【相关原文】（或用户选中的片段）作答，涉及原文事实时保持一致；
2. 同时运用你自身的知识储备进行解释、补充与延伸；当原文信息不足或你的补充超出原文范围时，简要说明"以下为知识补充"；
3. 使用中文，条理清晰，先结论后展开。`

/** 组装问答的用户消息上下文 */
export function buildQuestionMessages(opts: {
  question: string
  insight?: string
  selection?: string
  fullText?: string
}): LlmMessage[] {
  const parts: string[] = []
  if (opts.insight) parts.push(`【文档整体理解（AI 预解析）】\n${opts.insight}`)
  if (opts.selection) {
    parts.push(`【用户选中的原文片段】\n${opts.selection}`)
  } else if (opts.fullText) {
    parts.push(`【相关原文片段】\n${pickRelevantChunks(opts.fullText, opts.question)}`)
  }
  parts.push(`【用户问题】\n${opts.question}`)
  return [{ role: 'user', content: parts.join('\n\n') }]
}
