import { useEffect, useState } from 'react'
import logoUrl from '../assets/logo.png'
import type { UpdaterEvent } from '../types'

/** Toast：全局轻提示 */
let toastTimer: ReturnType<typeof setTimeout> | null = null
export function toast(msg: string): void {
  const el = document.getElementById('rex-toast')
  if (!el) return
  el.textContent = msg
  el.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400)
}

interface TopBarProps {
  onOpenSettings: () => void
}

/** 主题持久化键（默认深色：毛玻璃科技感基调） */
const LS_THEME = 'yueban.theme.v1'

/** 更新流程状态机：发现 → 横幅；下载中 → 进度；完成 → 重启安装 */
type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string; notes: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded' }

/** 顶栏：品牌 / 主题 / 设置 / 升级横幅（路径已移至中栏内部顶部悬浮显示） */
export default function TopBar({ onOpenSettings }: TopBarProps) {
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return (localStorage.getItem(LS_THEME) ?? 'dark') === 'dark'
    } catch {
      return true
    }
  })
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' })
  /** 横幅被用户手动收起（本次运行内不再弹出，例行检查发现新版本会再次提示） */
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    try {
      localStorage.setItem(LS_THEME, dark ? 'dark' : 'light')
    } catch {
      /* 忽略存储异常 */
    }
  }, [dark])

  // 订阅升级事件（主进程启动 5s 检查 + 每 6 小时例行）
  useEffect(() => {
    const off = window.rex.updater.onEvent((raw) => {
      const e = raw as UpdaterEvent
      if (e.type === 'available') {
        setUpdate({ phase: 'available', version: e.version, notes: e.notes })
        setDismissed(false)
      } else if (e.type === 'progress') {
        setUpdate({ phase: 'downloading', percent: e.percent })
      } else if (e.type === 'downloaded') {
        setUpdate({ phase: 'downloaded' })
      }
    })
    return off
  }, [])

  return (
    <header className="topbar">
      <div className="brand">
        <img className="logo-img" src={logoUrl} alt="ReX" draggable={false} />
        <small>当你看世界，世界也在看你</small>
      </div>
      <div className="top-actions">
        {update.phase !== 'idle' && !dismissed && (
          <div className={`update-banner ${update.phase}`} onClick={() => void window.rex.updater.install()}>
            {update.phase === 'available' && (
              <>
                <span className="u-badge">NEW</span>
                <span className="u-text">
                  发现新版本 v{update.version}
                  {update.notes ? ` · ${update.notes.slice(0, 30)}` : ''}
                </span>
                <button
                  className="u-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    void window.rex.updater.download()
                    setUpdate({ phase: 'downloading', percent: 0 })
                  }}
                >
                  立即更新
                </button>
                <button className="u-close" title="稍后再说" onClick={(e) => { e.stopPropagation(); setDismissed(true) }}>
                  ×
                </button>
              </>
            )}
            {update.phase === 'downloading' && (
              <>
                <span className="u-text">更新包下载中… {update.percent}%</span>
                <span className="u-progress">
                  <i style={{ width: `${update.percent}%` }} />
                </span>
              </>
            )}
            {update.phase === 'downloaded' && (
              <>
                <span className="u-badge ok">OK</span>
                <span className="u-text">更新包就绪，重启后完成安装</span>
                <button className="u-btn" onClick={() => void window.rex.updater.install()}>
                  重启安装
                </button>
              </>
            )}
          </div>
        )}
        <button
          className="icon-btn"
          title="切换主题"
          onClick={() => {
            setDark((d) => !d)
          }}
        >
          {dark ? '☀️' : '🌙'}
        </button>
        <button className="icon-btn" title="模型设置" onClick={onOpenSettings}>
          ⚙️
        </button>
      </div>
    </header>
  )
}
