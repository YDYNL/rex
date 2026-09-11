import { useEffect } from 'react'
import type { RendererProps } from './registry'
import { FAMILY_META, FAMILY_TIER } from './registry'
import { useAppStore } from '../stores/appStore'

/** 格式徽标 → 人类可读名 */
const TIER_HINT: Record<string, string> = {
  native: '已启用高保真预览',
  convert: '已启用 LibreOffice 转档预览',
  text: '已启用文本级预览（保留可读内容）',
  info: '该格式为二进制专有结构，暂以元信息展示（高保真解析已列入后续版本规划）'
}

/** 信息卡渲染器：暂不支持高保真预览的格式（dcm/nii/parquet/key/rar 等） */
export default function InfoRenderer({ doc }: RendererProps) {
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    setDocContent(
      doc.id,
      `[${doc.name.split('.').pop()?.toUpperCase() ?? '未知'} 格式] ${doc.name}。该格式为二进制结构，当前版本以元信息方式呈现；如需了解该格式本身，可以直接提问。`
    )
  }, [doc.id, doc.name, setDocContent])

  const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''
  const meta = FAMILY_META[doc.family]
  const tier = FAMILY_TIER[doc.family] ?? 'info'

  return (
    <div className="page-sheet info-view">
      <div className="info-card" data-blk="info">
        <div className="info-icon">{meta?.icon ?? '📦'}</div>
        <div className="info-name">{doc.name}</div>
        <div className="info-badge">
          {meta ? `${meta.badge} · .${ext}` : `.${ext}`}
        </div>
        <div className="info-desc">{TIER_HINT[tier]}</div>
        <div className="info-actions">
          💡 你仍可以让 AI 介绍这种文件格式的用途与打开方式
        </div>
      </div>
    </div>
  )
}
