import { useEffect, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { toast } from './TopBar'
import type { ModelProfile } from '../types'

/** 常用 OpenAI 兼容服务预设 */
const PRESETS: { label: string; baseUrl: string; model: string; needKey: boolean }[] = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needKey: true },
  { label: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', needKey: true },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', needKey: true },
  { label: '通义 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needKey: true }
]

interface DetectState {
  ok: boolean
  msg: string
}

interface ProfileForm {
  id?: string
  name: string
  kind: 'local' | 'custom'
  baseUrl: string
  apiKey: string
  model: string
}

interface SettingsModalProps {
  onClose: () => void
}

const emptyForm = (kind: 'local' | 'custom'): ProfileForm =>
  kind === 'local'
    ? { name: '本地 Ollama', kind, baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' }
    : { name: '', kind, baseUrl: '', apiKey: '', model: '' }

/** 设置弹窗：模型管理（启用切换 / Profile 增删改 / 密钥加密 / 思考模式），所有模型配置集中于此 */
export default function SettingsModal({ onClose }: SettingsModalProps) {
  const profiles = useAppStore((s) => s.profiles)
  const activeModelId = useAppStore((s) => s.activeModelId)
  const upsertProfile = useAppStore((s) => s.upsertProfile)
  const removeProfile = useAppStore((s) => s.removeProfile)
  const setActiveModel = useAppStore((s) => s.setActiveModel)
  const thinkMode = useAppStore((s) => s.thinkMode)
  const setThinkMode = useAppStore((s) => s.setThinkMode)

  /** 当前选中的 Profile id（null = 新建） */
  const [selectedId, setSelectedId] = useState<string | null>(profiles[0]?.id ?? null)
  const editing = profiles.find((p) => p.id === selectedId) ?? null
  const [form, setForm] = useState<ProfileForm>(
    editing
      ? { id: editing.id, name: editing.name, kind: editing.kind, baseUrl: editing.baseUrl, apiKey: '', model: editing.model }
      : emptyForm('custom')
  )
  const [models, setModels] = useState<string[]>([])
  const [detect, setDetect] = useState<DetectState | null>(null)
  const [busy, setBusy] = useState(false)
  /** 编辑已有 Profile 且密钥已保存时，输入框留空表示保持不变 */
  const hasStoredKey = !!editing?.apiKey

  /* 选中项变化 → 重置表单 */
  useEffect(() => {
    const p = profiles.find((x) => x.id === selectedId)
    if (p) {
      setForm({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, apiKey: '', model: p.model })
    } else {
      setForm(emptyForm('custom'))
    }
    setModels([])
    setDetect(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  /** 检测服务并拉取模型列表 */
  const detectService = async (): Promise<boolean> => {
    if (!form.baseUrl.trim()) {
      toast('请先填写服务地址')
      return false
    }
    setBusy(true)
    /* 输入框留空但已有保存密钥 → 用保存的密钥检测 */
    let key = form.apiKey.trim()
    if (!key && hasStoredKey) {
      const r = await window.rex.secure.decrypt(editing!.apiKey!)
      key = r.ok ? r.plain : ''
    }
    const r = await window.rex.llm.listModels({ baseUrl: form.baseUrl.trim(), apiKey: key || undefined })
    setBusy(false)
    if (r.ok) {
      setModels(r.models)
      setDetect({ ok: true, msg: `连接成功，发现 ${r.models.length} 个模型` })
      if (r.models.length > 0 && !r.models.includes(form.model)) {
        setForm((f) => ({ ...f, model: r.ok ? r.models[0] : f.model }))
      }
      return true
    }
    setModels([])
    setDetect({ ok: false, msg: r.error })
    return false
  }

  const save = async (): Promise<void> => {
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) {
      toast('请填写完整：名称 / 服务地址 / 模型名称')
      return
    }
    let apiKey: string | undefined
    if (form.kind === 'custom') {
      if (form.apiKey.trim()) {
        /* 新密钥 → safeStorage 加密后存储 */
        const r = await window.rex.secure.encrypt(form.apiKey.trim())
        apiKey = r.ok ? r.cipher : form.apiKey.trim()
      } else if (editing?.apiKey) {
        /* 留空 → 保持原密钥 */
        apiKey = editing.apiKey
      }
    }
    const p: ModelProfile = {
      id: editing?.id ?? `p${Date.now().toString(36)}`,
      name: form.name.trim(),
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      ...(apiKey ? { apiKey } : {})
    }
    upsertProfile(p)
    /* 演示模式下保存成功 → 自动启用该模型，便于直接测试 */
    if (activeModelId === 'mock') {
      setActiveModel(p.id)
      toast(`模型「${p.name}」已保存并启用`)
    } else {
      toast('模型配置已保存（密钥仅存本机加密）')
    }
    setSelectedId(p.id)
  }

  const del = (): void => {
    if (!editing) return
    removeProfile(editing.id)
    toast(`已删除「${editing.name}」`)
    setSelectedId(null)
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          模型设置
          <span className="close" onClick={onClose}>
            ×
          </span>
        </h3>

        <div className="settings-body">
          {/* ===== 左：Profile 列表（点击选中编辑；「启用」一键切换当前模型） ===== */}
          <div className="profile-list">
            <button
              className={`profile-item add${selectedId === null ? ' on' : ''}`}
              onClick={() => setSelectedId(null)}
            >
              ＋ 新增模型
            </button>
            {profiles.map((p) => (
              <div
                key={p.id}
                className={`profile-item${selectedId === p.id ? ' on' : ''}`}
                onClick={() => setSelectedId(p.id)}
              >
                <span className="p-icon">{p.kind === 'local' ? '🖥' : '☁️'}</span>
                <span className="p-main">
                  <span className="p-name">{p.name}</span>
                  <span className="p-model">
                    {p.model || '未配置模型'}
                    {p.kind === 'custom' && p.apiKey ? ' 🔒' : ''}
                  </span>
                </span>
                {activeModelId === p.id ? (
                  <span className="p-active" title="当前使用">
                    ● 使用中
                  </span>
                ) : (
                  <button
                    className="p-use"
                    title="启用此模型"
                    onClick={(e) => {
                      e.stopPropagation()
                      setActiveModel(p.id)
                      toast(`已切换为「${p.name}」`)
                    }}
                  >
                    启用
                  </button>
                )}
              </div>
            ))}
            {/* 演示模式：离线模拟，无需任何配置（不可编辑，仅可启用） */}
            <div className="profile-item mock">
              <span className="p-icon">✨</span>
              <span className="p-main">
                <span className="p-name">演示模式</span>
                <span className="p-model">离线模拟 · 无需配置</span>
              </span>
              {activeModelId === 'mock' ? (
                <span className="p-active" title="当前使用">
                  ● 使用中
                </span>
              ) : (
                <button
                  className="p-use"
                  title="启用演示模式"
                  onClick={() => {
                    setActiveModel('mock')
                    toast('已切换为演示模式（离线模拟）')
                  }}
                >
                  启用
                </button>
              )}
            </div>
            {profiles.length === 0 && (
              <div className="profile-empty">还没有模型配置，点上方按钮新增</div>
            )}

            {/* 全局对话偏好：思考模式（Qwen3 系） */}
            <div className="pref-box">
              <button
                className={`think-switch${thinkMode ? ' on' : ''}`}
                role="switch"
                aria-checked={thinkMode}
                title={
                  thinkMode
                    ? '深度思考：已开启（回答更全面，但更慢）· 点击切换为快速直答'
                    : '快速直答：已开启（响应更快）· 点击切换为深度思考'
                }
                onClick={() => setThinkMode(!thinkMode)}
              >
                <span className="ts-label">
                  🧠 深度思考 <em>{thinkMode ? 'ON' : 'OFF'}</em>
                </span>
                <span className="ts-track">
                  <span className="ts-knob" />
                </span>
              </button>
              <div className="pref-hint">仅 Qwen3 系模型生效；关闭时快速直答</div>
            </div>
          </div>

          {/* ===== 右：编辑表单 ===== */}
          <div className="profile-form">
            <div className="form-row">
              <label>类型</label>
              <div className="kind-switch">
                <button
                  className={form.kind === 'local' ? 'on' : ''}
                  onClick={() => setForm((f) => ({ ...f, kind: 'local' }))}
                >
                  🖥 本地（Ollama）
                </button>
                <button
                  className={form.kind === 'custom' ? 'on' : ''}
                  onClick={() => setForm((f) => ({ ...f, kind: 'custom' }))}
                >
                  ☁️ 云端 API
                </button>
              </div>
            </div>

            {form.kind === 'custom' && (
              <div className="form-row">
                <label>快速预设</label>
                <div className="preset-row">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      className="chip"
                      onClick={() => {
                        setForm((f) => ({
                          ...f,
                          baseUrl: p.baseUrl,
                          model: p.model,
                          name: f.name.trim() || p.label
                        }))
                        setDetect(null)
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="form-row">
              <label>名称</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={form.kind === 'local' ? '本地 Ollama' : '如：DeepSeek 日常'}
              />
            </div>

            <div className="form-row">
              <label>服务地址（OpenAI 兼容 baseUrl）</label>
              <div className="detect-row">
                <input
                  value={form.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  placeholder={form.kind === 'local' ? 'http://localhost:11434/v1' : 'https://api.deepseek.com/v1'}
                />
                <button className={`btn-detect${busy ? ' busy' : ''}`} onClick={() => void detectService()}>
                  {busy ? '检测中…' : '检测并获取模型'}
                </button>
              </div>
              {detect && (
                <div className={`detect-status ${detect.ok ? 'ok' : 'bad'}`}>
                  {detect.ok ? '✓ ' : '✕ '}
                  {detect.msg}
                  {!detect.ok && form.kind === 'local' && '（请确认 Ollama 已启动）'}
                </div>
              )}
            </div>

            <div className="form-row">
              <label>模型名称{models.length > 0 ? '（从服务列表选择）' : ''}</label>
              {models.length > 0 ? (
                <select value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  placeholder={form.kind === 'local' ? 'qwen3:4b' : 'deepseek-chat'}
                />
              )}
            </div>

            {form.kind === 'custom' && (
              <div className="form-row">
                <label>API Key（safeStorage 加密，仅存本机）</label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  placeholder={hasStoredKey ? '已加密保存 · 留空保持不变' : 'sk-...'}
                />
              </div>
            )}

            <div className="modal-tip">
              在列表点「启用」切换当前模型；每个文档会记住上次使用的模型。
              云端 API 不可达时自动降级本地模型；本地模型完全离线，文档内容不出本机。
            </div>

            <div className="modal-actions">
              {editing && (
                <button className="btn-danger" onClick={del}>
                  删除此模型
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button className="btn-ghost" onClick={onClose}>
                关闭
              </button>
              <button className="btn-primary" onClick={() => void save()}>
                保存
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
