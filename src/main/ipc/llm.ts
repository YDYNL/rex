import { ipcMain, IpcMainInvokeEvent } from 'electron'

/**
 * OpenAI 兼容流式聊天客户端（主进程侧）
 * - 统一请求 /chat/completions（stream: true），逐段通过 llm:chunk 推送
 * - 供应商差异（DeepSeek/Kimi/GLM/通义/Ollama）全部收敛为 baseUrl + model 配置
 * - noThink：关闭 Qwen3 思考模式（/no_think 软开关 + Ollama think:false），大幅降低首字延迟
 * - 思考增量：Ollama 新版把 qwen3 推理放 reasoning_content/reasoning 字段；
 *   旧版内联 <think>…</think> 在 content 里，两侧均剥离并标记为 reasoning 推送
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmChatPayload {
  reqId: string
  baseUrl: string // 例：https://api.deepseek.com/v1
  apiKey: string
  model: string
  messages: LlmMessage[]
  /** 关闭思考模式（Qwen3 系）：跳过长推理，显著提速 */
  noThink?: boolean
}

interface ChunkPayload {
  reqId: string
  delta: string
  /** true 表示该增量是思考过程（非最终答案），UI 淡色展示 */
  reasoning?: boolean
}

export function registerLlmIpc(): void {
  /** 拉取 OpenAI 兼容 /models 列表（Ollama / DeepSeek 等通用），用于连接检测与模型下拉 */
  ipcMain.handle(
    'llm:listModels',
    async (_event: IpcMainInvokeEvent, payload: { baseUrl: string; apiKey?: string }) => {
      const { baseUrl, apiKey } = payload
      try {
        const url = baseUrl.replace(/\/+$/, '') + '/models'
        const res = await fetch(url, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
        })
        if (!res.ok) {
          return { ok: false as const, error: `HTTP ${res.status}` }
        }
        const json = (await res.json()) as { data?: { id?: string }[] }
        const models = (json.data ?? []).map((m) => m.id ?? '').filter(Boolean)
        return { ok: true as const, models }
      } catch (err) {
        const msg = String(err)
        const hint = msg.includes('fetch failed')
          ? `无法连接 ${baseUrl}（服务可能未启动或地址不对）`
          : `连接异常：${msg}`
        return { ok: false as const, error: hint }
      }
    }
  )

  ipcMain.handle('llm:chat', async (event: IpcMainInvokeEvent, payload: LlmChatPayload) => {
    const { reqId, baseUrl, apiKey, noThink } = payload
    const isLocal = /localhost|127\.0\.0\.1|\[::1\]/.test(baseUrl)
    const isQwen3 = /qwen3/i.test(payload.model)

    /* 关闭思考：Qwen3 软开关拼到 system 末尾（对其他模型无副作用则不拼） */
    let messages = payload.messages
    if (noThink && isQwen3) {
      messages = payload.messages.map((m, i) =>
        i === 0 && m.role === 'system'
          ? { ...m, content: `${m.content} /no_think` }
          : m
      )
      if (messages[0]?.role !== 'system') {
        messages = [{ role: 'system', content: '/no_think' }, ...messages]
      }
    }

    try {
      const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        /* think:false 仅本地 Ollama 附加（云端严格网关可能拒绝未知字段） */
        body: JSON.stringify({
          model: payload.model,
          messages,
          stream: true,
          ...(noThink && isLocal ? { think: false } : {})
        })
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        return { ok: false as const, error: `模型请求失败 HTTP ${res.status} ${text.slice(0, 200)}` }
      }

      /* 内联 <think> 剥离状态（旧版 Ollama 思考内容直接混在 content） */
      let inThink = false
      let tail = '' // 跨 chunk 被拆开的标签前缀缓冲

      /** 把一段 content 按 <think>/<\/think> 切分为正文与思考 */
      const splitThink = (raw: string): { text: string; reasoning: string } => {
        let buf = tail + raw
        tail = ''
        let text = ''
        let reasoning = ''
        for (;;) {
          const open = !inThink ? buf.indexOf('<think>') : -1
          const close = inThink ? buf.indexOf('</think>') : -1
          if (open === -1 && close === -1) break
          if (open !== -1 && (close === -1 || open < close)) {
            text += buf.slice(0, open)
            buf = buf.slice(open + 7)
            inThink = true
          } else {
            reasoning += buf.slice(0, close)
            buf = buf.slice(close + 8)
            inThink = false
          }
        }
        /* 尾部疑似被截断的标签前缀 → 留到下个 chunk 再判 */
        const lt = buf.lastIndexOf('<')
        if (lt !== -1 && lt > buf.length - 8 && !inThink === !buf.slice(lt).includes('>')) {
          const frag = buf.slice(lt)
          if (frag === '<' || '<think>'.startsWith(frag) || '</think>'.startsWith(frag)) {
            tail = frag
            buf = buf.slice(0, lt)
          }
        }
        if (inThink) reasoning += buf
        else text += buf
        return { text, reasoning }
      }

      // 解析 SSE 流，推送增量
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let done = false
      while (!done) {
        const { value, done: rDone } = await reader.read()
        if (rDone) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const data = t.slice(5).trim()
          if (data === '[DONE]') {
            done = true
            break
          }
          try {
            const json = JSON.parse(data) as {
              choices?: {
                delta?: {
                  content?: string
                  /* Ollama 新版：思考增量单独字段 */
                  reasoning_content?: string
                  reasoning?: string
                }
              }[]
            }
            const d = json.choices?.[0]?.delta
            if (d?.reasoning_content || d?.reasoning) {
              const chunk: ChunkPayload = {
                reqId,
                delta: d.reasoning_content ?? d.reasoning ?? '',
                reasoning: true
              }
              if (chunk.delta) event.sender.send('llm:chunk', chunk)
            }
            if (d?.content) {
              const { text, reasoning } = splitThink(d.content)
              if (reasoning) {
                event.sender.send('llm:chunk', { reqId, delta: reasoning, reasoning: true })
              }
              if (text) {
                event.sender.send('llm:chunk', { reqId, delta: text })
              }
            }
          } catch {
            /* 忽略无法解析的行 */
          }
        }
      }
      /* 流结束：残留 tail 一并按正文冲刷 */
      if (tail) {
        event.sender.send('llm:chunk', { reqId, delta: inThink ? tail : tail })
      }
      return { ok: true as const }
    } catch (err) {
      const msg = String(err)
      /* 网络级失败（不可达/断网/DNS）：标记后渲染端可自动降级本地模型 */
      const network =
        err instanceof TypeError ||
        msg.includes('fetch failed') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('timed out')
      return { ok: false as const, error: `模型请求异常：${msg}`, network: network || undefined }
    }
  })
}
