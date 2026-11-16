# -*- coding: utf-8 -*-
"""
llm_bridge —— 统一模型网关（阅读板块 AI 面板 / 后端 9173 代理）

设计目标
  1. 前端不持有任何 API Key；所有模型调用经后端 9173 转发。
  2. 支持两类 Provider：
       - local  : 随包内置 llama.cpp（llama-server，OpenAI 兼容 /v1/chat/completions）；
                  也兼容本机自装 Ollama（protocol=ollama 时走 native /api/chat）
       - cloud  : 任意 OpenAI 兼容服务（/v1/chat/completions）
  3. 对外统一输出 OpenAI Chat Completions SSE 帧，前端只需处理一种流格式：
         data: {"choices":[{"delta":{"content":"..."}}]}\n\n
         data: [DONE]\n\n
     错误统一为：data: {"error":{"message":"..."}}\n\n + data: [DONE]
  4. 配置持久化在 <Ontology>/llm_config.json（0600），GET 接口做 Key 脱敏。
"""

import json
import os
import time
import urllib.error
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(BASE_DIR, "llm_config.json")

KEEP_ALIVE = "30m"
STREAM_TIMEOUT = 300
PLAIN_TIMEOUT = 60

DEFAULT_MODEL_LOCAL = "qwen3-4b"
# 随包内置 llama-server 的默认端口（main.js 启动时通过环境变量覆盖）
LOCAL_LLM_PORT = os.environ.get("WORKBENCH_LLM_PORT", "8199")
DEFAULT_LOCAL_BASE = "http://127.0.0.1:%s/v1" % LOCAL_LLM_PORT

# api_key 哨兵：前端回传该值时表示「保持原值不变」
KEY_KEEP = "__KEEP__"


class LLMError(Exception):
    """带用户可读文案的模型调用异常。"""


# --------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------
def default_config():
    return {
        "active": "local",
        "profiles": {
            "local": {
                "protocol": "openai",
                "base_url": DEFAULT_LOCAL_BASE,
                "api_key": "",
                "model": DEFAULT_MODEL_LOCAL,
                "temperature": 0.3,
                "top_p": 0.9,
                "max_tokens": 2048,
                "num_ctx": 32768,
                "think": False,
            },
            "cloud": {
                "protocol": "openai",
                "base_url": "",
                "api_key": "",
                "model": "",
                "temperature": 0.3,
                "top_p": 0.9,
                "max_tokens": 2048,
                "num_ctx": 0,
                "think": False,
            },
        },
    }


def _deep_fill(base, cur):
    """以 base 为模板补全 cur（只补缺失键，不改已有值）。"""
    out = dict(base)
    if isinstance(cur, dict):
        for k, v in base.items():
            if k in cur and cur[k] is not None:
                out[k] = _deep_fill(v, cur[k]) if isinstance(v, dict) else cur[k]
        for k, v in cur.items():
            if k not in out:
                out[k] = v
    return out


def load_config():
    cfg = default_config()
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            cfg = _deep_fill(cfg, raw)
    except Exception:
        pass
    # 兜底
    for kind in ("local", "cloud"):
        prof = cfg["profiles"].setdefault(kind, default_config()["profiles"][kind])
        prof.setdefault("protocol", "openai")
        if prof.get("protocol") not in ("openai", "ollama"):
            prof["protocol"] = "openai"
        if not prof.get("model") and kind == "local":
            prof["model"] = DEFAULT_MODEL_LOCAL
        if not (prof.get("base_url") or "").strip():
            prof["base_url"] = DEFAULT_LOCAL_BASE if kind == "local" else ""
    if cfg.get("active") not in ("local", "cloud"):
        cfg["active"] = "local"
    return cfg


def save_config(cfg):
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG_PATH)
    return cfg


def _num(v, dflt, cast=float):
    try:
        if v is None or v == "":
            return dflt
        return cast(v)
    except Exception:
        return dflt


def apply_patch(patch):
    """合并前端提交的配置补丁（仅允许白名单字段）。"""
    patch = patch if isinstance(patch, dict) else {}
    cfg = load_config()
    kind = patch.get("kind")
    if kind in ("local", "cloud"):
        if "active" in patch:
            cfg["active"] = kind
        prof = cfg["profiles"][kind]
        incoming = patch.get("profile") or {}
        if isinstance(incoming, dict):
            for key in ("base_url", "model"):
                if incoming.get(key) is not None:
                    prof[key] = str(incoming[key]).strip()
            if incoming.get("protocol") is not None:
                if incoming["protocol"] in ("ollama", "openai"):
                    prof["protocol"] = incoming["protocol"]
                else:
                    prof["protocol"] = "openai"
            if "api_key" in incoming and incoming["api_key"] not in (None, KEY_KEEP):
                prof["api_key"] = str(incoming["api_key"]).strip()
            if "temperature" in incoming:
                prof["temperature"] = _num(incoming.get("temperature"), 0.3)
            if "top_p" in incoming:
                prof["top_p"] = _num(incoming.get("top_p"), 0.9)
            if "max_tokens" in incoming:
                prof["max_tokens"] = int(_num(incoming.get("max_tokens"), 2048, int))
            if "num_ctx" in incoming:
                prof["num_ctx"] = int(_num(incoming.get("num_ctx"), 0, int))
            if "think" in incoming:
                prof["think"] = bool(incoming.get("think"))
    if patch.get("active") in ("local", "cloud") and not kind:
        cfg["active"] = patch["active"]
    save_config(cfg)
    return cfg


def masked(cfg=None):
    cfg = cfg or load_config()
    out = {"active": cfg["active"], "profiles": {}}
    for kind, prof in cfg["profiles"].items():
        item = dict(prof)
        key = item.pop("api_key", "") or ""
        item["api_key_set"] = bool(key)
        item["api_key_masked"] = (key[:3] + "..." + key[-4:]) if len(key) > 8 else ("***" if key else "")
        out["profiles"][kind] = item
    out["config_path"] = CONFIG_PATH
    return out


# --------------------------------------------------------------------------
# Endpoint 解析
# --------------------------------------------------------------------------
def _strip_tail(url):
    return (url or "").strip().rstrip("/")


def ollama_native_base(prof):
    """Ollama 原生 API 基址：把 /v1 后缀去掉。"""
    base = _strip_tail(prof.get("base_url")) or "http://127.0.0.1:11434/v1"
    if base.endswith("/v1"):
        base = base[:-3]
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return base


def openai_base(prof):
    base = _strip_tail(prof.get("base_url"))
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return base


def endpoints(kind):
    cfg = load_config()
    prof = cfg["profiles"].get(kind) or {}
    protocol = prof.get("protocol") or ("ollama" if kind == "local" else "openai")
    if protocol == "ollama":
        nb = ollama_native_base(prof)
        return {"protocol": "ollama", "chat": nb + "/api/chat",
                "tags": nb + "/api/tags", "models": nb + "/api/tags",
                "base": nb, "model": prof.get("model") or DEFAULT_MODEL_LOCAL}
    ob = openai_base(prof)
    return {"protocol": "openai", "chat": ob + "/chat/completions",
            "models": ob + "/models", "base": ob, "model": prof.get("model") or ""}


def _headers(prof):
    h = {"Content-Type": "application/json"}
    key = (prof.get("api_key") or "").strip()
    if key:
        h["Authorization"] = "Bearer " + key
    return h


def _post_json(url, payload, timeout=PLAIN_TIMEOUT, headers=None):
    req = urllib.request.Request(
        url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers or {"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore"))


def _get_json(url, timeout=15, headers=None):
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore"))


# --------------------------------------------------------------------------
# 模型列表 / 连通性
# --------------------------------------------------------------------------
def list_models(kind):
    cfg = load_config()
    prof = cfg["profiles"].get(kind) or {}
    ep = endpoints(kind)
    models = []
    note = ""
    try:
        if ep["protocol"] == "ollama":
            data = _get_json(ep["tags"], headers=_headers(prof))
            for m in data.get("models", []) or []:
                det = m.get("details") or {}
                models.append({"id": m.get("name") or m.get("model"),
                               "name": m.get("name") or m.get("model"),
                               "size": m.get("size"),
                               "ctx": det.get("context_length"),
                               "family": det.get("family") or det.get("families")})
        else:
            if not prof.get("base_url"):
                return {"ok": True, "models": [], "note": "尚未填写云端 Base URL"}
            data = _get_json(ep["models"], headers=_headers(prof))
            for m in data.get("data", []) or []:
                models.append({"id": m.get("id"), "name": m.get("id")})
    except Exception as e:
        return {"ok": False, "models": [], "error": _err_text(e), "base": ep["base"]}
    models = [m for m in models if m.get("id")]
    return {"ok": True, "models": models, "note": note, "base": ep["base"]}


def _err_text(e):
    if isinstance(e, urllib.error.HTTPError):
        try:
            body = e.read().decode("utf-8", "ignore")
        except Exception:
            body = ""
        return "HTTP %s %s %s" % (e.code, e.reason, body[:300])
    if isinstance(e, urllib.error.URLError):
        return "连接失败：%s" % (getattr(e, "reason", e),)
    return "%s: %s" % (type(e).__name__, str(e)[:300])


def test_conn(kind, model=None):
    """最小代价连通性测试：非流式一问一答。"""
    cfg = load_config()
    prof = dict(cfg["profiles"].get(kind) or {})
    if model:
        prof["model"] = model
    ep = endpoints(kind)
    prof["model"] = prof.get("model") or ep["model"]
    t0 = time.time()
    try:
        if ep["protocol"] == "ollama":
            payload = {
                "model": prof.get("model"),
                "messages": [{"role": "user", "content": "请只回复两个字：就绪"}],
                "stream": False,
                "think": bool(prof.get("think")),
                "keep_alive": KEEP_ALIVE,
                "options": {"num_predict": 24, "temperature": 0.1},
            }
            if prof.get("num_ctx"):
                payload["options"]["num_ctx"] = int(prof["num_ctx"])
            data = _post_json(ep["chat"], payload, timeout=180, headers=_headers(prof))
            reply = ((data.get("message") or {}).get("content") or "").strip()
            return {"ok": True, "protocol": "ollama", "base": ep["base"],
                    "model": data.get("model") or prof.get("model"),
                    "latency_ms": int((time.time() - t0) * 1000),
                    "reply": reply[:120] or "(空回复)",
                    "num_ctx": prof.get("num_ctx") or 0,
                    "note": "本地 Ollama 原生通道（think/keep_alive/num_ctx 生效）"}
        if not prof.get("base_url"):
            return {"ok": False, "error": "尚未填写 Base URL"}
        if not prof.get("model"):
            return {"ok": False, "error": "尚未选择/填写模型名"}
        payload = {"model": prof.get("model"),
                   "messages": [{"role": "user", "content": "请只回复两个字：就绪"}],
                   "stream": False, "max_tokens": 24, "temperature": 0.1}
        data = _post_json(ep["chat"], payload, timeout=60, headers=_headers(prof))
        reply = ""
        try:
            reply = (data["choices"][0]["message"]["content"] or "").strip()
        except Exception:
            reply = json.dumps(data, ensure_ascii=False)[:120]
        return {"ok": True, "protocol": "openai", "base": ep["base"],
                "model": data.get("model") or prof.get("model"),
                "latency_ms": int((time.time() - t0) * 1000),
                "reply": reply[:120] or "(空回复)",
                "note": "OpenAI 兼容通道"}
    except Exception as e:
        return {"ok": False, "protocol": ep["protocol"], "base": ep["base"],
                "model": prof.get("model"), "error": _err_text(e),
                "latency_ms": int((time.time() - t0) * 1000)}


# --------------------------------------------------------------------------
# 统一流式对话（OpenAI SSE 出参）
# --------------------------------------------------------------------------
def _frame(obj):
    return ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")


def _delta(text):
    return _frame({"choices": [{"delta": {"content": text}}]})


def _err_frame(msg):
    return _frame({"error": {"message": msg}})


DONE = b"data: [DONE]\n\n"


def chat_stream(messages, override=None):
    """SSE 生成器：产出 bytes 帧。"""
    cfg = load_config()
    override = override or {}
    kind = override.get("kind") or cfg.get("active") or "local"
    if kind not in ("local", "cloud"):
        kind = "local"
    prof = dict(cfg["profiles"].get(kind) or {})
    for k in ("temperature", "top_p", "max_tokens", "num_ctx", "think", "model"):
        if override.get(k) not in (None, ""):
            prof[k] = override[k]
    ep = endpoints(kind)
    prof["model"] = prof.get("model") or ep["model"]
    if not prof.get("model"):
        yield _err_frame("未选择模型（%s 通道）" % kind)
        yield DONE
        return
    if ep["protocol"] == "openai" and not prof.get("base_url"):
        yield _err_frame("云端 Base URL 未配置")
        yield DONE
        return
    try:
        if ep["protocol"] == "ollama":
            for chunk in _stream_ollama(prof, ep, messages):
                yield chunk
        else:
            for chunk in _stream_openai(prof, ep, messages):
                yield chunk
    except Exception as e:
        yield _err_frame(_err_text(e))
    yield DONE


def _stream_ollama(prof, ep, messages):
    options = {
        "temperature": _num(prof.get("temperature"), 0.3),
        "top_p": _num(prof.get("top_p"), 0.9),
        "num_predict": int(_num(prof.get("max_tokens"), 2048, int)),
    }
    ctx = int(_num(prof.get("num_ctx"), 0, int))
    if ctx > 0:
        options["num_ctx"] = ctx
    payload = {
        "model": prof.get("model"),
        "messages": messages,
        "stream": True,
        "think": bool(prof.get("think")),
        "keep_alive": KEEP_ALIVE,
        "options": options,
    }
    req = urllib.request.Request(ep["chat"], data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                 headers=_headers(prof), method="POST")
    with urllib.request.urlopen(req, timeout=STREAM_TIMEOUT) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("error"):
                yield _err_frame(str(obj["error"])[:400])
                return
            msg = obj.get("message") or {}
            piece = msg.get("content")
            if piece:
                yield _delta(piece)
            if obj.get("done"):
                return


def _stream_openai(prof, ep, messages):
    payload = {
        "model": prof.get("model"),
        "messages": messages,
        "stream": True,
        "temperature": _num(prof.get("temperature"), 0.3),
        "top_p": _num(prof.get("top_p"), 0.9),
        "max_tokens": int(_num(prof.get("max_tokens"), 2048, int)),
    }
    req = urllib.request.Request(ep["chat"], data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                 headers=_headers(prof), method="POST")
    with urllib.request.urlopen(req, timeout=STREAM_TIMEOUT) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line:
                continue
            if line.startswith("data:"):
                body = line[5:].strip()
                if body == "[DONE]":
                    return
                try:
                    obj = json.loads(body)
                except Exception:
                    continue
                if isinstance(obj, dict) and obj.get("error"):
                    yield _err_frame(str(obj["error"])[:400])
                    return
                yield _frame(obj)
                continue
            # 非 SSE 的整包 JSON（部分网关会这样返回错误）
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if isinstance(obj, dict) and obj.get("error"):
                yield _err_frame(str(obj["error"])[:400])
                return
            try:
                piece = obj["choices"][0]["message"]["content"]
                if piece:
                    yield _delta(piece)
            except Exception:
                pass


def chat_once(messages, override=None):
    """非流式一问一答（内部用途：标题生成/摘要等）。"""
    cfg = load_config()
    override = override or {}
    kind = override.get("kind") or cfg.get("active") or "local"
    prof = dict(cfg["profiles"].get(kind) or {})
    ep = endpoints(kind)
    model = prof.get("model") or ep["model"]
    try:
        if ep["protocol"] == "ollama":
            payload = {"model": model, "messages": messages, "stream": False,
                       "think": bool(prof.get("think")), "keep_alive": KEEP_ALIVE,
                       "options": {"temperature": 0.2,
                                   "num_predict": int(_num(prof.get("max_tokens"), 1024, int))}}
            if prof.get("num_ctx"):
                payload["options"]["num_ctx"] = int(prof["num_ctx"])
            data = _post_json(ep["chat"], payload, timeout=STREAM_TIMEOUT, headers=_headers(prof))
            return ((data.get("message") or {}).get("content") or "").strip()
        payload = {"model": model, "messages": messages, "stream": False,
                   "temperature": 0.2, "max_tokens": int(_num(prof.get("max_tokens"), 1024, int))}
        data = _post_json(ep["chat"], payload, timeout=STREAM_TIMEOUT, headers=_headers(prof))
        return (data["choices"][0]["message"]["content"] or "").strip()
    except Exception:
        return ""


if __name__ == "__main__":
    import sys
    kind = sys.argv[1] if len(sys.argv) > 1 else "local"
    print(json.dumps(masked(), ensure_ascii=False, indent=2))
    print(json.dumps(test_conn(kind), ensure_ascii=False, indent=2))
