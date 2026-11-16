# -*- coding: utf-8 -*-
"""v6 -> v7 图谱全量改造补丁：形状编码 / 交互重写 / 统一右侧详情 / HUD 控件"""
import io, sys, os

SRC = "/Users/lolilosorb/AI_APP/marvis/output/Ontology/web/prototype_ai_workbench_v6.html"

with io.open(SRC, "r", encoding="utf-8") as f:
    html = f.read()

orig_len = len(html)

# ---------------- 1. 追加 CSS ----------------
CSS_ANCHOR = ".legend b{color:var(--ink)}"
CSS_ADD = CSS_ANCHOR + """
/* ==== v7 图谱交互增强 ==== */
#paperArea{transition:padding-right .25s ease}
#paperArea.rel-open{padding-right:352px}
.ghud{position:absolute;top:10px;right:12px;display:flex;gap:6px;z-index:5}
.ghud button{border:1px solid #dfe3f0;background:rgba(255,255,255,.95);color:#3b4256;border-radius:8px;
  padding:5px 10px;font-size:12px;cursor:pointer;box-shadow:0 1px 5px rgba(30,41,80,.08);font-family:inherit}
.ghud button:hover{background:#f1f3fb;border-color:#c7cff0;color:#2b3d8f}
.g-node text{pointer-events:none}
.g-node .g-label{font-size:9.5px;fill:#343a40;stroke:#fff;stroke-width:2.6;paint-order:stroke;stroke-linejoin:round}
.g-node .g-label.hub{font-size:10.5px;fill:#1f2430;font-weight:600}
.g-node.dim .g-label{font-size:12.5px;font-weight:600;fill:#1f2430;stroke:#fff;stroke-width:3}
.g-node.sel polygon,.g-node.sel rect,.g-node.sel circle{stroke:#212529;stroke-width:2.2}
.g-edge{transition:stroke-opacity .15s,stroke-width .15s}
.rel-adj{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 10px}
.rel-adj span{cursor:pointer;font-size:11.5px;background:#f1f3f9;border:1px solid #e3e7f3;border-radius:6px;
  padding:2px 7px;color:#3b4256;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rel-adj span:hover{background:#e7ecff;border-color:#b9c6f5;color:#2b3d8f}
.rel-adj span .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle}
.rel-adj span.on{background:#e7ecff;border-color:#93a5f0}
.rel-kind{font-size:11.5px;color:var(--muted);margin:8px 0 4px;font-weight:600}
.rel-kind em{font-style:normal;color:#adb5bd;font-weight:400}
.kv{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;padding:5px 0;border-bottom:1px dashed #eef0f7}
.kv i{font-style:normal;color:var(--muted);flex:0 0 auto}
.kv b{font-weight:500;color:#212529;text-align:right;word-break:break-all}
.rel-badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:#eef1fb;color:#3b4256;margin-right:6px}"""
assert CSS_ANCHOR in html, "CSS anchor missing"
html = html.replace(CSS_ANCHOR, CSS_ADD, 1)

# ---------------- 2. 替换 JS 段 ----------------
START = "function renderGraph(){"
END_MARK = "/* ================= 管理：本体结构画布 ================= */"
i = html.index(START)
j = html.index(END_MARK)
old_block = html[i:j]

NEW_JS = r'''/* ================= 图谱：形状编码 / 交互 / 统一详情 ================= */

/* --- 形状编码：一眼区分节点类型（对齐 Knowledge Explorer 的 visual key） --- */
var NS_SHAPE = {
  Paper: "ring", LocalFile: "dot",
  Author: "square", Keyword: "diamond", Venue: "capsule",
  Organization: "hex", DomainCategory: "tri"
};
var SHAPE_LABEL = {ring:"圆环", dot:"虚点", square:"方点", diamond:"菱形", capsule:"胶囊", hex:"六边形", tri:"三角"};
var EDGE_LABEL = {cites:"引用", hasAuthor:"作者", hasKeyword:"关键词", hasResearchTopic:"研究方向",
                  publishedIn:"发表于", hasAffiliation:"所属机构", related_to:"相关", dim:"归属维度"};

/* 图谱节点 → 文献对象 */
function nodeToPaper(n){
  if (!n) return null;
  if (n.paper) return n.paper;
  for (var i=0;i<PAPERS.length;i++) if (String(PAPERS[i].nid) === String(n.id)) return PAPERS[i];
  return findP(n.id) || null;
}

function shapeGeom(nsType, r){
  var t = NS_SHAPE[nsType] || "ring";
  if (t === "ring" || t === "dot") return {t:t, geom:'<circle cx="0" cy="0" r="'+r.toFixed(1)+'"/>'};
  if (t === "square"){ var s = r*0.95; return {t:t, geom:'<rect x="'+(-s).toFixed(1)+'" y="'+(-s).toFixed(1)+'" width="'+(2*s).toFixed(1)+'" height="'+(2*s).toFixed(1)+'" rx="2.5"/>'}; }
  if (t === "capsule"){ var w = r*1.45, h = r*0.92; return {t:t, geom:'<rect x="'+(-w).toFixed(1)+'" y="'+(-h).toFixed(1)+'" width="'+(2*w).toFixed(1)+'" height="'+(2*h).toFixed(1)+'" rx="'+(h*0.95).toFixed(1)+'"/>'}; }
  var sides = (t==="tri") ? 3 : 4, rot = -Math.PI/2, K = (t==="diamond") ? 1.30 : 1.20;
  if (t === "hex"){ sides = 6; rot = -Math.PI/2; }
  var pts = [];
  for (var k=0;k<sides;k++){
    var a = rot + k*2*Math.PI/sides;
    pts.push((Math.cos(a)*r*K).toFixed(1)+","+(Math.sin(a)*r*K).toFixed(1));
  }
  return {t:t, geom:'<polygon points="'+pts.join(" ")+'"/>'};
}

/* --- 图数据缓存与视图状态 --- */
var GRAPH = null;   /* {g, viewBox, selId, adj, svg, wrap} */
var GVB = [0,0,1000,660];
var gtip = null;

function graphAdj(g){
  var adj = {};
  g.edges.forEach(function(e){
    if (!g.nodeMap[e.s] || !g.nodeMap[e.t]) return;
    (adj[e.s] = adj[e.s] || []).push({id:e.t, etype:e.etype, dir:"out"});
    (adj[e.t] = adj[e.t] || []).push({id:e.s, etype:e.etype, dir:"in"});
  });
  return adj;
}
function graphApplyVB(){
  var G = GRAPH; if (!G || !G.svg) return;
  G.svg.setAttribute("viewBox", G.viewBox.join(" "));
}
function graphZoom(f, cx, cy){
  var G = GRAPH; if (!G) return;
  var vb = G.viewBox;
  var mx = (cx===undefined) ? 0.5 : cx, my = (cy===undefined) ? 0.5 : cy;
  var nw = Math.max(180, Math.min(4000, vb[2]*f)), nh = nw*(vb[3]/vb[2]);
  var ax = vb[0] + mx*vb[2], ay = vb[1] + my*vb[3];
  G.viewBox = [ax-mx*nw, ay-my*nh, nw, nh];
  graphApplyVB();
}
function graphFit(){
  var G = GRAPH; if (!G) return;
  G.viewBox = [0,0,1000,660]; graphApplyVB();
}
function graphFocusNode(id){
  var G = GRAPH; if (!G) return;
  var n = G.g.nodeMap[id]; if (!n) return;
  var w = Math.min(G.viewBox[2], 460), h = w*(G.viewBox[3]/G.viewBox[2]);
  G.viewBox = [n.x-w/2, n.y-h/2, w, h];
  graphApplyVB();
}

/* 依据视图高度不同，重算布局并重绘（换一种分布） */
function graphRelayout(){
  var G = GRAPH; if (!G || !G.g) return;
  var g = G.g;
  var W = 1000, H = 660;
  g.nodes.forEach(function(n){ n.x = 60 + Math.random()*(W-120); n.y = 60 + Math.random()*(H-120); });
  layoutGraph(g.nodes, g.edges, g.nodeMap, {W:W, H:H, spread: (g.mode==="all" ? 0.44 : 0.40)});
  var host = document.getElementById("gHost");
  if (host) host.innerHTML = graphMarkup(g);
  GRAPH.selId = null;
  graphSelect(null, true);
}

/* --- SVG 主体生成 --- */
function graphMarkup(g){
  var W = 1000, H = 660;
  var labSet = {}, hubSet = {};
  if (g.mode === "all"){
    g.nodes.slice().sort(function(a,b){ return (b.deg||0)-(a.deg||0); }).slice(0, 46).forEach(function(n){ labSet[n.id] = 1; hubSet[n.id] = 1; });
  }
  var s = '<svg id="graphSvg" viewBox="' + GVB.join(" ") + '" preserveAspectRatio="xMidYMid meet"><g id="gEdges">';
  g.edges.forEach(function(e){
    var a = g.nodeMap[e.s], b = g.nodeMap[e.t]; if (!a || !b) return;
    var col = (g.mode === "all") ? (EDGE_COLOR[e.etype] || "#ced4da") : "#b9c2f0";
    var op = (g.mode === "all") ? 0.26 : 0.5;
    s += '<line class="g-edge" data-s="'+esc(e.s)+'" data-t="'+esc(e.t)+'" data-op="'+op+'"'
       + ' x1="'+a.x.toFixed(1)+'" y1="'+a.y.toFixed(1)+'" x2="'+b.x.toFixed(1)+'" y2="'+b.y.toFixed(1)+'"'
       + ' stroke="'+col+'" stroke-opacity="'+op+'" stroke-width="1"/>';
  });
  s += '</g><g id="gNodes">';

  /* 维度聚团图：大节点（维度值） */
  if (g.mode === "dim"){
    var cols = palette(g.dims.length);
    g.dims.forEach(function(n, i){
      n.color = cols[i];
      var fs = Math.max(9.5, Math.min(13.5, n.r*0.55));
      s += '<g class="g-node dim" data-id="'+esc(n.id)+'" data-kind="dim">'
         + '<circle cx="'+n.x.toFixed(1)+'" cy="'+n.y.toFixed(1)+'" r="'+n.r.toFixed(1)+'" fill="'+n.color+'" fill-opacity=".92"/>'
         + '<text class="g-label" x="'+n.x.toFixed(1)+'" y="'+(n.y-n.r-6).toFixed(1)+'" text-anchor="middle" font-size="'+fs.toFixed(1)+'">'
         + esc(short(n.name,12)) + (n.count>1 ? '<tspan fill="#868e96" font-size="'+(fs*0.85).toFixed(1)+'"> '+n.count+'</tspan>' : '') + '</text></g>';
    });
  }

  /* 文献 / 本体节点 */
  g.nodes.forEach(function(n){
    if (n.type === "dim") return;
    var isPaper = (n.type === "paper") || (n.nsType === "Paper");
    var col = isPaper ? "#4c6ef5" : (NS_COLOR[n.nsType] || "#868e96");
    var nsType = isPaper ? "Paper" : n.nsType;
    var geo = shapeGeom(nsType, n.r);
    var fill, stroke = "#fff", sw = 1.1;
    if (geo.t === "ring"){ fill = "#fff"; stroke = col; sw = 1.6; }
    else if (geo.t === "dot"){ fill = "#fff"; stroke = col; sw = 1.4; }
    else { fill = col; }
    var gid = esc(n.id), pid = isPaper ? (n.type==="paper" ? n.paper.id : "") : "";
    s += '<g class="g-node'+(isPaper?" paper":" ns")+(g.mode==="dim"?" pnode":"")+'" data-id="'+gid+'" data-kind="'+(isPaper?"paper":"ns")+'"'
       + (pid!=="" ? ' data-pid="'+esc(pid)+'"' : '')
       + (isPaper ? '' : ' data-nstype="'+esc(nsType)+'"')
       + ' transform="translate('+n.x.toFixed(1)+','+n.y.toFixed(1)+')" '
       + (geo.t==="dot" ? 'stroke-dasharray="2 2" ' : '')
       + 'fill="'+fill+'" fill-opacity="'+(geo.t==="ring"||geo.t==="dot"?1:0.9)+'" stroke="'+stroke+'" stroke-width="'+sw+'">'
       + geo.geom;
    /* 内芯（ring 类型加实心核，视觉权重按半径） */
    if (geo.t === "ring" && n.r >= 8){
      s += '<circle cx="0" cy="0" r="'+Math.max(1.6, n.r-4).toFixed(1)+'" fill="'+col+'" opacity=".9"/>';
    }
    var showLb = (g.mode === "dim") || !!labSet[n.id];
    if (showLb){
      var hub = !!hubSet[n.id];
      s += '<text class="g-label'+(hub?" hub":"")+'" x="0" y="'+(-n.r-(geo.t==="capsule"?3:7)).toFixed(1)+'" text-anchor="middle">'
         + esc(short(n.name, hub ? 22 : 16)) + '</text>';
    }
    s += '</g>';
  });
  s += '</g></svg>';
  return s;
}

function graphLegend(g, hasFocus){
  if (g.mode === "dim"){
    return '<b>'+esc(g.dim.name)+'</b> 维度聚团视图<br>大节点＝维度值（数字为关联文献数）· 小节点＝文献· 悬浮看详情 · 点击任意节点查看右栏详情';
  }
  var shapes = CLASS_ORDER.map(function(c){
    return '<span style="display:inline-block;margin-right:10px;font-size:11.5px;white-space:nowrap">'
      + '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:'+(NS_COLOR[c]||"#868e96")+';margin-right:4px"></span>'
      + esc(NS_LABEL[c]||c) + '<span style="color:#adb5bd;font-size:10.5px"> '+(SHAPE_LABEL[NS_SHAPE[c]]||"")+'</span></span>';
  }).join("");
  return '<div style="margin-bottom:5px">'+shapes+'</div>'
    + '<b>综合视图</b> · 全量本体图谱（'+((RAW.stats&&RAW.stats.nodes)||0)+' 节点 / '+((RAW.stats&&RAW.stats.edges)||0)+' 边）<br>'
    + '形状＝节点类型 · 大小＝关联强度 · 单击聚焦邻居 · 空白处清除 · 滚轮缩放'
    + (hasFocus ? '<br><span style="color:#e8590c">已高亮当前筛选命中文献及其一跳邻居</span>' : '');
}

/* --- 选中 / 高亮 --- */
function graphSelect(selId, silent){
  var G = GRAPH; if (!G || !G.svg) return;
  var svg = G.svg;
  G.selId = selId;
  var nodes = svg.querySelectorAll(".g-node"), edges = svg.querySelectorAll(".g-edge");
  var nb = null;
  if (selId){
    nb = {}; nb[String(selId)] = 1;
    (G.adj[selId] || []).forEach(function(x){ nb[String(x.id)] = 1; });
  }
  nodes.forEach(function(el){
    var on = !nb || nb[el.getAttribute("data-id")];
    el.style.opacity = on ? 1 : 0.08;
    el.classList.toggle("sel", !!nb && el.getAttribute("data-id") === String(selId));
  });
  edges.forEach(function(el){
    var op = parseFloat(el.getAttribute("data-op")) || 0.26;
    if (!nb){ el.setAttribute("stroke-opacity", op); el.setAttribute("stroke-width", 1); }
    else {
      var hit = (el.getAttribute("data-s") === String(selId) || el.getAttribute("data-t") === String(selId));
      el.setAttribute("stroke-opacity", hit ? 0.95 : 0.03);
      el.setAttribute("stroke-width", hit ? 2 : 1);
    }
  });
  if (!silent && !selId) closeRel();
}

function bindGraph(g){
  var wrap = document.getElementById("graphWrap"), svg = document.getElementById("graphSvg");
  if (!wrap || !svg) return;
  gtip = gtip || document.getElementById("gtip");
  GRAPH = {g:g, svg:svg, wrap:wrap, viewBox:[0,0,1000,660], selId:null, adj:graphAdj(g)};
  var G = GRAPH;

  /* 滚轮：以指针为锚点缩放 */
  wrap.onwheel = function(e){
    e.preventDefault();
    var r = wrap.getBoundingClientRect();
    graphZoom(e.deltaY < 0 ? 0.88 : 1.14, (e.clientX-r.left)/r.width, (e.clientY-r.top)/r.height);
  };

  /* 拖拽平移（带阈值，避免与点击冲突） */
  wrap.onmousedown = function(e){ G.drag = {x:e.clientX, y:e.clientY, vx:G.viewBox[0], vy:G.viewBox[1], moved:false}; };
  window.onmousemove = function(e){
    var d = G.drag; if (!d) return;
    var dx = e.clientX-d.x, dy = e.clientY-d.y;
    if (Math.abs(dx)+Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    G.viewBox[0] = d.vx - dx*G.viewBox[2]/wrap.clientWidth;
    G.viewBox[1] = d.vy - dy*G.viewBox[3]/wrap.clientHeight;
    graphApplyVB();
  };
  window.onmouseup = function(){ if (G.drag) setTimeout(function(){ G.drag = null; }, 0); };

  /* hover：邻居高亮 + tooltip（事件委托，重复渲染无需重绑） */
  svg.onmousemove = function(e){
    var el = e.target;
    while (el && el !== svg && !(el.classList && el.classList.contains("g-node"))) el = el.parentNode;
    if (!el || el === svg || !gtip) { if (gtip) gtip.style.opacity = 0; return; }
    var id = el.getAttribute("data-id");
    if (!G.selId) graphHover(id, true);
    var html = "";
    var kind = el.getAttribute("data-kind");
    if (kind === "dim"){
      var dn = g.nodeMap[id];
      html = "<b>"+esc(dn.name)+"</b><br>维度值 · 关联 "+dn.papers.length+" 篇文献<br><span style='color:#adb5bd'>单击查看详情</span>";
    } else if (kind === "ns"){
      var nd = g.nodeMap[id], pr = (nd && nd.node && nd.node.properties) || {}, eb = [];
      Object.keys(pr).forEach(function(k){ if (eb.length < 4 && pr[k] !== undefined && pr[k] !== null && String(pr[k]).trim() !== "") eb.push(esc(k)+"："+esc(short(String(pr[k]), 42))); });
      html = "<b>"+esc(NS_LABEL[nd.nsType]||nd.nsType)+" · "+esc(nd.name)+"</b><br>"+(eb.join("<br>")||"—")+"<br><span style='color:#adb5bd'>关联 "+(G.adj[id]||[]).length+" 条边</span>";
    } else {
      var p = g.nodeMap[id] && g.nodeMap[id].paper ? g.nodeMap[id].paper : findP(el.getAttribute("data-pid"));
      if (!p) { gtip.style.opacity = 0; return; }
      html = "<b>"+esc(short(p.title,60))+"</b><br>"+esc(p.authors.join(", "))+" · "+esc(p.year||"—")+" · "+esc(p.journal||"—")+"<br>置信度 "+esc(p.conf);
    }
    gtip.innerHTML = html;
    gtip.style.opacity = 1;
    gtip.style.left = (e.clientX + 14) + "px";
    gtip.style.top = (e.clientY - 12) + "px";
  };
  svg.onmouseout = function(e){
    var el = e.target;
    while (el && el !== svg && !(el.classList && el.classList.contains("g-node"))) el = el.parentNode;
    if (gtip) gtip.style.opacity = 0;
    if (!G.selId) graphHover(null, false);
  };

  /* 单击：统一进右侧详情，不再跳转 tab */
  svg.onclick = function(e){
    var el = e.target;
    while (el && el !== svg && !(el.classList && el.classList.contains("g-node"))) el = el.parentNode;
    if (!el || el === svg || !el.classList){   /* 空白 / 边 → 清除选中 */
      graphSelect(null);
      return;
    }
    var kind = el.getAttribute("data-kind"), id = el.getAttribute("data-id");
    graphSelect(id);
    if (kind === "dim") openDimDetail(g.nodeMap[id], g);
    else if (kind === "ns") openNSDetail(g.nodeMap[id], g);
    else openPaperDetail(nodeToPaper(g.nodeMap[id]), g);
  };

  /* HUD 控件（每次渲染重建，用内联 onclick） */
  var hud = document.getElementById("gHud");
  if (hud){
    hud.innerHTML = '<button onclick="graphZoom(0.85)">＋</button><button onclick="graphZoom(1.18)">－</button>'
      + '<button onclick="graphFit()">适应</button><button onclick="graphRelayout()">重排布局</button>';
  }
  GVB = G.viewBox.slice();
}

/* hover 临时高亮（无选中时） */
function graphHover(id, on){
  var G = GRAPH; if (!G || !G.svg || G.selId) return;
  if (G._hv === id) return;
  G._hv = id;
  if (!id){ graphSelect(null, true); return; }
  var svg = G.svg, nb = {}; nb[String(id)] = 1;
  (G.adj[id] || []).forEach(function(x){ nb[String(x.id)] = 1; });
  svg.querySelectorAll(".g-node").forEach(function(el){ el.style.opacity = nb[el.getAttribute("data-id")] ? 1 : 0.16; });
  svg.querySelectorAll(".g-edge").forEach(function(el){
    var hit = (el.getAttribute("data-s") === String(id) || el.getAttribute("data-t") === String(id));
    el.setAttribute("stroke-opacity", hit ? 0.8 : 0.04);
  });
}

function renderGraph(){
  var area = document.getElementById("paperArea");
  var isAll = (state.statDim === "all");
  var list = filteredPapers();
  var d = DIMS.filter(function(x){return x.key===state.statDim})[0] || DIMS[0];
  if (!isAll && !list.length){
    document.getElementById("viewHint").textContent = "共 0 篇";
    area.innerHTML = '<div class="pcard" style="text-align:center;color:var(--muted)">没有匹配的文献，试试放宽筛选条件</div>';
    return;
  }
  var hasFocus = false;
  Object.keys(state.filters).forEach(function(k){ if (k !== "all" && state.filters[k] && state.filters[k].length) hasFocus = true; });
  var q = (document.getElementById("search").value||"").trim();
  if (q) hasFocus = true;
  try{
    var g = isAll ? (RAW.ok ? buildAllGraph() : buildAllGraphFallback()) : buildDimGraph();
    GVB = [0,0,1000,660];
    var markup = graphMarkup(g);
    var lg = graphLegend(g, hasFocus);
    area.innerHTML = '<div class="graphbox" style="height:600px"><div id="graphWrap">'
      + '<div id="gHost">'+markup+'</div>'
      + '<div class="ghud" id="gHud"></div>'
      + '<div class="legend">'+lg+'</div>'
      + '</div></div>';
    document.getElementById("viewHint").textContent = isAll
      ? ("共 "+PAPERS.length+" 篇 · 全量图谱 "+(RAW.ok ? ((RAW.stats.nodes||0)+" 节点 / "+(RAW.stats.edges||0)+" 边") : "（示例数据）"))
      : ("共 "+list.length+" 篇" + (RAW.ok?"（真实图谱）":"（示例）"));
    bindGraph(g);
  }catch(err){
    area.innerHTML = '<div class="pcard" style="border:2px solid #ffc9c9;background:#fff5f5"><b style="color:#c92a2a">图谱渲染失败</b><br><span style="font-size:12.5px;color:#e03131">'+esc(err.message)+'</span></div>';
    document.getElementById("viewHint").textContent = "图谱渲染失败";
  }
}

/* ================= 右侧统一详情面板 ================= */
function relOpen(){ document.getElementById("paperArea").classList.add("rel-open"); }
function relCloseArea(){ document.getElementById("paperArea").classList.remove("rel-open"); }
function closeRel(){
  document.getElementById("relPanel").classList.remove("open");
  relCloseArea();
  if (GRAPH) graphSelect(null, true);
}
function relHead(color, label, title, sub){
  return '<button class="close" onclick="closeRel()">× 关闭</button>'
    + '<div style="margin-bottom:8px"><span class="rel-badge" style="background:'+(color||"#eef1fb")+'22;color:#3b4256">'
    + '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+(color||"#868e96")+';margin-right:5px;vertical-align:middle"></span>'
    + esc(label)+'</span></div>'
    + '<h3>'+esc(title)+'</h3><div class="sub">'+esc(sub||"")+'</div>';
}
function relAdjGroup(title, items){
  if (!items.length) return "";
  return '<div class="rel-kind">'+esc(title)+' <em>'+items.length+'</em></div><div class="rel-adj">'
    + items.slice(0, 26).map(function(x){
        return '<span title="'+esc(x.name)+'" onclick="selectInGraph(\''+esc(String(x.id)).replace(/'/g,"")+'\')">'
          + '<span class="dot" style="background:'+x.color+'"></span>'+esc(short(x.name, 20))+'</span>';
      }).join("") + '</div>';
}

/* 图谱内定位选中（右侧面板内条目点击） */
function selectInGraph(id){
  if (!GRAPH) return;
  var n = GRAPH.g.nodeMap[id];
  if (!n) return;
  graphSelect(id);
  graphFocusNode(id);
  var kind = (n.type === "paper" || n.nsType === "Paper") ? "paper" : "ns";
  if (n.type === "dim") openDimDetail(n, GRAPH.g);
  else if (kind === "paper") openPaperDetail(nodeToPaper(n), GRAPH.g);
  else openNSDetail(n, GRAPH.g);
}

/* 文献详情 */
function openPaperDetail(p, g){
  if (!p) return;
  var r = document.getElementById("relPanel");
  var related = PAPERS.filter(function(x){
    return x.id !== p.id && (x.dir === p.dir || x.kw.some(function(k){ return p.kw.indexOf(k) >= 0; }));
  });
  var h = relHead("#4c6ef5", "文献 Paper", short(p.title,46),
    (p.authors.join(", ")||"未标注作者")+" · "+(p.year||"—")+" · "+(p.journal||"—")+" · "+(p.org||""));
  h += '<div class="kw">'+p.kw.slice(0,12).map(function(k){ return '<span class="kwtag">'+esc(k)+'</span>'; }).join("")+'</div>';

  /* 图谱内关联分组 */
  if (g && g.nodeMap && p.nid != null && g.nodeMap[p.nid]){
    var byType = {};
    (GRAPH ? (GRAPH.adj[p.nid]||[]) : []).forEach(function(x){
      var nn = g.nodeMap[x.id]; if (!nn) return;
      var t = (nn.type === "dim") ? "维度值" : (NS_LABEL[nn.nsType] || nn.nsType);
      var col = (nn.type === "dim") ? "#748ffc" : (NS_COLOR[nn.nsType] || "#868e96");
      (byType[t] = byType[t] || []).push({id:x.id, name:nn.name, color:col});
    });
    Object.keys(byType).forEach(function(t){ h += relAdjGroup("图谱关联 · "+t, byType[t]); });
  }

  h += '<div class="rel-sec">研究方向</div><div class="kv"><b>'+esc(p.dir)+'</b></div>';
  h += '<div class="rel-sec">关键字段</div>'
    + '<div class="kv"><i>DOI</i><b>'+esc(p.doi||"—")+'</b></div>'
    + '<div class="kv"><i>本地文件</i><b>'+esc(short(p.file||"—",26))+'</b></div>'
    + '<div class="kv"><i>置信度</i><b>'+esc(p.conf||"—")+'</b></div>';
  h += '<div class="rel-sec">关联文献（'+related.length+'）</div>';
  related.slice(0,6).forEach(function(x){
    h += '<div class="kv"><i style="cursor:pointer" onclick="selectInGraph(\'p'+esc(String(x.nid))+'\')">'+esc(short(x.title,26))+'</i><b>'+esc(x.year||"—")+'</b></div>';
  });
  h += '<div class="rel-sec">快捷操作</div>'
    + '<div class="kv"><i>📖 进入阅读</i><b class="act" style="cursor:pointer" onclick="state.sel=findP(\''+esc(String(p.id))+'\');switchTab(\'read\')">去阅读 →</b></div>'
    + '<div class="kv"><i>🧩 在管理中打开</i><b class="act" style="cursor:pointer" onclick="openInManager(\''+esc(String(p.id))+'\')">去编辑 →</b></div>';
  if (RAW.ok) h += '<div class="kv"><i>📂 在访达中显示</i><b class="act" style="cursor:pointer" onclick="state.sel=findP(\''+esc(String(p.id))+'\');revealFile()">显示 →</b></div>';
  r.innerHTML = h;
  r.classList.add("open"); relOpen();
}

/* 本体节点详情（作者/期刊/机构/关键词/研究方向/本地文件） */
function openNSDetail(n, g){
  if (!n) return;
  var r = document.getElementById("relPanel");
  var col = NS_COLOR[n.nsType] || "#868e96";
  var pr = (n.node && n.node.properties) || {};
  var deg = (GRAPH ? (GRAPH.adj[n.id]||[]).length : 0);
  var h = relHead(col, NS_LABEL[n.nsType]||n.nsType, n.name, "本体节点 · "+(n.nsType||"")+" · 关联 "+deg+" 条边");

  var kv = [];
  Object.keys(pr).forEach(function(k){
    if (pr[k] === undefined || pr[k] === null || String(pr[k]).trim() === "") return;
    kv.push('<div class="kv"><i>'+esc(k)+'</i><b>'+esc(short(String(pr[k]), 60))+'</b></div>');
  });
  if (kv.length){ h += '<div class="rel-sec">属性</div>'+kv.join(""); }

  /* 关联分组（按边类型） */
  if (GRAPH){
    var byType = {};
    (GRAPH.adj[n.id]||[]).forEach(function(x){
      var nn = g.nodeMap[x.id]; if (!nn) return;
      var et = EDGE_LABEL[x.etype] || x.etype;
      var c = (nn.nsType === "Paper") ? "#4c6ef5" : (NS_COLOR[nn.nsType] || "#868e96");
      (byType[et] = byType[et] || []).push({id:x.id, name:nn.name, color:c});
    });
    Object.keys(byType).forEach(function(t){ h += relAdjGroup("关联 · "+t, byType[t]); });
  }
  h += '<div class="rel-sec">快捷操作</div>'
    + '<div class="kv"><i>🧩 在管理中打开</i><b class="act" style="cursor:pointer" onclick="openInManagerNid(\''+esc(String(n.id))+'\',\''+esc(n.nsType||"")+'\')">去编辑 →</b></div>';
  r.innerHTML = h;
  r.classList.add("open"); relOpen();
}

/* 维度值详情（聚团图大节点） */
function openDimDetail(n, g){
  if (!n) return;
  var r = document.getElementById("relPanel");
  var d = (g && g.dim) ? g.dim : {key:"dim", name:"维度"};
  var h = relHead("#748ffc", "维度值 · " + d.name, n.name, "关联 "+(n.papers||[]).length+" 篇文献");
  h += '<div class="rel-sec">关联文献（'+(n.papers||[]).length+'）</div>';
  (n.papers||[]).slice(0, 20).forEach(function(pn){
    var p = pn.paper || findP(pn.id);
    if (!p) return;
    h += '<div class="kv"><i style="cursor:pointer" onclick="selectInGraph(\'p'+esc(String(p.id))+'\')">'+esc(short(p.title, 26))+'</i><b>'+esc(p.year||"—")+'</b></div>';
  });
  h += '<div class="rel-sec">快捷操作</div><div class="kv"><i>只高亮该维度下的文献</i><b class="act" style="cursor:pointer" onclick="graphSelect(\''+esc(String(n.id))+'\')">高亮 →</b></div>';
  r.innerHTML = h;
  r.classList.add("open"); relOpen();
}

/* 列表视图点击文献 → 复用统一详情面板 */
function openRel(p){
  if (!p) return;
  if (!state.graph){ GRAPH = null; }
  openPaperDetail(p, (state.graph && GRAPH) ? GRAPH.g : null);
}

function revealFile(){
  if (window.workbenchDesktop && state.sel && state.sel.file){
    window.workbenchDesktop.revealInFinder(state.sel.file);
  }
}
function openInManager(pid){
  var p = findP(pid); if (!p) return;
  closeRel();
  state.ontoClass = "Paper"; state.ontoInst = p.nid;
  switchTab("onto");
}
function openInManagerNid(nid, cls){
  closeRel();
  state.ontoClass = cls || "Paper"; state.ontoInst = nid;
  switchTab("onto");
}

'''

html = html[:i] + NEW_JS + html[j:]

# ---------------- 3. 收尾 ----------------
with io.open(SRC, "w", encoding="utf-8") as f:
    f.write(html)

print("orig=%d new=%d delta=%+d" % (orig_len, len(html), len(html)-orig_len))
print("openRel refs:", html.count("openRel("))
