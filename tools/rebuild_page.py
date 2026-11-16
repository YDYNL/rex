#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rebuild_page.py — v1.6 前端页面重建脚本（科研文献本地化管理系统）

用途：基于最新图谱 JSON（默认 scholar_literature_graph_v2_4.json，其次 v2_3）
      全量聚合生成页面内嵌 DATA，重建 scholar_literature_manager.html，
      使「上传 PDF 自动入库」后的新增文献在可视化页面即时可见。

与 v1.5 版关键差异：
  - 不再以旧页面 DATA 为底做字段增强，而是从图谱 JSON 全量聚合
    papers / authors / venues / keywords / orgs / stats / yearDist /
    typeDist / graph，新增文献必然反映在统计与列表中（统计不编造）。
  - 支持 --graph 指定任意 v2_x JSON。

复跑方式：
  python3 rebuild_page.py [--graph ../scholar_literature_graph_v2_4.json]
  （需在 Ontology 目录下或使用绝对路径；脚本自动定位 Ontology 根目录）

输出：
  - scholar_literature_manager.html（覆盖）
  - scholar_literature_manager.v2.3.html（旧版备份，仅首次）

不修改任何 TTL / JSON 图谱数据；本脚本只读图谱 JSON 重建页面。
"""
import argparse
import json
import os
import re
import sys
import datetime

# ---------- 路径定位 ----------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ONT = os.path.dirname(SCRIPT_DIR)  # Ontology 根目录
HTML = os.path.join(ONT, "scholar_literature_manager.html")
HTML_BAK = os.path.join(ONT, "scholar_literature_manager.v2.3.html")
DATA_DIR = os.path.join(ONT, "data_test", "论文")
ES_NS = "http://edu-scholar.org/ontology#"


def latest_graph():
    for cand in ("scholar_literature_graph_v2_4.json", "scholar_literature_graph_v2_3.json"):
        p = os.path.join(ONT, cand)
        if os.path.exists(p):
            return p
    raise SystemExit("未找到图谱 JSON（v2_3/v2_4）")


# ---------- 小工具：JS 括号感知定位 ----------
def js_function_end(src, start):
    """从 start（'function'/'{' 起始附近）扫到函数体匹配的 '}' 结束下标（含）。"""
    i = start
    depth = 0
    state = "code"  # code | sq | dq | tpl | linec | blockc
    while i < len(src):
        c = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""
        if state == "code":
            if c == "/" and nxt == "/":
                state = "linec"; i += 2; continue
            if c == "/" and nxt == "*":
                state = "blockc"; i += 2; continue
            if c == "'":
                state = "sq"; i += 1; continue
            if c == '"':
                state = "dq"; i += 1; continue
            if c == "`":
                state = "tpl"; i += 1; continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return i
            i += 1
        elif state == "sq":
            if c == "\\":
                i += 2; continue
            if c == "'":
                state = "code"
            i += 1
        elif state == "dq":
            if c == "\\":
                i += 2; continue
            if c == '"':
                state = "code"
            i += 1
        elif state == "tpl":
            if c == "\\":
                i += 2; continue
            if c == "`":
                state = "code"
            elif c == "$" and nxt == "{":
                end = js_function_end(src, i + 1)
                i = end + 1
                continue
            i += 1
        elif state == "linec":
            if c == "\n":
                state = "code"
            i += 1
        elif state == "blockc":
            if c == "*" and nxt == "/":
                state = "code"; i += 2; continue
            i += 1
    return len(src)


def replace_function(src, func_name, new_func_text):
    """在 src 中按函数名定位并整体替换整个函数。"""
    m = re.search(r"function\s+" + re.escape(func_name) + r"\s*\(", src)
    if not m:
        raise RuntimeError("未找到函数: " + func_name)
    end = js_function_end(src, m.start())
    return src[:m.start()] + new_func_text + src[end + 1:]


# ============================================================================
# 图谱 JSON -> 页面 DATA 全量聚合（唯一事实源：图谱 JSON）
# ============================================================================
def build_page_data(g2):
    nodes = g2["nodes"]
    edges = g2["edges"]
    n_by_id = {n["id"]: n for n in nodes}
    papers = [n for n in nodes if n.get("type") == "Paper"]
    author_nodes = [n for n in nodes if n.get("type") == "Author"]
    venue_nodes = [n for n in nodes if n.get("type") == "Venue"]
    kw_nodes = [n for n in nodes if n.get("type") == "Keyword"]
    org_nodes = [n for n in nodes if n.get("type") == "Organization"]
    lf_nodes = [n for n in nodes if n.get("type") == "LocalFile"]

    # ---- 关系表 ----
    has_author = {}; pub_in = {}; has_kw = {}; cites = {}
    has_affil = {}  # author_id -> set(org_id)
    for e in edges:
        s, t, ty = e.get("source_id"), e.get("target_id"), e.get("type")
        if ty == "hasAuthor":
            has_author.setdefault(s, []).append(t)
        elif ty == "publishedIn":
            pub_in.setdefault(s, []).append(t)
        elif ty == "hasKeyword":
            has_kw.setdefault(s, []).append(t)
        elif ty == "cites":
            cites.setdefault(s, []).append(t)
        elif ty == "hasAffiliation":
            has_affil.setdefault(s, set()).add(t)

    def paper_abs_path(props):
        f = props.get("file", "")
        return os.path.abspath(os.path.join(DATA_DIR, os.path.basename(str(f)))) if f else ""

    # ---- papers ----
    papers_out = []
    for p in papers:
        pp = p.get("properties", {})
        pid = p["id"]
        title = pp.get("title", "")
        pdf = paper_abs_path(pp)
        authors = [{"name": n_by_id[a].get("properties", {}).get("name", ""),
                    "id": a} for a in has_author.get(pid, []) if a in n_by_id]
        keywords = [n_by_id[k].get("properties", {}).get("name", "")
                    for k in has_kw.get(pid, []) if k in n_by_id]
        cites_out = [n_by_id[c].get("properties", {}).get("title", "")
                     for c in cites.get(pid, []) if c in n_by_id]
        papers_out.append({
            "id": pid,
            "title": title,
            "year": pp.get("year", ""),
            "venue": pp.get("venue", ""),
            "doi": pp.get("doi", ""),
            "paperType": pp.get("paperType", "期刊论文"),
            "file": pp.get("file", ""),
            "pdfPath": pdf,
            "keywords": keywords,
            "authors": authors,
            "citesOut": cites_out,
            "aiSummary": pp.get("aiSummary"),
            "autoKeywords": pp.get("autoKeywords"),
            "autoResearchArea": pp.get("autoResearchArea"),
            "confidence": pp.get("confidence"),
            "createdBy": pp.get("createdBy"),
            "sourcedFrom": pp.get("sourcedFrom"),
        })

    # ---- authors ----
    def topk_keywords_for(paper_ids, k=5):
        freq = {}
        for pid in paper_ids:
            for kid in has_kw.get(pid, []):
                nm = n_by_id.get(kid, {}).get("properties", {}).get("name")
                if nm:
                    nm = nm.lower()
                    freq[nm] = freq.get(nm, 0) + 1
        return [w for w, _ in sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))][:k]

    authors_out = []
    for a in author_nodes:
        ap = a.get("properties", {})
        aid = a["id"]
        my_papers = []
        for s, tlist in has_author.items():
            if aid in tlist and s in n_by_id:
                tp = n_by_id[s].get("properties", {})
                my_papers.append([tp.get("title", ""), s])
        ra = ap.get("researchArea") or ""
        if not ra and my_papers:
            kw5 = topk_keywords_for([p[1] for p in my_papers])
            if kw5:
                ra = ", ".join(kw5) + "（由关键词聚合生成）"
        coauth = set()
        for _, pid in my_papers:
            for bid in has_author.get(pid, []):
                if bid != aid:
                    bn = n_by_id.get(bid, {}).get("properties", {}).get("name")
                    if bn:
                        coauth.add(bn)
        authors_out.append({
            "id": aid,
            "name": ap.get("name", ""),
            "affiliation": ap.get("affiliation") or "",
            "researchArea": ra,
            "papers": my_papers,
            "coauthors": sorted(coauth),
        })

    # ---- venues ----
    venue_paper_obj = {p["id"]: p for p in papers_out}
    venues_out = []
    for v in venue_nodes:
        vp = v.get("properties", {})
        vlst = [venue_paper_obj[s] for s, tlist in pub_in.items()
                if v["id"] in tlist and s in venue_paper_obj]
        venues_out.append({"name": vp.get("name", ""), "papers": vlst})

    # ---- keywords ----
    kw_freq = {}
    for k in kw_nodes:
        nm = k.get("properties", {}).get("name", "")
        if not nm:
            continue
        cnt = sum(1 for tlist in has_kw.values() if k["id"] in tlist)
        kw_freq[nm] = cnt
    keywords_out = [{"name": n, "freq": c} for n, c in
                    sorted(kw_freq.items(), key=lambda kv: (-kv[1], kv[0]))]

    # ---- orgs ----
    orgs_out = []
    for o in org_nodes:
        op = o.get("properties", {})
        members = [n_by_id[a].get("properties", {}).get("name", "")
                   for a, orglist in has_affil.items() if o["id"] in orglist and a in n_by_id]
        members = [m for m in members if m]
        orgs_out.append({"name": op.get("name", ""), "members": members})

    # ---- stats ----
    n_paper = len(papers_out)
    paper_with_file = sum(1 for p in papers_out if p["pdfPath"] and os.path.exists(p["pdfPath"]))
    paper_key_total = sum(1 for p in papers_out if p.get("doi") or p.get("title"))
    cites_cover = len(cites)
    node_ids = set(n_by_id.keys())
    dangling = sum(1 for e in edges if e.get("source_id") not in node_ids or e.get("target_id") not in node_ids)
    authors_no_org = sum(1 for a in authors_out if not a.get("affiliation"))
    authors_with_ra = sum(1 for a in authors_out if a.get("researchArea"))
    gmeta = g2.get("meta", {})
    llm_meta = gmeta.get("llm", {})
    enhance_model = llm_meta.get("model") or gmeta.get("enhance_model") or "qwen3:8b"
    enhance_mode = gmeta.get("enhance_mode") or ("ollama" if enhance_model else "rule")
    v16 = gmeta.get("v16", {}) if isinstance(gmeta, dict) else {}
    dedup_hit = v16.get("dedup_hit", 0) if isinstance(v16, dict) else 0
    added_new = v16.get("added_new", 0) if isinstance(v16, dict) else 0
    stats = {
        "paper": n_paper,
        "author": len(authors_out),
        "venue": len(venues_out),
        "keyword": len(keywords_out),
        "organization": len(orgs_out),
        "localfile": len(lf_nodes),
        "edge": len({(e.get("source_id"), e.get("target_id"), e.get("type")) for e in edges}),
        "paperKey": paper_key_total,
        "citesCover": cites_cover,
        "dangling": dangling,
        "authorsNoOrg": authors_no_org,
        "authorsWithResearch": authors_with_ra,
        "paperWithFile": paper_with_file,
        "aiKeywordsCover": sum(1 for p in papers_out if p.get("autoKeywords")),
        "withConfidence": sum(1 for p in papers_out if p.get("confidence") is not None),
        "withSourcedFrom": sum(1 for p in papers_out if p.get("sourcedFrom")),
        "aiSummaryCover": sum(1 for p in papers_out if p.get("aiSummary")),
        "paperEnhanced": sum(1 for p in papers_out if p.get("createdBy")),
        "enhanceMode": enhance_mode,
        "enhanceModel": enhance_model,
        "dedupHit": dedup_hit,
        "addedNew": added_new,
    }

    # ---- yearDist / typeDist ----
    yd = {}
    for p in papers_out:
        y = p.get("year") or ""
        if re.match(r"^\d{4}$", str(y)):
            yd[str(y)] = yd.get(str(y), 0) + 1
    year_dist = [[y, c] for y, c in sorted(yd.items(), key=lambda kv: kv[0])]
    td = {}
    for p in papers_out:
        t = p.get("paperType") or "待补全"
        td[t] = td.get(t, 0) + 1
    type_dist = [[t, c] for t, c in td.items()]

    # ---- graph ----
    g_nodes = []
    for n in nodes:
        pp = n.get("properties", {})
        if n.get("type") == "Paper":
            nm = pp.get("title", "")
        else:
            nm = pp.get("name") or pp.get("content") or ""
        g_nodes.append({"id": n["id"], "type": n.get("type", ""), "name": nm})
    seen = set()
    g_edges = []
    for e in edges:
        key = (e.get("source_id"), e.get("target_id"), e.get("type"))
        if key in seen:
            continue
        seen.add(key)
        g_edges.append({"s": key[0], "t": key[1], "type": key[2]})

    meta = {
        "title": gmeta.get("title", "科研文献知识图谱"),
        "version": gmeta.get("version", ""),
        "created": gmeta.get("created", ""),
        "namespace": gmeta.get("namespace", ES_NS),
        "source": gmeta.get("source", ""),
    }

    return {
        "meta": meta,
        "stats": stats,
        "yearDist": year_dist,
        "typeDist": type_dist,
        "papers": papers_out,
        "authors": authors_out,
        "venues": venues_out,
        "keywords": keywords_out,
        "orgs": orgs_out,
        "graph": {"nodes": g_nodes, "edges": g_edges},
        "pdfDir": DATA_DIR,
    }


# ============================================================================
# v1.6 上传入库标签页脚本（幂等，缺失才注入）
# ============================================================================
UPLOAD_SCRIPT = '''
<script>
/* ================= v1.6 上传入库面板 ================= */
(() => {
  const VID = 'view-upload';
  function $id(x){ return document.getElementById(x); }

  function escHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ------- file:// 下仅展示命令指引，不报错 ------- */
  function isFileProto(){ return location.protocol === 'file:'; }

  function renderFileGuidance(){
    const el = $id(VID);
    if(!el) return;
    el.innerHTML = '<div class="panel"><h3>上传 PDF 自动入库（v1.6）</h3>'
      + '<div class="note" style="line-height:1.9">'
      + '当前以 <code>file://</code> 方式直接打开页面，无法调用上传接口。'
      + '请先启动本地服务后再刷新页面：'
      + '<br><br><code style="background:#eef2f7;padding:6px 10px;border-radius:6px;display:inline-block">'
      + 'cd ' + escHtml(DATA.pdfDir.split('论文')[0]) + ' && python3 tools/serve.py'
      + '</code>'
      + '<br><span class="muted" style="color:#aab4c4">然后浏览器访问 <code>http://localhost:9000</code>，'
      + '切到「上传入库」标签页即可上传本地 PDF 文献。</span>'
      + '</div></div>';
  }

  /* ------- 服务模式下：上传表单 + 结果 ------- */
  function renderUploadPanel(){
    const el = $id(VID);
    if(!el) return;
    el.innerHTML = '<div class="panel"><h3>上传 PDF 文献入库（v1.6 自动闭环）</h3>'
      + '<div class="note">上传本地 PDF 后，系统将自动完成：<b>解析元数据（标题/作者/年份/DOI/摘要）'
      + '→ 去重（DOI/标题/文件名）→ 本地 LLM 增强（qwen3:8b 生成 aiSummary/关键词/研究方向）'
      + '→ 本体实例化 → 增量写入 v2_4 图谱与 TTL → 即时重建页面</b>。</div>'
      + '<div id="up-drop" style="border:2px dashed #bac8ff;border-radius:12px;background:#f5f7ff;'
      + 'padding:34px 20px;text-align:center;margin:14px 0;cursor:pointer;color:#4263eb">'
      + '<div style="font-size:15px;font-weight:600">拖拽 PDF 文件到此处</div>'
      + '<div style="font-size:13px;color:#748ffc;margin-top:6px">或点击下方按钮选择文件（仅支持 .pdf）</div></div>'
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + '<button id="up-pick" style="padding:8px 16px;background:#4263eb;color:#fff;border:0;border-radius:8px;cursor:pointer">选择 PDF 文件…</button>'
      + '<input type="file" id="up-file" accept="application/pdf,.pdf" style="display:none">'
      + '<span id="up-name" style="color:#55607a;font-size:13px"></span></div>'
      + '<div id="up-status" style="margin-top:14px;line-height:1.8"></div></div>';

    const drop = $id('up-drop'), fileInput = $id('up-file'), nameSpan = $id('up-name');
    $id('up-pick').addEventListener('click', () => fileInput.click());
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#4263eb'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = '#bac8ff'; });
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.style.borderColor = '#bac8ff';
      if(e.dataTransfer.files && e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if(fileInput.files.length) uploadFile(fileInput.files[0]);
    });

    function uploadFile(file){
      nameSpan.textContent = '已选择：' + file.name + '（' + (file.size/1024/1024).toFixed(2) + ' MB）';
      const st = $id('up-status');
      st.innerHTML = '<div class="status loading">正在上传并入库，请稍候（本地 LLM 摘要生成约需数十秒）…</div>';
      const fd = new FormData();
      fd.append('file', file);
      fetch('/upload', {method:'POST', body:fd})
        .then(r => r.json())
        .then(res => {
          const color = (res.status === 'ingested') ? '#2f9e44'
                      : (res.status === 'duplicate') ? '#e8590c'
                      : '#e03131';
          const head = (res.status === 'ingested') ? '✅ 入库成功（新增文献）'
                     : (res.status === 'duplicate') ? '⏭ 已入库（去重命中，跳过新增）'
                     : (res.status === 'failed') ? '⚠ 入库失败'
                     : '处理完成';
          let tail = '';
          if(res.status === 'ingested'){
            tail = '<div style="margin-top:8px"><b style="color:#2f9e44">3 秒后自动刷新，'
                 + '新文献将在「文献」标签页与其他统计中可见。</b></div>'
                 + '<button id="up-reload" style="padding:6px 12px;border:1px solid #4263eb;'
                 + 'border-radius:6px;background:#fff;color:#4263eb;cursor:pointer;margin-right:8px">立即刷新</button>'
                 + '<button id="up-goto" style="padding:6px 12px;border:0;border-radius:6px;'
                 + 'background:#eef2ff;color:#4263eb;cursor:pointer">去「文献」标签页查看</button>';
            setTimeout(() => location.reload(), 3000);
          } else if(res.status === 'duplicate'){
            tail = '<div style="margin-top:6px;font-size:13px;color:#55607a">'
                 + '该 PDF 与库中已有文献重复（' + escHtml(res.reason || 'DOI/标题/文件名命中') + '），'
                 + '未重复入库，库体积不变。</div>';
          } else {
            tail = '<div style="margin-top:6px;font-size:13px;color:#55607a;white-space:pre-wrap;'
                 + 'max-height:180px;overflow:auto">' + escHtml(res.reason || res.detail || '未知原因：' + res.title) + '</div>';
          }
          st.innerHTML = '<div class="status" style="border:1px solid ' + color + ';color:' + color
            + ';background:#fff;padding:10px 12px;border-radius:8px">'
            + '<b>' + head + '</b>'
            + (res.title ? '<div style="margin-top:4px">文献：' + escHtml(res.title) + '</div>' : '')
            + '</div>' + tail;
          const rl = $id('up-reload'); if(rl) rl.addEventListener('click', () => location.reload());
          const gt = $id('up-goto'); if(gt) gt.addEventListener('click', () => {
            document.querySelector('#tabs .tab[data-v="papers"]').click();
          });
        })
        .catch(err => {
          st.innerHTML = '<div class="status" style="color:#e03131;border:1px solid #e03131;'
            + 'border-radius:8px;padding:10px 12px;background:#fff">上传请求失败：' + escHtml(String(err))
            + '<div style="margin-top:4px;font-size:13px">请确认已通过 <code>python3 tools/serve.py</code> '
            + '启动本地服务（file:// 直接打开无法上传）。</div></div>';
        });
    }
  }

  function initUpload(){
    if(isFileProto()){ renderFileGuidance(); return; }
    renderUploadPanel();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUpload);
  else initUpload();
})();
</script>
'''

# ============================================================================
# 主流程
# ============================================================================
def main():
    ap = argparse.ArgumentParser(description="v1.6 页面重建：图谱 JSON 全量聚合 -> 页面")
    ap.add_argument("--graph", help="图谱 JSON 路径（默认自动选择最新 v2_x）")
    args = ap.parse_args()

    graph_path = args.graph or latest_graph()
    with open(graph_path, encoding="utf-8") as f:
        g2 = json.load(f)
    version = str(g2.get("meta", {}).get("version", ""))
    if version == "2.4":
        VERSION, VERSION_LABEL = "2.4", "v2.4（v1.6 上传 PDF 自动入库版）"
    else:
        VERSION, VERSION_LABEL = "2.3", "v2.3（v1.5 增强版 · 真实 LLM 摘要）"

    # 备份旧页面（仅首次）
    if os.path.exists(HTML) and not os.path.exists(HTML_BAK):
        with open(HTML, encoding="utf-8") as f:
            html_src = f.read()
        with open(HTML_BAK, "w", encoding="utf-8") as f:
            f.write(html_src)
        print("已备份旧页面 ->", HTML_BAK)

    with open(HTML, encoding="utf-8") as f:
        html = f.read()

    # ---- 解析旧 <script>（作为 CSS/JS 模板） ----
    script_i = html.find("<script>")
    script_j = html.find("</script>")
    js = html[script_i + 8:script_j]

    # ---- 全量聚合新 DATA（唯一事实源：图谱 JSON） ----
    data = build_page_data(g2)
    new_data_json = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    js2 = js[:script_i + 8 - script_i]  # 占位
    # 替换旧 const DATA 定义
    m_data = re.search(r"const DATA\s*=.*?;\n", js, re.S)
    if not m_data:
        raise RuntimeError("旧页面未找到 const DATA 定义")
    js2 = js[:m_data.start()] + "const DATA = " + new_data_json + ";\n" + js[m_data.end():]

    # ---- paperCard：新增文献同样展示 v1.5/v1.6 增强字段，failed 如实标注 ----
    new_paper_card = r'''function paperCard(p){
  const modeLabel = (p.createdBy === 'ollama') ? '本地 LLM 标注'
    : (p.createdBy === 'llm' ? 'LLM 标注'
    : (p.createdBy === 'rule' ? '规则标注'
    : (p.createdBy === 'failed' ? 'LLM 标注失败'
    : '未标注')));
  const confPct = (p.confidence != null) ? (Math.round(p.confidence * 100) + '%') : '—';
  return `<div class="item long">
    <h4>${esc(p.title)} ${p.createdBy ? '<span class="tag ai" title="v1.5 自动元数据增强 / v1.6 上传入库">增强标注</span>' : ''}</h4>
    <div class="meta">${esc(p.year||'待补全')} · <b>${esc(p.venue||'待补全')}</b>
      · 作者 ${p.authors.map(a=>esc(a.name)).join(', ')}</div>
    <div>${p.keywords.map(k=>`<span class="tag kw">${esc(k)}</span>`).join('')}</div>
    <div class="detail">
      <div class="dl">
        <div><div class="k">DOI</div><div class="v">${esc(p.doi||'待补全')}</div></div>
        <div><div class="k">年份</div><div class="v">${esc(p.year||'待补全')}</div></div>
        <div><div class="k">文献类型</div><div class="v">${esc(p.paperType||'待补全')}</div></div>
        <div><div class="k">期刊 / 会议</div><div class="v">${esc(p.venue||'待补全')}</div></div>
        <div><div class="k">本地 PDF 路径</div><div class="v">${p.pdfPath ? `<a href="file://${esc(p.pdfPath)}">${esc(p.pdfPath)}</a>` : '待补全'}</div></div>
        <div><div class="k">引用 (cites)</div><div class="v">${p.citesOut.length ? p.citesOut.map(esc).join('<br>') : '暂无引用记录'}</div></div>
      </div>
      <div class="ai">
        <div class="ai-title">自动元数据增强</div>
        <div class="dl">
          <div><div class="k">自动关键词（autoKeywords）</div><div class="v">${p.autoKeywords ? esc(p.autoKeywords) : '—'}</div></div>
          <div><div class="k">研究方向（自动归类）</div><div class="v">${p.autoResearchArea ? esc(p.autoResearchArea) : '—'}</div></div>
          <div><div class="k">置信度（confidence）</div><div class="v">${confPct}</div></div>
          <div><div class="k">标注模式（createdBy）</div><div class="v">${modeLabel}</div></div>
          <div><div class="k">溯源回链（sourcedFrom）</div><div class="v">${p.sourcedFrom ? esc(p.sourcedFrom) : '—'}</div></div>
        </div>
        <div class="k">AI 摘要（aiSummary · ${esc((DATA.stats && DATA.stats.enhanceModel) || '本地 LLM')}）</div>
        <div class="v" style="margin-top:2px">${p.aiSummary ? esc(p.aiSummary) : '<i style="color:var(--muted)">该篇 LLM 调用失败或未增强，aiSummary 如实留空（不编造）</i>'}</div>
      </div>
    </div>
  </div>`;
}'''
    js2 = replace_function(js2, "paperCard", new_paper_card)

    # ---- renderOverview 注入 v1.5/v1.6 说明块 ----
    v16_block = '''以上均为数据实际状态，未作任何编造。
      </div>
      <div class="dl" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <div><div class="k">自动关键词增强</div><div class="v">${s.aiKeywordsCover}/${s.paper} 篇（autoKeywords）</div></div>
        <div><div class="k">研究方向自动归类</div><div class="v">${s.paperEnhanced}/${s.paper} 篇（createdBy 已标注）</div></div>
        <div><div class="k">置信度标注</div><div class="v">${s.withConfidence}/${s.paper} 篇（confidence）</div></div>
        <div><div class="k">溯源回链</div><div class="v">${s.withSourcedFrom}/${s.paper} 篇（sourcedFrom）</div></div>
        <div><div class="k">AI 摘要</div><div class="v">${s.aiSummaryCover}/${s.paper} 篇（aiSummary，本地 LLM ${s.enhanceModel||\'\'}）</div></div>
        <div><div class="k">上传入库（v1.6）</div><div class="v">本次新增 ${s.addedNew} 篇 · 去重命中 ${s.dedupHit} 篇</div></div>
        <div><div class="k">增强模式</div><div class="v">${s.enhanceMode===\'ollama\' ? (\'本地 LLM 抽取（created_by=ollama，模型 \' + (s.enhanceModel||\'-\') + \'）\') : (s.enhanceMode===\'rule\' ? \'规则抽取（created_by=rule）\' : s.enhanceMode)}</div></div>
      </div>
      <div class="note"><b>v1.6 上传 PDF 自动入库闭环：</b>本地 PDF 上传后自动完成 解析元数据 → 去重（DOI/标题/文件名）→ 本地 LLM 增强（qwen3:8b，aiSummary/关键词/研究方向，带置信度与溯源）→ 本体实例化 -> 增量写入 v2_4 图谱与 TTL → 即时重建本页面。新增文献见「文献」标签页；去重命中/失败在「上传入库」标签页如实显示。上传方式：请先运行 <code>python3 tools/serve.py</code> 并以浏览器访问 <code>http://localhost:9000</code>（file:// 直开仅展示命令指引）。增强明细见 v1_5_enhancement_report.md 与 v1_6_ingest_report.md。</div>'''
    v16_start_marker = "以上均为数据实际状态，未作任何编造。"
    v16_end_marker = "v1_5_enhancement_report.md。</div>"
    if "v1_6_ingest_report.md" in js2:
        # 已注入 v1.6 说明块（幂等重建），不重复注入
        pass
    elif v16_end_marker in js2:
        i0 = js2.find(v16_start_marker)
        i1 = js2.find(v16_end_marker, i0) + len(v16_end_marker)
        js2 = js2[:i0] + v16_block + js2[i1:]
    else:
        raise RuntimeError("未找到 renderOverview 的说明锚点，页面结构可能已变化")

    # ---- 追加 CSS ----
    extra_css = """
.tag.ai{background:#edf2ff;color:#4263eb;border:1px solid #bac8ff}
.ai{margin-top:14px;border-top:1px dashed #bac8ff;padding:10px 12px;background:#f5f7ff;border-radius:10px}
.ai .ai-title{font-size:12px;font-weight:600;color:#4263eb;margin-bottom:6px}
"""
    style_end = html.find("</style>")
    if style_end == -1:
        raise RuntimeError("未找到 </style>")
    html2 = html[:style_end] + extra_css + html[style_end:]

    # ---- 版本 / 标题文本更新（兼容多代） ----
    html2 = html2.replace("<title>科研文献本地化管理系统 2.3（v1.5 自动元数据增强版）</title>",
                          "<title>科研文献本地化管理系统 %s（v1.5 增强 · v1.6 上传入库）</title>" % VERSION)
    html2 = html2.replace("<title>科研文献本地化管理系统 2.2（v1.5 自动元数据增强版）</title>",
                          "<title>科研文献本地化管理系统 %s（v1.5 增强 · v1.6 上传入库）</title>" % VERSION)
    html2 = html2.replace("<h1>科研文献本地化管理系统 v2.3（v1.5 增强版）</h1>",
                          "<h1>科研文献本地化管理系统 %s</h1>" % VERSION_LABEL)
    html2 = html2.replace("<h1>科研文献本地化管理系统 v2.2（v1.5 增强版）</h1>",
                          "<h1>科研文献本地化管理系统 %s</h1>" % VERSION_LABEL)

    # ---- footer 数据源更新（v2_4 时保持与图谱版本一致） ----
    html2 = re.sub(r"<footer[^>]*>[\s\S]*?</footer>",
                   '<footer style="text-align:center;color:#aab4c4;font-size:12px;margin-top:40px">'
                   '科研学术本体 v1 · 基于 ' + os.path.basename(graph_path)
                   + '（v1.5 LLM 增强 · v1.6 上传 PDF 自动入库）自适应生成 · 本地化单文件页面</footer>',
                   html2, count=1)

    # ---- 写回（head 坐标系用 partition，鲁棒） ----
    head, sep, _ = html2.partition("<script>")
    if not sep:
        raise RuntimeError("html2 中未找到 <script>")
    _, _, tail = html2.partition("</script>")
    html_new = head + "<script>" + js2 + "</script>" + tail

    # ---- 幂等补齐「上传入库」标签页：tab 按钮 + 视图容器 + 脚本 ----
    if 'data-v="upload"' not in html_new:
        m_tab = re.search(r'<button class="tab" data-v="graph">[^<]*</button>', html_new)
        if m_tab:
            html_new = (html_new[:m_tab.end()]
                        + '\n    <button class="tab" data-v="upload">上传入库</button>'
                        + html_new[m_tab.end():])
    if 'id="view-upload"' not in html_new:
        m_view = re.search(r'<div id="view-graph" class="view"></div>', html_new)
        if m_view:
            html_new = (html_new[:m_view.end()]
                        + '\n  <div id="view-upload" class="view"></div>'
                        + html_new[m_view.end():])
    if 'v1.6 上传入库面板' not in html_new:
        if "</body>" in html_new:
            html_new = html_new.replace("</body>", UPLOAD_SCRIPT + "</body>", 1)
        else:
            html_new += UPLOAD_SCRIPT

    with open(HTML, "w", encoding="utf-8") as f:
        f.write(html_new)
    print("已重建页面 ->", HTML)
    print("新版本:", VERSION, "| 图谱:", os.path.basename(graph_path),
          "| 节点:", len(data["graph"]["nodes"]), "边:", len(data["graph"]["edges"]),
          "| 文献:", data["stats"]["paper"], "作者:", data["stats"]["author"])


if __name__ == "__main__":
    main()
