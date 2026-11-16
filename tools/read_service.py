# -*- coding: utf-8 -*-
"""
read_service —— 阅读板块后端服务（字节通道 + 文档解析/定位）

职责
  1. /api/read/file  : 把本地 PDF/MD/TXT 以 HTTP 字节流回吐给前端
                       （同源 iframe 可用，规避 file:// opaque origin 问题）
  2. /api/read/probe : 打开前探测（是否存在 / 大小 / mtime），供前端预检与提示
  3. /api/read/list  : 列出可阅读文档（后端权威路径，修正图谱里 file 只有 basename 的缺陷）
  4. /api/read/resolve: 名称 -> 绝对路径解析（供其他区复用）
  5. /api/read/search : 关键词检索本体 Paper 实例及其关联
                       （title/abstract/author/keyword/organization/year 等字段）

安全
  - 白名单根目录：<Ontology>/data_test/论文、<Ontology>/data_test、<Ontology>/.ingest_inbox
  - realpath 校验，禁止 ../ 越界与软链接逃逸
  - 仅允许 .pdf / .md / .txt / .html 后缀
"""

import json
import mimetypes
import os
import re
import unicodedata
import urllib.parse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SCRIPT_DIR)

PAPER_DIR = os.path.join(BASE_DIR, "data_test", "论文")
DATA_TEST_DIR = os.path.join(BASE_DIR, "data_test")
INBOX_DIR = os.path.join(BASE_DIR, ".ingest_inbox")
GRAPH_FILE = os.path.join(BASE_DIR, "scholar_literature_graph_v2_4.json")

ALLOWED_ROOTS = [PAPER_DIR, DATA_TEST_DIR, INBOX_DIR]
ALLOWED_EXT = {".pdf", ".md", ".txt", ".html", ".htm"}

CT_BY_EXT = {
    ".pdf": "application/pdf",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
}


def _norm(s):
    """用于模糊比对的归一化：去除空白/中英文标点差异/大小写差异。"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", str(s))
    out = []
    for ch in s:
        if ch.isspace():
            continue
        if ch in "_-–—·,，.。（）()[]【】+":
            continue
        out.append(ch.lower())
    return "".join(out)


def _real(p):
    try:
        return os.path.realpath(p)
    except Exception:
        return p


def is_allowed(path):
    rp = _real(path)
    for root in ALLOWED_ROOTS:
        rr = _real(root)
        if rp == rr or rp.startswith(rr + os.sep):
            return True
    return False


def _ctype(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in CT_BY_EXT:
        return CT_BY_EXT[ext]
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def _info(path, name=None):
    st = os.stat(path)
    return {
        "ok": True,
        "name": name or os.path.basename(path),
        "path": path,
        "ext": os.path.splitext(path)[1].lower().lstrip("."),
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "content_type": _ctype(path),
    }


def _iter_root(root, recursive=True):
    if not os.path.isdir(root):
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if fn.startswith("."):
                continue
            if os.path.splitext(fn)[1].lower() in ALLOWED_EXT:
                yield os.path.join(dirpath, fn)
        if not recursive:
            dirnames[:] = []


def _rank(path):
    """同名文件优先级：data_test/论文(0) < data_test(1) < .ingest_inbox(2)。

    .ingest_inbox 是上传暂存目录，其中常存在与正式库同名的副本，
    列出/解析时应优先命中正式库中的那份，避免前端出现重复条目。
    """
    rp = _real(path)
    pr = _real(PAPER_DIR)
    if rp == pr or rp.startswith(pr + os.sep):
        return 0
    dr = _real(DATA_TEST_DIR)
    if rp == dr or rp.startswith(dr + os.sep):
        return 1
    return 2


def all_docs():
    seen, out = set(), []
    for root in ALLOWED_ROOTS:
        for p in _iter_root(root):
            rp = _real(p)
            if rp in seen:
                continue
            seen.add(rp)
            out.append(rp)
    # 按 basename 去重，保留优先级最高的那份
    chosen = {}
    for p in out:
        b = os.path.basename(p)
        k = _rank(p)
        if b not in chosen or k < chosen[b][0]:
            chosen[b] = (k, p)
    return sorted((v[1] for v in chosen.values()), key=lambda p: os.path.basename(p).lower())


def resolve(name=None, path=None):
    """名称/路径 -> 磁盘绝对路径。返回 dict（ok/reason/path/...）。"""
    if path:
        p = _real(path)
        if not is_allowed(p):
            return {"ok": False, "reason": "路径不在允许的阅读目录内"}
        if not os.path.isfile(p):
            return {"ok": False, "reason": "文件不存在: " + os.path.basename(p)}
        if os.path.splitext(p)[1].lower() not in ALLOWED_EXT:
            return {"ok": False, "reason": "不支持的文件类型（仅 pdf/md/txt/html）"}
        return _info(p)

    raw = (name or "").strip()
    if not raw:
        return {"ok": False, "reason": "缺少 name 参数"}
    raw = urllib.parse.unquote(raw)
    base = os.path.basename(raw.replace("\\", "/"))
    docs = all_docs()
    # 1) 精确文件名
    for p in docs:
        if os.path.basename(p) == base:
            return _info(p)
    # 2) 归一化比对
    nb = _norm(base)
    if nb:
        hits = [p for p in docs if _norm(os.path.basename(p)) == nb]
        if len(hits) == 1:
            return _info(hits[0])
        if len(hits) > 1:
            return _info(hits[0], name=os.path.basename(hits[0]))
        # 3) 子串命中（唯一才认）
        subs = [p for p in docs if nb in _norm(os.path.basename(p)) or _norm(os.path.basename(p)) in nb]
        if len(subs) == 1:
            return _info(subs[0])
        if len(subs) > 1:
            return {"ok": False, "reason": "名称匹配到多份文档，请指定更完整的文件名",
                    "candidates": [os.path.basename(p) for p in subs[:10]]}
    return {"ok": False, "reason": "未找到文档: " + base}


def read_bytes(name=None, path=None):
    """返回 (info, raw_bytes)。失败时 info.ok=False。"""
    info = resolve(name=name, path=path)
    if not info.get("ok"):
        return info, None
    with open(info["path"], "rb") as f:
        return info, f.read()


def list_docs(limit=500):
    items = []
    for p in all_docs()[:limit]:
        try:
            items.append(_info(p))
        except Exception:
            continue
    return items


# ---------------------------------------------------------------------------
# 本体实例检索（阅读选择器搜索框）：关键词 -> Paper 实例 + 关联实体
# ---------------------------------------------------------------------------
_GRAPH_CACHE = {"mtime": None, "data": None}


def _load_graph():
    """读取图谱 JSON（按 mtime 缓存）；失败时返回空结构，绝不抛异常。"""
    try:
        mtime = os.stat(GRAPH_FILE).st_mtime
    except Exception:
        return {"nodes": [], "edges": []}
    if _GRAPH_CACHE["data"] is None or _GRAPH_CACHE["mtime"] != mtime:
        try:
            with io_open(GRAPH_FILE) as f:
                _GRAPH_CACHE["data"] = json.load(f)
            _GRAPH_CACHE["mtime"] = mtime
        except Exception:
            return _GRAPH_CACHE["data"] or {"nodes": [], "edges": []}
    return _GRAPH_CACHE["data"]


def io_open(path):
    import io as _io
    return _io.open(path, "r", encoding="utf-8")


def _split_terms(q):
    """归一化查询串并切词：空白 / 中英文逗号 / 分号 / 顿号 / 斜杠，最多 8 个词。"""
    q = unicodedata.normalize("NFKC", str(q or "")).strip().lower()
    parts = [t for t in re.split(r"[\s,\uff0c;\uff1b\u3001/|]+", q) if t]
    return parts[:8]


def _node_label(node, nid=""):
    p = (node or {}).get("properties") or {}
    return (p.get("name") or p.get("title") or p.get("file")
            or str(nid).split("#")[-1])


def search_papers(q, limit=60):
    """按关键词检索本体 Paper 实例。

    匹配字段：title / abstract(aiSummary) / author / keyword / organization /
              year / venue / researchArea / file
    多词为 AND 语义（每个词至少命中一个字段），命中权重：标题/文件名 3、作者/关键词/机构 2、其余 1。
    """
    terms = _split_terms(q)
    if not terms:
        return {"ok": False, "reason": "缺少查询关键词 q"}
    g = _load_graph()
    nodes = {}
    for n in g.get("nodes", []) or []:
        nodes[n.get("id")] = n
    out_idx = {}
    for e in g.get("edges", []) or []:
        out_idx.setdefault(e.get("source_id"), []).append(e)

    results = []
    for n in g.get("nodes", []) or []:
        if n.get("type") != "Paper":
            continue
        p = n.get("properties") or {}
        authors, keywords, orgs = [], [], []
        for e in out_idx.get(n.get("id"), []):
            t = e.get("type")
            if t == "hasAuthor":
                a = nodes.get(e.get("target_id"))
                authors.append(_node_label(a, e.get("target_id")))
                for e2 in out_idx.get((a or {}).get("id"), []):
                    if e2.get("type") == "hasAffiliation":
                        orgs.append(_node_label(nodes.get(e2.get("target_id")), e2.get("target_id")))
            elif t == "hasKeyword":
                keywords.append(_node_label(nodes.get(e.get("target_id")), e.get("target_id")))
        authors = list(dict.fromkeys([x for x in authors if x]))
        keywords = list(dict.fromkeys([x for x in keywords if x]))
        orgs = list(dict.fromkeys([x for x in orgs if x]))

        abstract = p.get("abstract") or p.get("aiSummary") or p.get("content") or ""
        fields = {
            "title": p.get("title") or "",
            "abstract": abstract,
            "author": " ".join(authors),
            "keyword": " ".join(keywords) + " " + str(p.get("autoKeywords") or ""),
            "organization": " ".join(orgs),
            "year": str(p.get("year") or ""),
            "venue": p.get("venue") or "",
            "researchArea": p.get("autoResearchArea") or "",
            "file": p.get("file") or "",
        }
        lower = dict((k, str(v).lower()) for k, v in fields.items())
        hits, score, miss = {}, 0, False
        for term in terms:
            fs = [k for k, v in lower.items() if term in v]
            if not fs:
                miss = True
                break
            hits[term] = fs
            for k in fs:
                score += 3 if k in ("title", "file") else (2 if k in ("author", "keyword", "organization") else 1)
        if miss:
            continue
        results.append({
            "name": fields["file"] or _node_label(n, n.get("id")),
            "file": fields["file"],
            "title": fields["title"] or _node_label(n, n.get("id")),
            "nid": n.get("id"),
            "year": fields["year"],
            "venue": fields["venue"],
            "authors": authors[:6],
            "keywords": keywords[:8],
            "orgs": orgs[:4],
            "summary": abstract[:180],
            "score": score,
            "hits": hits,
        })
    results.sort(key=lambda x: (-x["score"], str(x["title"])))
    return {"ok": True, "q": q, "total": len(results), "results": results[:limit]}


def content_disposition(path):
    fn = os.path.basename(path)
    quoted = urllib.parse.quote(fn)
    return "inline; filename=\"%s\"; filename*=UTF-8''%s" % (fn.encode("ascii", "ignore").decode() or "doc", quoted)


if __name__ == "__main__":
    import json
    import sys
    if len(sys.argv) > 1:
        print(json.dumps(resolve(name=sys.argv[1]), ensure_ascii=False, indent=2))
    else:
        docs = list_docs()
        print("可阅读文档 %d 份" % len(docs))
        for d in docs[:10]:
            print(" -", d["name"], d["size"])
