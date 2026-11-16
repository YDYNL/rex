#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve.py — v1.6 本地文献服务（轻量、零第三方依赖，python3 直接可跑）

功能（localhost:9000）：
  1.  GET  /            打开可视化页面（scholar_literature_manager.html）
  2.  POST /upload      上传本地 PDF -> 保存到工作目录暂存区，自动触发
                        tools/ingest_pdf.py --file 完成「解析 -> 去重 -> 本地
                        LLM 增强 -> 本体实例化 -> 增量写入 v2_4 图谱/TTL ->
                        重建页面」闭环，返回处理结果 JSON：
                            { ok, status: ingested|duplicate|failed|error,
                              title, reason, ingested_total, summary }

运行：
  python3 serve.py            （默认 0.0.0.0:9000）
  python3 serve.py 9001       （指定端口）

实现细节：
  - 仅用 Python 标准库（http.server / email / json / subprocess / os），
    无需安装任何第三方包。
  - 上传为 multipart/form-data 或 application/octet-stream，均支持。
  - 服务端将上传 PDF 暂存至 <基地目录>/.ingest_inbox/ 后调用 ingest_pdf.py
    处理（由 ingest 负责复制进 data_test/论文 并去重入库）。
"""
import cgi
import json
import os
import re
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------- 目录定位：本文件位于 <Ontology>/tools/serve.py ----------
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INGEST_SCRIPT = os.path.join(BASE_DIR, "tools", "ingest_pdf.py")
HTML_FILE = os.path.join(BASE_DIR, "scholar_literature_manager.html")
INBOX = os.path.join(BASE_DIR, ".ingest_inbox")
MAX_BODY = 512 * 1024 * 1024  # 512MB 上传上限

ALLOWED_EXT = {".pdf"}


def ensure_inbox():
    os.makedirs(INBOX, exist_ok=True)


def pick_name(orig):
    """避免覆盖：若 INBOX 已有同名，加序号后缀。"""
    base = os.path.splitext(os.path.basename(orig))[0]
    ext = os.path.splitext(os.path.basename(orig))[1]
    cand = os.path.join(INBOX, base + ext)
    n = 1
    while os.path.exists(cand):
        cand = os.path.join(INBOX, f"{base}_{n}{ext}")
        n += 1
    return cand


def run_ingest(pdf_path):
    """调用 ingest_pdf.py --file，返回 (ok, summary_dict, detail_text)。"""
    env = dict(os.environ)
    try:
        r = subprocess.run(
            [sys.executable, INGEST_SCRIPT, "--file", pdf_path],
            capture_output=True, text=True, timeout=1800, env=env,
        )
    except subprocess.TimeoutExpired:
        return False, {}, "处理超时（>30min），请检查 Ollama 服务后重试"
    out = (r.stdout or "") + ("\n" + r.stderr if r.stderr else "")
    # 解析 ingest_pdf.py 打印的最终统计 JSON
    m = re.search(r"DONE\. 处理统计:\s*(\{.*?\})", out, re.S)
    summary = {}
    if m:
        try:
            summary = json.loads(m.group(1))
        except Exception:
            summary = {"raw": m.group(1)[:500]}
    ok = (r.returncode == 0)
    detail = out.strip()
    return ok, summary, detail


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---------- 公共 ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.address_string(), fmt % args))

    def _headers(self, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        extra = extra or {}
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()

    def _json_reply(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ---------- GET / ----------
    def do_GET(self):
        if self.path.split("?")[0] != "/":
            self._json_reply({"ok": False, "status": "error",
                              "reason": "未支持的路径，本服务仅提供 / 与 POST /upload"},
                             code=404)
            return
        if not os.path.exists(HTML_FILE):
            self._json_reply({"ok": False, "status": "error",
                              "reason": "find scholar_literature_manager.html failed: " + HTML_FILE},
                             code=500)
            return
        with open(HTML_FILE, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    # ---------- POST /upload ----------
    def do_POST(self):
        if self.path.split("?")[0] != "/upload":
            self._json_reply({"ok": False, "status": "error",
                              "reason": "未支持的路径，上传请 POST /upload"}, code=404)
            return
        ctype = self.headers.get("Content-Type", "")
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._json_reply({"ok": False, "status": "error",
                              "reason": "内容长度非法或超过 %d 字节上限" % MAX_BODY})
            return

        raw = self.rfile.read(length)

        # ---- 解析上传文件（支持 multipart 与裸流两种） ----
        filename = ""
        filedata = b""
        if "multipart/form-data" in ctype:
            try:
                pdict = cgi.parse_header(ctype)[1]
                boundary = pdict.get("boundary", "").encode("utf-8")
                parts = raw.split(b"--" + boundary)
                for part in parts:
                    if b"\r\n\r\n" not in part:
                        continue
                    head, _, body = part.partition(b"\r\n\r\n")
                    head_s = part[: len(head)].decode("utf-8", "ignore")
                    m = re.search(r'filename="([^"]+)"', head_s)
                    if m:
                        filename = m.group(1)
                        filedata = body.rstrip(b"\r\n")
                        break
            except Exception as e:
                self._json_reply({"ok": False, "status": "error",
                                  "reason": "multipart 解析失败: %s" % e})
                return
        else:
            # 裸流上传：文件名从查询参数 name 或 Content-Disposition 取
            try:
                cd = self.headers.get("Content-Disposition", "")
                m = re.search(r'filename="([^"]+)"', cd)
                filename = m.group(1) if m else ""
            except Exception:
                filename = ""
            if not filename:
                filename = "upload_%s.pdf" % len(raw)
            filedata = raw

        if not filedata:
            self._json_reply({"ok": False, "status": "error",
                              "reason": "未接收到文件内容"})
            return
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_EXT:
            self._json_reply({"ok": False, "status": "error",
                              "reason": "仅支持 PDF 文件（收到: %s）" % (filename or "未知")})
            return

        ensure_inbox()
        dest = pick_name(filename)
        try:
            with open(dest, "wb") as f:
                f.write(filedata)
        except OSError as e:
            self._json_reply({"ok": False, "status": "error",
                              "reason": "暂存文件写入失败: %s" % e})
            return

        # ---- 触发 ingest_pdf.py 闭环 ----
        ok, summary, detail = run_ingest(dest)

        # ---- 组装结果（优先按统计 JSON 判定，正则仅兜底） ----
        status = "unknown"
        title = ""
        reason = ""
        if ok:
            ss = summary.get("ingested", summary.get("duplicate", summary)) if isinstance(summary, dict) else None
            n_ing = int(summary.get("ingested") or 0) if isinstance(summary, dict) else 0
            n_dup = int(summary.get("duplicate") or 0) if isinstance(summary, dict) else 0
            n_upd = int(summary.get("updated") or 0) if isinstance(summary, dict) else 0
            n_fail = int(summary.get("failed") or 0) if isinstance(summary, dict) else 0
            if n_fail > 0:
                status = "failed"
            elif n_ing > 0:
                status = "ingested"
            elif n_upd > 0:
                status = "updated"
            elif n_dup > 0:
                status = "duplicate"
            else:
                body = detail
                if "命中已入库" in body or "已入库（去重命中）" in body:
                    status = "duplicate"
                elif "入库失败" in body:
                    status = "failed"
            title = summary.get("title", "") if isinstance(summary, dict) else ""
            if not title:
                mtitle = re.search(r"(?:处理)?[：:]?\s*?(?:标题|title)[^：:]*[：:]\s*([^\n]+)", detail)
                if mtitle:
                    title = mtitle.group(1).strip()
            # 试图从 detail 尾部截取关键行
            keep_lines = [l.strip() for l in detail.splitlines()
                          if any(k in l for k in ("[入库]", "[去重]", "DONE", "标题", "摘要", "失败"))]
            reason = "\n".join(keep_lines[-12:])
        else:
            status = "error"
            reason = (detail or "ingest_pdf.py 调用异常")[:1000]

        # 服务端日志留痕（供 upload_detailed_results 查看最近处理）
        ensure_inbox()
        history = os.path.join(BASE_DIR, ".ingest_inbox", "upload_history.jsonl")
        rec = {
            "file": dest, "original": filename,
            "ok": ok, "status": status, "title": title,
            "summary": summary, "detail_tail": reason,
        }
        try:
            with open(history, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            pass

        stats = summary.get("stats", summary) if isinstance(summary, dict) else {}
        self._json_reply({
            "ok": ok,
            "status": status,
            "statusText": {"ingested": "已入库（新增）", "duplicate": "已入库（去重命中，跳过新增）",
                           "updated": "已入库（修正噪声旧记录的元数据）",
                           "failed": "入库失败（如 LLM 调用失败，aiSummary 留空不编造）",
                           "error": "处理异常", "unknown": "处理完成（状态未知）"}.get(status, status),
            "title": title,
            "reason": reason,
            "saved_at": dest,
            "summary": stats,
            "detail": detail[-3000:],
        })


def main():
    ensure_inbox()
    port = 9000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("端口参数无效，使用默认 9000")
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("=" * 60)
    print("科研文献本地化管理系统 v1.6 本地服务已启动")
    print("  浏览器访问:  http://localhost:%d/" % port)
    print("  上传接口:    POST http://localhost:%d/upload" % port)
    print("  上传 PDF 将自动: 解析元数据 -> 去重 -> 本地 LLM 增强 -> 写入 v2_4 图谱 -> 重建页面")
    print("  Ctrl+C 停止")
    print("=" * 60)
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
        server.server_close()


if __name__ == "__main__":
    main()
