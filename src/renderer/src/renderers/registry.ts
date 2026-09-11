import type { ComponentType } from 'react'
import type { OpenDoc } from '../types'

/** 渲染器统一契约：每种格式族注册一个 React 组件 */
export interface RendererProps {
  doc: OpenDoc
  zoom: number
  onBlockAnchorClick: (qaId: string, blkKey: string, anchorId?: string) => void
}

/** 渲染策略分级（PRD 保真度）：
 *  native=专用高保真 / convert=LibreOffice 转 PDF / text=文本级降级 / info=元信息提示 */
export type RenderTier = 'native' | 'convert' | 'text' | 'info'

interface FamilyDef {
  icon: string
  badge: string
  badgeCls: string
  tier: RenderTier
  loader?: () => Promise<{ default: ComponentType<RendererProps> }>
}

/** 格式族定义（P0 + P1 全量，28 族 / 约 120 扩展名） */
const FAMILIES: Record<string, FamilyDef> = {
  pdf: { icon: '📕', badge: 'PDF', badgeCls: 'b-pdf', tier: 'native', loader: () => import('./PdfRenderer') },
  docx: { icon: '📘', badge: 'DOCX', badgeCls: 'b-md', tier: 'native', loader: () => import('./DocxRenderer') },
  office: { icon: '📙', badge: 'OFFICE', badgeCls: 'b-md', tier: 'convert', loader: () => import('./LibreRenderer') },
  sheet: { icon: '📊', badge: 'SHEET', badgeCls: 'b-ok', tier: 'native', loader: () => import('./SheetRenderer') },
  md: { icon: '📝', badge: 'MD', badgeCls: 'b-md', tier: 'native', loader: () => import('./MarkdownRenderer') },
  code: { icon: '💻', badge: 'CODE', badgeCls: 'b-code', tier: 'native', loader: () => import('./CodeRenderer') },
  txt: { icon: '📄', badge: 'TXT', badgeCls: 'b-txt', tier: 'native', loader: () => import('./TextRenderer') },
  image: { icon: '🖼', badge: 'IMG', badgeCls: 'b-img', tier: 'native', loader: () => import('./ImageRenderer') },
  media: { icon: '🎬', badge: 'MEDIA', badgeCls: 'b-img', tier: 'native', loader: () => import('./MediaRenderer') },
  html: { icon: '🌐', badge: 'HTML', badgeCls: 'b-code', tier: 'native', loader: () => import('./HtmlRenderer') },
  epub: { icon: '📗', badge: 'EPUB', badgeCls: 'b-md', tier: 'native', loader: () => import('./EpubRenderer') },
  ipynb: { icon: '📓', badge: 'IPYNB', badgeCls: 'b-code', tier: 'native', loader: () => import('./IpynbRenderer') },
  data: { icon: '🗂', badge: 'DATA', badgeCls: 'b-ok', tier: 'native', loader: () => import('./DataRenderer') },
  three: { icon: '🧊', badge: '3D', badgeCls: 'b-code', tier: 'native', loader: () => import('./ThreeRenderer') },
  archive: { icon: '🗜', badge: 'ZIP', badgeCls: 'b-txt', tier: 'native', loader: () => import('./ArchiveRenderer') },
  sqlite: { icon: '🗄', badge: 'DB', badgeCls: 'b-ok', tier: 'native', loader: () => import('./SqliteRenderer') },
  xmind: { icon: '🧠', badge: 'MIND', badgeCls: 'b-md', tier: 'native', loader: () => import('./XmindRenderer') },
  /** 文本级降级：科学数据 / 字幕 / 学术排版 / 基因组等（文本可读） */
  scitext: { icon: '🧬', badge: 'TEXT', badgeCls: 'b-txt', tier: 'text', loader: () => import('./TextRenderer') },
  /** 二进制信息提示：列式数据 / 医学影像 / RAR 漫画 / Apple 私有等 */
  binary: { icon: '📦', badge: 'BIN', badgeCls: 'b-txt', tier: 'info', loader: () => import('./InfoRenderer') }
}

/** 扩展名 → 格式族（PRD P0+P1 全量清单） */
const EXT_MAP: Record<string, string> = {
  // P0: PDF / Word 新版
  '.pdf': 'pdf',
  '.docx': 'docx', '.docm': 'docx', '.dotx': 'docx',
  // P0: 表格新版（xlsx 家族 + csv/tsv 原生表格渲染；ods 走 LibreOffice）
  '.xlsx': 'sheet', '.xlsm': 'sheet', '.xltx': 'sheet',
  '.csv': 'sheet', '.tsv': 'sheet',
  // P0: 文本 / Markdown
  '.md': 'md', '.markdown': 'md', '.txt': 'txt', '.log': 'txt', '.out': 'txt', '.err': 'txt',
  // P0: 网页快照
  '.html': 'html', '.htm': 'html',
  // P0: 图片
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.avif': 'image', '.svg': 'image', '.bmp': 'image',
  // P0: 计算笔记
  '.ipynb': 'ipynb',
  // P0: 分子结构（文本级预览）
  '.pdb': 'scitext', '.mol': 'scitext', '.sdf': 'scitext', '.cif': 'scitext',
  // P0: 3D 模型
  '.stl': 'three', '.obj': 'three', '.ply': 'three', '.gltf': 'three', '.glb': 'three',
  // P0: 音频
  '.mp3': 'media', '.wav': 'media', '.flac': 'media', '.aac': 'media', '.ogg': 'media', '.m4a': 'media',
  // P0: 漫画（cbz 可解；cbr=RAR 降级提示）
  '.cbz': 'archive', '.cbr': 'binary',
  // P0: 结构化数据（json 树形；xml/opml 走 data 树）
  '.json': 'data', '.xml': 'data', '.opml': 'data',
  '.yaml': 'code', '.yml': 'code', '.toml': 'code', '.ini': 'code', '.conf': 'code',
  // P0: 代码 / 日志
  '.ts': 'code', '.tsx': 'code', '.js': 'code', '.jsx': 'code', '.mjs': 'code', '.cjs': 'code',
  '.py': 'code', '.java': 'code', '.c': 'code', '.h': 'code', '.cpp': 'code', '.cs': 'code',
  '.go': 'code', '.rs': 'code', '.swift': 'code', '.kt': 'code', '.php': 'code', '.rb': 'code',
  '.sh': 'code', '.bat': 'code', '.ps1': 'code', '.sql': 'code', '.css': 'code',
  // P0: 轻量数据库
  '.sqlite': 'sqlite', '.db': 'sqlite', '.sqlite3': 'sqlite',
  // P1: 旧版 Office / 演示 / RTF / ODF（LibreOffice 转 PDF）
  '.doc': 'office', '.xls': 'office', '.ppt': 'office',
  '.pptx': 'office', '.potx': 'office', '.ppsx': 'office', '.odp': 'office', '.key': 'binary',
  '.rtf': 'office', '.odt': 'office', '.ods': 'office',
  // P1: 基因组数据（文本级）
  '.fasta': 'scitext', '.fa': 'scitext', '.fastq': 'scitext', '.fq': 'scitext',
  '.vcf': 'scitext', '.sam': 'scitext', '.bed': 'scitext', '.gff': 'scitext', '.gtf': 'scitext',
  '.bam': 'binary',
  // P1: 医学影像（二进制提示，Cornerstone3D 后续接入）
  '.dcm': 'binary', '.nii': 'binary', '.mhd': 'binary',
  // P1: 地理数据（geojson 树形 / 其余文本）
  '.geojson': 'data', '.kml': 'scitext', '.gpx': 'scitext', '.kmz': 'archive',
  '.shp': 'binary', '.shx': 'binary', '.dbf': 'sheet',
  // P1: 学术排版（文本级，KaTeX 后续增强）
  '.tex': 'scitext', '.bib': 'scitext', '.sty': 'scitext', '.cls': 'scitext',
  // P1: 电子书
  '.epub': 'epub', '.fb2': 'scitext',
  // P1: 视频
  '.mp4': 'media', '.webm': 'media', '.mov': 'media',
  // P1: 字幕（文本级）
  '.srt': 'scitext', '.ass': 'scitext', '.ssa': 'scitext', '.vtt': 'scitext', '.lrc': 'scitext',
  // P1: 思维导图
  '.xmind': 'xmind', '.mmap': 'binary', '.mindnode': 'binary',
  // P1: 大数据列式（二进制提示）
  '.parquet': 'binary', '.orc': 'binary', '.arrow': 'binary', '.feather': 'binary',
  // P1: 压缩包（zip 家族可解；其余格式提示）
  '.zip': 'archive', '.7z': 'binary', '.tar': 'archive', '.gz': 'binary', '.bz2': 'binary',
  '.xz': 'binary', '.zst': 'binary',
  // P1: 网页快照 mhtml（降级文本）
  '.mhtml': 'scitext', '.mht': 'scitext'
}

export function detectFamily(ext: string): string {
  return EXT_MAP[ext.toLowerCase()] ?? ''
}

/** 未注册但文本可读的常见扩展 → 按文本打开（兜底，提升格式广度） */
export function detectFamilyLoose(ext: string): string {
  const f = detectFamily(ext)
  if (f) return f
  return ''
}

export function getRendererLoader(
  family: string
): (() => Promise<{ default: ComponentType<RendererProps> }>) | null {
  return FAMILIES[family]?.loader ?? null
}

/** 格式徽标与图标 */
export const FAMILY_META: Record<string, { icon: string; badge: string; badgeCls: string }> =
  Object.fromEntries(
    Object.entries(FAMILIES).map(([k, v]) => [k, { icon: v.icon, badge: v.badge, badgeCls: v.badgeCls }])
  )

/** 渲染策略（保真度分级提示用） */
export const FAMILY_TIER: Record<string, RenderTier> = Object.fromEntries(
  Object.entries(FAMILIES).map(([k, v]) => [k, v.tier])
)

/** 支持编辑的格式族（纯文本类：渲染器按 readText 读取，可写回） */
export const EDITABLE_FAMILIES = new Set(['txt', 'md', 'code', 'scitext', 'html', 'data'])
