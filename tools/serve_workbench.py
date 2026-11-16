#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve_workbench.py — v2.0 六大工作区服务层（semantica 全量移植 M1）
=====================================================================
在保留 v1.6 上传入图闭环的前提下，把服务端升级为「按六大工作区划分 API +
统一提交闸门 + 版本快照回滚」的地基。前端页面/模块由本服务静态托管。

端口默认 9000，可传参覆盖。

数据模型（原则：图谱 JSON 是唯一事实源，TTL/页面全部由它派生）：
    GRAPH_FILE  scholar_literature_graph_v2_4.json
    TTL_FILE    scholar_data_v2_4.ttl            (由 JSON 派生)
    ONTOLOGY    edu_scholar_ontology.ttl         (Schema 定义)
    SHAPES      edu_scholar_shapes.ttl           (SHACL 约束)
    VERSIONS    versions/ 目录                   (提交快照 + checksum + 日志)

API 一览（/api/<zone>/...）：
    graph     只读：stats / nodes / edges / search / node/{id} / neighbors
    ontology  summary / types / properties / instances / node/{id}
    commit    统一写闸门：POST /api/commit；versions / rollback / log
    manage    stats（KG 概览 + 治理摘要）【M1 骨架】
    decisions 治理审计流（change_log + governance_log）【M1 骨架】
    analyze   sparql（M4 接入 rdflib，暂 501）
    enrich    ingest(复用 /upload)、export、diff、resolve【M2/M5 渐进】
    /upload   保留 v1.6 PDF 导入闭环
    /         静态托管前端

零第三方依赖（Analyze 区 M4 起才会引入 rdflib）。
"""
import cgi
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
import copy
import queue
import select
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, quote, urlparse, parse_qs

# --------------------------------------------------------------------------
# 目录定位
# --------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))      # <Ontology>/tools
BASE_DIR = os.path.dirname(SCRIPT_DIR)                       # <Ontology>
GRAPH_FILE = os.path.join(BASE_DIR, "scholar_literature_graph_v2_4.json")
TTL_FILE = os.path.join(BASE_DIR, "scholar_data_v2_4.ttl")
ONTOLOGY_TTL = os.path.join(BASE_DIR, "edu_scholar_ontology.ttl")
SHAPES_TTL = os.path.join(BASE_DIR, "edu_scholar_shapes.ttl")
VERSIONS_DIR = os.path.join(BASE_DIR, "versions")
CHANGE_LOG = os.path.join(VERSIONS_DIR, "change_log.jsonl")
INGEST_SCRIPT = os.path.join(SCRIPT_DIR, "ingest_pdf.py")
INBOX = os.path.join(BASE_DIR, ".ingest_inbox")
MAX_BODY = 512 * 1024 * 1024
ALLOWED_EXT = {".pdf"}

if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

# 阅读板块：字节通道（read_service） + 模型网关（llm_bridge）
import read_service
import llm_bridge

# 阅读板块：翻译 / 批注持久化存储（按文件名分组的 JSON）
READ_ANN_FILE = os.path.join(BASE_DIR, "data_test", "reader_annotations.json")
_ANN_LOCK = threading.Lock()


def _load_ann_store():
    try:
        if os.path.exists(READ_ANN_FILE):
            with open(READ_ANN_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                return d
    except Exception:
        pass
    return {}


def _save_ann_store(d):
    with _ANN_LOCK:
        os.makedirs(os.path.dirname(READ_ANN_FILE), exist_ok=True)
        tmp = READ_ANN_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, READ_ANN_FILE)


def _read_annotations(fname):
    if not fname:
        return []
    return _load_ann_store().get(fname, [])

NS = "http://edu-scholar.org/ontology#"
PROV_NS = "http://www.w3.org/ns/prov#"

# --------------------------------------------------------------------------
# 本体常量（来自 edu_scholar_ontology.ttl，供轻量校验；TTL 仍为权威 Schema）
# --------------------------------------------------------------------------
CLASSES = {"Paper", "Author", "Organization", "Venue", "Keyword",
           "LocalFile", "DomainCategory"}
OBJ_PROPS = {"hasAuthor", "cites", "publishedIn", "hasKeyword", "belongsTo",
             "hasAffiliation", "hasResearchTopic", "hasPart", "related_to",
             "sourcedFrom"}
DATA_PROPS = {"researchArea", "aiSummary", "autoKeywords", "confidence",
              "title", "year", "doi", "filePath", "name", "paperType",
              "keywordName", "organizationName", "venueName"}


def now_iso():
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


# --------------------------------------------------------------------------
# 图谱加载 / 保存 / 版本快照
# --------------------------------------------------------------------------
_LOCK = threading.Lock()


def load_graph():
    with open(GRAPH_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_graph(g):
    with open(GRAPH_FILE, "w", encoding="utf-8") as f:
        json.dump(g, f, ensure_ascii=False, indent=1)


def blob_sha256(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def next_version():
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    vs = []
    for n in os.listdir(VERSIONS_DIR):
        m = re.match(r"v?(\d{6})_(\d{6})", n)
        if m:
            vs.append(m.group(1) + m.group(2))
    if vs:
        vs.sort()
        last = vs[-1]
        # last 形如 yymmddHHMMSS；+1 秒
        from datetime import datetime as _dt
        nxt = _dt.fromtimestamp(_dt.strptime(last, "%y%m%d%H%M%S").timestamp() + 1)
        return nxt.strftime("%y%m%d%H%M%S")
    return datetime.now().strftime("%y%m%d%H%M%S")


def snapshot_json(g):
    return {
        "graph_id": g.get("graph_id"),
        "meta_version": g.get("meta", {}).get("version"),
        "nodes": g.get("nodes", []),
        "edges": g.get("edges", []),
        "links": g.get("links", []),
        "n_nodes": len(g.get("nodes", [])),
        "n_edges": len(g.get("edges", [])),
        "taken_at": now_iso(),
    }


def create_snapshot(g, author="web", description="commit"):
    """执行一次快照：写入 versions/，返回 (version, checksum, path)。"""
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    version = next_version()
    # description 可能含 "/"（如实例 URL），消毒后再拼文件名，避免解释成子目录
    safe = re.sub(r'[\\/:*?"<>|\s]+', "_", description or "")[:40].strip("_") or "commit"
    path = os.path.join(VERSIONS_DIR, "%s_%s.json" % (version, safe))
    body = json.dumps(snapshot_json(g), ensure_ascii=False)
    cs = blob_sha256(body)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    # 写 change log
    rec = {
        "t": now_iso(), "version": version, "author": author,
        "action": "snapshot", "description": description,
        "checksum": cs, "file": os.path.basename(path),
        "n_nodes": len(g.get("nodes", [])), "n_edges": len(g.get("edges", [])),
    }
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    with open(CHANGE_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return version, cs, path


def append_change(action, author, payload):
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    rec = {"t": now_iso(), "action": action, "author": author,
           "payload": payload}
    with open(CHANGE_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def list_versions():
    if not os.path.isdir(VERSIONS_DIR):
        return []
    out = []
    for n in sorted(os.listdir(VERSIONS_DIR)):
        if not n.endswith(".json"):
            continue
        p = os.path.join(VERSIONS_DIR, n)
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            out.append({"version": data.get("meta_version"),
                        "snapshot": n[:-5],
                        "taken_at": data.get("taken_at"),
                        "n_nodes": data.get("n_nodes"),
                        "n_edges": data.get("n_edges"),
                        "file": n,
                        "sha": blob_sha256(open(p, encoding="utf-8").read())})
        except Exception:
            continue
    out.sort(key=lambda x: x.get("taken_at") or "", reverse=True)
    return out


def load_snapshot(version):
    """按快照 ID（文件名前缀）/ 文件名 / 图谱 meta_version 找快照，返回原始 JSON 或 None。"""
    if not os.path.isdir(VERSIONS_DIR):
        return None
    names = [n for n in os.listdir(VERSIONS_DIR) if n.endswith(".json")]
    # 1) 直接按文件名前缀（快照 ID，如 260914161447）
    for n in names:
        if n.startswith("%s_" % version) or n.startswith("v%s_" % version) or n == version:
            with open(os.path.join(VERSIONS_DIR, n), encoding="utf-8") as f:
                return json.load(f)
    # 2) 退化匹配：meta_version（如 2.24）或完整文件名
    for n in names:
        if n == version or n == "%s.json" % version:
            with open(os.path.join(VERSIONS_DIR, n), encoding="utf-8") as f:
                return json.load(f)
        try:
            with open(os.path.join(VERSIONS_DIR, n), encoding="utf-8") as f:
                data = json.load(f)
            if str(data.get("meta_version")) == str(version):
                return data
        except Exception:
            continue
    return None


# --------------------------------------------------------------------------
# 本体派生与轻量 SHACL 校验（不依赖 rdflib）
# --------------------------------------------------------------------------
def parse_ttl_simple(ttl_path):
    """极简 TTL 扫描：提取 owl:Class / rdf:Property / 类别+属性名。
    仅用于 page 展示与校验白名单，不是完整 RDF 解析。"""
    classes, obj_props, data_props = [], [], []
    if not os.path.exists(ttl_path):
        return classes, obj_props, data_props
    cur = None
    with open(ttl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.endswith("Entity") or line.endswith("a owl:Class;"):
                cur = "class"
                nm = re.match(r"([A-Za-z_][\w]+)", line.replace(" #", ""))
                if nm and nm.group(1) not in ("a", "rdf", "owl"):
                    classes.append(nm.group(1))
            if line.startswith("rdfs:subClassOf"):
                pass
    # 二次扫描更稳：优先收集 "  X a owl:Class " 模式
    classes, obj_props, data_props = _scan_ttl(ttl_path)
    return classes, obj_props, data_props


def _scan_ttl(ttl_path):
    classes, obj_props, data_props = [], [], []
    with open(ttl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            m = re.match(r"(\S+)\s+a\s+owl:Class(?:;|\.)", line)
            if m:
                nm = m.group(1).replace(NS, "")
                if nm and nm not in classes:
                    classes.append(nm)
                continue
            m = re.match(r"(\S+)\s+a\s+owl:ObjectProperty(?:;|\.)", line)
            if m:
                nm = m.group(1).replace(NS, "")
                if nm and nm not in obj_props:
                    obj_props.append(nm)
                continue
            m = re.match(r"(\S+)\s+a\s+owl:DatatypeProperty(?:;|\.)", line)
            if m:
                nm = m.group(1).replace(NS, "")
                if nm and nm not in data_props:
                    data_props.append(nm)
    return classes, obj_props, data_props


def _scan_schema_ttl(ttl_path):
    """结构化解析本体 TTL（零第三方依赖）：
    返回 (classes, obj_props, data_props)，各为 {name: {label, comment, domain, range}}。
    类/属性定义均以 'es:NAME a owl:XXX' 起句、以 '.' 结束。"""
    def _flush(cur, buf, classes, obj_props, data_props):
        if cur is None:
            return
        name, t = cur
        text = "\n".join(buf)
        rec = {}
        m = re.search(r'rdfs:label\s+"([^"]*)"@zh', text)
        if m:
            rec["label"] = m.group(1)
        m = re.search(r'rdfs:comment\s+"([^"]*)"@zh', text)
        if m:
            rec["comment"] = (m.group(1)[:220])
        m = re.search(r'\brdfs:domain\s+es:(\w+)', text)
        if m:
            rec["domain"] = m.group(1)
        m = re.search(r'\brdfs:range\s+(?:es:(\w+)|xsd:(\w+))', text)
        if m:
            rec["range"] = m.group(1) or m.group(2)
        if t == "Class":
            classes[name] = rec
        elif t == "ObjectProperty":
            obj_props[name] = rec
        else:
            data_props[name] = rec
    classes, obj_props, data_props = {}, {}, {}
    cur, buf = None, []
    try:
        with open(ttl_path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                m = re.match(r"^es:(\w+)\s+a\s+owl:(Class|ObjectProperty|DatatypeProperty)\b", s)
                if m:
                    _flush(cur, buf, classes, obj_props, data_props)
                    cur = (m.group(1), m.group(2))
                    buf = [s]
                    if s.endswith("."):
                        _flush(cur, buf, classes, obj_props, data_props)
                        cur, buf = None, []
                    continue
                if cur is not None:
                    buf.append(s)
                    if s.endswith("."):
                        _flush(cur, buf, classes, obj_props, data_props)
                        cur, buf = None, []
        _flush(cur, buf, classes, obj_props, data_props)
    except Exception:
        traceback.print_exc()
    return classes, obj_props, data_props


def _scan_shacl(shapes_path):
    """解析 SHACL：返回 { ClassName: {required:[path...], props:[{path,min,max,class,datatype}]} }。
    用于表单必填标注与校验报告的轻量展示。"""
    result = {}
    cur, prop = None, None
    try:
        with open(shapes_path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                m = re.match(r"es:(\w+)\s+a\s+sh:NodeShape", s)
                if m:
                    name = m.group(1)
                    cur = name[:-5] if name.endswith("Shape") else name
                    result.setdefault(cur, {"required": [], "props": []})
                    prop = None
                    continue
                tm = re.search(r"sh:targetClass\s+es:(\w+)", s)
                if tm:
                    cur = tm.group(1)
                    result.setdefault(cur, {"required": [], "props": []})
                    prop = None
                    continue
                pm = re.match(r"sh:path\s+es:(\w+)", s)
                if pm:
                    prop = {"path": pm.group(1), "min": 0, "max": None,
                            "class": None, "datatype": None}
                    result.setdefault(cur, {"required": [], "props": []})["props"].append(prop)
                    continue
                if prop is None or cur is None:
                    continue
                mm = re.search(r"sh:minCount\s+(\d+)", s)
                if mm:
                    prop["min"] = int(mm.group(1))
                    if prop["min"] >= 1 and prop["path"] not in result[cur]["required"]:
                        result[cur]["required"].append(prop["path"])
                am = re.search(r"sh:maxCount\s+(\d+)", s)
                if am:
                    prop["max"] = int(am.group(1))
                cm = re.search(r"sh:class\s+es:(\w+)", s)
                if cm:
                    prop["class"] = cm.group(1)
                dm = re.search(r"sh:datatype\s+xsd:(\w+)", s)
                if dm:
                    prop["datatype"] = dm.group(1)
    except Exception:
        traceback.print_exc()
    return result


KNOWN_GRAPH_OPS = {"add_node", "update", "delete_node", "add_edge", "delete_edge", "rename", "schema", "reverse"}


def validate_commit(mut_graph, changes, with_details=False):
    """轻量 SHACL 校验（JSON 层）：
    1. 变更涉及的节点/边必须存在（或新增合法）
    2. 类型必须在本体类集合
    3. 对象属性边 ex端点必须是真实存在的节点
    4. Paper 必需 title / year
    对象属性校验取「原生 + 扩展」视图（obj_props_of(ext)，与 /api/ontology/schema 同一口径）。
    返回 (ok, errors[])；with_details=True 时返回 (ok, errors[], failed[])，
    failed 为逐条失败详情（含索引 / 操作 / 节点或边标识），供前端剔除非法变更、解除连坐。
    """
    errors = []
    failed = []
    node_ids = {n.get("id") for n in mut_graph.get("nodes", [])}
    # P1-2：统一校验视图（与 /api/ontology/schema 结构链路同源）
    ext_now = load_ext()
    view = ontology_view(ext_now)
    classes = view["classes"]
    oprops = view["obj_props"]
    # P1-1：扩展类的必填属性（schema 扩展区 required → SHACL sh:minCount 1）
    req_map = ext_now.get("required") or {}
    def _check_one(ch):
        """单条变更的校验规则（P2-2：reverse 内嵌的子变更复用同一套规则）。"""
        cerr = []
        op = ch.get("operation")
        if op not in KNOWN_GRAPH_OPS:
            cerr.append("未知操作 %r（支持：%s）" % (op, ", ".join(sorted(KNOWN_GRAPH_OPS))))
        elif op == "add_node":
            typ = ch.get("type", "")
            if typ not in classes:
                cerr.append("非法类型 %s（本体类：%s）" % (typ, sorted(classes)))
            props = ch.get("properties", {}) or {}
            if typ == "Paper" and not props.get("title"):
                cerr.append("Paper 必须有 title")
            if typ == "Paper" and not props.get("year") and not props.get("yearText"):
                cerr.append("Paper 建议有 year")
            # P1-1：扩展类必填属性校验，与 TTL 扩展区 SHACL（sh:minCount 1）口径一致。
            # 空扩展类（required 为空）不设门槛，允许“仅建实例，稍后补属性”。
            for f in (req_map.get(typ) or []):
                if props.get(f) in (None, "", [], {}):
                    cerr.append("类 %s 的必填属性缺失：%s（SHACL 要求 sh:minCount 1）" % (typ, f))
        elif op == "add_edge":
            typ = ch.get("type", "")
            if typ not in oprops:
                cerr.append("非法对象属性 %s（本体对象属性：%s）" % (typ, sorted(oprops)))
            src, dst = ch.get("source_id"), ch.get("target_id")
            if src not in node_ids:
                cerr.append("source 节点不存在：%s" % src)
            if dst not in node_ids:
                cerr.append("target 节点不存在：%s" % dst)
        elif op == "update":
            nid = ch.get("id")
            if nid and nid not in node_ids:
                cerr.append("要更新的节点不存在：%s" % nid)
        elif op == "delete_edge":
            # R1（P2 顺带修复）：delete_edge 参数完整性校验。
            # 合法形态二选一：① 提供 id；② 同时提供 source_id + target_id（可选 type）精确定位。
            # 二者皆缺时 apply_commit 会退化为“按 None 匹配 → 全量删边”，必须在校验层硬拦。
            eid = ch.get("id")
            if not eid and not (ch.get("source_id") and ch.get("target_id")):
                cerr.append("delete_edge 参数不完整：必须提供 id，或同时提供 source_id + target_id"
                            "（可选 type）以精确定位一条边；禁止无 id 全量删边")
        elif op == "reverse":
            # P2-2：撤销/重做 —— 必须携带反向变更序列（由前端按已提交动作生成）
            if not (ch.get("changes") or []):
                cerr.append("reverse 必须携带非空的 changes 列表（撤销目标的反向变更）")
        return cerr

    for idx, ch in enumerate(changes):
        cerr = list(_check_one(ch))
        if ch.get("operation") == "reverse":
            for _sub in (ch.get("changes") or []):
                if isinstance(_sub, dict):
                    cerr.extend(_check_one(_sub))
        op = ch.get("operation")
        if cerr:
            item = {"index": idx, "operation": op, "errors": list(cerr)}
            if op in ("add_edge", "delete_edge"):
                item["edge"] = {"id": ch.get("id"), "type": ch.get("type"),
                                "source_id": ch.get("source_id"),
                                "target_id": ch.get("target_id")}
            else:
                item["node"] = {"id": ch.get("id"), "type": ch.get("type")}
            failed.append(item)
            errors.extend(cerr)
    if with_details:
        return (len(errors) == 0, errors, failed)
    return (len(errors) == 0, errors)


def derive_ttl(g, out_path):
    """从图谱 JSON 派生 TTL。调用 enhance_ingest.graph_to_ttl（零第三方依赖）。"""
    try:
        from enhance_ingest import graph_to_ttl
        triples = graph_to_ttl(g, out_path)
        return triples
    except Exception as e:
        traceback.print_exc()
        raise


# --------------------------------------------------------------------------
# 本体结构扩展：管理页「结构编辑」→ schema_ext.json + TTL 自动管理扩展区
# 原则：图谱 JSON 是实例的唯一事实源；本体类 / 属性的新增与修改落在
#       schema_ext.json，并由它重写 edu_scholar_ontology.ttl /
#       edu_scholar_shapes.ttl 末尾的自动管理扩展区（不动原生定义）。
# --------------------------------------------------------------------------
EXT_JSON = os.path.join(BASE_DIR, "schema_ext.json")
SCHEMA_BACKUP_DIR = os.path.join(VERSIONS_DIR, "schema")
EXT_BEGIN = "# ===== WORKBENCH EXTENSIONS (auto-managed) BEGIN ====="
EXT_END = "# ===== WORKBENCH EXTENSIONS (auto-managed) END ====="
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
XSD_TYPES = ["string", "integer", "decimal", "boolean", "date", "gYear", "anyURI"]


def default_ext():
    """扩展区数据模型。
    P2-5 新增语义位（向后兼容：老 schema_ext.json 缺键时自动补默认值）：
      subclass         {子类: [父类, ...]}                  → rdfs:subClassOf
      equivalent       [[类A, 类B], ...]                    → owl:equivalentClass（双向）
      disjoint         [[类A, 类B], ...]                    → owl:disjointWith
      value_constraints {属性: {datatype, in, min, max, pattern}} → owl:Restriction + SHACL 取值约束
    """
    return {"classes": {}, "data_props": {}, "object_props": {}, "required": {},
            "subclass": {}, "equivalent": [], "disjoint": [], "value_constraints": {},
            "updated": None}


def load_ext():
    ext = default_ext()
    try:
        with open(EXT_JSON, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k in ("classes", "data_props", "object_props", "required",
                      "subclass", "value_constraints", "rules"):
                if isinstance(data.get(k), dict):
                    ext[k] = data[k]
            for k in ("equivalent", "disjoint"):
                if isinstance(data.get(k), list):
                    ext[k] = [p for p in data[k] if isinstance(p, (list, tuple)) and len(p) == 2]
            ext["updated"] = data.get("updated")
    except Exception:
        pass
    return ext


def save_ext(ext):
    ext = dict(ext)
    ext["updated"] = now_iso()
    with open(EXT_JSON, "w", encoding="utf-8") as f:
        json.dump(ext, f, ensure_ascii=False, indent=2)
    return ext


def classes_of(ext):
    return set(CLASSES) | set((ext or {}).get("classes", {}))


def obj_props_of(ext):
    return set(OBJ_PROPS) | set((ext or {}).get("object_props", {}))


def data_props_of(ext):
    return set(DATA_PROPS) | set((ext or {}).get("data_props", {}))


def ontology_view(ext):
    """P1-2：本体统一校验视图 —— 结构链路（/api/ontology/*）与 commit 链路
    （/api/commit）共用同一份「原生 + 扩展」集合，杜绝“界面可选、后端必拒”。
    返回 {"classes": set, "obj_props": set, "data_props": set}。"""
    return {"classes": classes_of(ext),
            "obj_props": obj_props_of(ext),
            "data_props": data_props_of(ext)}


def schema_delete_guard(ext, changes):
    """扩展类 / 扩展属性删除前的数据护栏：已有实例数据时拒绝，避免孤儿实例与静默丢值。"""
    guard = []
    g_now = None
    ext = ext or {}
    for c in changes:
        op = (c.get("operation") or "").strip()
        nm = (c.get("name") or "").strip()
        if op == "delete_class" and nm in (ext.get("classes") or {}):
            if g_now is None:
                g_now = load_graph()
            cnt = sum(1 for n in g_now.get("nodes", []) if n.get("type") == nm)
            if cnt:
                guard.append("类 %s 下仍有 %d 个实例，请先在管理页删除这些实例再删类" % (nm, cnt))
        elif op == "delete_prop" and (nm in (ext.get("data_props") or {}) or nm in (ext.get("object_props") or {})):
            if g_now is None:
                g_now = load_graph()
            filled = sum(1 for n in g_now.get("nodes", [])
                         if (n.get("properties") or {}).get(nm) not in (None, "", [], {}))
            edges = sum(1 for e in g_now.get("edges", []) if e.get("type") == nm)
            if nm in (ext.get("object_props") or {}):
                # v6：关系类型允许删除，发布时级联清理该类型全部关联边（见 commit_schema_changes）
                pass
            elif filled:
                guard.append("数据属性 %s 已被使用（%d 个实例有取值），请先清空再删除" % (nm, filled))
    return guard


def apply_schema_commit(ext, changes):
    """在 ext 深拷贝上应用结构变更，返回 (ok, errors, new_ext)。"""
    mut = copy.deepcopy(ext) or default_ext()
    for k in ("classes", "data_props", "object_props", "required", "subclass",
              "equivalent", "disjoint", "value_constraints"):
        mut.setdefault(k, {} if k not in ("equivalent", "disjoint") else [])
    errors = []
    for ch in changes:
        op = (ch.get("operation") or "").strip()
        name = (ch.get("name") or "").strip()
        if op == "add_class":
            if not NAME_RE.match(name):
                errors.append("类名 %r 不合法（须字母开头，仅含字母/数字/下划线）" % name)
                continue
            if name in CLASSES or name in mut["classes"]:
                errors.append("类 %s 已存在" % name)
                continue
            mut["classes"][name] = {"label": (ch.get("label") or name).strip(),
                                    "comment": (ch.get("comment") or "").strip(), "ext": True}
        elif op == "update_class":
            if name in CLASSES:
                errors.append("原生类 %s 的标签在 edu_scholar_ontology.ttl 中维护，界面不可改" % name)
                continue
            if name not in mut["classes"]:
                errors.append("扩展类 %s 不存在" % name)
                continue
            if ch.get("label"):
                mut["classes"][name]["label"] = str(ch["label"]).strip()
            if ch.get("comment") is not None:
                mut["classes"][name]["comment"] = str(ch.get("comment") or "").strip()
        elif op == "delete_class":
            if name in CLASSES:
                errors.append("原生类 %s 不可删除" % name)
                continue
            if name not in mut["classes"]:
                errors.append("扩展类 %s 不存在" % name)
                continue
            del mut["classes"][name]
            mut["required"].pop(name, None)
            for k in ("data_props", "object_props"):
                for pn in [p for p, m in mut[k].items()
                           if m.get("domain") == name or m.get("range") == name]:
                    del mut[k][pn]
                    mut["value_constraints"].pop(pn, None)
            # P2-5：同步清理引用该类的公理边（subClassOf / 等价 / 不相交）
            mut["subclass"].pop(name, None)
            for child in list(mut["subclass"]):
                rest = [p for p in mut["subclass"][child] if p != name]
                if rest:
                    mut["subclass"][child] = rest
                else:
                    mut["subclass"].pop(child, None)
            mut["equivalent"] = [p for p in mut["equivalent"] if name not in p]
            mut["disjoint"] = [p for p in mut["disjoint"] if name not in p]
        elif op in ("add_data_prop", "add_obj_prop"):
            kind = "data_props" if op == "add_data_prop" else "object_props"
            if not NAME_RE.match(name):
                errors.append("属性名 %r 不合法（须字母开头，仅含字母/数字/下划线）" % name)
                continue
            if name in data_props_of(mut) or name in obj_props_of(mut):
                errors.append("属性 %s 已存在" % name)
                continue
            dom = (ch.get("domain") or "").strip()
            if dom not in classes_of(mut):
                errors.append("domain 类 %s 不存在（可选：%s）" % (dom, sorted(classes_of(mut))))
                continue
            if op == "add_data_prop":
                rng = (ch.get("range") or "string").strip()
                if rng not in XSD_TYPES:
                    errors.append("数据属性取值类型 %s 不支持（可选：%s）" % (rng, XSD_TYPES))
                    continue
            else:
                rng = (ch.get("range") or "").strip()
                if rng not in classes_of(mut):
                    errors.append("range 类 %s 不存在（可选：%s）" % (rng, sorted(classes_of(mut))))
                    continue
            mut[kind][name] = {"label": (ch.get("label") or name).strip(),
                               "domain": dom, "range": rng, "ext": True}
        elif op == "delete_prop":
            hit = False
            for k in ("data_props", "object_props"):
                if name in mut[k]:
                    del mut[k][name]
                    hit = True
            if not hit:
                errors.append("仅可删除扩展属性：%s 不存在或属于原生本体" % name)
            else:
                mut["value_constraints"].pop(name, None)
        elif op == "set_required":
            cls = (ch.get("cls") or ch.get("class") or "").strip()
            fields = [f for f in (ch.get("fields") or []) if f]
            if cls not in classes_of(mut):
                errors.append("类 %s 不存在" % cls)
                continue
            if cls in CLASSES:
                errors.append("原生类 %s 的必填约束在 SHACL 文件中维护，界面暂不可改" % cls)
                continue
            mut["required"][cls] = fields
        elif op in ("add_subclass", "delete_subclass"):
            # P2-5：rdfs:subClassOf（含环检测，避免自指与循环继承）
            child = (ch.get("child") or ch.get("sub") or "").strip()
            parent = (ch.get("parent") or ch.get("sup") or "").strip()
            if child not in classes_of(mut) or parent not in classes_of(mut):
                errors.append("subClassOf 两端类必须已存在：%s ⊑ %s" % (child, parent))
                continue
            if child == parent:
                errors.append("subClassOf 不允许自指：%s" % child)
                continue
            cur = [p for p in (mut["subclass"].get(child) or []) if p != child]
            if op == "add_subclass":
                # 环检测（修复 P2-5）：新增 child ⊑ parent 会成环 ⟺ 沿 parent 的
                # subClassOf 祖先链上溯能遇到 child（即 child 已是 parent 的祖先）。
                # 原实现从 child 上溯、判断 parent 是否在链上，方向相反：既漏掉真环
                # （已有 ZZTestCls ⊑ Paper 时 Paper ⊑ ZZTestCls 被放行），又把
                # 「A ⊑ C」这类已有 A ⊑ B ⊑ C 的冗余合法关系误报为环。
                seen, stack, cyclic = set(), [parent], False
                while stack:
                    c = stack.pop()
                    for p in (mut["subclass"].get(c) or []):
                        if p == child:
                            cyclic = True
                            break
                        if p not in seen:
                            seen.add(p)
                            stack.append(p)
                    if cyclic:
                        break
                if cyclic:
                    errors.append("subClassOf 会形成环：%s ⊑ %s（%s 已继承自 %s）"
                                  % (child, parent, parent, child))
                    continue
                if parent in cur:
                    errors.append("subClassOf 已存在：%s ⊑ %s" % (child, parent))
                    continue
                cur.append(parent)
                mut["subclass"][child] = cur
            else:
                if parent not in cur:
                    errors.append("subClassOf 关系不存在：%s ⊑ %s" % (child, parent))
                    continue
                cur.remove(parent)
                if cur:
                    mut["subclass"][child] = cur
                else:
                    mut["subclass"].pop(child, None)
        elif op in ("add_equivalent", "delete_equivalent", "add_disjoint", "delete_disjoint"):
            # P2-5：owl:equivalentClass / owl:disjointWith（无向，内部按字典序归一存储）
            a = (ch.get("a") or "").strip()
            b = (ch.get("b") or "").strip()
            key = "equivalent" if "equivalent" in op else "disjoint"
            if a not in classes_of(mut) or b not in classes_of(mut):
                errors.append("%s 两端类必须已存在：%s / %s" % (key, a, b))
                continue
            if a == b:
                errors.append("%s 两端类不能相同：%s" % (key, a))
                continue
            pair = sorted([a, b])
            cur = [p for p in mut[key] if isinstance(p, (list, tuple)) and len(p) == 2]
            if "add" in op:
                if any(sorted(p) == pair for p in cur):
                    errors.append("%s 已存在：%s / %s" % (key, a, b))
                    continue
                cur.append(pair)
            else:
                kept = [p for p in cur if sorted(p) != pair]
                if len(kept) == len(cur):
                    errors.append("%s 关系不存在：%s / %s" % (key, a, b))
                    continue
                cur = kept
            mut[key] = cur
        elif op in ("set_value_constraint", "delete_value_constraint"):
            # P2-5：数据属性的取值约束（SHACL sh:in / sh:minInclusive / sh:maxInclusive / sh:pattern / sh:datatype）
            pname = (ch.get("name") or ch.get("prop") or "").strip()
            if pname not in data_props_of(mut):
                errors.append("值约束仅支持数据属性：%s" % pname)
                continue
            if op == "delete_value_constraint":
                if pname not in mut["value_constraints"]:
                    errors.append("值约束不存在：%s" % pname)
                    continue
                del mut["value_constraints"][pname]
                continue
            dt = (ch.get("datatype") or "").strip()
            if dt and dt not in XSD_TYPES:
                errors.append("取值类型 %s 不支持（可选：%s）" % (dt, XSD_TYPES))
                continue
            spec = {}
            if dt:
                spec["datatype"] = dt
            vals = ch.get("in")
            if isinstance(vals, list) and vals:
                spec["in"] = [str(v).strip() for v in vals if str(v).strip()]
            bad = None
            for k in ("min", "max"):
                if ch.get(k) not in (None, ""):
                    try:
                        spec[k] = float(ch[k])
                        if float(ch[k]).is_integer():
                            spec[k] = int(ch[k])
                    except Exception:
                        bad = k
                        break
            if bad:
                errors.append("值约束 %s 必须为数字" % bad)
                continue
            pat = (ch.get("pattern") or "").strip()
            if pat:
                try:
                    re.compile(pat)
                except Exception as e:
                    errors.append("pattern 不是合法正则：%s" % str(e)[:80])
                    continue
                spec["pattern"] = pat
            if not spec:
                errors.append("值约束至少需提供 datatype / in / min / max / pattern 之一")
                continue
            mut["value_constraints"][pname] = spec
        else:
            errors.append("未知结构操作：%s" % op)
    return (len(errors) == 0), errors, mut


def reverse_schema_changes(ext_before, changes):
    """P2-1：为一批结构变更生成「反向变更序列」（供「撤销上次提交」直接回放）。
    返回序列可直接再提交给 commit_schema_changes，或包成
    {"operation": "reverse", "changes": [...]} 交给 /api/commit 的 reverse 通道。
    仅覆盖 apply_schema_commit 已支持的操作；无法求逆的项（如原生类）自动跳过。"""
    ext_before = ext_before or {}
    bc = ext_before.get("classes") or {}
    bd = ext_before.get("data_props") or {}
    bo = ext_before.get("object_props") or {}
    bv = ext_before.get("value_constraints") or {}
    breq = ext_before.get("required") or {}
    bsub = ext_before.get("subclass") or {}
    beq = ext_before.get("equivalent") or []
    bdj = ext_before.get("disjoint") or []
    known = set(bc) | set(CLASSES)
    out = []

    def _vc_inverse(pn):
        spec = bv.get(pn)
        if not spec:
            return {"operation": "delete_value_constraint", "name": pn}
        inv = {"operation": "set_value_constraint", "name": pn}
        inv.update({k: v for k, v in spec.items() if k != "name"})
        return inv

    for ch in changes or []:
        if not isinstance(ch, dict):
            continue
        op = (ch.get("operation") or "").strip()
        name = (ch.get("name") or "").strip()
        if op == "add_class":
            out.append({"operation": "delete_class", "name": name})
        elif op == "update_class":
            old = bc.get(name)
            if not old:
                continue
            inv = {"operation": "update_class", "name": name}
            if ch.get("label"):
                inv["label"] = old.get("label") or name
            if ch.get("comment") is not None:
                inv["comment"] = old.get("comment") or ""
            if len(inv) > 2:
                out.append(inv)
        elif op == "delete_class":
            old = bc.get(name)
            if not old:
                continue
            out.append({"operation": "add_class", "name": name,
                        "label": old.get("label") or name,
                        "comment": old.get("comment") or ""})
            # apply_schema_commit 的 delete_class 会级联清理属性 / 约束 / 公理，逐一恢复
            for pn, pm in bd.items():
                if (pm or {}).get("domain") == name:
                    out.append({"operation": "add_data_prop", "name": pn,
                                "label": (pm or {}).get("label") or pn,
                                "domain": name, "range": (pm or {}).get("range") or "string"})
                    out.append(_vc_inverse(pn))
            for pn, pm in bo.items():
                pdomain = (pm or {}).get("domain") or ""
                prange = (pm or {}).get("range") or ""
                if pdomain == name or prange == name:
                    if pdomain in known and prange in known:
                        out.append({"operation": "add_obj_prop", "name": pn,
                                    "label": (pm or {}).get("label") or pn,
                                    "domain": pdomain, "range": prange})
            if breq.get(name):
                out.append({"operation": "set_required", "cls": name,
                            "fields": list(breq.get(name) or [])})
            for child, parents in bsub.items():
                if child == name:
                    for p in (parents or []):
                        out.append({"operation": "add_subclass", "child": child, "parent": p})
                elif name in (parents or []):
                    out.append({"operation": "add_subclass", "child": child, "parent": name})
            for pair in beq:
                if isinstance(pair, (list, tuple)) and len(pair) == 2 and name in pair:
                    out.append({"operation": "add_equivalent", "a": pair[0], "b": pair[1]})
            for pair in bdj:
                if isinstance(pair, (list, tuple)) and len(pair) == 2 and name in pair:
                    out.append({"operation": "add_disjoint", "a": pair[0], "b": pair[1]})
        elif op in ("add_data_prop", "add_obj_prop"):
            out.append({"operation": "delete_prop", "name": name})
        elif op == "delete_prop":
            kind = str(ch.get("kind") or "").strip()
            if kind in ("data", "data_prop", "data_props", "data_property"):
                src, add = bd, "add_data_prop"
            elif kind in ("obj", "object", "object_prop", "object_props", "object_property"):
                src, add = bo, "add_obj_prop"
            else:
                src, add = (bd, "add_data_prop") if name in bd else (bo, "add_obj_prop")
            old = (src or {}).get(name)
            if not old:
                continue
            out.append({"operation": add, "name": name, "label": old.get("label") or name,
                        "domain": old.get("domain") or "", "range": old.get("range") or ""})
            out.append(_vc_inverse(name))
        elif op in ("add_subclass", "delete_subclass"):
            out.append({"operation": ("delete_subclass" if op == "add_subclass" else "add_subclass"),
                        "child": ch.get("child") or ch.get("sub"),
                        "parent": ch.get("parent") or ch.get("sup")})
        elif op in ("add_equivalent", "delete_equivalent"):
            out.append({"operation": ("delete_equivalent" if op == "add_equivalent" else "add_equivalent"),
                        "a": ch.get("a"), "b": ch.get("b")})
        elif op in ("add_disjoint", "delete_disjoint"):
            out.append({"operation": ("delete_disjoint" if op == "add_disjoint" else "add_disjoint"),
                        "a": ch.get("a"), "b": ch.get("b")})
        elif op == "set_value_constraint":
            out.append(_vc_inverse(name))
        elif op == "delete_value_constraint":
            out.append(_vc_inverse(name))
        elif op == "set_required":
            cls = (ch.get("cls") or ch.get("class") or "").strip()
            out.append({"operation": "set_required", "cls": cls,
                        "fields": list(breq.get(cls) or [])})
        # op == "reverse" 自身不再求逆（避免无限回卷）
    return out


def commit_schema_changes(changes, author="web", source="/api/ontology/schema",
                          base_rev=None, proposal=None):
    """P1-5 / P2-1：结构变更的唯一发布链路
    （/api/ontology/schema、/api/ontology/draft/publish、/api/ontology/proposal/publish 共用）。
    流程：并发前置条件(P2-4) → 删除护栏 → 结构校验 → 备份 → 写 schema_ext.json →
          重写 TTL 扩展区 → 派生数据 TTL → 版本快照(P2-1) → rev 递增 → 审计。
    返回 (http_code, payload)；护栏 / 校验拒绝按 P0-6 写 reject 审计。"""
    changes = changes or []
    # P2-1：撤销（reverse）——把顶层 reverse 展开为它承载的反向变更序列，
    # 使删除护栏 / 结构校验 / 审计全部作用于具体操作，口径与 /api/commit 的 reverse 一致。
    reverse_used = False
    expanded = []
    for _c in changes:
        if isinstance(_c, dict) and (_c.get("operation") or "").strip() == "reverse":
            _sub = [s for s in (_c.get("changes") or []) if isinstance(s, dict)]
            if not _sub:
                append_change("reject", author, {
                    "endpoint": source, "target": "schema", "ops": ["reverse"],
                    "errors": ["reverse 未携带反向变更序列"],
                })
                return 422, {"ok": False, "status": "rejected",
                             "errors": ["reverse 必须携带非空的 changes 列表（撤销目标的反向变更）"]}
            reverse_used = True
            expanded.extend(_sub)
        else:
            expanded.append(_c)
    changes = expanded
    with _LOCK:
        # P2-4：乐观并发前置校验 —— 客户端携带 base_rev 时先比对，不一致直接 409，杜绝静默覆盖
        cur_rev = read_rev()
        if base_rev not in (None, "", 0, "0"):
            try:
                want = int(base_rev)
            except Exception:
                want = -1
            if want != cur_rev:
                append_change("conflict", author, {
                    "endpoint": source, "expected_rev": want, "current_rev": cur_rev,
                    "ops": [c.get("operation") for c in changes],
                })
                return 409, {"ok": False, "status": "conflict",
                             "expected_rev": want, "current_rev": cur_rev,
                             "errors": ["本体结构已被其他会话修改（当前 rev=%d，你的基线 rev=%s），"
                                        "请刷新后重新编辑" % (cur_rev, base_rev)]}
        ext = load_ext()
        guard = schema_delete_guard(ext, changes)
        if guard:
            # P0-6：护栏拒绝也写审计（真实日志此前只有成功记录，故障无法回溯）
            append_change("reject", author, {
                "endpoint": source,
                "target": "schema",
                "ops": [c.get("operation") for c in changes],
                "names": [c.get("name") for c in changes if c.get("name")],
                "errors": guard,
            })
            return 422, {"ok": False, "status": "rejected", "errors": guard}
        ok, errors, new_ext = apply_schema_commit(ext, changes)
        if not ok:
            # P0-6：结构变更被拒同样落审计
            append_change("reject", author, {
                "endpoint": source,
                "target": "schema",
                "ops": [c.get("operation") for c in changes],
                "names": [c.get("name") for c in changes if c.get("name")],
                "errors": errors,
            })
            return 422, {"ok": False, "status": "rejected", "errors": errors}
        backup = backup_schema_files()
        save_ext(new_ext)
        # v6：删除关系类型（对象属性）时级联清理该类型全部关联边（P0-1 数据一致性）
        cascade_removed = 0
        cascade_types = []
        for _c in changes:
            if (_c.get("operation") or "").strip() == "delete_prop":
                _nm = (_c.get("name") or "").strip()
                if _nm in ((ext.get("object_props") or {})):
                    _g = load_graph()
                    _before = len(_g.get("edges", []))
                    _g["edges"] = [e for e in _g.get("edges", [])
                                   if e.get("type") != _nm]
                    _g["links"] = [e for e in _g.get("links", [])
                                   if e.get("type") != _nm]
                    cascade_removed += _before - len(_g.get("edges", []))
                    if cascade_removed:
                        save_graph(_g)
                    cascade_types.append(_nm)
        try:
            sync_ext_ttl(new_ext)
            ttl_ok, ttl_info = True, "本体 / SHACL 扩展区已重写"
        except Exception as e:
            ttl_ok, ttl_info = False, str(e)
        data_ok, data_info = True, ""
        try:
            data_info = "%d triples" % derive_ttl(load_graph(), TTL_FILE)
        except Exception as e:
            data_ok, data_info = False, str(e)
        # P2-1：发布生效才写版本快照 + 递增 rev（乐观并发基线 / 回滚定位）
        new_rev = bump_rev(source)
        snap = write_schema_snapshot(new_ext, "publish", author, source,
                                     meta={"rev": new_rev, "proposal": proposal,
                                           "ops": [c.get("operation") for c in changes]})
        append_change("schema", author, {
            "source": source,
            "rev": new_rev,
            "proposal": proposal,
            "snapshot": snap,
            "ops": [c.get("operation") for c in changes],
            "classes": sorted(new_ext.get("classes", {})),
            "object_props": sorted(new_ext.get("object_props", {})),
            "data_props": sorted(new_ext.get("data_props", {})),
            "backup": backup,
            "cascade_removed": cascade_removed,
            "cascade_types": cascade_types,
            "ttl_ok": ttl_ok, "ttl": ttl_info,
            "data_ttl_ok": data_ok, "data_ttl": data_info,
            "reverse": reverse_used,
        })
        return 200, {"ok": True, "status": "committed",
                     "source": source,
                     "rev": new_rev,
                     "etag": "srev-%d" % new_rev,
                     "reverse": reverse_used,
                     # P2-1：同时回传反向变更序列，前端「撤销上次提交」可直接回放
                     "reverse_changes": reverse_schema_changes(ext, changes),
                     "snapshot": snap,
                     "proposal": proposal,
                     "classes": sorted(new_ext.get("classes", {})),
                     "object_props": sorted(new_ext.get("object_props", {})),
                     "data_props": sorted(new_ext.get("data_props", {})),
                     "required": new_ext.get("required", {}),
                     "backup": backup,
                     "ontology_ttl": os.path.basename(ONTOLOGY_TTL),
                     "shapes_ttl": os.path.basename(SHAPES_TTL),
                     "ttl_ok": ttl_ok, "ttl_info": ttl_info,
                     "data_ttl_ok": data_ok, "data_ttl_info": data_info,
                     "errors": errors}


# --------------------------------------------------------------------------
# P1-5：本体结构草稿（/api/ontology/draft）—— 「存草稿 → 稍后继续 → 发布」
# 草稿只落 versions/drafts/（刻意不放 versions/ 顶层，避免被 list_versions 误当版本快照）；
# 不触碰 schema_ext.json / TTL，只有 publish 才走 commit_schema_changes 落盘。
# --------------------------------------------------------------------------
DRAFT_DIR = os.path.join(VERSIONS_DIR, "drafts")
DRAFT_FILE = os.path.join(DRAFT_DIR, "ontology_draft.json")
DRAFT_HIST_DIR = os.path.join(DRAFT_DIR, "history")


def workspace_key():
    """工作区标识：供前端 localStorage key 与草稿归属校验（同一工作区稳定）。"""
    return hashlib.md5(BASE_DIR.encode("utf-8")).hexdigest()[:12]


def _stamp():
    return datetime.now().strftime("%y%m%d%H%M%S")


def _archive_draft(prev):
    """把上一版草稿归档到 drafts/history/，返回归档文件名或 None。"""
    if not prev:
        return None
    try:
        os.makedirs(DRAFT_HIST_DIR, exist_ok=True)
        name = "%s_ontology_draft.json" % _stamp()
        with open(os.path.join(DRAFT_HIST_DIR, name), "w", encoding="utf-8") as f:
            json.dump(prev, f, ensure_ascii=False, indent=2)
        return name
    except Exception:
        return None


def load_draft():
    try:
        with open(DRAFT_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("changes"), list):
            return d
    except Exception:
        pass
    return None


def save_draft(changes, author="web", note=""):
    """写草稿（原子替换）：上一版先归档，再落最新；写 draft 审计。"""
    os.makedirs(DRAFT_DIR, exist_ok=True)
    archived = _archive_draft(load_draft())
    rec = {"workspace": workspace_key(), "author": author, "note": note,
           "saved_at": now_iso(), "count": len(changes or []),
           "changes": changes or [], "archived": archived}
    tmp = DRAFT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DRAFT_FILE)
    append_change("draft", author, {
        "count": rec["count"], "note": note, "archived": archived,
        "ops": [c.get("operation") for c in (changes or [])],
    })
    return rec


def clear_draft(author="web", note=""):
    """清空草稿（发布成功 / 显式放弃）：先归档留痕，再移除当前草稿文件。"""
    prev = load_draft()
    if not prev:
        return None
    _archive_draft(prev)
    try:
        os.remove(DRAFT_FILE)
        append_change("draft_cleared", author, {"note": note,
                                                "count": prev.get("count", 0)})
    except Exception:
        pass
    return prev


# --------------------------------------------------------------------------
# P2-1 编辑—暂存—发布三段式 / P2-4 乐观并发 / P2-3 一致性校验 新增支撑层
#   三段式：草稿(P1-5 已有) → 提案 proposals/（可评审） → 发布（快照 + rev + 审计）
#   并发：schema rev(versions/schema_rev.json) 与图谱 sha256 作为 ETag
#   校验：rdflib/owlrl/pyshacl 覆盖 + 一致性看板（发布前用候选 TTL 预检，不触碰真实文件）
# --------------------------------------------------------------------------
REV_FILE = os.path.join(VERSIONS_DIR, "schema_rev.json")
SNAPSHOT_DIR = os.path.join(VERSIONS_DIR, "snapshots")
PROPOSAL_DIR = os.path.join(VERSIONS_DIR, "proposals")


def read_rev():
    """当前结构版本号（无文件视为 0）。"""
    try:
        with open(REV_FILE, encoding="utf-8") as f:
            return int((json.load(f) or {}).get("rev") or 0)
    except Exception:
        return 0


def read_rev_info():
    try:
        with open(REV_FILE, encoding="utf-8") as f:
            d = json.load(f) or {}
        return {"rev": int(d.get("rev") or 0), "updated": d.get("updated") or "",
                "note": d.get("note") or ""}
    except Exception:
        return {"rev": 0, "updated": "", "note": ""}


def bump_rev(note=""):
    """发布成功后递增结构版本号，作为乐观并发（P2-4）的基线。"""
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    rev = read_rev() + 1
    tmp = REV_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"rev": rev, "updated": now_iso(), "note": note}, f,
                  ensure_ascii=False, indent=2)
    os.replace(tmp, REV_FILE)
    return rev


def blob_sha256(text):
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()


def graph_checksum():
    """图谱 JSON 内容校验和（/api/commit 的 ETag）。"""
    try:
        with open(GRAPH_FILE, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except Exception:
        return ""


def write_schema_snapshot(ext, tag, author="web", source="", meta=None):
    """P2-1：把“已发布生效”的结构落一份不可变快照到 versions/snapshots/，供回滚定位。"""
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    body = {"tag": tag, "taken_at": now_iso(), "author": author, "source": source,
            "workspace": workspace_key(), "ext": ext, "meta": meta or {}}
    text = json.dumps(body, ensure_ascii=False, indent=2)
    cs = blob_sha256(text)
    name = "%s_%s_%s.json" % (_stamp(), tag, cs[:8])
    path = os.path.join(SNAPSHOT_DIR, name)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    except Exception as e:
        return {"file": None, "checksum": cs, "error": str(e)[:120]}
    return {"file": name, "checksum": cs, "path": path,
            "classes": sorted((ext or {}).get("classes", {}) or {}),
            "counts": {"classes": len((ext or {}).get("classes", {}) or {}),
                       "object_props": len((ext or {}).get("object_props", {}) or {}),
                       "data_props": len((ext or {}).get("data_props", {}) or {})}}


def list_schema_snapshots(limit=50):
    out = []
    try:
        for fn in sorted(os.listdir(SNAPSHOT_DIR), reverse=True):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(SNAPSHOT_DIR, fn)
            item = {"file": fn, "size": os.path.getsize(p)}
            try:
                with open(p, encoding="utf-8") as f:
                    d = json.load(f) or {}
                item.update({"tag": d.get("tag"), "taken_at": d.get("taken_at"),
                             "author": d.get("author"), "source": d.get("source"),
                             "meta": d.get("meta") or {}})
            except Exception:
                pass
            out.append(item)
            if len(out) >= limit:
                break
    except Exception:
        pass
    return out


# ---- P2-1：提案（提案/评审） ----
def _proposal_path(pid):
    return os.path.join(PROPOSAL_DIR, "%s.json" % pid)


def load_proposal(pid):
    try:
        with open(_proposal_path(pid), encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and d.get("id"):
            return d
    except Exception:
        pass
    return None


def list_proposals(limit=50):
    out = []
    try:
        for fn in sorted(os.listdir(PROPOSAL_DIR), reverse=True):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(PROPOSAL_DIR, fn), encoding="utf-8") as f:
                    d = json.load(f) or {}
            except Exception:
                continue
            out.append({k: d.get(k) for k in (
                "id", "title", "author", "note", "created_at", "status", "base_rev",
                "count", "published_at", "published_rev")})
            if len(out) >= limit:
                break
    except Exception:
        pass
    return out


def save_proposal(rec):
    os.makedirs(PROPOSAL_DIR, exist_ok=True)
    path = _proposal_path(rec["id"])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return rec


def create_proposal(changes, author="web", note="", title="", base_rev=None):
    """把一批变更固化为提案（评审前不触碰已发布本体）。"""
    changes = changes or []
    if not changes:
        return None, ["提案内容为空"]
    try:
        b = int(base_rev) if base_rev not in (None, "", 0, "0") else read_rev()
    except Exception:
        b = read_rev()
    pid = "P%s-%s" % (_stamp(), blob_sha256(json.dumps(changes, ensure_ascii=False, sort_keys=True))[:6])
    rec = {"id": pid, "title": (title or ("结构变更提案 %s" % pid)).strip()[:120],
           "author": author, "note": note, "created_at": now_iso(),
           "status": "pending", "base_rev": b, "count": len(changes),
           "changes": changes, "reviews": [], "published": None}
    save_proposal(rec)
    append_change("proposal", author, {"id": pid, "count": len(changes),
                                       "ops": [c.get("operation") for c in changes]})
    return rec, []


def review_proposal(pid, decision, reviewer="web", comment=""):
    rec = load_proposal(pid)
    if not rec:
        return None, ["提案不存在：%s" % pid]
    if rec.get("status") == "published":
        return None, ["提案已发布，不可再评审：%s" % pid]
    if decision not in ("approve", "reject"):
        return None, ["decision 必须为 approve / reject"]
    rec["status"] = "approved" if decision == "approve" else "rejected"
    rec.setdefault("reviews", []).append({"at": now_iso(), "reviewer": reviewer,
                                          "decision": decision, "comment": comment,
                                          "status": rec["status"]})
    save_proposal(rec)
    append_change("proposal_review", reviewer, {"id": pid, "decision": decision,
                                                "comment": (comment or "")[:200]})
    return rec, []


def publish_proposal(pid, author="web"):
    """发布提案：走 commit_schema_changes（并发校验→护栏→校验→备份→落盘→TTL→快照→rev）。"""
    rec = load_proposal(pid)
    if not rec:
        return None, ["提案不存在：%s" % pid]
    if rec.get("status") != "approved":
        return None, ["提案需先评审通过（当前状态：%s）" % rec.get("status")]
    code, payload = commit_schema_changes(rec.get("changes") or [], author=author,
                                          source="/api/ontology/proposal/publish",
                                          base_rev=rec.get("base_rev"), proposal=pid)
    if code != 200:
        return None, (payload.get("errors") or [str(payload)]), code, payload
    rec["status"] = "published"
    rec["published_at"] = now_iso()
    rec["published_rev"] = payload.get("rev")
    rec["published"] = {"rev": payload.get("rev"), "etag": payload.get("etag"),
                        "snapshot": payload.get("snapshot")}
    save_proposal(rec)
    return {"proposal": rec, "commit": payload}, [], 200, payload


# ---- P2-3：覆盖 / 一致性看板（JSON 层 + rdflib/owlrl/pyshacl 层） ----
def native_prop_axioms(ext=None):
    """原生属性 domain/range：优先从本体 TTL 读，读不到再退回扩展定义。"""
    dom, rng = {}, {}
    try:
        from rdflib import Graph, RDFS
        g = Graph()
        g.parse(ONTOLOGY_TTL, format="turtle")
        for p, _, o in g.triples((None, RDFS.domain, None)):
            dom[str(p).rsplit("#", 1)[-1].rsplit("/", 1)[-1]] = str(o).rsplit("#", 1)[-1].rsplit("/", 1)[-1]
        for p, _, o in g.triples((None, RDFS.range, None)):
            rng[str(p).rsplit("#", 1)[-1].rsplit("/", 1)[-1]] = str(o).rsplit("#", 1)[-1].rsplit("/", 1)[-1]
    except Exception:
        pass
    for pname, spec in ((ext or {}).get("object_props") or {}).items():
        if spec.get("domain"):
            dom.setdefault(pname, spec["domain"])
        if spec.get("range"):
            rng.setdefault(pname, spec["range"])
    return dom, rng


def json_layer_report(graph=None, ext=None):
    """JSON 图谱层的覆盖 / 一致性指标（不依赖 rdflib）。"""
    g = graph if isinstance(graph, dict) else load_graph()
    ext = ext if isinstance(ext, dict) else load_ext()
    nodes = g.get("nodes", []) or []
    edges = g.get("edges", []) or []
    by_type, node_type, deg = {}, {}, {}
    for n in nodes:
        by_type.setdefault(n.get("type"), []).append(n)
        node_type[n.get("id")] = n.get("type")
    for e in edges:
        deg[e.get("source_id")] = deg.get(e.get("source_id"), 0) + 1
        deg[e.get("target_id")] = deg.get(e.get("target_id"), 0) + 1

    # 孤儿实例：无任何出入边
    orphans = [n.get("id") for n in nodes if deg.get(n.get("id"), 0) == 0]
    # 类覆盖率：实例化类 / 全部类
    all_classes = set(classes_of(ext))
    filled_classes = [c for c in by_type if by_type.get(c)]
    empty_classes = sorted(c for c in all_classes - set(filled_classes))
    # 域值冲突：边的类型与属性 domain/range 不符
    dom, rng = native_prop_axioms(ext)
    conflicts = []
    for e in edges:
        t = e.get("type")
        s, o = node_type.get(e.get("source_id")), node_type.get(e.get("target_id"))
        if not t or s is None or o is None:
            continue
        if dom.get(t) and s != dom[t]:
            conflicts.append({"kind": "domain", "prop": t, "expect": dom[t], "actual": s,
                              "edge": e.get("id") or "%s->%s" % (e.get("source_id"), e.get("target_id"))})
        if rng.get(t) and o != rng[t]:
            conflicts.append({"kind": "range", "prop": t, "expect": rng[t], "actual": o,
                              "edge": e.get("id") or "%s->%s" % (e.get("source_id"), e.get("target_id"))})
    # 必填缺失（扩展 required）
    missing = []
    for cls, fields in ((ext.get("required") or {}) or {}).items():
        for n in by_type.get(cls, []):
            props = n.get("properties") or {}
            for f in (fields or []):
                if props.get(f) in (None, "", []):
                    missing.append({"node": n.get("id"), "cls": cls, "field": f})
    # 同类型同标签重复实例
    seen, dups = {}, []
    for n in nodes:
        props = n.get("properties") or {}
        label = (props.get("name") or props.get("title") or "").strip()
        if not label:
            continue
        key = (n.get("type"), label)
        if key in seen:
            dups.append({"type": key[0], "label": label, "nodes": [seen[key], n.get("id")]})
        else:
            seen[key] = n.get("id")

    # === 三类纯结构检测（JSON 层）===
    subclass = ext.get("subclass") or {}

    # 1. subClassOf 传递闭包自反检测（环）
    class_graph = {}
    for child, parents in subclass.items():
        class_graph.setdefault(child, [])
        for p in (parents or []):
            class_graph.setdefault(p, [])
            class_graph[child].append(p)
    subcyclic = []
    def dfs(c, vis, rec):
        if vis.get(c):
            return False
        vis[c] = True
        rec[c] = True
        for n in class_graph.get(c, []):
            if not dfs(n, vis, rec):
                return False
        del rec[c]
        return True
    visited = {}
    for c in class_graph:
        if not dfs(c, visited, {}):
            subcyclic.append(c)
    subcyclic = sorted(set(subcyclic))

    # 2. 等价 / 不相交交叉冲突
    eq = ext.get("equivalent") or []
    dj = ext.get("disjoint") or []
    # 构建等价闭包（传递闭包）
    eq_cls = {}
    for a, b in eq:
        eq_cls.setdefault(a, set())
        eq_cls.setdefault(b, set())
        eq_cls[a].add(b)
        eq_cls[b].add(a)
    eq_closure = {}
    def eq_closure_build(c, stack=None):
        if c in eq_closure:
            return eq_closure[c]
        if stack is None:
            stack = set()
        if c in stack:
            eq_closure[c] = None
            return None
        stack.add(c)
        r = set()
        for e in eq_cls.get(c, []):
            r.add(e)
            cb = eq_closure_build(e, stack)
            if cb:
                r |= cb
        stack.discard(c)
        eq_closure[c] = r
        return r
    for c in list(eq_cls.keys()):
        eq_closure_build(c)

    eq_dj_conflicts = []
    for x, y in dj:
        cx = eq_closure.get(x, None)
        cy = eq_closure.get(y, None)
        if cx is not None and cy is not None:
            # 如果 x 和 y 等价（直接或间接），则不相交声明矛盾
            if x in cy or y in cx:
                eq_dj_conflicts.append({"kind": "equivalent_disjoint_conflict", "pair": [x, y]})
    eq_dj_conflicts.sort(key=lambda e: (e["pair"][0], e["pair"][1]))

    # === 结束 ===
    # 属性使用率 / 填充率
    used_edge_types = sorted({e.get("type") for e in edges if e.get("type")})
    all_obj = set(obj_props_of(ext))
    unfilled_fields = []
    for cls in by_type:
        fields = list((ext.get("required") or {}).get(cls) or [])
        for n in by_type.get(cls, []):
            for f in fields:
                if (n.get("properties") or {}).get(f) in (None, "", []):
                    unfilled_fields.append(1)
    total_required = sum(len((ext.get("required") or {}).get(cls) or []) * len(v)
                         for cls, v in by_type.items())
    n_nodes = max(len(nodes), 1)
    return {
        "generated_at": now_iso(),
        "workspace": workspace_key(),
        "scale": {"nodes": len(nodes), "edges": len(edges),
                  "classes": len(all_classes), "obj_props": len(all_obj),
                  "data_props": len(data_props_of(ext))},
        "coverage": {
            "class_coverage": round(len(filled_classes) / max(len(all_classes), 1), 4),
            "instance_attached_rate": round((len(nodes) - len(orphans)) / n_nodes, 4),
            "obj_prop_usage": round(len([p for p in used_edge_types if p in all_obj]) / max(len(all_obj), 1), 4),
            "required_fill_rate": round(1 - len(unfilled_fields) / max(total_required, 1), 4)
            if total_required else None,
            "empty_classes": empty_classes,
            "used_edge_types": used_edge_types,
            "unused_obj_props": sorted(all_obj - set(used_edge_types)),
        },
        "issues": {
            "orphan_nodes": orphans,
            "orphan_count": len(orphans),
            "domain_range_conflicts": conflicts,
            "missing_required": missing,
            "duplicate_labels": dups,
            "subcyclic_classes": subcyclic,
            "equivalent_disjoint_conflicts": eq_dj_conflicts,
        },
        "node_type_distribution": {k: len(v) for k, v in sorted(by_type.items())},
        "edge_type_distribution": {t: sum(1 for e in edges if e.get("type") == t)
                                   for t in used_edge_types},
    }


def _ext_ttl_blocks_cached():
    return _ext_ttl_blocks(load_ext())


def candidate_ttl_files(ext, tmpdir):
    """把候选 ext 渲染成临时 TTL（本体 + SHACL），供发布前预检，不触碰真实文件。"""
    os.makedirs(tmpdir, exist_ok=True)
    onto_block, shapes_block = _ext_ttl_blocks(ext)
    outs = []
    for src, block, tag in ((ONTOLOGY_TTL, onto_block, "ontology"),
                            (SHAPES_TTL, shapes_block, "shapes")):
        try:
            with open(src, encoding="utf-8") as f:
                text = f.read()
        except Exception:
            text = ""
        text = _strip_ext_block(text).rstrip() + "\n\n" + block + "\n"
        p = os.path.join(tmpdir, "%s.candidate.ttl" % tag)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        outs.append(p)
    return outs


def ttl_layer_report(cand_ontology=None, cand_shapes=None):
    """rdflib / owlrl / pyshacl 层校验：OWL 一致性 + SHACL 约束。"""
    out = {"available": False, "violations": [], "inconsistent": False}
    try:
        import rdflib
        from rdflib import Graph, RDF, OWL
        import owlrl
        import pyshacl
        try:
            from rdflib.namespace import SH
        except Exception:
            SH = None
    except Exception as e:
        out["error"] = "推理依赖不可用：%s" % str(e)[:160]
        return out
    out["available"] = True
    out["engine"] = {"rdflib": getattr(rdflib, "__version__", "?"),
                     "owlrl": getattr(owlrl, "__version__", "?"),
                     "pyshacl": getattr(pyshacl, "__version__", "?"),
                     "python": sys.version.split()[0]}
    onto_path = cand_ontology or ONTOLOGY_TTL
    shape_path = cand_shapes or SHAPES_TTL
    # 1) OWL-RL 一致性：本体 + 数据合并后闭包推理，检测 owl:Nothing
    try:
        og = Graph()
        og.parse(onto_path, format="turtle")
        dg = Graph()
        if os.path.isfile(TTL_FILE):
            dg.parse(TTL_FILE, format="turtle")
        merged = og + dg
        owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(merged)
        nothing = list(merged.subjects(RDF.type, OWL.Nothing))
        out["inconsistent"] = bool(nothing)
        out["triples_after_closure"] = len(merged)
        for s in nothing[:20]:
            out["violations"].append({"level": "error", "kind": "owl:Nothing",
                                      "msg": "推理判定不可满足/矛盾：%s" % str(s)})
    except Exception as e:
        out["reasoning_error"] = str(e)[:200]
    # 2) SHACL 约束校验
    try:
        dg2 = Graph()
        if os.path.isfile(TTL_FILE):
            dg2.parse(TTL_FILE, format="turtle")
        conforms, rg, _text = pyshacl.validate(dg2, shacl_graph=shape_path,
                                               advanced=True, allow_infos=True,
                                               allow_warnings=True, abort_on_first=False)
        out["shacl_conforms"] = bool(conforms)
        cnt = 0
        if SH is not None:
            for r in rg.subjects(RDF.type, SH.ValidationResult):
                sev = str(rg.value(r, SH.resultSeverity) or "")
                comp = str(rg.value(r, SH.sourceConstraintComponent) or "")
                out["violations"].append({
                    "level": "error" if "Violation" in sev else "warn",
                    "kind": "shacl",
                    "node": str(rg.value(r, SH.focusNode) or ""),
                    "path": str(rg.value(r, SH.resultPath) or ""),
                    "component": comp.rsplit("#", 1)[-1],
                    "msg": str(rg.value(r, SH.resultMessage) or "")[:200],
                })
                cnt += 1
                if cnt >= 50:
                    break
    except Exception as e:
        out["shacl_error"] = str(e)[:200]
    out["violation_count"] = len(out["violations"])
    return out


def ontology_health(graph=None, ext=None, ttl_layer=True, cand_ontology=None, cand_shapes=None):
    """P2-3 看板总入口：JSON 层指标 + 可选 TTL 推理层校验。"""
    rep = json_layer_report(graph, ext)
    if ttl_layer:
        rep["ttl"] = ttl_layer_report(cand_ontology, cand_shapes)
    return rep


def validate_before_publish(ext):
    """发布前预检（P2-3）：用候选 TTL 跑 SHACL + OWL 一致性，不写入任何真实文件。"""
    tmpdir = tempfile.mkdtemp(prefix="onto_cand_")
    try:
        cand = candidate_ttl_files(ext, tmpdir)
        rep = ttl_layer_report(cand[0], cand[1])
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return rep


def _ttl_escape(s):
    return str(s or "").replace("\\", "\\\\").replace('"', "'").replace("\n", " ")


def _ext_ttl_blocks(ext):
    """生成 (本体扩展块, SHACL 扩展块)。
    P2-5：本体块额外输出 rdfs:subClassOf / owl:equivalentClass / owl:disjointWith 公理、
    owl:Restriction 取值约束、SKOS 词表对齐（skos:prefLabel / skos:altLabel）与 PROV-O 溯源块；
    SHACL 块额外输出 sh:in / sh:minInclusive / sh:maxInclusive / sh:pattern / sh:datatype 取值约束。
    """
    L = [EXT_BEGIN, "",
         "# 由工作台「结构编辑」自动生成，请通过界面修改；手改会在下次提交时被覆盖。",
         "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .",
         "@prefix prov: <http://www.w3.org/ns/prov#> ."]
    for name, meta in sorted(ext.get("classes", {}).items()):
        label = _ttl_escape(meta.get("label") or name)
        L.append("")
        L.append("es:%s a owl:Class ;" % name)
        L.append('    rdfs:label "%s"@zh ;' % label)
        L.append('    skos:prefLabel "%s"@zh ;' % label)
        for alt in (meta.get("altLabels") or []):
            alt = str(alt).strip()
            if alt:
                L.append('    skos:altLabel "%s"@zh ;' % _ttl_escape(alt))
        comment = (meta.get("comment") or "").strip()
        if comment:
            L.append('    rdfs:comment "%s"@zh ;' % _ttl_escape(comment))
        L.append('    rdfs:isDefinedBy <http://edu-scholar.org/ontology> .')
    for name, meta in sorted(ext.get("data_props", {}).items()):
        L.append("")
        L.append("es:%s a owl:DatatypeProperty ;" % name)
        L.append('    rdfs:label "%s"@zh ;' % _ttl_escape(meta.get("label") or name))
        L.append("    rdfs:domain es:%s ;" % (meta.get("domain") or "Paper"))
        L.append("    rdfs:range xsd:%s ." % (meta.get("range") or "string"))
    for name, meta in sorted(ext.get("object_props", {}).items()):
        L.append("")
        L.append("es:%s a owl:ObjectProperty ;" % name)
        L.append('    rdfs:label "%s"@zh ;' % _ttl_escape(meta.get("label") or name))
        L.append("    rdfs:domain es:%s ;" % (meta.get("domain") or "Paper"))
        L.append("    rdfs:range es:%s ." % (meta.get("range") or "Paper"))
    # ---- P2-5：类公理（subClassOf / 等价类 / 不相交） ----
    sub = ext.get("subclass") or {}
    eq = [p for p in (ext.get("equivalent") or []) if len(p) == 2]
    dj = [p for p in (ext.get("disjoint") or []) if len(p) == 2]
    L.append("")
    L.append("# --- P2-5 类公理：subClassOf / equivalentClass / disjointWith ---")
    for child in sorted(sub):
        for parent in sorted(sub[child]):
            if parent != child:
                L.append("es:%s rdfs:subClassOf es:%s ." % (child, parent))
    for a, b in sorted(eq):
        L.append("es:%s owl:equivalentClass es:%s ." % (a, b))
    for a, b in sorted(dj):
        L.append("es:%s owl:disjointWith es:%s ." % (a, b))
    # ---- P2-5：取值约束（OWL2 datatype restriction；与 SHACL 同口径） ----
    vcs = ext.get("value_constraints") or {}
    if vcs:
        L.append("")
        L.append("# --- P2-5 取值约束（owl:Restriction） ---")
    for pname in sorted(vcs):
        spec = vcs[pname] or {}
        dt = spec.get("datatype") or "string"
        facets = []
        if spec.get("min") is not None:
            facets.append("[ xsd:minInclusive %s ]" % spec["min"])
        if spec.get("max") is not None:
            facets.append("[ xsd:maxInclusive %s ]" % spec["max"])
        if spec.get("pattern"):
            facets.append('[ xsd:pattern "%s" ]' % _ttl_escape(spec["pattern"]))
        if spec.get("in"):
            L.append("# es:%s 允许取值：%s" % (pname, ", ".join('"%s"' % _ttl_escape(v) for v in spec["in"])))
        if not facets:
            continue
        L.append("es:%sConstraint a owl:Restriction ;" % pname)
        L.append("    owl:onProperty es:%s ;" % pname)
        L.append("    owl:allValuesFrom [ a rdfs:Datatype ;")
        L.append("        owl:onDatatype xsd:%s ;" % dt)
        L.append("        owl:withRestrictions ( %s ) ] ." % " ".join(facets))
    # ---- P2-5：PROV-O 溯源（扩展集生成活动） ----
    L.append("")
    L.append("# --- P2-5 溯源：PROV-O ---")
    L.append("es:workbench-extensions a prov:Entity ;")
    L.append('    rdfs:label "工作台扩展区（自动生成）"@zh ;')
    L.append('    prov:generatedAtTime "%s"^^xsd:dateTime ;' % now_iso())
    L.append('    prov:wasAttributedTo <http://edu-scholar.org/ontology#WorkbenchUI> .')
    L.append("")
    L.append(EXT_END)
    ontology_block = "\n".join(L)

    S = [EXT_BEGIN, "",
         "# 扩展类的新增必填约束 + 取值约束（由工作台「结构编辑」生成）。"]
    reqs = ext.get("required") or {}
    for cls in sorted(ext.get("classes", {})):
        fields = reqs.get(cls) or []
        if not fields:
            continue
        S.append("")
        S.append("es:%sShape a sh:NodeShape ;" % cls)
        S.append("    sh:targetClass es:%s" % cls)
        for f in fields:
            S.append(" ;\n    sh:property [ sh:path es:%s ; sh:minCount 1 ]" % f)
        S[-1] = S[-1] + " ."
    # P2-5：取值约束落 SHACL（按“属性主体”定位，无需预先知道 domain 类）
    for pname in sorted(vcs):
        spec = vcs[pname] or {}
        cons = []
        if spec.get("datatype"):
            cons.append("sh:datatype xsd:%s" % spec["datatype"])
        if spec.get("in"):
            cons.append('sh:in ( %s )' % " ".join('"%s"' % _ttl_escape(v) for v in spec["in"]))
        if spec.get("min") is not None:
            cons.append("sh:minInclusive %s" % spec["min"])
        if spec.get("max") is not None:
            cons.append("sh:maxInclusive %s" % spec["max"])
        if spec.get("pattern"):
            cons.append('sh:pattern "%s"' % _ttl_escape(spec["pattern"]))
        if not cons:
            continue
        S.append("")
        S.append("es:%sValueShape a sh:NodeShape ;" % pname)
        S.append("    sh:targetSubjectsOf es:%s ;" % pname)
        S.append("    sh:property [ sh:path es:%s ;" % pname)
        for c in cons[:-1]:
            S.append("        %s ;" % c)
        S.append("        %s ] ." % cons[-1])
    S.append("")
    S.append(EXT_END)
    shapes_block = "\n".join(S)
    return ontology_block, shapes_block


def _strip_ext_block(text):
    i = text.find(EXT_BEGIN)
    if i < 0:
        return text
    j = text.find(EXT_END)
    if j < 0:
        return text[:i]
    return text[:i] + text[j + len(EXT_END):]


def backup_schema_files():
    """结构编辑前备份本体 / SHACL / 扩展 JSON。"""
    os.makedirs(SCHEMA_BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%y%m%d%H%M%S")
    saved = []
    for p in (ONTOLOGY_TTL, SHAPES_TTL, EXT_JSON):
        if os.path.isfile(p):
            dst = os.path.join(SCHEMA_BACKUP_DIR, "%s_%s" % (stamp, os.path.basename(p)))
            shutil.copy2(p, dst)
            saved.append(os.path.basename(dst))
    return {"stamp": stamp, "files": saved}


def sync_ext_ttl(ext):
    """把扩展定义重写进本体 / SHACL 文件的扩展区（先剔除旧扩展区，保证幂等）。"""
    ontology_block, shapes_block = _ext_ttl_blocks(ext)
    for path, block in ((ONTOLOGY_TTL, ontology_block), (SHAPES_TTL, shapes_block)):
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except Exception:
            text = ""
        text = _strip_ext_block(text).rstrip() + "\n\n" + block + "\n"
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    return True


def apply_commit(g, changes, author="web"):
    """在 g 的深拷贝上应用变更，返回 (ok, errors, new_g, failed)。"""
    mut = copy.deepcopy(g)
    node_ids = {n.get("id") for n in mut.get("nodes", [])}
    edges = mut.setdefault("edges", [])
    nodes = mut.setdefault("nodes", [])
    # P2-2：把 reverse（撤销/重做）展开为内联反向变更序列，
    # 使撤销与普通变更共用同一套落地逻辑与版本快照节奏。
    flat = []
    for _ch in (changes or []):
        if isinstance(_ch, dict) and _ch.get("operation") == "reverse":
            for _sub in (_ch.get("changes") or []):
                if isinstance(_sub, dict):
                    flat.append(_sub)
            continue
        flat.append(_ch)

    for ch in flat:
        op = ch.get("operation")
        if op == "add_node":
            # 幂等：已存在则改为 update
            nid = ch.get("id") or (NS + ch.get("type") + ":" + slug(ch.get("name") or "node"))
            if nid in node_ids:
                for n in nodes:
                    if n.get("id") == nid:
                        n.setdefault("properties", {}).update(ch.get("properties", {}) or {})
                        node_ids = {x.get("id") for x in nodes}
                        break
            else:
                nodes.append({"id": nid, "type": ch.get("type"),
                              "properties": ch.get("properties", {}) or {}})
                node_ids = {x.get("id") for x in nodes}
        elif op == "update":
            for n in nodes:
                if n.get("id") == ch.get("id"):
                    props = ch.get("properties", {}) or {}
                    # 空值删除，否则合并
                    for k, v in props.items():
                        if v is None or v == "":
                            n.get("properties", {}).pop(k, None)
                        else:
                            n.setdefault("properties", {})[k] = v
                    if ch.get("type"):
                        n["type"] = ch["type"]
                    break
        elif op == "delete_node":
            nid = ch.get("id")
            nodes[:] = [n for n in nodes if n.get("id") != nid]
            # 级联删除关联边
            edges[:] = [e for e in edges
                        if e.get("source_id") != nid and e.get("target_id") != nid]
            mut.setdefault("links", [])
            mut["links"][:] = [e for e in mut["links"]
                               if e.get("source_id") != nid and e.get("target_id") != nid]
            node_ids = {x.get("id") for x in nodes}
        elif op == "add_edge":
            if ch.get("id") and any(e.get("id") == ch["id"] for e in edges):
                break  # 已存在
            eid = ch.get("id") or _gen_id(edges)
            edge = {"id": eid, "familyId": ch.get("familyId") or eid,
                    "source_id": ch.get("source_id"), "target_id": ch.get("target_id"),
                    "type": ch.get("type"),
                    "weight": ch.get("weight", 1.0),
                    "properties": ch.get("properties", {}) or {}}
            edges.append(edge)
            # 同步 links 集合（图谱与可视化共用）
            links = mut.setdefault("links", [])
            if not any(l.get("id") == eid for l in links):
                links.append(dict(edge))
        elif op == "delete_edge":
            # R1（P2 顺带修复）：只按 id 或 (source_id, target_id[, type]) 精确删除。
            # 原实现 `e.get("id") != eid`（eid=None）会把所有无 id 边一次性抹掉，属“无 id 全量删边”缺陷；
            # 现改为：无 id 且无端点时不做任何删除（由 validate_commit 报参数不完整 → 整体拒绝）。
            eid = ch.get("id")
            mut.setdefault("links", [])
            if eid:
                def _hit(e, _eid=eid):
                    return e.get("id") == _eid
            elif ch.get("source_id") and ch.get("target_id"):
                _s, _t, _ty = ch.get("source_id"), ch.get("target_id"), ch.get("type")

                def _hit(e, _s=_s, _t=_t, _ty=_ty):
                    return (e.get("source_id") == _s and e.get("target_id") == _t
                            and (not _ty or e.get("type") == _ty))
            else:
                _hit = None
            if _hit is not None:
                edges[:] = [e for e in edges if not _hit(e)]
                mut["links"][:] = [e for e in mut["links"] if not _hit(e)]
        elif op == "rename":
            old, new = ch.get("id"), ch.get("new_id")
            for n in nodes:
                if n.get("id") == old:
                    n["id"] = new
                    break
            for e in edges:
                if e.get("source_id") == old:
                    e["source_id"] = new
                if e.get("target_id") == old:
                    e["target_id"] = new
        elif op == "schema":
            # Schema 级变更（类/属性）本期先记录，不修改本体 TTL；TTL 权威。
            pass
    # 更新 meta 版本与治理日志
    meta = mut.setdefault("meta", {})
    meta["updated"] = now_iso()
    meta["version"] = bump_version(meta.get("version", "2.4"))
    gl = mut.setdefault("governance_log", [])
    if isinstance(gl, dict):
        gl = mut["governance_log"] = []
    gl.append({"t": now_iso(), "actor": author,
               "ops": [c.get("operation") for c in flat],
               "detail": "web commit"})
    ok, errors, failed = validate_commit(mut, changes, with_details=True)
    return ok, errors, mut, failed


def bump_version(v):
    try:
        major, minor = v.split(".")
        return "%s.%d" % (major, int(minor) + 1)
    except Exception:
        return v + ".1"


def _gen_id(edges):
    seen = {e.get("id") for e in edges}
    import uuid
    for _ in range(32):
        c = uuid.uuid4().hex[:16]
        if c not in seen:
            return c
    return uuid.uuid4().hex


def slug(s):
    s = re.sub(r"[^\w\u4e00-\u9fa5]+", "_", s)
    return s.strip("_")[:60]


# --------------------------------------------------------------------------
# 上传闭环（保留 v1.6）
# --------------------------------------------------------------------------
def ensure_inbox():
    os.makedirs(INBOX, exist_ok=True)


def pick_name(orig):
    base = os.path.splitext(os.path.basename(orig))[0]
    ext = os.path.splitext(os.path.basename(orig))[1]
    cand = os.path.join(INBOX, base + ext)
    n = 1
    while os.path.exists(cand):
        cand = os.path.join(INBOX, f"{base}_{n}{ext}")
        n += 1
    return cand


def run_ingest(pdf_path, on_stage=None, extra_args=None):
    """同步执行单篇入库解析。

    on_stage(stage_key) 会在子进程打印 [STAGE] 标记时回调，用于上报解析阶段。
    extra_args 透传额外 CLI 参数（S3 阶段一传 --no-llm --pending-llm 以先入库）。
    子进程标准输出逐行读取（1s 轮询），避免长时间无输出时无法感知超时。
    """
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    try:
        cmd = [sys.executable, "-u", INGEST_SCRIPT, "--file", pdf_path] + list(extra_args or [])
        proc = subprocess.Popen(cmd,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1, env=env)
    except Exception as e:
        return False, {}, "无法启动解析进程：%s" % e
    lines = []
    deadline = time.time() + 1800
    while True:
        ready = False
        try:
            if os.name == "nt":          # Windows 的 select 不支持管道，直接阻塞 readline
                ready = True
            else:
                ready = bool(select.select([proc.stdout], [], [], 1.0)[0])
        except Exception:
            ready = True
        if ready:
            line = proc.stdout.readline()
            if line:
                m = re.search(r"\[STAGE\]\s*([A-Za-z_]+)", line)
                if m:
                    if on_stage:
                        try:
                            on_stage(m.group(1))
                        except Exception:
                            pass
                    continue
                lines.append(line)
                continue
        if proc.poll() is not None:
            try:
                rest = proc.stdout.read()
            except Exception:
                rest = ""
            if rest:
                lines.append(rest)
            break
        if time.time() > deadline:
            try:
                proc.kill()
            except Exception:
                pass
            return False, {}, "处理超时（>30min），请检查 Ollama 服务后重试"
    try:
        proc.wait(timeout=30)
    except Exception:
        pass
    out = "".join(lines)
    m = re.search(r"DONE\. 处理统计:\s*(\{.*?\})", out, re.S)
    summary = {}
    if m:
        try:
            summary = json.loads(m.group(1))
        except Exception:
            summary = {"raw": m.group(1)[:500]}
    return (proc.returncode == 0), summary, out.strip()


# --------------------------------------------------------------------------
# 上传任务队列 + 实时进度（v1.7）
# --------------------------------------------------------------------------
# 阶段定义与 ingest_pdf.py 中的 [STAGE] 标记一一对应
UPLOAD_STAGES = [
    ("receive", "接收文件", 6),
    ("copy", "归档入库副本", 14),
    ("meta", "解析元数据", 30),
    ("llm", "AI 补全摘要与关键词", 72),
    ("ingest", "构建实体与关系", 86),
    ("write", "写入图谱并派生 TTL", 96),
    ("page", "刷新检索页面", 99),
    ("done", "解析完成", 100),
]
STAGE_INFO = {k: {"index": i, "name": n, "percent": p}
              for i, (k, n, p) in enumerate(UPLOAD_STAGES)}
MAX_TASKS = 50

UPLOAD_TASKS = {}          # file_id -> task dict
UPLOAD_ORDER = []          # file_id 入队顺序
UPLOAD_LOCK = threading.Lock()
UPLOAD_QUEUE = queue.Queue()
UPLOAD_WORKER = {"started": False}

STATUS_TEXT_MAP = {
    "ingested": "已入库（新增）",
    "duplicate": "已入库（去重命中，跳过新增）",
    "updated": "已入库（修正噪声旧记录）",
    "failed": "入库失败",
    "error": "处理异常",
    "unknown": "处理完成（状态未知）",
}


def _classify_ingest(ok, summary):
    """把 ingest_pdf.py 的统计结果归类为入库状态。"""
    status, title = "unknown", ""
    if ok and isinstance(summary, dict):
        n_ing = int(summary.get("ingested") or 0)
        n_dup = int(summary.get("duplicate") or 0)
        n_upd = int(summary.get("updated") or 0)
        n_fail = int(summary.get("failed") or 0)
        if n_fail > 0:
            status = "failed"
        elif n_ing > 0:
            status = "ingested"
        elif n_upd > 0:
            status = "updated"
        elif n_dup > 0:
            status = "duplicate"
        title = summary.get("title", "")
    else:
        status = "error"
    return status, title


def _new_upload_task(filename, saved_at, size):
    fid = hashlib.md5(("%s|%s|%s" % (filename, saved_at, time.time())).encode("utf-8")).hexdigest()[:16]
    task = {
        "file_id": fid,
        "file": filename,
        "saved_at": saved_at,
        "size": size,
        "status": "queued",        # queued | parsing | done | failed
        "status_text": "排队中",
        "stage": "queued",
        "stage_name": "排队等待",
        "stage_index": -1,
        "percent": 2,
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "elapsed": 0.0,
        "title": "",
        "reason": "",
        "result_status": "",
        "detail": "",
        "llm_status": "",            # S3：AI 摘要后台补全状态 pending|running|done|failed|""
        "llm_status_text": "",
        "llm_elapsed": 0.0,
    }
    with UPLOAD_LOCK:
        UPLOAD_TASKS[fid] = task
        UPLOAD_ORDER.append(fid)
        while len(UPLOAD_ORDER) > MAX_TASKS:
            UPLOAD_TASKS.pop(UPLOAD_ORDER.pop(0), None)
    return task


def _update_upload_task(fid, **patch):
    with UPLOAD_LOCK:
        t = UPLOAD_TASKS.get(fid)
        if not t:
            return
        t.update(patch)
        if t.get("started_at") and not t.get("finished_at"):
            t["elapsed"] = round(time.time() - t["started_at"], 1)
        elif t.get("started_at") and t.get("finished_at"):
            t["elapsed"] = round(t["finished_at"] - t["started_at"], 1)


def _task_stage(fid, stage_key):
    info = STAGE_INFO.get(stage_key)
    if not info:
        return
    with UPLOAD_LOCK:
        t = UPLOAD_TASKS.get(fid)
        if not t:
            return
        if info["percent"] >= t.get("percent", 0):
            t["stage"] = stage_key
            t["stage_name"] = info["name"]
            t["stage_index"] = info["index"]
            t["percent"] = info["percent"]
        if t.get("started_at") and not t.get("finished_at"):
            t["elapsed"] = round(time.time() - t["started_at"], 1)


def queue_position(fid):
    with UPLOAD_LOCK:
        pend = [i for i in UPLOAD_ORDER
                if UPLOAD_TASKS.get(i, {}).get("status") in ("queued", "parsing")]
    try:
        return pend.index(fid) + 1
    except ValueError:
        return 0


def _upload_worker():
    """单 worker 串行执行入库解析，保证队列中任务依次占用本地 AI 模型。"""
    while True:
        fid = UPLOAD_QUEUE.get()
        with UPLOAD_LOCK:
            task = UPLOAD_TASKS.get(fid)
            started = dict(task) if task else None
        if not started:
            continue
        _update_upload_task(fid, status="parsing", status_text="解析中",
                            started_at=time.time(), stage="receive",
                            stage_name=STAGE_INFO["receive"]["name"],
                            stage_index=0, percent=STAGE_INFO["receive"]["percent"])
        try:
            # S3 阶段一：先入库（跳过 LLM），拿到入库状态后由后台线程补 AI 摘要
            ok, summary, detail = run_ingest(started["saved_at"],
                                            lambda k: _task_stage(fid, k),
                                            extra_args=["--no-llm", "--pending-llm"])
        except Exception as e:
            ok, summary, detail = False, {}, "解析进程异常：%s" % e
        status, title = _classify_ingest(ok, summary)
        try:
            append_change("upload", "web", {"file": started["file"],
                                            "status": status, "title": title})
        except Exception:
            pass
        tail = (detail or "").strip()
        if ok:
            # S3：元数据已先行入库，AI 摘要/关键词交给后台线程异步补全（用户感知耗时 < 2s）
            if status == "ingested":
                _update_upload_task(fid, llm_status="pending",
                                    llm_status_text="AI 摘要后台补全中…")
                _ensure_llm_backfill_worker()
                LLM_BACKFILL_QUEUE.put(fid)
            _update_upload_task(fid, status="done", status_text=STATUS_TEXT_MAP.get(status, status),
                                result_status=status, title=title,
                                stage="done", stage_name=STAGE_INFO["done"]["name"],
                                stage_index=STAGE_INFO["done"]["index"], percent=100,
                                finished_at=time.time(), detail=tail[-4000:])
        else:
            reason = ""
            for ln in reversed(tail.splitlines()):
                if ln.strip():
                    reason = ln.strip()
                    break
            _update_upload_task(fid, status="failed",
                                status_text=STATUS_TEXT_MAP.get(status, "处理异常"),
                                result_status=status, title=title,
                                reason=reason[:300] or "解析失败",
                                finished_at=time.time(), detail=tail[-4000:])


def _ensure_upload_worker():
    with UPLOAD_LOCK:
        if UPLOAD_WORKER["started"]:
            return
        UPLOAD_WORKER["started"] = True
    threading.Thread(target=_upload_worker, name="upload-worker", daemon=True).start()


# ---- S3：LLM 后台补全队列（与入库解耦，单独线程串行消费）-------------------
LLM_BACKFILL_QUEUE = queue.Queue()
LLM_BACKFILL_WORKER = {"started": False}


def run_llm_backfill(pdf_path):
    """S3 阶段二：调用 ingest_pdf.py --llm-backfill 为已入库文献补 AI 摘要/关键词。"""
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    try:
        proc = subprocess.run([sys.executable, "-u", INGEST_SCRIPT,
                               "--file", pdf_path, "--llm-backfill"],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, timeout=1800, env=env)
    except Exception as e:
        return False, "补全进程异常：%s" % str(e)[:200]
    out = proc.stdout or ""
    # v21：ingest_pdf.py 结尾为 `DONE. 处理统计: {...}`（行首非 "{"，对象为裸 dict）
    for ln in reversed(out.splitlines()):
        if '"backfilled"' not in ln:
            continue
        m = re.search(r"\{.*\}", ln)
        if not m:
            continue
        try:
            obj = json.loads(m.group(0))
        except Exception:
            continue
        s = obj.get("summary") or obj
        if s.get("backfilled"):
            return True, "AI 摘要已补全（%s 篇）" % s.get("backfilled")
        if s.get("skipped"):
            return True, "已存在 AI 摘要，跳过补全"
        if s.get("failed"):
            return False, "补全失败（failed=%s）" % s.get("failed")
    for ln in reversed(out.splitlines()):
        if ln.strip():
            return False, "补全未成功：%s" % ln.strip()[:200]
    return False, "补全未成功（无输出）"


def _llm_backfill_worker():
    """串行消费 LLM 补全队列；补全只写增强字段，不动元数据。"""
    while True:
        fid = LLM_BACKFILL_QUEUE.get()
        with UPLOAD_LOCK:
            task = UPLOAD_TASKS.get(fid)
            target = dict(task) if task else None
        if not target:
            continue
        _update_upload_task(fid, llm_status="running", llm_status_text="AI 摘要后台补全中…")
        t0 = time.time()
        try:
            ok, note = run_llm_backfill(target["saved_at"])
        except Exception as e:
            ok, note = False, "补全异常：%s" % str(e)[:200]
        _update_upload_task(fid,
                            llm_status="done" if ok else "failed",
                            llm_status_text=note,
                            llm_elapsed=round(time.time() - t0, 1))
        try:
            append_change("llm_backfill", "web", {"file": target["file"], "ok": ok,
                                                  "note": note,
                                                  "elapsed": round(time.time() - t0, 1)})
        except Exception:
            pass


def _ensure_llm_backfill_worker():
    with UPLOAD_LOCK:
        if LLM_BACKFILL_WORKER["started"]:
            return
        LLM_BACKFILL_WORKER["started"] = True
    threading.Thread(target=_llm_backfill_worker, name="llm-backfill-worker",
                     daemon=True).start()


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------
class WorkbenchHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MarvisWorkbench/2.0"

    # ---------- helpers ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, rel):
        """静态资源：/assets/xxx -> <Ontology>/web/assets/xxx"""
        base = os.path.join(BASE_DIR, "web")
        p = os.path.realpath(os.path.join(base, rel.lstrip("/")))
        if not p.startswith(os.path.realpath(base)) or not os.path.isfile(p):
            return False
        ct = {".html": "text/html; charset=utf-8",
              ".js": "application/javascript; charset=utf-8",
              ".css": "text/css; charset=utf-8",
              ".json": "application/json; charset=utf-8",
              ".png": "image/png", ".svg": "image/svg+xml",
              ".jpg": "image/jpeg", ".woff2": "font/woff2"}.get(
                  os.path.splitext(p)[1], "application/octet-stream")
        with open(p, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return True

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return b""
        return self.rfile.read(length)

    def _params(self):
        return parse_qs(urlparse(self.path).query)

    def _route(self, method, path):
        """(zone, sub, rest)"""
        parts = [p for p in path.split("/") if p]
        if len(parts) >= 2 and parts[0] == "api":
            zone = parts[1]
            sub = parts[2] if len(parts) > 2 else ""
            rest = parts[3:]
            return zone, sub, rest
        return None, None, []

    # ---------- entry ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/" or path == "":
            self._serve_index()
            return
        if path.startswith("/assets/"):
            if self._static(path.lstrip("/")):
                return
            self._json({"ok": False, "reason": "static 404: " + path}, 404)
            return
        zone, sub, rest = self._route("GET", path)
        if not zone:
            self._json({"ok": False, "reason": "未支持路径: " + path}, 404)
            return
        self._api_get(zone, sub, rest)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        body = self._read_body()
        if path == "/upload":
            self._handle_upload(body)
            return
        zone, sub, rest = self._route("POST", path)
        if not zone:
            self._json({"ok": False, "reason": "未支持路径: " + path}, 404)
            return
        self._api_post(zone, sub, rest, body, qs)

    def do_PATCH(self):
        path = urlparse(self.path).path
        body = self._read_body()
        zone, sub, rest = self._route("PATCH", path)
        if not zone:
            self._json({"ok": False, "reason": "未支持路径: " + path}, 404)
            return
        self._api_patch(zone, sub, rest, body)

    def do_DELETE(self):
        path = urlparse(self.path).path
        zone, sub, rest = self._route("DELETE", path)
        if not zone:
            self._json({"ok": False, "reason": "未支持路径: " + path}, 404)
            return
        self._api_delete(zone, sub, rest)

    # ---------- index ----------
    def _serve_index(self):
        # 默认入口：v5 交互壳 + 真实 API（v6）；六大区页面仍可经 /index.html 直达（诊断视图）
        cands = [os.path.join(BASE_DIR, "web", "prototype_ai_workbench_v6.html"),
                 os.path.join(BASE_DIR, "web", "index.html"),
                 os.path.join(BASE_DIR, "scholar_literature_manager.html")]
        for p in cands:
            if os.path.exists(p):
                with open(p, "rb") as f:
                    self._html(f.read())
                return
        self._json({"ok": False, "reason": "找不到前端入口（web/prototype_ai_workbench_v6.html）"}, 500)

    # ---------- zone: graph ----------
    def _api_graph_get(self, sub, rest, qs):
        g = load_graph()
        if sub == "stats":
            from collections import Counter
            nodes, edges = g.get("nodes", []), g.get("edges", [])
            self._json({"ok": True,
                        "nodes": len(nodes), "edges": len(edges),
                        "links": len(g.get("links", [])),
                        "counts_by_type": dict(Counter(n.get("type") for n in nodes)),
                        "edge_counts_by_type": dict(sorted(Counter(e.get("type") for e in edges).items())),
                        # P2-4：图谱内容校验和（实例链路的乐观并发基线 / ETag）
                        "checksum": graph_checksum(),
                        "etag": "graph-" + (graph_checksum() or "")[:16],
                        "meta": g.get("meta", {})})
            return
        if sub == "nodes":
            qtype = qs.get("type", [""])[0]
            q = qs.get("q", [""])[0].lower()
            out = []
            for n in g.get("nodes", []):
                if qtype and n.get("type") != qtype:
                    continue
                if q:
                    joined = " ".join(str(v) for v in (n.get("properties") or {}).values()).lower()
                    if q not in joined and q not in (n.get("id") or "").lower():
                        continue
                out.append({"id": n.get("id"), "type": n.get("type"),
                            "properties": n.get("properties", {})})
            self._json({"ok": True, "total": len(out), "nodes": out[:500]})
            return
        if sub == "edges":
            qtype = qs.get("type", [""])[0]
            out = []
            for e in g.get("edges", []):
                if qtype and e.get("type") != qtype:
                    continue
                out.append({"id": e.get("id"), "type": e.get("type"),
                            "source_id": e.get("source_id"),
                            "target_id": e.get("target_id"),
                            "weight": e.get("weight")})
            self._json({"ok": True, "total": len(out), "edges": out[:1000]})
            return
        if sub == "search":
            q = qs.get("q", [""])[0].strip().lower()
            res = []
            if q:
                for n in g.get("nodes", []):
                    idl = (n.get("id") or "").lower()
                    name = (n.get("properties") or {}).get("name", "") or \
                           (n.get("properties") or {}).get("title", "")
                    if q in idl or q in str(name).lower():
                        res.append({"id": n.get("id"), "type": n.get("type"),
                                    "label": name})
            self._json({"ok": True, "results": res[:200]})
            return
        if sub == "node" and rest:
            nid = unquote(rest[0])
            for n in g.get("nodes", []):
                if n.get("id") == nid:
                    self._json({"ok": True, "node": n})
                    return
            self._json({"ok": False, "reason": "节点不存在: " + nid}, 404)
            return
        if sub == "neighbors" and rest:
            nid = unquote(rest[0])
            node = next((n for n in g.get("nodes", []) if n.get("id") == nid), None)
            if not node:
                self._json({"ok": False, "reason": "节点不存在: " + nid}, 404)
                return
            nb = {"neighbors": [], "edges": []}
            for e in g.get("edges", []):
                if e.get("source_id") == nid:
                    nb["edges"].append(e)
                    on = next((x for x in g.get("nodes", []) if x.get("id") == e.get("target_id")), None)
                    if on:
                        nb["neighbors"].append({"id": on.get("id"), "type": on.get("type"),
                                                "via": e.get("type"),
                                                "name": (on.get("properties") or {}).get("name", "") or
                                                        (on.get("properties") or {}).get("title", "")})
                elif e.get("target_id") == nid:
                    nb["edges"].append(e)
                    on = next((x for x in g.get("nodes", []) if x.get("id") == e.get("source_id")), None)
                    if on:
                        nb["neighbors"].append({"id": on.get("id"), "type": on.get("type"),
                                                "via": e.get("type"),
                                                "name": (on.get("properties") or {}).get("name", "") or
                                                        (on.get("properties") or {}).get("title", "")})
            self._json({"ok": True, **nb})
            return
        self._json({"ok": False, "reason": "graph 未知子路径: " + sub}, 404)

    # ---------- zone: ontology ----------
    def _api_ontology_get(self, sub, rest, qs):
        # P1-5：草稿读取（「存草稿 → 稍后继续 → 发布」的读取端）
        if sub == "draft":
            return self._api_ontology_draft_get(rest, qs)
        # P2-3：覆盖 / 一致性看板（JSON 层 + 可选 TTL 推理层）
        if sub in ("health", "consistency", "dashboard"):
            ttl_want = qs.get("ttl", ["1"])[0] not in ("0", "false", "no")
            rep = ontology_health(ext=load_ext(), ttl_layer=ttl_want)
            rep["rev"] = read_rev()
            rep["rev_info"] = read_rev_info()
            rep["schema_snapshots"] = list_schema_snapshots(5)
            self._json({"ok": True, **rep})
            return
        # P2-4：结构版本号 / ETag
        if sub == "rev":
            self._json({"ok": True, "rev": read_rev(), "rev_info": read_rev_info(),
                        "etag": "schema-%d" % read_rev(), "graph_etag": graph_checksum()})
            return
        # P2-1：已发布结构快照清单
        if sub in ("snapshots", "schema_snapshots"):
            self._json({"ok": True, "snapshots": list_schema_snapshots(50),
                        "dir": SNAPSHOT_DIR})
            return
        # P2-1：提案 / 评审队列
        if sub in ("proposal", "proposals"):
            return self._api_ontology_proposals_get(rest, qs)
        g = load_graph()
        from collections import Counter
        classes, obj_props, data_props = _scan_ttl(ONTOLOGY_TTL)
        if sub == "summary":
            ext = load_ext()
            self._json({"ok": True, "namespace": NS,
                        "classes": sorted(classes_of(ext) if not classes else (set(classes) | classes_of(ext))),
                        "object_props": sorted(obj_props_of(ext) if not obj_props else (set(obj_props) | obj_props_of(ext))),
                        "data_props": sorted(data_props_of(ext) if not data_props else (set(data_props) | data_props_of(ext))),
                        "disjoint": True,
                        "instance_counts": dict(Counter(n.get("type") for n in g.get("nodes", []))),
                        "shapes_file": os.path.basename(SHAPES_TTL)})
            return
        if sub == "types":
            ext = load_ext()
            self._json({"ok": True, "classes": sorted(set(classes) | classes_of(ext))})
            return
        if sub == "properties":
            ext = load_ext()
            self._json({"ok": True,
                        "object_props": sorted(set(obj_props) | obj_props_of(ext)),
                        "data_props": sorted(set(data_props) | data_props_of(ext))})
            return
        if sub == "instances":
            qtype = qs.get("type", [""])[0]
            out = []
            for n in g.get("nodes", []):
                if qtype and n.get("type") != qtype:
                    continue
                props = n.get("properties", {})
                label = props.get("name", "") or props.get("title", "") or n.get("id")
                out.append({"id": n.get("id"), "type": n.get("type"), "label": label,
                            "props": props})
            self._json({"ok": True, "total": len(out), "instances": out[:1000]})
            return
        if sub == "schema":
            classes, obj_props, data_props = _scan_schema_ttl(ONTOLOGY_TTL)
            if not classes:
                # P1-2：TTL 扫描为空时的兜底也走统一本体视图（原生 + 扩展），
                # 与 /api/commit 校验同源，避免结构链路与写入链路视图分叉
                view0 = ontology_view(load_ext())
                classes = {c: {"label": c} for c in sorted(view0["classes"])}
                obj_props = {p: {"label": p, "domain": "", "range": ""} for p in sorted(view0["obj_props"])}
                data_props = {p: {"label": p, "domain": "", "range": ""} for p in sorted(view0["data_props"])}
            shapes = _scan_shacl(SHAPES_TTL)
            ext = load_ext()
            for n, m in (ext.get("classes") or {}).items():
                classes[n] = {"label": m.get("label") or n,
                              "comment": m.get("comment") or "", "ext": True}
            for n, m in (ext.get("object_props") or {}).items():
                obj_props[n] = {"label": m.get("label") or n, "domain": m.get("domain"),
                                "range": m.get("range"), "ext": True}
            for n, m in (ext.get("data_props") or {}).items():
                data_props[n] = {"label": m.get("label") or n, "domain": m.get("domain"),
                                 "range": m.get("range"), "ext": True}
            for cls, fields in (ext.get("required") or {}).items():
                cur = shapes.setdefault(cls, {"required": [], "props": []})
                merged = list(cur.get("required") or [])
                for f in fields:
                    if f not in merged:
                        merged.append(f)
                cur["required"] = merged
            self._json({"ok": True, "namespace": NS,
                        "workspace_key": workspace_key(),
                        "classes": classes, "object_props": obj_props,
                        "data_props": data_props,
                        "shapes": shapes,
                        "ext": ext,
                        "required": ext.get("required") or {},
                        "draft": (lambda d: ({"count": d.get("count", 0), "saved_at": d.get("saved_at")} if d else None))(load_draft()),
                        "xsd_types": XSD_TYPES,
                        "rev": read_rev(),                  # P2-4：乐观并发基线
                        "etag": "schema-%d" % read_rev(),
                        "instance_counts": dict(Counter(n.get("type") for n in g.get("nodes", [])))})
            return
        if sub == "ext":
            self._json({"ok": True, "ext": load_ext(),
                        "classes": sorted(classes_of(load_ext())),
                        "object_props": sorted(obj_props_of(load_ext())),
                        "data_props": sorted(data_props_of(load_ext())),
                        "xsd_types": XSD_TYPES})
            return
        if sub == "schema_backups":
            items = []
            if os.path.isdir(SCHEMA_BACKUP_DIR):
                for n in sorted(os.listdir(SCHEMA_BACKUP_DIR), reverse=True):
                    p = os.path.join(SCHEMA_BACKUP_DIR, n)
                    if os.path.isfile(p):
                        items.append({"file": n, "stamp": n.split("_")[0],
                                      "size": os.path.getsize(p)})
            self._json({"ok": True, "backups": items, "dir": SCHEMA_BACKUP_DIR})
            return
        if sub == "node" and rest:
            nid = unquote(rest[0])
            node = next((n for n in g.get("nodes", []) if n.get("id") == nid), None)
            if not node:
                self._json({"ok": False, "reason": "节点不存在: " + nid}, 404)
                return
            node_ids = {n.get("id"): n for n in g.get("nodes", [])}
            def _label(o):
                p = (o.get("properties") or {})
                return p.get("name", "") or p.get("title", "") or o.get("id")
            outs, ins = [], []
            for e in g.get("edges", []):
                if e.get("source_id") == nid:
                    tgt = node_ids.get(e.get("target_id"))
                    outs.append({"edge_id": e.get("id"), "type": e.get("type"),
                                 "direction": "out", "other": {
                                     "id": e.get("target_id"),
                                     "type": tgt.get("type") if tgt else "?",
                                     "label": _label(tgt) if tgt else e.get("target_id")}})
                elif e.get("target_id") == nid:
                    src = node_ids.get(e.get("source_id"))
                    ins.append({"edge_id": e.get("id"), "type": e.get("type"),
                                "direction": "in", "other": {
                                    "id": e.get("source_id"),
                                    "type": src.get("type") if src else "?",
                                    "label": _label(src) if src else e.get("source_id")}})
            self._json({"ok": True, "node": node, "out_edges": outs, "in_edges": ins})
            return
        self._json({"ok": False, "reason": "ontology 未知子路径: " + sub}, 404)

    # ---------- zone: ontology 结构编辑（写闸门） ----------
    def _api_ontology_schema_post(self, body):
        """POST /api/ontology/schema：类 / 属性增删改 → 备份 → schema_ext.json → 重写 TTL 扩展区 → 派生数据 TTL。
        P1-5：核心逻辑抽为 commit_schema_changes()，与 /api/ontology/draft/publish 共用同一条发布链路。"""
        try:
            req = json.loads(body or b"{}")
        except Exception as e:
            self._json({"ok": False, "reason": "请求体解析失败: " + str(e)}, 400)
            return
        changes = req.get("changes") or []
        author = req.get("author", "web")
        base_rev = req.get("base_rev")          # P2-4：客户端基线版本号（可选）
        if not changes:
            self._json({"ok": False, "reason": "changes 为空"}, 422)
            return
        # P2-3：可选发布前一致性预检（渲染候选 TTL 做 SHACL + OWL 校验，不触碰任何真实文件）
        if req.get("validate"):
            tmpdir = tempfile.mkdtemp(prefix="onto_cand_")
            try:
                ok_c, err_c, cand_ext = apply_schema_commit(load_ext(), changes)
                if not ok_c:
                    self._json({"ok": False, "status": "validation_failed",
                                "errors": err_c}, 422)
                    return
                cand = candidate_ttl_files(cand_ext, tmpdir)
                report = ttl_layer_report(cand[0], cand[1])
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)
            if not report.get("available"):
                self._json({"ok": False, "status": "validation_unavailable",
                            "errors": [report.get("error") or "推理依赖不可用"],
                            "report": report}, 503)
                return
            bad = [v for v in report.get("violations", []) if v.get("level") == "error"]
            if report.get("inconsistent") or bad:
                self._json({"ok": False, "status": "validation_failed",
                            "errors": [v.get("msg") for v in bad[:10]] or ["OWL 一致性校验未通过"],
                            "report": report}, 422)
                return
        code, payload = commit_schema_changes(changes, author,
                                              source="/api/ontology/schema",
                                              base_rev=base_rev)
        self._json(payload, code)
        return

    def _api_ontology_draft_get(self, rest, qs):
        """GET /api/ontology/draft：读取当前草稿 + 版本快照清单（发布/继续编辑用）。"""
        d = load_draft()
        self._json({"ok": True, "workspace_key": workspace_key(),
                    "draft": d,
                    "count": (d or {}).get("count", 0),
                    "saved_at": (d or {}).get("saved_at"),
                    "versions": list_versions()[:20],
                    "draft_dir": DRAFT_DIR})

    def _api_ontology_draft_post(self, rest, body):
        """POST /api/ontology/draft[/publish|/discard]：草稿存取 → 发布走结构提交链路。"""
        try:
            req = json.loads(body or b"{}")
        except Exception as e:
            self._json({"ok": False, "reason": "请求体解析失败: " + str(e)}, 400)
            return
        author = req.get("author", "web")
        action = (rest[0] if rest else "").strip()
        if action == "publish":
            d = load_draft()
            changes = req.get("changes") or (d or {}).get("changes") or []
            if not changes:
                self._json({"ok": False, "reason": "草稿为空，无可发布内容"}, 422)
                return
            code, payload = commit_schema_changes(changes, author,
                                                  source="/api/ontology/draft/publish",
                                                  base_rev=req.get("base_rev"))
            if code == 200:
                payload["draft_cleared"] = bool(clear_draft(author, note="published"))
                payload["published_from"] = "draft"
            self._json(payload, code)
            return
        if action == "discard":
            prev = clear_draft(author, note="discarded")
            self._json({"ok": True, "status": "discarded",
                        "cleared": bool(prev),
                        "count": (prev or {}).get("count", 0)})
            return
        changes = req.get("changes")
        if changes is None:
            self._json({"ok": False, "reason": "缺少 changes"}, 422)
            return
        rec = save_draft(changes, author=author, note=req.get("note", ""))
        self._json({"ok": True, "status": "drafted", "saved_at": rec["saved_at"],
                    "count": rec["count"], "workspace_key": rec["workspace"],
                    "archived": rec["archived"]})

    def _api_ontology_proposals_get(self, rest, qs):
        """GET /api/ontology/proposal[s][/{id}]：评审队列 / 单个提案详情（P2-1）。"""
        pid = unquote(rest[0]) if rest else ""
        if pid:
            rec = load_proposal(pid)
            if not rec:
                self._json({"ok": False, "reason": "提案不存在: " + pid}, 404)
                return
            self._json({"ok": True, "proposal": rec, "current_rev": read_rev()})
            return
        self._json({"ok": True, "proposals": list_proposals(50),
                    "current_rev": read_rev(), "rev_info": read_rev_info(),
                    "dir": PROPOSAL_DIR})

    def _api_ontology_proposal_post(self, rest, body):
        """POST /api/ontology/proposal{s}[/review|/publish]：提案创建 / 评审 / 发布（P2-1）。"""
        try:
            req = json.loads(body or b"{}")
        except Exception as e:
            self._json({"ok": False, "reason": "请求体解析失败: " + str(e)}, 400)
            return
        author = req.get("author", "web")
        action = (rest[0] if rest else "").strip()
        if action == "review":
            rec, errs = review_proposal(req.get("id") or req.get("proposal"),
                                        req.get("decision"), reviewer=author,
                                        comment=req.get("comment", ""))
            if errs:
                self._json({"ok": False, "errors": errs}, 422)
                return
            self._json({"ok": True, "status": rec.get("status"), "proposal": rec})
            return
        if action == "publish":
            out, errs, code, payload = publish_proposal(req.get("id") or req.get("proposal"),
                                                        author=author)
            if errs:
                self._json(payload if isinstance(payload, dict) else
                           {"ok": False, "errors": errs}, code or 422)
                return
            self._json({"ok": True, "status": "published", **out}, 200)
            return
        changes = req.get("changes")
        if not changes:
            d = load_draft()
            changes = (d or {}).get("changes") or []
        rec, errs = create_proposal(changes, author=author, note=req.get("note", ""),
                                    title=req.get("title", ""),
                                    base_rev=req.get("base_rev"))
        if errs:
            self._json({"ok": False, "errors": errs}, 422)
            return
        self._json({"ok": True, "status": "pending", "proposal": rec,
                    "current_rev": read_rev()})

    # ---------- zone: commit ----------
    def _api_commit_post(self, body):
        try:
            req = json.loads(body or b"{}")
        except Exception as e:
            self._json({"ok": False, "reason": "请求体解析失败: " + str(e)})
            return
        changes = req.get("changes", [])
        author = req.get("author", "web")
        desc = req.get("description", "commit")
        if not changes:
            # 修复：与 /api/ontology/schema 保持一致，空提交返回 422 而非 200
            self._json({"ok": False, "reason": "changes 为空"}, 422)
            return
        # P2-4：实例链路的乐观并发前置校验 —— 客户端携带基线 checksum（ETag）时先比对，
        # 不一致直接 409，杜绝多端编辑静默覆盖。
        want_cs = str(req.get("expected_checksum") or req.get("base_checksum")
                      or req.get("expected_etag") or "").strip()
        if want_cs.startswith("graph-"):
            want_cs = want_cs[len("graph-"):]
        with _LOCK:
            g = load_graph()
            if want_cs:
                cur_cs = graph_checksum()
                if want_cs[:16] != cur_cs[:16]:
                    append_change("conflict", author, {
                        "endpoint": "/api/commit", "target": desc,
                        "expected_checksum": want_cs, "current_checksum": cur_cs,
                        "ops": [c.get("operation") for c in changes],
                    })
                    self._json({"ok": False, "status": "conflict",
                                "expected_checksum": want_cs,
                                "current_checksum": cur_cs,
                                "etag": "graph-" + cur_cs[:16],
                                "errors": ["图谱已被其他会话修改（当前校验和 %s…，你的基线 %s…），"
                                           "请刷新后重试" % (cur_cs[:12], want_cs[:12])]}, 409)
                    return
            ok, errors, new_g, failed = apply_commit(g, changes, author=author)
            if not ok:
                # P0-6：拒绝也写审计，保证"谁在何时提交了什么被拒"可回溯
                append_change("reject", author, {
                    "endpoint": "/api/commit",
                    "target": desc,
                    "ops": [c.get("operation") for c in changes],
                    "failed": failed,
                    "errors": errors,
                })
                self._json({"ok": False, "status": "rejected",
                            "errors": errors, "failed": failed}, 422)
                return
            # 快照 + 校验 + 写回
            version, cs, snap_path = create_snapshot(new_g, author=author,
                                                     description=desc)
            save_graph(new_g)
            # TTL 派生（失败不阻塞主流程，但记录）
            ttl_ok, ttl_err = True, ""
            try:
                triples = derive_ttl(new_g, TTL_FILE)
                ttl_err = "%d triples" % triples
            except Exception as e:
                ttl_ok = False
                ttl_err = str(e)
            append_change("commit", author, {
                "version": version, "desc": desc,
                "ops": [c.get("operation") for c in changes],
                "ttl_ok": ttl_ok, "ttl": ttl_err,
                "n_nodes": len(new_g.get("nodes", [])),
                "n_edges": len(new_g.get("edges", [])),
                "checksum": cs,
            })
            self._json({"ok": True, "status": "committed",
                        "commit_id": version, "version": version,
                        "checksum": cs, "snapshot": os.path.basename(snap_path),
                        # P2-4：回传提交后的图谱 ETag / 校验和，供客户端刷新乐观并发基线
                        "etag": "graph-" + (graph_checksum() or "")[:16],
                        "graph_checksum": graph_checksum(),
                        "failed": failed,
                        "ttl_ok": ttl_ok, "ttl_info": ttl_err,
                        "n_nodes": len(new_g.get("nodes", [])),
                        "n_edges": len(new_g.get("edges", [])),
                        "errors": errors})

    def _api_commit_get(self, sub, rest, qs):
        if sub == "versions":
            self._json({"ok": True, "versions": list_versions()})
            return
        if sub == "log":
            logs = []
            if os.path.exists(CHANGE_LOG):
                with open(CHANGE_LOG, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                logs.append(json.loads(line))
                            except Exception:
                                pass
            self._json({"ok": True, "total": len(logs), "logs": logs[-300:][::-1]})
            return
        self._json({"ok": False, "reason": "commit 未知子路径: " + sub}, 404)

    def _api_commit_rollback(self, body):
        try:
            req = json.loads(body or b"{}")
        except Exception:
            req = {}
        version = req.get("version", "")
        if not version:
            self._json({"ok": False, "reason": "缺少 version"})
            return
        with _LOCK:
            snap = load_snapshot(version)
            if not snap:
                self._json({"ok": False, "reason": "快照不存在: " + version}, 404)
                return
            g = load_graph()
            # 校验 checksum 由前端提供可选
            # 恢复：将快照的 nodes/edges/links 写回 GRAPH_FILE
            g["nodes"] = snap.get("nodes", [])
            g["edges"] = snap.get("edges", [])
            g["links"] = snap.get("links", [])
            g["meta"]["version"] = bump_version(g.get("meta", {}).get("version", "2.0"))
            gl = g.setdefault("governance_log", [])
            if isinstance(gl, dict):
                g["governance_log"] = []
            g.setdefault("governance_log", []).append(
                {"t": now_iso(), "actor": "web",
                 "ops": ["rollback"], "detail": "回滚到版本 " + version})
            save_graph(g)
            ttl_ok, ttl_err = True, ""
            try:
                ttl_err = "%d triples" % derive_ttl(g, TTL_FILE)
            except Exception as e:
                ttl_ok = False
                ttl_err = str(e)
            append_change("rollback", "web", {"to_version": version, "ttl_ok": ttl_ok})
            self._json({"ok": True, "status": "rolled_back", "to": version,
                        "graph_version": g.get("meta", {}).get("version"),
                        "n_nodes": len(g.get("nodes", [])),
                        "n_edges": len(g.get("edges", [])),
                        "ttl_ok": ttl_ok, "ttl_info": ttl_err})

    # ---------- zone: manage / decisions / analyze / enrich ----------
    def _api_manage_get(self, sub, rest, qs):
        if sub == "stats":
            g = load_graph()
            from collections import Counter
            nodes, edges = g.get("nodes", []), g.get("edges", [])
            vd = os.path.isdir(VERSIONS_DIR) and len([x for x in os.listdir(VERSIONS_DIR) if x.endswith(".json")]) or 0
            self._json({"ok": True,
                        "kg": {"nodes": len(nodes), "edges": len(edges),
                               "types": dict(Counter(n.get("type") for n in nodes))},
                        "sources": Counter(
                            (n.get("properties", {}) or {}).get("prov:dataSource", "unknown")
                            for n in nodes).most_common(),
                        "versions": vd,
                        "updated": g.get("meta", {}).get("updated", ""),
                        "namespace": g.get("meta", {}).get("namespace", NS)})
            return
        if sub == "lineage" and rest:
            nid = unquote(rest[0])
            g = load_graph()
            node = next((n for n in g.get("nodes", []) if n.get("id") == nid), None)
            if not node:
                self._json({"ok": False, "reason": "节点不存在"}, 404)
                return
            props = node.get("properties", {})
            lineage = {
                "id": nid,
                "prov": {k: v for k, v in props.items() if k.startswith("prov:")},
                "trace": [{"t": el.get("t"), "actor": el.get("actor"),
                           "ops": el.get("ops"), "detail": el.get("detail")}
                          for el in (g.get("governance_log", []) or []) if isinstance(el, dict)],
            }
            self._json({"ok": True, "lineage": lineage})
            return
        self._json({"ok": False, "reason": "manage 未知子路径"}, 404)

    def _api_decisions_get(self, sub, rest, qs):
        logs = []
        if os.path.exists(CHANGE_LOG):
            with open(CHANGE_LOG, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            logs.append(json.loads(line))
                        except Exception:
                            pass
        self._json({"ok": True, "total": len(logs), "log": logs[:200][::-1]})
        return

    # ---------- zone: analyze（M4：rdflib SPARQL + 轻量推理） ----------
    ANALYZE_TEMPLATES = [
        {"id": "papers_by_author", "name": "某作者的全部论文",
         "desc": "按作者姓名查论文标题（可改 ?name 值）",
         "sparql": 'SELECT ?paper ?title WHERE { ?paper es:hasAuthor ?a . ?a es:name ?name . ?paper es:title ?title . FILTER(lang(?title)="" || lang(?title)="zh") }'},
        {"id": "keyword_dist", "name": "关键词分布 Top20",
         "desc": "统计图谱中最常出现的关键词",
         "sparql": 'SELECT ?kw (COUNT(?p) AS ?n) WHERE { ?p es:hasKeyword ?kw } GROUP BY ?kw ORDER BY DESC(?n) LIMIT 20'},
        {"id": "venue_papers", "name": "期刊论文量排行",
         "desc": "按发表期刊统计论文数（Top15）",
         "sparql": 'SELECT ?venue (COUNT(?p) AS ?n) WHERE { ?p es:publishedIn ?venue } GROUP BY ?venue ORDER BY DESC(?n) LIMIT 15'},
        {"id": "authors_org", "name": "机构-作者-论文链路",
         "desc": "机构下有哪些作者、各发了几篇",
         "sparql": 'SELECT ?org ?auth (COUNT(?p) AS ?n) WHERE { ?p es:hasAuthor ?auth . ?auth es:hasAffiliation ?org } GROUP BY ?org ?auth ORDER BY DESC(?n) LIMIT 30'},
        {"id": "papers_no_author", "name": "缺作者论文（质检）",
         "desc": "找出没有 hasAuthor 的论文，便于补数据",
         "sparql": 'SELECT ?p ?title WHERE { ?p a es:Paper . ?p es:title ?title . FILTER NOT EXISTS { ?p es:hasAuthor ?any } } LIMIT 50'},
        {"id": "cites_chain", "name": "引用网络（谁引用谁）",
         "desc": "列出全部 cites 引用边（Paper 间）",
         "sparql": 'SELECT ?from ?to WHERE { ?from es:cites ?to . ?from a es:Paper . ?to a es:Paper } LIMIT 100'},
        {"id": "confidence_low", "name": "低置信度文献（<0.7）",
         "desc": "找出自动增强置信度不足的论文，人工复核",
         "sparql": 'SELECT ?p ?title ?conf WHERE { ?p a es:Paper . ?p es:title ?title . ?p es:confidence ?conf . FILTER(?conf < 0.7) } ORDER BY ASC(?conf) LIMIT 50'},
        {"id": "recent_papers", "name": "按年份论文数",
         "desc": "各年份发表的论文数量统计",
         "sparql": 'SELECT ?y (COUNT(?p) AS ?n) WHERE { ?p a es:Paper . ?p es:year ?y } GROUP BY ?y ORDER BY DESC(?y)'},
        {"id": "org_rank", "name": "机构发文量排行",
         "desc": "按机构统计论文数（Top15）",
         "sparql": 'SELECT ?org (COUNT(DISTINCT ?p) AS ?n) WHERE { ?p es:hasAuthor ?a . ?a es:hasAffiliation ?org } GROUP BY ?org ORDER BY DESC(?n) LIMIT 15'},
        {"id": "all_papers", "name": "全量论文清单",
         "desc": "列出所有论文的标题与年份",
         "sparql": 'SELECT ?title ?y WHERE { ?p a es:Paper . ?p es:title ?title . OPTIONAL { ?p es:year ?y } } LIMIT 100'},
    ]

    def _load_rdflib_graph(self):
        """加载 TTL 为 rdflib Graph（M4 唯一第三方依赖，延迟导入）"""
        from rdflib import Graph
        g = Graph()
        g.parse(TTL_FILE, format="turtle")
        return g

    def _api_analyze_get(self, sub, rest, qs):
        if sub == "templates":
            self._json({"ok": True, "templates": self.ANALYZE_TEMPLATES})
            return
        if sub == "stats":
            try:
                g = self._load_rdflib_graph()
                from rdflib.namespace import RDF
                from rdflib import Namespace
                ES = Namespace(NS)
                cls_counts = {}
                for cls in ("Paper", "Author", "Organization", "Venue",
                            "Keyword", "LocalFile", "DomainCategory"):
                    try:
                        n = len(list(g.subjects(RDF.type, ES[cls])))
                    except Exception:
                        n = 0
                    cls_counts[cls] = n
                self._json({"ok": True,
                            "triples": len(g),
                            "classes": cls_counts,
                            "ttl_file": os.path.basename(TTL_FILE)})
            except Exception as e:
                self._json({"ok": False, "reason": "rdflib 加载 TTL 失败: %s" % e}, 500)
            return
        self._json({"ok": False, "reason": "analyze 未知子路径: " + sub}, 404)

    def _api_analyze_post(self, body):
        try:
            body = json.loads(body or b"{}")
        except Exception as e:
            self._json({"ok": False, "reason": "请求体解析失败: " + str(e)}, 400)
            return
        sub = (body.get("sub") or body.get("action") or "").strip()
        if sub == "sparql" or (body.get("query") and sub in ("", "query")):
            q = (body.get("query") or "").strip()
            if not q:
                self._json({"ok": False, "reason": "query 不能为空"}, 400)
                return
            timeout = float(body.get("timeout") or 30)
            try:
                from rdflib.plugins.sparql import prepareQuery
                from rdflib.namespace import RDF, RDFS, XSD, OWL
                from rdflib import Namespace
                g = self._load_rdflib_graph()
                prepared = prepareQuery(q, initNs={
                    "es": Namespace(NS),
                    "rdf": RDF,
                    "rdfs": RDFS,
                    "xsd": XSD,
                    "owl": OWL,
                    "prov": Namespace(PROV_NS),
                })
                res = g.query(prepared)
                cols = [str(v) for v in res.vars]
                rows = []
                from decimal import Decimal
                for row in res:
                    r = []
                    for v in row:
                        if v is None:
                            r.append(None)
                        elif hasattr(v, "toPython"):
                            pv = v.toPython()
                            r.append(float(pv) if isinstance(pv, Decimal) else pv)
                        else:
                            r.append(str(v))
                    rows.append(r)
                self._json({"ok": True, "columns": cols, "rows": rows,
                            "row_count": len(rows), "triples": len(g)})
            except Exception as e:
                self._json({"ok": False, "reason": "SPARQL 执行失败: %s" % e}, 400)
            return
        if sub == "reason":
            # 轻量推理：基于 rdflib 做简单的规则推理/质检建议
            try:
                from rdflib import Namespace
                from rdflib.namespace import RDF
                g = self._load_rdflib_graph()
                ES = Namespace(NS)
                findings = []
                # 1) 缺作者论文
                no_auth = []
                for p in g.subjects(RDF.type, ES.Paper):
                    if not list(g.objects(p, ES.hasAuthor)):
                        t = g.value(p, ES.title)
                        no_auth.append({"id": str(p).replace(NS, ""),
                                        "title": str(t) if t else ""})
                if no_auth:
                    findings.append({"rule": "论文缺少作者 hasAuthor",
                                     "severity": "high",
                                     "count": len(no_auth),
                                     "samples": no_auth[:10]})
                # 2) 引用不对称（A cites B 但 B 未回引，仅提示）
                asym = []
                for a, b in list(g.subject_objects(ES.cites)):
                    if a not in list(g.objects(b, ES.cites)):
                        asym.append({"from": str(a).replace(NS, ""),
                                     "to": str(b).replace(NS, "")})
                if asym:
                    findings.append({"rule": "引用不对称 cites（不强制回引，仅提示）",
                                     "severity": "info",
                                     "count": len(asym),
                                     "samples": asym[:10]})
                # 3) 低置信度
                low_conf = []
                for p, c in g.subject_objects(ES.confidence):
                    try:
                        cv = float(c)
                    except Exception:
                        continue
                    if cv < 0.7:
                        t = g.value(p, ES.title)
                        low_conf.append({"id": str(p).replace(NS, ""),
                                         "title": str(t) if t else "",
                                         "confidence": cv})
                if low_conf:
                    findings.append({"rule": "自动增强置信度低于 0.7，建议人工复核",
                                     "severity": "medium",
                                     "count": len(low_conf),
                                     "samples": low_conf[:10]})
                # 4) 孤儿关键词（无论文使用）
                orphan_kw = []
                for k in g.subjects(RDF.type, ES.Keyword):
                    if not list(g.subjects(ES.hasKeyword, k)):
                        orphan_kw.append(str(k).replace(NS, ""))
                if orphan_kw:
                    findings.append({"rule": "孤立关键词（无论文关联）",
                                     "severity": "low",
                                     "count": len(orphan_kw),
                                     "samples": orphan_kw[:10]})
                self._json({"ok": True, "triples": len(g), "findings": findings})
            except Exception as e:
                self._json({"ok": False, "reason": "推理失败: %s" % e}, 500)
            return
        self._json({"ok": False, "reason": "analyze 未知操作: %s" % sub,
                    "hint": "POST /api/analyze 需 body.sub ∈ {sparql, reason}"}, 400)

    def _api_enrich_get(self, sub, rest, qs):
        if sub == "export":
            fmt = qs.get("fmt", ["json"])[0]
            g = load_graph()
            if fmt == "json":
                body = json.dumps(g, ensure_ascii=False)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition",
                                 'attachment; filename="graph_export.json"')
                self._cors()
                self.send_header("Content-Length", str(len(body.encode("utf-8"))))
                self.end_headers()
                self.wfile.write(body.encode("utf-8"))
                return
            if fmt in ("ttl", "turtle"):
                if os.path.exists(TTL_FILE):
                    body = open(TTL_FILE, encoding="utf-8").read()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/turtle; charset=utf-8")
                    self.send_header("Content-Disposition",
                                     'attachment; filename="scholar_data_export.ttl"')
                    self._cors()
                    self.send_header("Content-Length", str(len(body.encode("utf-8"))))
                    self.end_headers()
                    self.wfile.write(body.encode("utf-8"))
                    return
                self._json({"ok": False, "reason": "TTL 尚未派生"}, 404)
            self._json({"ok": False, "reason": "不支持的导出格式: " + fmt})
            return
        if sub == "diff":
            v1 = qs.get("v1", [""])[0]
            v2 = qs.get("v2", [""])[0]
            if not v1 or not v2:
                self._json({"ok": False, "reason": "需 v1 与 v2"}, 400)
                return
            s1, s2 = load_snapshot(v1), load_snapshot(v2)
            if not s1 or not s2:
                self._json({"ok": False, "reason": "快照不存在"})
                return
            self._json({"ok": True,
                        "diff": simple_diff(s1, s2)})
            return
        self._json({"ok": False, "reason": "enrich 未知子路径"}, 404)

    # ---------- upload（保留） ----------
    def _handle_upload(self, raw):
        qs = self._params()
        sync_mode = str((qs.get("sync") or ["0"])[0]).lower() in ("1", "true", "yes", "sync")
        ctype = self.headers.get("Content-Type", "")
        filename, filedata = "", b""
        if "multipart/form-data" in ctype:
            try:
                pdict = cgi.parse_header(ctype)[1]
                boundary = pdict.get("boundary", "").encode("utf-8")
                for part in raw.split(b"--" + boundary):
                    if b"\r\n\r\n" not in part:
                        continue
                    head, _, body = part.partition(b"\r\n\r\n")
                    head_s = part[:len(head)].decode("utf-8", "ignore")
                    m = re.search(r'filename="([^"]+)"', head_s)
                    if m:
                        filename = m.group(1)
                        filedata = body.rstrip(b"\r\n")
                        break
            except Exception as e:
                self._json({"ok": False, "status": "error",
                            "reason": "multipart 解析失败: %s" % e})
                return
        else:
            cd = self.headers.get("Content-Disposition", "")
            m = re.search(r'filename="([^"]+)"', cd)
            filename = m.group(1) if m else "upload_%s.pdf" % len(raw)
            filedata = raw
        if not filedata:
            self._json({"ok": False, "status": "error", "reason": "未接收到文件内容"})
            return
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_EXT:
            self._json({"ok": False, "status": "error",
                        "reason": "仅支持 PDF（收到: %s）" % filename})
            return
        ensure_inbox()
        dest = pick_name(filename)
        with open(dest, "wb") as f:
            f.write(filedata)

        # 异步模式：入队后立即返回 file_id，前端凭 /api/upload/progress 轮询进度
        if not sync_mode:
            task = _new_upload_task(filename, dest, len(filedata))
            _ensure_upload_worker()
            UPLOAD_QUEUE.put(task["file_id"])
            self._json({"ok": True, "async": True, "file_id": task["file_id"],
                        "file": filename, "status": "queued", "statusText": "排队中",
                        "queue_position": queue_position(task["file_id"]),
                        "saved_at": dest}, 202)
            return

        ok, summary, detail = run_ingest(dest)
        status, title = _classify_ingest(ok, summary)
        append_change("upload", "web", {"file": filename, "status": status,
                                        "title": title})
        self._json({"ok": ok, "status": status,
                    "statusText": STATUS_TEXT_MAP.get(status, status),
                    "title": title, "saved_at": dest,
                    "summary": summary.get("stats", summary) if isinstance(summary, dict) else {},
                    "detail": detail[-3000:]})

    # ---------- 上传进度查询（v1.7） ----------
    def _api_upload_get(self, sub, rest, qs):
        """GET /api/upload/progress?file_id=a,b  —— 返回指定任务进度
           GET /api/upload/progress                 —— 返回最近任务列表
           GET /api/upload/task/<file_id>           —— 返回单个任务"""
        ids = []
        if rest:
            ids = [unquote(x) for x in rest if x]
        if not ids:
            raw_ids = (qs.get("file_id") or qs.get("file_ids") or qs.get("ids") or [""])[0]
            ids = [x for x in re.split(r"[,\s]+", raw_ids) if x]
        # 无 file_id 时返回最近任务列表；limit 可控（默认 20，上限 MAX_TASKS=50），
        # 供前端「上传记录」弹窗一次性拉取全部历史任务
        try:
            limit = int((qs.get("limit") or ["20"])[0])
        except (TypeError, ValueError):
            limit = 20
        limit = max(1, min(MAX_TASKS, limit))
        with UPLOAD_LOCK:
            if ids:
                items = [dict(UPLOAD_TASKS[i]) for i in ids if i in UPLOAD_TASKS]
            else:
                items = [dict(UPLOAD_TASKS[i]) for i in UPLOAD_ORDER[-limit:]]
        now = time.time()
        for it in items:
            if it.get("started_at") and not it.get("finished_at"):
                it["elapsed"] = round(now - it["started_at"], 1)
            it["queue_position"] = 0 if it.get("status") != "queued" else queue_position(it["file_id"])
        self._json({"ok": True, "items": items, "total": len(items),
                    "stages": [{"key": k, "name": n, "percent": p}
                               for k, n, p in UPLOAD_STAGES]})

    # ---------- zone: read（阅读板块：字节通道 + 文档解析） ----------
    def _api_read_get(self, sub, rest, qs):
        if sub == "list":
            return self._json({"ok": True, "docs": read_service.list_docs(),
                               "root": read_service.PAPER_DIR})
        if sub == "search":
            # 阅读选择器搜索框：关键词 -> 本体 Paper 实例（标题/摘要/作者/关键词/机构/年份）
            q = qs.get("q", [""])[0]
            try:
                limit = int(qs.get("limit", ["60"])[0])
            except Exception:
                limit = 60
            return self._json(read_service.search_papers(q, limit=max(1, min(limit, 200))))
        if sub in ("probe", "resolve"):
            info = read_service.resolve(name=qs.get("name", [""])[0],
                                        path=qs.get("path", [""])[0])
            if info.get("ok"):
                info["url"] = "/api/read/file?name=" + quote(info["name"])
            return self._json(info)
        if sub == "file":
            return self._api_read_file(qs)
        if sub == "annotate":
            fname = qs.get("file", [""])[0]
            items = _read_annotations(fname)
            return self._json({"ok": True, "file": fname, "items": items})
        self._json({"ok": False, "reason": "read 未知子路径: " + sub}, 404)

    def _api_read_file(self, qs):
        info, data = read_service.read_bytes(name=qs.get("name", [""])[0],
                                             path=qs.get("path", [""])[0])
        if not info.get("ok"):
            return self._json({"ok": False, "reason": info.get("reason", ""),
                               "candidates": info.get("candidates")}, 404)
        size = len(data)
        code, start, end = 200, 0, max(0, size - 1)
        rng = (self.headers.get("Range") or "").strip()
        if rng.startswith("bytes="):
            try:
                spec = rng[6:].split(",")[0].strip()
                a, _, b = spec.partition("-")
                if not a and b:                       # bytes=-500 后缀区间
                    start = max(0, size - int(b))
                    end = size - 1
                else:                                  # bytes=100- / bytes=100-200
                    start = max(0, int(a))
                    end = int(b) if b else size - 1
                    end = min(end, size - 1)
                if end < start:
                    start, end = 0, size - 1
                else:
                    code = 206
            except Exception:
                code, start, end = 200, 0, max(0, size - 1)
        body = data[start:end + 1] if code == 206 else data
        self.send_response(code)
        self.send_header("Content-Type", info["content_type"])
        self.send_header("Content-Disposition", read_service.content_disposition(info["path"]))
        self.send_header("Accept-Ranges", "bytes")
        if code == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _api_read_post(self, sub, rest, body):
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            return self._json({"ok": False, "reason": "请求体不是合法 JSON"}, 400)
        if sub == "translate":
            return self._api_read_translate(payload)
        if sub == "annotate":
            return self._api_read_annotate(payload)
        self._json({"ok": False, "reason": "read 未知子路径: " + sub}, 404)

    def _api_read_translate(self, payload):
        text = (payload.get("text") or "").strip()
        if not text:
            return self._json({"ok": False, "reason": "text 为空"}, 400)
        if len(text) > 4000:
            text = text[:4000]
        to = payload.get("to") or "中文"
        msgs = [
            {"role": "system", "content": "你是学术文献翻译助手。将用户给出的片段准确译为%s；"
                                         "保持术语与公式原样，只输出译文，不要任何解释或前后缀。" % to},
            {"role": "user", "content": text},
        ]
        try:
            out = llm_bridge.chat_once(msgs, {"temperature": 0.2})
        except Exception as e:
            return self._json({"ok": False, "reason": "翻译失败: " + str(e)[:200]}, 500)
        out = (out or "").strip()
        if not out:
            return self._json({"ok": False, "reason": "模型未返回内容"}, 500)
        return self._json({"ok": True, "text": out})

    def _api_read_annotate(self, payload):
        fname = (payload.get("file") or "").strip()
        note = (payload.get("note") or "").strip()
        if not fname or not note:
            return self._json({"ok": False, "reason": "file / note 不能为空"}, 400)
        data = _load_ann_store()
        lst = data.setdefault(fname, [])
        item = {
            "id": "an_%d_%d" % (int(time.time() * 1000), len(lst)),
            "kind": payload.get("kind") or "annotate",
            "page": payload.get("page"), "fx": payload.get("fx"), "fy": payload.get("fy"),
            "rect": payload.get("rect"), "quote": (payload.get("quote") or "")[:500],
            "content": note[:2000], "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        lst.append(item)
        _save_ann_store(data)
        return self._json({"ok": True, "id": item["id"], "item": item})

    # ---------- zone: llm（模型网关：本地 Ollama / 云端 OpenAI 兼容） ----------
    def _api_llm_get(self, sub, rest, qs):
        if sub == "config":
            return self._json({"ok": True, **llm_bridge.masked()})
        if sub == "models":
            kind = qs.get("kind", [""])[0] or llm_bridge.load_config()["active"]
            return self._json({"ok": True, "kind": kind, **llm_bridge.list_models(kind)})
        if sub == "test":
            kind = qs.get("kind", [""])[0] or llm_bridge.load_config()["active"]
            model = qs.get("model", [""])[0] or None
            return self._json({"ok": True, "kind": kind, **llm_bridge.test_conn(kind, model)})
        self._json({"ok": False, "reason": "llm 未知子路径: " + sub}, 404)

    def _api_llm_post(self, sub, body):
        if sub == "config":
            try:
                patch = json.loads(body.decode("utf-8")) if body else {}
            except Exception:
                return self._json({"ok": False, "reason": "请求体不是合法 JSON"}, 400)
            try:
                llm_bridge.apply_patch(patch)
            except Exception as e:
                return self._json({"ok": False, "reason": "配置保存失败: " + str(e)[:200]}, 500)
            return self._json({"ok": True, **llm_bridge.masked()})
        if sub == "chat":
            return self._api_llm_chat(body)
        self._json({"ok": False, "reason": "llm 未知子路径: " + sub}, 404)

    def _api_llm_chat(self, body):
        """SSE 流式代理：对外统一 OpenAI Chat Completions 帧。"""
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            return self._json({"ok": False, "reason": "请求体不是合法 JSON"}, 400)
        messages = payload.get("messages") or []
        if not isinstance(messages, list) or not messages:
            return self._json({"ok": False, "reason": "messages 为空"}, 400)
        override = {k: payload.get(k) for k in
                    ("kind", "model", "temperature", "top_p", "max_tokens", "num_ctx", "think")
                    if payload.get(k) not in (None, "")}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self._cors()
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            for chunk in llm_bridge.chat_stream(messages, override):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self.wfile.write(("data: " + json.dumps(
                    {"error": {"message": "代理异常: " + str(e)[:200]}}, ensure_ascii=False) + "\n\n").encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except Exception:
                pass

    # ---------- dispatch ----------
    def _api_get(self, zone, sub, rest):
        qs = self._params()
        if zone == "upload":
            return self._api_upload_get(sub, rest, qs)
        if zone == "read":
            return self._api_read_get(sub, rest, qs)
        if zone == "llm":
            return self._api_llm_get(sub, rest, qs)
        if zone == "graph":
            return self._api_graph_get(sub, rest, qs)
        if zone == "ontology":
            return self._api_ontology_get(sub, rest, qs)
        if zone == "commit":
            return self._api_commit_get(sub, rest, qs)
        if zone == "manage":
            return self._api_manage_get(sub, rest, qs)
        if zone == "decisions":
            return self._api_decisions_get(sub, rest, qs)
        if zone == "analyze":
            return self._api_analyze_get(sub, rest, qs)
        if zone == "enrich":
            return self._api_enrich_get(sub, rest, qs)
        if zone == "relations":
            return self._api_relations_get(sub, rest, qs)
        if zone == "data":
            return self._api_data_get(sub, rest, qs)
        if zone == "rules":
            return self._api_rules_get(sub, rest, qs)
        if zone == "search":
            return self._api_search_get(sub, rest, qs)
        if zone == "quality":
            return self._api_quality_get(sub, rest, qs)
        self._json({"ok": False, "reason": "未知 API 区: " + zone}, 404)

    def _api_post(self, zone, sub, rest, body, qs=None):
        if zone == "read":
            return self._api_read_post(sub, rest, body)
        if zone == "commit" and sub == "rollback":
            return self._api_commit_rollback(body)
        if zone == "llm":
            return self._api_llm_post(sub, body)
        if zone == "commit" and sub == "":
            return self._api_commit_post(body)
        if zone == "ontology" and sub == "draft":
            # P1-5：/api/ontology/draft（存草稿）、/draft/publish（发布）、/draft/discard（放弃）
            return self._api_ontology_draft_post(rest, body)
        if zone == "ontology" and sub == "schema":
            return self._api_ontology_schema_post(body)
        if zone == "ontology" and sub in ("proposal", "proposals"):
            # P2-1：/api/ontology/proposal（建提案）、/proposal/review（评审）、/proposal/publish（发布）
            return self._api_ontology_proposal_post(rest, body)
        if zone == "analyze":
            return self._api_analyze_post(body)
        if zone == "enrich" and sub == "resolve":
            self._json({"ok": False, "reason": "实体消歧 M5 实现"}, 501)
            return
        if zone == "relations" and sub and rest and rest[0] == "instances":
            return self._api_relations_post(sub, rest, body)
        if zone == "rules" and sub == "check":
            return self._api_rules_check_post(sub, rest, body, qs)
        self._json({"ok": False, "reason": "POST 未支持: /api/%s/%s" % (zone, sub)}, 404)

    def _api_patch(self, zone, sub, rest, body):
        self._json({"ok": False, "reason": "PATCH 未支持"}, 404)

    def _api_delete(self, zone, sub, rest, body=b""):
        if zone == "relations" and sub and rest and rest[0] == "instances":
            return self._api_relations_delete(sub, rest, body)
        self._json({"ok": False, "reason": "DELETE 未支持: /api/%s/%s" % (zone, sub)}, 404)

    # ---------- zone: relations（P0-1 关系实例 CRUD：画布关系边 ↔ 关联实例对） ----------
    def _commit_simple(self, changes, desc, author="web"):
        """与 /api/commit 同闸门（apply_commit + 快照 + TTL 派生 + 审计）的轻量提交，
        供关系实例 CRUD 复用，保证写链路一致。"""
        with _LOCK:
            g = load_graph()
            ok, errors, new_g, failed = apply_commit(g, changes, author=author)
            if not ok:
                append_change("reject", author, {
                    "endpoint": "relations", "target": desc,
                    "ops": [c.get("operation") for c in changes],
                    "failed": failed, "errors": errors,
                })
                return {"ok": False, "status": "rejected", "errors": errors, "failed": failed}
            version, cs, snap_path = create_snapshot(new_g, author=author, description=desc)
            save_graph(new_g)
            ttl_ok, ttl_err = True, ""
            try:
                ttl_err = "%d triples" % derive_ttl(new_g, TTL_FILE)
            except Exception as e:
                ttl_ok, ttl_err = False, str(e)
            append_change("commit", author, {
                "version": version, "desc": desc,
                "ops": [c.get("operation") for c in changes],
                "ttl_ok": ttl_ok, "ttl": ttl_err,
                "n_nodes": len(new_g.get("nodes", [])),
                "n_edges": len(new_g.get("edges", [])),
                "checksum": cs,
            })
            return {"ok": True, "status": "committed", "version": version,
                    "checksum": cs, "ttl_ok": ttl_ok, "ttl_info": ttl_err,
                    "n_nodes": len(new_g.get("nodes", [])),
                    "n_edges": len(new_g.get("edges", [])),
                    "new_g": new_g}

    def _api_relations_get(self, rel_type, rest, qs):
        if not rest or rest[0] != "instances":
            self._json({"ok": False, "reason": "relations 未知子路径"}, 404)
            return
        g = load_graph()
        by_id = {n.get("id"): n for n in g.get("nodes", [])}
        items = []
        for e in g.get("edges", []):
            if e.get("type") != rel_type:
                continue
            s = by_id.get(e.get("source_id"))
            t = by_id.get(e.get("target_id"))
            items.append({"id": e.get("id"), "type": rel_type,
                          "source_id": e.get("source_id"),
                          "source_label": _inst_label(s) if s else e.get("source_id"),
                          "source_type": (s or {}).get("type") or "",
                          "target_id": e.get("target_id"),
                          "target_label": _inst_label(t) if t else e.get("target_id"),
                          "target_type": (t or {}).get("type") or "",
                          "weight": e.get("weight", 1.0)})
        self._json({"ok": True, "type": rel_type, "total": len(items), "instances": items})

    def _api_relations_post(self, rel_type, rest, body):
        if not rest or rest[0] != "instances":
            self._json({"ok": False, "reason": "relations 未知子路径"}, 404)
            return
        try:
            req = json.loads(body or b"{}")
        except Exception:
            self._json({"ok": False, "reason": "请求体解析失败"}, 400)
            return
        src = (req.get("source_id") or "").strip()
        dst = (req.get("target_id") or "").strip()
        if not src or not dst:
            self._json({"ok": False, "reason": "缺少 source_id / target_id"}, 422)
            return
        ext = load_ext()
        op = (ext.get("object_props") or {}).get(rel_type)
        if not op and rel_type not in OBJ_PROPS:
            self._json({"ok": False, "reason": "未知关系类型 %s" % rel_type}, 422)
            return
        g = load_graph()
        ids = {n.get("id") for n in g.get("nodes", [])}
        if src not in ids or dst not in ids:
            self._json({"ok": False, "reason": "source / target 实例不存在"}, 422)
            return
        by_id = {n.get("id"): n for n in g.get("nodes", [])}
        dom = (op or {}).get("domain") or ""
        rng = (op or {}).get("range") or ""
        if dom and by_id[src].get("type") != dom:
            self._json({"ok": False, "reason": "source 类型 %s 不符合 domain %s" % (by_id[src].get("type"), dom)}, 422)
            return
        if rng and by_id[dst].get("type") != rng:
            self._json({"ok": False, "reason": "target 类型 %s 不符合 range %s" % (by_id[dst].get("type"), rng)}, 422)
            return
        for e in g.get("edges", []):
            if e.get("type") == rel_type and e.get("source_id") == src and e.get("target_id") == dst:
                self._json({"ok": False, "reason": "该关联实例对已存在"}, 409)
                return
        res = self._commit_simple([{"operation": "add_edge", "type": rel_type,
                                    "source_id": src, "target_id": dst}],
                                  "relations-hub 添加关联 " + rel_type)
        if res.get("ok"):
            ng = res.get("new_g") or {}
            eid = None
            for e in ng.get("edges", []):
                if e.get("type") == rel_type and e.get("source_id") == src and e.get("target_id") == dst:
                    eid = e.get("id")
                    break
            total = sum(1 for e in ng.get("edges", []) if e.get("type") == rel_type)
            res["edge_id"] = eid
            res["total"] = total
        self._json({k: v for k, v in res.items() if k != "new_g"})

    def _api_relations_delete(self, rel_type, rest, body):
        if not rest or rest[0] != "instances" or len(rest) < 2:
            self._json({"ok": False, "reason": "relations 未知子路径"}, 404)
            return
        rel_id = unquote(rest[1])
        res = self._commit_simple([{"operation": "delete_edge", "id": rel_id}],
                                  "relations-hub 删除关联 " + rel_type)
        if res.get("ok"):
            ng = res.get("new_g") or {}
            res["total"] = sum(1 for e in ng.get("edges", []) if e.get("type") == rel_type)
        self._json({k: v for k, v in res.items() if k != "new_g"})

    # ---------- zone: data（P0-2 Excel 导出：实例 / 关系 / 规则 三 Sheet） ----------
    def _api_data_get(self, sub, rest, qs):
        if sub != "export":
            self._json({"ok": False, "reason": "data 未知子路径"}, 404)
            return
        qtype = (qs.get("type", [""])[0] or "").strip()
        if qtype.lower() in ("all", "*"):
            qtype = ""
        g = load_graph()
        nodes = [n for n in g.get("nodes", [])
                 if not qtype or (n.get("type") or "").lower() == qtype.lower()]
        all_keys = []
        for n in nodes:
            for k in (n.get("properties") or {}):
                if k not in all_keys:
                    all_keys.append(k)
        rows1 = []
        for n in nodes:
            p = n.get("properties") or {}
            rows1.append([n.get("id"), n.get("type")] + [_prop_text(p.get(k)) for k in all_keys])
        by_id = {n.get("id"): n for n in g.get("nodes", [])}
        rows2 = []
        for e in g.get("edges", []):
            s = by_id.get(e.get("source_id"))
            t = by_id.get(e.get("target_id"))
            rows2.append([e.get("source_id"), _inst_label(s) if s else "", (s or {}).get("type") or "",
                          e.get("type"), e.get("target_id"), _inst_label(t) if t else "", (t or {}).get("type") or ""])
        rules = collect_rules()
        rows3 = [[r["id"], r["type"], r["name"], r["target"], r["severity"], r["description"]] for r in rules]
        data = build_xlsx_bytes([
            {"name": "实例数据", "headers": ["id", "type"] + all_keys, "rows": rows1},
            {"name": "关系关联", "headers": ["source_id", "source_label", "source_type", "relation", "target_id", "target_label", "target_type"], "rows": rows2},
            {"name": "规则清单", "headers": ["rule_id", "type", "name", "target", "severity", "description"], "rows": rows3},
        ])
        fname = "ReX_数据导出_%s_%s.xlsx" % (qtype or "全部", time.strftime("%Y%m%d_%H%M%S"))
        fname_ascii = "ReX_export_%s_%s.xlsx" % (qtype or "all", time.strftime("%Y%m%d_%H%M%S"))
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self._cors()
        # 中文文件名必须走 RFC 5987（filename*），否则 latin-1 编码头会抛 UnicodeEncodeError
        self.send_header("Content-Disposition",
                         "attachment; filename=\"%s\"; filename*=UTF-8''%s"
                         % (fname_ascii, quote(fname)))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------- zone: rules（P1-2 规则清单 + 全量复检） ----------
    def _api_rules_get(self, sub, rest, qs):
        rules = collect_rules()
        self._json({"ok": True, "total": len(rules), "rules": rules})

    def _api_rules_check_post(self, sub, rest, body, qs):
        try:
            req = json.loads(body or b"{}")
        except Exception:
            req = {}
        qtype = (req.get("type") or (qs or {}).get("type", [""])[0] or "").strip()
        self._json(run_rule_check(qtype))

    # ---------- zone: search（P1-3 全局检索） ----------
    def _api_search_get(self, sub, rest, qs):
        q = (qs.get("q", [""])[0] or "").strip().lower()
        g = load_graph()
        items = []
        for n in g.get("nodes", []):
            p = n.get("properties") or {}
            hay = " ".join([
                str(n.get("id") or ""), str(n.get("type") or ""),
                str(p.get("title") or ""), str(p.get("name") or ""),
                str(p.get("author") or ""), str(p.get("doi") or ""),
                str(p.get("keywords") or ""), str(p.get("venue") or ""),
                str(p.get("abstract") or ""),
            ]).lower()
            if q and q not in hay:
                continue
            items.append({"id": n.get("id"), "type": n.get("type"),
                          "label": _inst_label(n),
                          "props": {k: p.get(k) for k in ("title", "name", "author", "year", "yearText", "doi", "venue", "keywords") if p.get(k) is not None}})
        groups = {}
        for it in items:
            groups.setdefault(it["type"], []).append(it)
        out = [{"type": t, "count": len(v), "items": v} for t, v in sorted(groups.items())]
        self._json({"ok": True, "q": q, "total": len(items), "groups": out})

    # ---------- zone: quality（P1-3 质量统计） ----------
    def _api_quality_get(self, sub, rest, qs):
        if sub != "stats":
            self._json({"ok": False, "reason": "quality 未知子路径"}, 404)
            return
        payload = run_rule_check("")
        payload["checksum"] = graph_checksum()
        payload["last_check"] = QUALITY_CACHE["ts"]
        self._json(payload)


# --------------------------------------------------------------------------
# v6：关系实例 / 规则引擎 / Excel 导出 / 全局检索 / 质量统计（P0-1/P0-2/P1-2/P1-3）
# --------------------------------------------------------------------------
QUALITY_CACHE = {"ts": None, "payload": None}


def _inst_label(n):
    p = (n or {}).get("properties") or {}
    for k in ("title", "name", "keywordName", "filePath"):
        if p.get(k):
            return str(p[k])
    return (n or {}).get("id") or "?"


def _prop_text(v):
    if v is None:
        return ""
    if isinstance(v, (list, tuple)):
        return ", ".join(str(x) for x in v)
    return str(v)


def _is_blank(v):
    if v is None:
        return True
    if isinstance(v, (list, tuple, dict)):
        return len(v) == 0
    return str(v).strip() == ""


def _is_int(v):
    try:
        int(str(v).strip())
        return True
    except Exception:
        return False


def _is_num(v):
    try:
        float(str(v).strip())
        return True
    except Exception:
        return False


def _is_year(v):
    s = str(v).strip()
    return len(s) == 4 and s.isdigit()


def _is_date(v):
    s = str(v).strip()
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", s))


def collect_rules():
    """从本体 TTL + SHACL + 扩展区派生可执行规则清单（/api/rules 与全量复检共用）。"""
    ext = load_ext()
    classes, obj_props, data_props = _scan_schema_ttl(ONTOLOGY_TTL)
    shapes = _scan_shacl(SHAPES_TTL)
    rules = []

    def _add(rid, kind, name, target, severity, description):
        rules.append({"id": rid, "type": kind, "name": name, "target": target,
                      "severity": severity, "description": description})

    # 1) 必填属性（SHACL minCount + 扩展 required，与 /api/ontology/schema 同源合并）
    all_req = {}
    for cls, shape in (shapes or {}).items():
        for f in (shape.get("required") or []):
            if f not in all_req.setdefault(cls, []):
                all_req[cls].append(f)
    for cls, fields in (ext.get("required") or {}).items():
        for f in fields:
            if f not in all_req.setdefault(cls, []):
                all_req[cls].append(f)
    for cls in sorted(all_req):
        for f in all_req[cls]:
            _add("req:%s:%s" % (cls, f), "required", "%s 必填属性 %s" % (cls, f),
                 "%s.%s" % (cls, f), "error",
                 "类 %s 的实例必须填写属性 %s（SHACL sh:minCount 1 / 扩展 required）" % (cls, f))

    # 2) 数据属性取值类型（xsd range）
    all_dp = dict(data_props or {})
    for n, m in (ext.get("data_props") or {}).items():
        all_dp[n] = m
    for n, m in sorted(all_dp.items()):
        rng = (m or {}).get("range") or "string"
        if rng in ("integer", "decimal", "gYear", "date", "boolean", "anyURI"):
            _add("range:%s" % n, "range", "属性 %s 取值类型 %s" % (n, rng),
                 n, "warning", "属性 %s 的取值应为 %s" % (n, rng))

    # 3) 值约束（枚举 / 最小最大 / 正则 / 数据类型）
    for n, spec in sorted((ext.get("value_constraints") or {}).items()):
        bits = []
        if spec.get("in"):
            bits.append("枚举 %s" % ", ".join(str(x) for x in spec["in"]))
        if spec.get("min") is not None:
            bits.append("≥ %s" % spec["min"])
        if spec.get("max") is not None:
            bits.append("≤ %s" % spec["max"])
        if spec.get("pattern"):
            bits.append("匹配 %s" % spec["pattern"])
        if spec.get("datatype"):
            bits.append("类型 %s" % spec["datatype"])
        _add("vc:%s" % n, "value_constraint", "属性 %s 取值约束" % n, n, "warning",
             "属性 %s 必须满足：%s" % (n, "；".join(bits) or "无"))

    # 4) 对象属性端点类型（domain/range）
    all_op = dict(obj_props or {})
    for n, m in (ext.get("object_props") or {}).items():
        all_op[n] = m
    for n, m in sorted(all_op.items()):
        dom = (m or {}).get("domain") or ""
        rng = (m or {}).get("range") or ""
        if dom or rng:
            _add("op:%s" % n, "object_prop", "关系 %s 端点类型" % n, n, "warning",
                 "关系 %s 的源实例类型应∈{%s}、目标实例类型应∈{%s}" % (n, dom or "*", rng or "*"))

    # 5) unique 规则（扩展 rules 配置，如 {"Paper": {"unique": ["doi"]}}）
    for cls, cfg in sorted((ext.get("rules") or {}).items()):
        for f in (cfg.get("unique") or []):
            _add("uniq:%s:%s" % (cls, f), "unique", "%s 字段 %s 唯一" % (cls, f),
                 "%s.%s" % (cls, f), "error",
                 "类 %s 内属性 %s 的取值应全局唯一（重复会导致数据歧义）" % (cls, f))
    return rules


def check_instance_rules(cls, node, g, rules, ext):
    """对单个实例执行适用规则，返回违规列表 [{rule_id, severity, message}]。"""
    viol = []
    props = node.get("properties") or {}
    nid = node.get("id")
    by_id = {x.get("id"): x for x in g.get("nodes", [])}

    for r in rules:
        rid = r["id"]
        if rid.startswith("req:") and r["target"].startswith(cls + "."):
            f = r["target"].split(".", 1)[1]
            if _is_blank(props.get(f)):
                viol.append({"rule_id": rid, "severity": r["severity"],
                             "message": "缺少必填属性 %s" % f})
        elif rid.startswith("range:"):
            pname = rid.split(":", 1)[1]
            v = props.get(pname)
            if _is_blank(v):
                continue
            m = (ext.get("data_props") or {}).get(pname) or {}
            rng = m.get("range") or "string"
            ok = True
            if rng == "integer":
                ok = _is_int(v)
            elif rng == "decimal":
                ok = _is_num(v)
            elif rng == "gYear":
                ok = _is_year(v)
            elif rng == "date":
                ok = _is_date(v)
            elif rng == "boolean":
                ok = str(v).strip().lower() in ("true", "false", "1", "0", "是", "否")
            elif rng == "anyURI":
                ok = str(v).startswith(("http://", "https://", "file://", "doi:", "urn:"))
            if not ok:
                viol.append({"rule_id": rid, "severity": r["severity"],
                             "message": "属性 %s 取值“%s”不符合类型 %s" % (pname, _prop_text(v), rng)})
        elif rid.startswith("vc:"):
            pname = rid.split(":", 1)[1]
            v = props.get(pname)
            if _is_blank(v):
                continue
            spec = (ext.get("value_constraints") or {}).get(pname) or {}
            if spec.get("in") and _prop_text(v) not in [str(x) for x in spec["in"]]:
                viol.append({"rule_id": rid, "severity": r["severity"],
                             "message": "属性 %s 取值“%s”不在枚举 [%s] 内" % (pname, _prop_text(v), ", ".join(str(x) for x in spec["in"]))})
            if spec.get("min") is not None:
                try:
                    if float(v) < float(spec["min"]):
                        viol.append({"rule_id": rid, "severity": r["severity"],
                                     "message": "属性 %s 取值“%s”小于最小值 %s" % (pname, v, spec["min"])})
                except Exception:
                    pass
            if spec.get("max") is not None:
                try:
                    if float(v) > float(spec["max"]):
                        viol.append({"rule_id": rid, "severity": r["severity"],
                                     "message": "属性 %s 取值“%s”大于最大值 %s" % (pname, v, spec["max"])})
                except Exception:
                    pass
            if spec.get("pattern"):
                try:
                    if not re.search(str(spec["pattern"]), str(v)):
                        viol.append({"rule_id": rid, "severity": r["severity"],
                                     "message": "属性 %s 取值“%s”不匹配正则 %s" % (pname, _prop_text(v), spec["pattern"])})
                except Exception:
                    pass
            if spec.get("datatype"):
                dt = spec["datatype"]
                ok = True
                if dt == "integer":
                    ok = _is_int(v)
                elif dt == "decimal":
                    ok = _is_num(v)
                elif dt == "gYear":
                    ok = _is_year(v)
                elif dt == "date":
                    ok = _is_date(v)
                if not ok:
                    viol.append({"rule_id": rid, "severity": r["severity"],
                                 "message": "属性 %s 取值“%s”不符合 datatype %s" % (pname, _prop_text(v), dt)})
        elif rid.startswith("op:"):
            pname = rid.split(":", 1)[1]
            m = (ext.get("object_props") or {}).get(pname) or {}
            dom = m.get("domain") or ""
            rng = m.get("range") or ""
            for e in g.get("edges", []):
                if e.get("type") != pname:
                    continue
                if e.get("source_id") == nid:
                    t = by_id.get(e.get("target_id"))
                    if rng and t and t.get("type") != rng:
                        viol.append({"rule_id": rid, "severity": r["severity"],
                                     "message": "出边 %s → %s 的目标类型 %s 不符合 range %s" % (_inst_label(node), _inst_label(t), t.get("type"), rng)})
                if e.get("target_id") == nid:
                    s = by_id.get(e.get("source_id"))
                    if dom and s and s.get("type") != dom:
                        viol.append({"rule_id": rid, "severity": r["severity"],
                                     "message": "入边 %s → %s 的源类型 %s 不符合 domain %s" % (_inst_label(s), _inst_label(node), s.get("type"), dom)})
        elif rid.startswith("uniq:"):
            _, cls_r, f = rid.split(":", 2)
            if cls_r != cls:
                continue
            v = props.get(f)
            if _is_blank(v):
                continue
            val = _prop_text(v)
            for o in g.get("nodes", []):
                if o.get("id") == nid or o.get("type") != cls:
                    continue
                ov = _prop_text((o.get("properties") or {}).get(f))
                if ov and ov == val:
                    viol.append({"rule_id": rid, "severity": r["severity"],
                                 "message": "属性 %s 取值“%s”与实例 %s 重复（要求唯一）" % (f, val, _inst_label(o))})
    return viol


def run_rule_check(qtype=""):
    """全量复检：遍历（可选限定类型）实例执行规则，返回统计 + 违规明细。"""
    qtype = (qtype or "").strip()
    if qtype in ("all", "*"):
        qtype = ""
    g = load_graph()
    ext = load_ext()
    rules = collect_rules()
    total = passed = failed = 0
    by_type_set = {}
    for n in g.get("nodes", []):
        cls = n.get("type") or "?"
        if qtype and cls != qtype:
            continue
        v = check_instance_rules(cls, n, g, rules, ext)
        total += 1
        b = by_type_set.setdefault(cls, {"total": 0, "passed": 0, "failed": 0, "violations": []})
        b["total"] += 1
        if v:
            failed += 1
            b["failed"] += 1
            b["violations"].append({"id": n.get("id"), "label": _inst_label(n),
                                    "rules": [x["message"] for x in v]})
        else:
            passed += 1
            b["passed"] += 1
    rate = round(passed / total * 100, 2) if total else 100.0
    payload = {"ok": True, "checked_type": qtype or "*", "total": total,
               "passed": passed, "failed": failed, "compliance_rate": rate,
               "rules_total": len(rules),
               "by_type": [{"type": k, **v} for k, v in sorted(by_type_set.items())]}
    QUALITY_CACHE["ts"] = now_iso()
    QUALITY_CACHE["payload"] = payload
    return payload


# ---------- 纯标准库 xlsx 生成（不引入 openpyxl 依赖） ----------
def _xlsx_xml_esc(v):
    return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _xlsx_col_letter(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def build_xlsx_bytes(sheets):
    """sheets: [{name, headers, rows}] → xlsx bytes（zipfile + 最小 OOXML）。"""
    import io
    import zipfile

    def _clean_name(name, idx):
        bad = "".join(c for c in str(name) if c in "[]:*?/\\")
        nm = (bad or ("Sheet%d" % idx))[:31]
        return nm or ("Sheet%d" % idx)

    names = [_clean_name(sh["name"], i) for i, sh in enumerate(sheets, 1)]
    parts = []
    for sh in sheets:
        rows = []
        rows.append("<row>" + "".join(
            '<c t="inlineStr"><is><t>%s</t></is></c>' % _xlsx_xml_esc(h)
            for h in sh["headers"]) + "</row>")
        for row in sh["rows"]:
            cells = "".join('<c t="inlineStr"><is><t>%s</t></is></c>' % _xlsx_xml_esc(_xlsx_escape(v)) for v in row)
            rows.append("<row>%s</row>" % cells)
        parts.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                     '<sheetData>' + "".join(rows) + '</sheetData></worksheet>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                     + "".join('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % i for i in range(1, len(parts) + 1))
                     + '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          '<sheets>' + "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (_xlsx_xml_esc(nm), i, i) for i, nm in enumerate(names, 1)) + '</sheets></workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               + "".join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>' % (i, i) for i in range(1, len(parts) + 1))
               + '</Relationships>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        for i, xml in enumerate(parts, 1):
            z.writestr("xl/worksheets/sheet%d.xml" % i, xml)
    return buf.getvalue()


def _xlsx_escape(v):
    return str(v if v is not None else "")


def simple_diff(s1, s2):
    byid1 = {n.get("id"): n for n in s1.get("nodes", [])}
    byid2 = {n.get("id"): n for n in s2.get("nodes", [])}
    added = [k for k in byid2 if k not in byid1]
    removed = [k for k in byid1 if k not in byid2]
    modified = []
    for k in byid1:
        if k in byid2 and byid1[k] != byid2[k]:
            modified.append(k)
    e1 = {(e.get("source_id"), e.get("type"), e.get("target_id")) for e in s1.get("edges", [])}
    e2 = {(e.get("source_id"), e.get("type"), e.get("target_id")) for e in s2.get("edges", [])}
    return {
        "nodes_added": added, "nodes_removed": removed, "nodes_modified": modified,
        "nodes_added_n": len(added), "nodes_removed_n": len(removed),
        "nodes_modified_n": len(modified),
        "edges_added_n": len(e2 - e1), "edges_removed_n": len(e1 - e2),
    }


def main():
    ensure_inbox()
    # S8：服务启动即预热模型并常驻（keep_alive=30m），避免首篇解析冷启动
    def _warm():
        try:
            from enhance_ingest import warmup_model
            ok, note = warmup_model()
            print("[预热] " + note)
        except Exception as e:
            print("[预热] 跳过：%s" % str(e)[:120])
    threading.Thread(target=_warm, name="llm-warmup", daemon=True).start()
    port = 9000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    server = ThreadingHTTPServer(("0.0.0.0", port), WorkbenchHandler)
    print("=" * 62)
    print("科研文献工作台 v2.0（semantica 六大区移植 · M1 服务层）已启动")
    print("  URL:      http://localhost:%d/" % port)
    print("  六大区API: /api/graph /api/ontology /api/commit /api/manage")
    print("             /api/decisions /api/analyze /api/enrich")
    print("  上传:      POST /api/enrich/ingest/pdf -> 仍在 /upload（兼容）")
    print("  提交闸门:  POST /api/commit  (备份->校验->写回JSON->派生TTL)")
    print("  版本回滚:  GET /api/commit/versions / POST /api/commit/rollback")
    print("  Ctrl+C 停止")
    print("=" * 62)
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
        server.server_close()


if __name__ == "__main__":
    # 授权闸门：无有效 license.json 时后端拒绝启动（开发/测试可用 REX_SKIP_LICENSE=1）
    try:
        import license_guard
        license_guard.require_license("backend")
    except SystemExit:
        raise
    except Exception as _e:      # 缺少校验模块时按未授权处理，避免被静默绕过
        print(f"[license] 校验模块异常，拒绝启动：{_e}", flush=True)
        raise SystemExit(3)
    main()
