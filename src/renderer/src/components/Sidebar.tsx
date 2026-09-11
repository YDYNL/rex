import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { detectFamily, FAMILY_META } from '../renderers/registry'
import { toast } from './TopBar'

interface FsNode {
  name: string
  path: string
  isDir: boolean
  ext: string
}

/** 左栏：真实本地文件树（目录懒加载） */
export default function Sidebar() {
  const rootDir = useAppStore((s) => s.rootDir)
  const setRootDir = useAppStore((s) => s.setRootDir)
  const openDoc = useAppStore((s) => s.openDoc)
  const activeDocId = useAppStore((s) => s.activeDocId)
  const [children, setChildren] = useState<Record<string, FsNode[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // 打开根目录并加载第一级
  const loadRoot = useCallback(
    async (dir: string) => {
      const nodes = await window.rex.file.readDir(dir)
      setChildren({ [dir]: nodes })
      setExpanded({ [dir]: true })
    },
    []
  )

  useEffect(() => {
    if (rootDir) void loadRoot(rootDir)
  }, [rootDir, loadRoot])

  /* 实时监听：文件/子目录增删改名后，刷新已加载的各级目录（保持展开状态） */
  const childrenRef = useRef(children)
  childrenRef.current = children
  useEffect(() => {
    if (!rootDir) return
    void window.rex.file.watchDir(rootDir)
    const unsub = window.rex.file.onTreeChanged(() => {
      const dirs = Object.keys(childrenRef.current)
      if (dirs.length === 0) return
      void (async () => {
        const next: Record<string, FsNode[]> = {}
        for (const d of dirs) {
          next[d] = await window.rex.file.readDir(d)
        }
        setChildren(next)
      })()
    })
    return () => {
      unsub()
    }
  }, [rootDir])

  const openFolder = async (): Promise<void> => {
    const dir = await window.rex.file.openFolderDialog()
    if (dir) {
      setRootDir(dir)
      setChildren({})
      setExpanded({})
    }
  }

  const openFiles = async (): Promise<void> => {
    const paths = await window.rex.file.openFileDialog()
    if (!paths) return
    for (const p of paths) {
      openPath(p)
    }
  }

  const openPath = (path: string, name?: string, ext?: string): void => {
    const nm = name ?? path.split(/[\\/]/).pop() ?? path
    const ex = ext ?? (nm.includes('.') ? '.' + nm.split('.').pop()!.toLowerCase() : '')
    const family = detectFamily(ex)
    if (!family) {
      toast(`暂不支持 ${ex || '该格式'} 的预览（已进入格式路线图候选池）`)
      return
    }
    openDoc({ id: path, name: nm, path, family })
  }

  const toggleDir = async (dir: string): Promise<void> => {
    if (expanded[dir]) {
      setExpanded((e) => ({ ...e, [dir]: false }))
      return
    }
    if (!children[dir]) {
      const nodes = await window.rex.file.readDir(dir)
      setChildren((c) => ({ ...c, [dir]: nodes }))
    }
    setExpanded((e) => ({ ...e, [dir]: true }))
  }

  const renderNodes = (parent: string): React.ReactNode => {
    const nodes = children[parent]
    if (!nodes) return null
    return nodes.map((n) => {
      if (n.isDir) {
        const open = !!expanded[n.path]
        return (
          <div key={n.path}>
            <div className="node folder" onClick={() => void toggleDir(n.path)}>
              <span className="tw">{open ? '▾' : '▸'}</span>
              <span className="ico">📁</span>
              <span className="fname">{n.name}</span>
            </div>
            <div className={`children${open ? '' : ' closed'}`}>{renderNodes(n.path)}</div>
          </div>
        )
      }
      const meta = FAMILY_META[detectFamily(n.ext)]
      return (
        <div
          key={n.path}
          className={`node file${n.path === activeDocId ? ' active' : ''}`}
          onClick={() => openPath(n.path, n.name, n.ext)}
        >
          <span className="tw" />
          <span className="ico">{meta?.icon ?? '📄'}</span>
          <span className="fname">{n.name}</span>
          {meta && <span className={`badge ${meta.badgeCls}`}>{meta.badge}</span>}
        </div>
      )
    })
  }

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="label">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {rootDir ? rootDir.split(/[\\/]/).pop() : '本地文件夹'}
          </span>
        </div>
        <button className="open-btn" onClick={() => void openFolder()}>
          ＋ 打开文件夹
        </button>
        <button
          className="open-btn"
          style={{ marginTop: 8, background: 'var(--panel-2)', color: 'var(--text-2)', boxShadow: 'none', border: '1px solid var(--border)' }}
          onClick={() => void openFiles()}
        >
          📄 打开文件
        </button>
      </div>
      {rootDir ? (
        <>
          <div className="root-label" title={rootDir}>
            📁 {rootDir}
          </div>
          <div className="tree">{renderNodes(rootDir)}</div>
        </>
      ) : (
        <div className="tree tree-empty">
          点击「打开文件夹」
          <br />
          选择本地目录作为文件导航根
          <br />
          <br />
          当前版本支持 120+ 格式：
          <br />
          PDF / Office / 表格 / Markdown
          <br />
          代码 / 图片 / 音视频 / EPUB / 3D 等
        </div>
      )}
    </aside>
  )
}
