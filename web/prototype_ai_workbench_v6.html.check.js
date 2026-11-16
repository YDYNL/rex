
/* ==========================================================================
   v6 = v5 交互壳 + 真实 API
   数据源：/api/graph/*（只读） /api/ontology/*（只读） /api/commit（写闸门）
          /api/manage/stats（治理统计） /upload（PDF 入库）
   后端不可用时：自动回退到内置示例数据（顶部横幅提示）
   ========================================================================== */
var NS_PREFIX = "http://edu-scholar.org/ontology#";

/* ------------------ 内置示例（后端未就绪时兜底） ------------------ */
var FALLBACK_PAPERS = [
  {id:"p1",title:"Effects of confining stiffness and rupture strain on performance of FRP confined concrete",authors:["Xiao Y","Wu H"],year:2020,journal:"Engineering Structures",org:"Tongji University",kw:["FRP","confined concrete","concrete"],dir:"FRP约束混凝土",conf:0.65,sum:"系统研究了约束刚度与断裂应变对 FRP 约束混凝土性能的影响规律。"},
  {id:"p2",title:"Axial compressive behavior of confined steel fiber reinforced high strength concrete",authors:["Li J","Wang Q"],year:2021,journal:"Construction and Building Materials",org:"Tsinghua University",kw:["steel fiber","high strength concrete","axial"],dir:"FRP约束混凝土",conf:0.6,sum:"通过 36 个试件试验揭示钢纤维高强混凝土约束受压机理。"},
  {id:"p3",title:"Assessing the Efficiency of CFRP Discrete Confinement Systems for Concrete Cylinders",authors:["ASCE 1090"],year:2008,journal:"Journal of Composites for Construction",org:"Southeast University",kw:["CFRP","confinement","cylinders"],dir:"FRP约束混凝土",conf:0.8,sum:"评估 CFRP 离散约束系统对混凝土圆柱的约束效率。"},
  {id:"p4",title:"体外预应力 FRP 筋加固混凝土单向板抗裂及刚度计算方法",authors:["朱超宇","高丹盈"],year:2020,journal:"工程力学",org:"Zhengzhou University",kw:["FRP筋","预应力","单向板"],dir:"混凝土结构",conf:0.85,sum:"提出体外预应力 FRP 筋加固单向板的抗裂验算与刚度折减方法。"},
  {id:"p5",title:"钢筋混凝土连续梁在集中荷载下的挠度计算",authors:["高丹盈","房栋"],year:2018,journal:"土木工程学报",org:"Zhengzhou University",kw:["钢筋混凝土","连续梁","挠度"],dir:"混凝土结构",conf:0.9,sum:"基于虚功原理推导集中荷载下连续梁挠度计算公式。"},
  {id:"p6",title:"Machine learning prediction of FRP-confined concrete strength",authors:["Naderpour H"],year:2023,journal:"Journal of Composites for Construction",org:"Semnan University",kw:["machine learning","FRP","strength prediction"],dir:"智能方法",conf:0.82,sum:"基于 700+ 试验数据训练机器学习模型预测 FRP 约束混凝土强度。"}
];
function fallbackDims(){
  return [
    {key:"all", name:"综合", cls:"—", single:true, synthetic:true, get:null},
    {key:"dir", name:"研究方向", cls:"autoResearchArea", single:true, get:function(p){return p.dir}},
    {key:"year", name:"年份", cls:"data:year", single:true, get:function(p){return String(p.year||"")}},
    {key:"journal", name:"期刊", cls:"Venue", single:true, get:function(p){return p.journal}},
    {key:"org", name:"机构", cls:"Organization", single:true, get:function(p){return p.org}},
    {key:"authors", name:"作者", cls:"Author", single:false, get:function(p){return p.authors}},
    {key:"kw", name:"关键词", cls:"Keyword", single:false, get:function(p){return p.kw}}
  ];
}

/* ------------------ 运行时数据 ------------------ */
var RAW = {ok:false, mode:"loading", nodes:[], edges:[], byId:{}, byType:{}, outIdx:{}, inIdx:{}, stats:null, schema:null, manage:null};
var PAPERS = [], DIMS = [], CACHE = {};
var SID = {}, NID = {};              /* 节点长 id ↔ 短 id */
var state = {tab:"lib", sel:null, selNid:null, filters:{}, graph:true, statDim:"all",
             ontoClass:"Paper", ontoInst:null, draft:null, edit:null};
/* P0-1/P1-4/P2-9 多核心布局配置：核心色板（核心①=深紫保持原语义）、二跳 Top-K 收敛、聚合展开集、显示上下文开关 */
var CORE_PALETTE = ["#7048e8","#e64980","#0ca678","#f59f00","#5c7cfa","#12b886","#e8590c","#1098ad"];
var HOP2_TOPK = 18;                 /* 二跳按关联论文数取 Top-K 默认值（15~20） */
state._hop2Expand = {};             /* 已展开二跳聚合的核心 key 集合：dimKey#coreId -> true */
state._showContext = false;         /* 单选"显示上下文"开关：未选中但有关联的节点淡色呈现 */
state._dimPos = {};                 /* 上次聚焦布局位置缓存（P2-10 布局稳定性：已见节点位置尽量保持） */
var NS_LABEL = {Paper:"论文",Author:"作者",Organization:"机构",Venue:"期刊",Keyword:"关键词",LocalFile:"本地文件",DomainCategory:"研究方向"};
var NS_COLOR = {Paper:"#8b7cf6",Author:"#12b886",Organization:"#f59f00",Venue:"#e64980",Keyword:"#7048e8",LocalFile:"#5c7cfa",DomainCategory:"#0ca678"};
var CLASS_ORDER = ["Paper","Author","Organization","Venue","Keyword","LocalFile","DomainCategory"];
/* 维度 key → 实体类型（无类型的维度如 year / 未标注保持灰色圆形） */
var DIM_NS = {dir:"DomainCategory", journal:"Venue", org:"Organization", authors:"Author", kw:"Keyword"};
var FALLBACK_EDGES = [
  ["Paper","Author","hasAuthor"],["Paper","Venue","publishedIn"],["Paper","Keyword","hasKeyword"],
  ["Paper","LocalFile","related_to"],["Paper","Paper","cites"],["Author","Organization","hasAffiliation"],
  ["Author","Keyword","hasResearchTopic"]
];

/* ------------------ 工具 ------------------ */
function esc(s){ return String(s===undefined||s===null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function dedup(arr){ var seen = {}, out = []; (arr||[]).forEach(function(x){ var k = String(x); if (!seen[k]){ seen[k] = 1; out.push(x); } }); return out; }

/* 实例详情的对象关系分组：同 (方向, 关系类型, 对端实例) 合并为一行，ids 供批量删除 */
function groupEdges(edges, selfId){
  var map = {}, order = [];
  (edges||[]).forEach(function(e){
    var dir = (e.source_id === selfId) ? "out" : ((e.target_id === selfId) ? "in" : (e.direction || "out"));
    var other = (dir === "out") ? e.target_id : e.source_id;
    var key = dir + "|" + e.type + "|" + other;
    if (!map[key]){ map[key] = {dir: dir, type: e.type, other: other, ids: []}; order.push(key); }
    map[key].ids.push(e.id);
  });
  return order.map(function(k){ return map[k]; });
}
function stripNS(id){ return String(id||"").split("#").pop(); }
function short(s,n){ s=String(s||""); return s.length>n? s.slice(0,n-1)+"…": s; }
function empty(v){ return v===undefined||v===null||String(v).trim()===""; }

/* ------------------ API ------------------ */
/* 桌面端同源（Electron 静态服务反代 /api/*），故默认相对路径即可；
   window.WB_API_BASE 仅供离线 file:// 调试时指向 http://127.0.0.1:9173。 */
var API_BASE = String(window.WB_API_BASE || "").replace(/\/+$/, "");
/* 统一请求封装：永不抛异常，超时/网络错误都返回 {ok:false, reason}，
   避免任何一次请求失败把界面卡在「读取中…」。 */
var API = {
  async _fetch(url, opts, ms){
    var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctl ? setTimeout(function(){ try { ctl.abort(); } catch(_){} }, ms || 15000) : null;
    var o = Object.assign({}, opts || {});
    if (ctl) o.signal = ctl.signal;
    try {
      var r = await fetch(url, o);
      var t = await r.text();
      var j = null;
      try { j = JSON.parse(t); } catch(e){ j = {ok:false, reason:"响应解析失败："+String(t).slice(0,200)}; }
      if (!j || typeof j !== "object") j = {ok:false, reason:"响应格式异常"};
      if (r.status >= 400 && j.ok === undefined) j.ok = false;
      if (r.status >= 400 && !j.reason && !(j.errors && j.errors.length)) j.reason = "HTTP " + r.status;
      j.http_status = r.status;
      return j;
    } catch(e){
      var to = e && (e.name === "AbortError");
      return {ok:false, http_status:0,
              reason: to ? ("请求超时（" + Math.round((ms||15000)/1000) + "s）· 后端可能未就绪或被占用")
                         : ("网络错误：" + String((e && e.message) || e))};
    } finally { if (timer) clearTimeout(timer); }
  },
  get(path){ return API._fetch(API_BASE + path, {headers:{"Accept":"application/json"}}, 20000); },
  post(path, body){ return API._fetch(API_BASE + path, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)}, 90000); },
  del(path){ return API._fetch(API_BASE + path, {method:"DELETE", headers:{"Accept":"application/json"}}, 20000); },
  /* 异步提交单个 PDF：后端立即返回 202 + file_id，随后用 progress() 轮询真实阶段 */
  async uploadFile(file){
    var fd = new FormData();
    fd.append("file", file, file.name);
    var j = await API._fetch(API_BASE + "/upload", {method:"POST", body: fd}, 600000);
    j.file = file.name;
    if (!j.file_id){ j.ok = false; if (!j.reason) j.reason = "后端未返回 file_id（可能仍是旧版同步接口）"; }
    return j;
  },
  /* 进度查询：file_id 逗号分隔，返回 {ok, items:[{file_id,file,status,status_text,percent,stage,stage_name,stage_index,elapsed,title,reason,detail}]} */
  progress(ids){
    return API._fetch(API_BASE + "/api/upload/progress?file_id=" + encodeURIComponent(ids.join(",")),
                      {headers:{"Accept":"application/json"}}, 20000);
  },
  /* 全部上传记录（含历史）：limit 上限 50；后端若忽略该参数仍返回最近 20 条，不影响可用性 */
  progressAll(limit){
    return API._fetch(API_BASE + "/api/upload/progress?limit=" + (limit || 50),
                      {headers:{"Accept":"application/json"}}, 20000);
  }
};

/* 全局异常兜底：单个脚本错误不再让整页无响应，底部提示 + 可继续操作 */
window.addEventListener("error", function(ev){
  try {
    var box = document.getElementById("errBar");
    if (!box){ box = document.createElement("div"); box.id = "errBar"; document.body.appendChild(box); }
    box.textContent = "页面脚本异常：" + ((ev && ev.message) || "未知") + " · 已隔离该异常；若界面无响应请按 ⌘R 刷新";
    box.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#b02a37;color:#fff;font:12px/1.6 -apple-system,sans-serif;padding:6px 12px;opacity:.94";
    setTimeout(function(){ try { box.remove(); } catch(_){} }, 15000);
  } catch(_) {}
});
window.addEventListener("unhandledrejection", function(ev){
  try { console.warn("[workbench] 未处理的 Promise 拒绝：", ev && ev.reason); } catch(_) {}
});

/* ================= 数据装载 ================= */
async function reload(showLoading){
  if (showLoading){ document.getElementById("paperArea").innerHTML = '<div class="loading">正在读取图谱…</div>'; }
  try {
    var stats = await API.get("/api/graph/stats");
    if (!stats || !stats.ok) throw new Error((stats && stats.reason) || "后端未就绪");
    var nodes = await API.get("/api/graph/nodes");
    var edges = await API.get("/api/graph/edges");
    if (!nodes.ok || !edges.ok) throw new Error("图谱数据读取失败");
    RAW.nodes = nodes.nodes || [];
    RAW.edges = edges.edges || [];
    RAW.stats = stats;
    RAW.ok = true; RAW.mode = "live";
    try {
      var sch = await API.get("/api/ontology/schema");
      RAW.schema = sch && sch.ok ? sch : null;
    } catch(e){ RAW.schema = null; }
    try {
      var mg = await API.get("/api/manage/stats");
      RAW.manage = mg && mg.ok ? mg : null;
    } catch(e){ RAW.manage = null; }
  } catch(err){
    RAW.ok = false; RAW.mode = "fallback"; RAW.failReason = err.message;
    RAW.nodes = []; RAW.edges = []; RAW.stats = null; RAW.schema = null; RAW.manage = null;
  }
  ALLGRAPH = null;
  buildIndex();
  if (RAW.ok) buildFromGraph(); else buildFallback();
  renderStatus();
}

function buildIndex(){
  RAW.byId = {}; RAW.byType = {}; RAW.outIdx = {}; RAW.inIdx = {};
  SID = {}; NID = {};
  RAW.nodes.forEach(function(n,i){
    var sid = "n"+i;
    SID[n.id] = sid; NID[sid] = n.id;
    RAW.byId[n.id] = n;
    (RAW.byType[n.type] = RAW.byType[n.type] || []).push(n);
  });
  RAW.edges.forEach(function(e){
    (RAW.outIdx[e.source_id] = RAW.outIdx[e.source_id] || []).push(e);
    (RAW.inIdx[e.target_id] = RAW.inIdx[e.target_id] || []).push(e);
  });
}
function nodeLabel(n){
  if (!n) return "?";
  var p = n.properties || {};
  return p.name || p.title || p.file || stripNS(n.id);
}
function nodesOfType(t){ return RAW.byType[t] || []; }
function edgesBetween(nid, type){
  var all = (RAW.outIdx[nid]||[]).concat(RAW.inIdx[nid]||[]);
  return type ? all.filter(function(e){ return e.type===type; }) : all;
}

function buildFromGraph(){
  var papers = nodesOfType("Paper").map(function(n){
    var p = n.properties || {};
    var authors = dedup((RAW.outIdx[n.id]||[]).filter(function(e){return e.type==="hasAuthor";})
      .map(function(e){ var a = RAW.byId[e.target_id]; return a ? nodeLabel(a) : stripNS(e.target_id); }));
    var kws = dedup((RAW.outIdx[n.id]||[]).filter(function(e){return e.type==="hasKeyword";})
      .map(function(e){ var k = RAW.byId[e.target_id]; return k ? nodeLabel(k) : stripNS(e.target_id); }));
    var org = "";
    for (var i=0;i<authors.length && !org;i++){
      var an = nodesOfType("Author").filter(function(a){ return nodeLabel(a)===authors[i]; })[0];
      if (an){
        var aff = (RAW.outIdx[an.id]||[]).filter(function(e){return e.type==="hasAffiliation";})[0];
        if (aff && RAW.byId[aff.target_id]) org = nodeLabel(RAW.byId[aff.target_id]);
      }
    }
    if (!org && p.autoAffiliation) org = p.autoAffiliation;
    var dir = (p.autoResearchArea||"").split(/[,，;；]/).map(function(x){return x.trim();}).filter(Boolean)[0] || "未分类";
    return {
      id: SID[n.id], nid: n.id, node: n,
      title: p.title || stripNS(n.id),
      authors: authors,
      year: p.year || "",
      journal: p.venue || "",
      org: org || "未标注",
      kw: kws,
      dir: dir,
      conf: parseFloat(p.confidence)>=0 ? parseFloat(p.confidence) : 0,
      sum: p.aiSummary || p.abstract || p.content || "",
      doi: p.doi || "", file: p.file || "", paperType: p.paperType || ""
    };
  });
  papers.sort(function(a,b){ return String(b.year||"").localeCompare(String(a.year||"")); });
  PAPERS = papers;
  DIMS = fallbackDims();
  rebuildCache();
}
function buildFallback(){
  PAPERS = FALLBACK_PAPERS.slice();
  DIMS = fallbackDims();
  rebuildCache();
}
function dimValues(dim){
  var m = {};
  PAPERS.forEach(function(p){
    var vs = dim.get(p); if (!vs) return;
    (Array.isArray(vs)?vs:[vs]).forEach(function(v){ if(!empty(v)) m[v]=(m[v]||0)+1; });
  });
  return Object.keys(m).map(function(k){return {v:k,n:m[k]}}).sort(function(a,b){return b.n-a.n});
}
function rebuildCache(){
  CACHE = {};
  DIMS.forEach(function(d){ if (d.synthetic || !d.get) return; CACHE[d.key] = dimValues(d); });
  var used = Object.keys(state.filters);
  used.forEach(function(k){
    var avail = (CACHE[k]||[]).map(function(x){return x.v;});
    state.filters[k] = (state.filters[k]||[]).filter(function(v){ return avail.indexOf(v)>=0; });
    if (!state.filters[k].length) delete state.filters[k];
  });
}
function renderStatus(){
  var bar = document.getElementById("statusbar");
  var conn = document.getElementById("stConn");
  bar.classList.remove("live","fake");
  if (RAW.ok){
    bar.classList.add("live");
    conn.textContent = "后端已连接 · 图谱与保存服务正常";
    document.getElementById("stKg").textContent = "图谱 " + (RAW.stats.nodes||0) + " 节点 / " + (RAW.stats.edges||0) + " 边";
    document.getElementById("stVer").textContent = "版本 " + ((RAW.stats.meta||{}).version||"—") +
      (RAW.manage && RAW.manage.versions ? " · 版本记录 " + RAW.manage.versions : "");
  } else {
    bar.classList.add("fake");
    conn.textContent = "后端未连接（" + esc(RAW.failReason||"") + "）· 当前为内置示例数据";
    document.getElementById("stKg").textContent = "示例 " + PAPERS.length + " 篇";
    document.getElementById("stVer").textContent = "版本信息不可用";
  }
  var banner = document.getElementById("libBanner");
  banner.innerHTML = RAW.ok ? "" :
    '<div class="banner">后端未就绪：' + esc(RAW.failReason||"") +
    '。当前展示内置示例数据，仅可浏览；请通过桌面端启动（Electron 会自动拉起 Python 后端）后重试。</div>';
  var ob = document.getElementById("ontoBanner");
  if (ob) ob.innerHTML = RAW.ok ? "" :
    '<div class="banner">本体数据来自后端 /api/ontology，当前不可用。启动后端后本页将展示真实类/实例，并支持读写提交。</div>';
}

/* ================= 筛选（检索页） ================= */
function dimByKey(k){ return DIMS.filter(function(x){return x.key===k})[0]; }
function dimName(k){ var d = dimByKey(k); return d ? d.name : k; }
function ctrlActiveDim(){
  if (!dimByKey(state.statDim)) state.statDim = (DIMS[0]||{}).key || "all";
  return state.statDim;
}
function selCount(){
  var n = 0; Object.keys(state.filters).forEach(function(k){ n += (state.filters[k]||[]).length; }); return n;
}
/* v7 统一控件区：维度行（单选，兼作图谱聚团维度）+ 取值行（多选）+ 已选条件行 */
function renderCtrlBar(){
  var box = document.getElementById("ctrlBar");
  if (!box) return;
  var act = ctrlActiveDim();
  var d = dimByKey(act);
  var nSel = selCount();
  var h = '';
  /* 第 1 行：维度 */
  h += '<div class="ctrl-row"><span class="ctrl-lb">维度</span><div class="ctrl-chips" id="dimChips">';
  DIMS.forEach(function(x){
    var on = (act === x.key);
    h += '<button class="dimbtn'+(on?" on":"")+'" data-k="'+esc(x.key)+'" aria-pressed="'+(on?"true":"false")+'">'+esc(x.name)+'</button>';
  });
  h += '</div>';
  if (state.graph) h += '<span class="ctrl-note">图谱按所选维度聚团</span>';
  h += '<span class="ctrl-acts">';
  if (nSel) h += '<span class="sel-n">已选 '+nSel+' 项</span><button class="mini-link" id="clearFilters">清空筛选</button>';
  h += '</span></div>';
  /* 第 2 行：取值 */
  h += '<div class="ctrl-row"><span class="ctrl-lb">筛选</span><div class="val-wrap'+(state._valOpen?" open":"")+'" id="valWrap">';
  if (!d || d.synthetic){
    h += '<span class="ctrl-empty">综合视图不含取值筛选，请在具体维度上筛选</span>';
  } else {
    var vals = CACHE[act] || [];
    if (!vals.length){
      h += '<span class="ctrl-empty">该维度暂无可筛选取值</span>';
    } else {
      var cur = state.filters[act] || [];
      var BASE = 14;
      vals.forEach(function(x, i){
        var on = cur.indexOf(x.v) >= 0;
        h += '<button class="fchip'+(on?" on":"")+(i>=BASE?" vx":"")+'" data-v="'+esc(x.v)+'" aria-pressed="'+(on?"true":"false")+'">'+esc(x.v)+' ('+x.n+')</button>';
      });
      if (vals.length > BASE) h += '<button class="more-btn" id="moreBtn">'+(state._valOpen ? '收起 ▴' : '更多 ('+(vals.length-BASE)+') ▾')+'</button>';
    }
  }
  h += '</div></div>';
  /* 第 3 行：已选条件（跨维度汇总，点击 × 单独移除） */
  if (nSel){
    h += '<div class="ctrl-row"><span class="ctrl-lb">已选</span><div class="ctrl-chips">';
    Object.keys(state.filters).forEach(function(k){
      (state.filters[k]||[]).forEach(function(v){
        h += '<span class="sel-tag">'+esc(dimName(k))+': '+esc(v)
          + '<button class="tag-x" data-k="'+esc(k)+'" data-v="'+esc(v)+'" title="移除该条件">×</button></span>';
      });
    });
    h += '</div></div>';
  }
  box.innerHTML = h;
  /* --- 事件绑定 --- */
  box.querySelectorAll("#dimChips .dimbtn").forEach(function(b){
    b.addEventListener("click", function(){
      state.statDim = b.getAttribute("data-k");
      state._valOpen = false;
      renderCtrlBar(); refreshArea();
    });
  });
  box.querySelectorAll(".fchip").forEach(function(c){
    c.addEventListener("click", function(){
      var v = c.getAttribute("data-v");
      if (!state.filters[act]) state.filters[act] = [];
      var arr = state.filters[act], idx = arr.indexOf(v);
      if (idx >= 0) arr.splice(idx,1); else arr.push(v);
      if (!arr.length) delete state.filters[act];
      renderCtrlBar(); refreshArea();
    });
  });
  box.querySelectorAll(".tag-x").forEach(function(b){
    b.addEventListener("click", function(){
      var k = b.getAttribute("data-k"), v = b.getAttribute("data-v");
      var arr = state.filters[k] || [], idx = arr.indexOf(v);
      if (idx >= 0) arr.splice(idx,1);
      if (!arr.length) delete state.filters[k];
      renderCtrlBar(); refreshArea();
    });
  });
  var cb = document.getElementById("clearFilters");
  if (cb) cb.addEventListener("click", function(){ state.filters = {}; renderCtrlBar(); refreshArea(); });
  var mb = document.getElementById("moreBtn");
  if (mb) mb.addEventListener("click", function(){ state._valOpen = !state._valOpen; renderCtrlBar(); });
}
/* 兼容旧调用点：v7 起统一走 renderCtrlBar */
function renderFilters(){ renderCtrlBar(); }
function filteredPapers(){
  var q = (document.getElementById("search").value||"").toLowerCase();
  return PAPERS.filter(function(p){
    for (var k in state.filters){
      var d = DIMS.filter(function(x){return x.key===k})[0]; if(!d) return false;
      var vs = d.get(p); vs = Array.isArray(vs)?vs:[vs];
      if (!state.filters[k].some(function(v){ return vs.indexOf(v)>=0; })) return false;
    }
    if (q){
      var blob = (p.title+" "+p.authors.join(" ")+p.kw.join(" ")+p.sum+" "+p.journal+" "+p.org+" "+p.dir).toLowerCase();
      if (blob.indexOf(q)<0) return false;
    }
    return true;
  });
}
document.getElementById("search").addEventListener("input", refreshArea);
document.getElementById("viewList").addEventListener("click", function(){ state.graph=false; syncView(); });
document.getElementById("viewGraph").addEventListener("click", function(){ state.graph=true; syncView(); });
function syncView(){
  document.getElementById("viewList").classList.toggle("active", !state.graph);
  document.getElementById("viewGraph").classList.toggle("active", state.graph);
  syncNarrow();
  renderCtrlBar();
  refreshArea();
}
/* 窄屏保护：取值行改横向滚动，避免撑高控件区 */
function syncNarrow(){
  var v = document.getElementById("view-lib");
  if (v) v.classList.toggle("narrow", (window.innerWidth || 1200) < 1100);
}
window.addEventListener("resize", syncNarrow);
function refreshArea(){ if (state.graph) renderGraph(); else renderList(); }

/* ================= 列表 ================= */
function renderList(){
  var list = filteredPapers();
  var box = document.getElementById("paperArea");
  document.getElementById("viewHint").textContent = "共 "+list.length+" 篇" + (RAW.ok?"（真实图谱）":"（示例）");
  if (!list.length){ box.innerHTML = '<div class="pcard" style="text-align:center;color:var(--muted)">没有匹配的文献，试试放宽筛选条件</div>'; return; }
  var h = '<div class="paperlist">';
  list.forEach(function(p){
    h += '<div class="pcard'+(state.sel&&state.sel.id===p.id?" sel":"")+'" data-id="'+p.id+'">'
      + '<div class="t">'+esc(p.title)+'</div>'
      + '<div class="meta">'+esc(p.authors.join(", ")||"未标注作者")+' · '+esc(p.year||"—")+' · '+esc(p.journal||"—")+' · <span style="color:var(--accent2)">'+esc(p.dir)+'</span></div>'
      + '<div class="kw">'+p.kw.slice(0,10).map(function(k){return '<span class="kwtag">'+esc(k)+'</span>'}).join("")+'</div>'
      + '<div class="sum">'+esc(p.sum)+'</div>'
      + '<div class="ai">AI 摘要 · 置信度 '+(p.conf||"—")+' · '+esc(p.org)
      + (p.file ? '<button class="pcard-read" data-read="'+esc(String(p.id))+'">阅读</button>' : '')+'</div></div>';
  });
  h += '</div>';
  box.innerHTML = h;
  box.querySelectorAll(".pcard-read[data-read]").forEach(function(b){
    b.addEventListener("click", function(e){
      e.stopPropagation();
      openReaderPaper(b.getAttribute("data-read"));
    });
  });
  box.querySelectorAll(".pcard[data-id]").forEach(function(c){
    c.addEventListener("click", function(){
      var p = findP(c.getAttribute("data-id"));
      if (!p) return;
      state.sel = p; state.selNid = p.nid;
      box.querySelectorAll(".pcard").forEach(function(x){ x.classList.remove("sel"); });
      c.classList.add("sel");
      openRel(p); renderAI("lib");
    });
  });
}
function findP(id){ for (var i=0;i<PAPERS.length;i++) if (String(PAPERS[i].id)===String(id)) return PAPERS[i]; return null; }

/* ================= 图谱 ================= */
function renderDimBtns(){ renderCtrlBar(); /* v7：已合并进统一控件区，保留兼容旧调用点 */ }
var gtip = document.getElementById("gtip");
function palette(n){ var cols=[]; for (var i=0;i<n;i++){ var hue=Math.round(210 - i*(210/Math.max(n,1))); cols.push("hsl("+hue+",72%,55%)"); } return cols; }
var EDGE_COLOR = {cites:"#adb5bd", hasAuthor:"#12b886", hasKeyword:"#7048e8", hasResearchTopic:"#0ca678",
                  publishedIn:"#e64980", hasAffiliation:"#f59f00", related_to:"#5c7cfa"};
/* 通用力导向布局：随机初值（不再固定圆环），斥力质量与节点半径相关，
   使关联规模大的节点既更大也更舒展；末段做硬性防重叠分离 */
/* 自由力导向布局（对齐 semantica Knowledge Explorer）
   —— 不再把节点裁剪进矩形边框：节点在无限平面上自由铺开，视口按内容包围盒自适应 */
/* 目标视口宽高比：优先取真实图谱容器，首次构建（容器未挂载）时按窗口估算 */
function layoutAR(){
  var w = document.getElementById("graphWrap");
  if (w && w.clientWidth > 60 && w.clientHeight > 60) return w.clientWidth / w.clientHeight;
  var vw = (window.innerWidth || 1440) - 320;
  var vh = (window.innerHeight || 900) - 262;
  return Math.max(0.5, vw / Math.max(320, vh));
}

/* 稳定哈希：同一节点在多次渲染/重排中保持一致的有机抖动（避免每次跳变，也让外缘天然参差） */
function nodeHash(s){
  var h = 2166136261, i;
  s = String(s == null ? "" : s);
  for (i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h >>> 0;
}
function nodeRand(s, k){ return (nodeHash(s + "#" + (k || 0)) % 10000) / 10000; }

function layoutGraph(nodes, edges, nodeMap, opt){
  opt = opt || {};
  var spread = (opt.spread === undefined) ? 0.44 : opt.spread;
  var N = nodes.length; if (!N) return;
  var E = edges.length;

  var avgR = 0;
  nodes.forEach(function(n){ avgR += (n.r || 7); });
  avgR = avgR / N;

  /* 初始分布：多中心有机铺开（不再用单圆盘 sunflower，也不再做视口宽高比拉伸）
     —— 节点按类型分组落到若干簇心，簇心沿黄金角螺旋分布在带径向噪声的扁椭圆盘上，
        簇内再按黄金角散开；外轮廓天然凹凸不平，而非"圆盘被塞进矩形视口" */
  var GOLD = Math.PI * (3 - Math.sqrt(5));
  var step = (avgR * 2 + 12) * Math.max(1, Math.sqrt(Math.max(E, 1) / N)) * (0.5 + spread);
  var groups = {}, order = [];
  nodes.forEach(function(n){
    var gk = String(n.nsType || n.type || "n") + "#" + (nodeHash(n.id) % 5);
    if (!groups[gk]){ groups[gk] = []; order.push(gk); }
    groups[gk].push(n);
  });
  var clusterStep = step * 2.8;   /* 簇心更散 → 簇与簇之间留出空隙，轮廓自然凹凸 */
  var centers = order.map(function(gk, gi){
    var rad = clusterStep * Math.sqrt(gi + 0.5) * (0.55 + nodeRand(gk, 7) * 1.15);
    var ang = gi * GOLD + nodeRand(gk, 3) * 1.4;
    return {x: Math.cos(ang) * rad * 1.24, y: Math.sin(ang) * rad * 0.80};
  });
  order.forEach(function(gk, gi){
    var arr = groups[gk], c = centers[gi];
    var inner = step * Math.max(0.7, Math.sqrt(Math.max(arr.length, 1)) * 0.5);
    arr.forEach(function(n, i){
      if (typeof n.x === "number" && typeof n.y === "number") return;
      /* 约 14% 的节点作为"卫星"落到更远轨道 → 外轮廓出现大小不一的凸起，而非光滑壳层 */
      var sat = nodeRand(n.id, 31) < 0.14;
      var rad = inner * Math.sqrt(i + 0.6) * (0.66 + nodeRand(n.id, 11) * 0.80)
                * (sat ? (1.9 + nodeRand(n.id, 37) * 1.3) : 1);
      var ang = i * GOLD + nodeRand(gk, 5) * 3.1 + (sat ? nodeRand(n.id, 41) * 6.283 : 0);
      n.x = c.x + Math.cos(ang) * rad;
      n.y = c.y + Math.sin(ang) * rad;
    });
  });

  /* P1-03：高权重节点中心辐射锚点 —— 综合图取度最高的前 3 个文献/本体节点钉在中心，
     dim 模式取维度值节点（"d_*"）作为天然核心；锚点让图谱形成中心辐射、避免散点无重心 */
  var anchorTgt = {};
  var anchors = [];
  var isDimMode = nodes.length && nodes[0] && String(nodes[0].id).indexOf("d_") === 0;
  if (isDimMode){
    /* P1-6：未筛选维度图不再把全部 d_* 节点钉成横向一字长条；
       仅 dimAnchor==="top" 时取关联文献数前 3 的维度值作锚点（聚焦时由 focusDimLayout 接管径向布局） */
    if (opt.dimAnchor === "top"){
      var topDim = nodes.slice().sort(function(a, b){ return ((b.count||0)-(a.count||0)) || String(a.name).localeCompare(String(b.name)); }).slice(0, 3);
      for (var ad = 0; ad < topDim.length; ad++) anchors.push(topDim[ad]);
    }
  } else {
    var byDeg = nodes.slice().sort(function(a, b){
      return (b.deg || 0) - (a.deg || 0) || ((b.r || 0) - (a.r || 0));
    });
    var topN = byDeg.slice(0, 3).filter(function(x){ return (x.deg || 0) > 0 || (x.r || 0) >= 16; });
    if (!topN.length) topN = byDeg.slice(0, Math.min(3, N));
    for (var ai2 = 0; ai2 < topN.length; ai2++) anchors.push(topN[ai2]);
  }
  if (anchors.length){
    var anchorGap = Math.min(34, (avgR * 1.6 + 24));
    anchors.forEach(function(a, ai){
      var tgt = {x: (ai - (anchors.length - 1) / 2) * anchorGap, y: 0};
      anchorTgt[a.id] = tgt;
      a.x = tgt.x; a.y = tgt.y;   /* 锚点直接钉在中心位，形成向心辐射结构 */
    });
    /* 非锚点节点初始位置朝锚点质心收缩，形成向心辐射的初始结构 */
    var acx = 0, acy = 0;
    for (var ax = 0; ax < anchors.length; ax++){ acx += anchors[ax].x; acy += anchors[ax].y; }
    acx /= anchors.length; acy /= anchors.length;
    for (var ai3 = 0; ai3 < N; ai3++){
      var nn = nodes[ai3];
      if (anchorTgt[nn.id] || typeof nn.x !== "number" || !isFinite(nn.x)) continue;
      nn.x += (acx - nn.x) * 0.35;
      nn.y += (acy - nn.y) * 0.35;
    }
  }

  var iters = N > 400 ? 90 : (N > 150 ? 170 : 260);
  var alpha = 0.95;
  var linkRest = avgR * 2 + 68;
  var LIMIT = step * Math.sqrt(N) * 3.4 + 420;   /* 软半径：仅兜住极端外扩，非硬裁剪 */

  for (var it = 0; it < iters; it++){
    /* 斥力：自由平面上互相推开，无边界约束 */
    for (var i = 0; i < N; i++) for (var j = i + 1; j < N; j++){
      var a = nodes[i], b = nodes[j];
      var dx = a.x - b.x, dy = a.y - b.y;
      var d2 = dx*dx + dy*dy;
      if (d2 < 1){ dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; d2 = dx*dx + dy*dy || 1; }
      var dd = Math.sqrt(d2) || 0.7;
      var mass = a.r*a.r + b.r*b.r + 70;
      var f = mass / d2 * 44; if (f > 58) f = 58;
      var ux = dx/dd, uy = dy/dd;
      a.x += ux*f*alpha; a.y += uy*f*alpha;
      b.x -= ux*f*alpha; b.y -= uy*f*alpha;
    }
    /* 边弹簧：把有关系的节点拉成不规则的团簇，而不是整齐网格 */
    for (var k = 0; k < E; k++){
      var e = edges[k], a2 = nodeMap[e.s], b2 = nodeMap[e.t];
      if (!a2 || !b2) continue;
      var ddx = a2.x - b2.x, ddy = a2.y - b2.y;
      var dd2 = Math.sqrt(ddx*ddx + ddy*ddy) || 0.7;
      var rest = a2.r + b2.r + linkRest;
      var kk = 0.015 * (dd2 - rest); if (kk > 30) kk = 30; if (kk < -30) kk = -30;
      var vx = ddx/dd2, vy = ddy/dd2;
      a2.x -= vx*kk*alpha; a2.y -= vy*kk*alpha;
      b2.x += vx*kk*alpha; b2.y += vy*kk*alpha;
    }
    /* 重力：朝当前质心温和收缩（FA2 gravity），只收拢松散结构，不设画布边界 */
    var cx = 0, cy = 0, wsum = 0;
    for (var m = 0; m < N; m++){
      var wt = 1 + (nodes[m].deg || 0) * 0.3;
      cx += nodes[m].x * wt; cy += nodes[m].y * wt; wsum += wt;
    }
    cx /= wsum; cy /= wsum;
    for (var g2 = 0; g2 < N; g2++){
      var n3 = nodes[g2];
      var gw = (n3.deg ? 0.0015 : 0.0026);   /* 孤立节点稍强回拉，避免飘远 */
      n3.x += (cx - n3.x) * gw * alpha;
      n3.y += (cy - n3.y) * gw * alpha;
      /* P1-03：锚点节点持续弹性回拉至中心位，保证中心辐射结构在力导向迭代后仍成立 */
      var at = anchorTgt[n3.id];
      if (at){
        n3.x += (at.x - n3.x) * 0.055 * alpha;
        n3.y += (at.y - n3.y) * 0.055 * alpha;
      }
      /* 极端外扩时的软回拉（每节点软半径不同 → 外缘参差，不形成规整壳层/边框） */
      var rlim = LIMIT * (0.82 + nodeRand(n3.id, 13) * 0.42);
      var rr = Math.sqrt(n3.x*n3.x + n3.y*n3.y);
      if (rr > rlim){
        var pull = (rr - rlim) / rr * 0.05 * alpha;
        n3.x -= n3.x * pull; n3.y -= n3.y * pull;
      }
    }
    alpha *= 0.986;
  }

  /* 说明：已移除"按视口宽高比拉伸坐标"的形状适配——它会把自由分布压成贴边的矩形块 */

  /* 有机形变：对整体坐标做低频径向调制（3/5 叶凹凸）+ 轻微旋转，
     使外轮廓既不与画布边平行、也不形成规整壳层或矩形边界；
     同一布局只施加一次（标记挂在 nodes 数组上，避免多次重渲染时累积旋转） */
  if (!nodes.__organic){
    nodes.__organic = true;
    var fx = 0, fy = 0;
    for (var f = 0; f < N; f++){ fx += nodes[f].x; fy += nodes[f].y; }
    fx /= Math.max(1, N); fy /= Math.max(1, N);
    var rot = 0.21, cR = Math.cos(rot), sR = Math.sin(rot);
    for (var f2 = 0; f2 < N; f2++){
      var n4 = nodes[f2];
      var dx4 = n4.x - fx, dy4 = n4.y - fy;
      var a4 = Math.atan2(dy4, dx4);
      var mod4 = 1 + 0.13 * Math.sin(3 * a4 + 0.7) + 0.07 * Math.sin(5 * a4 + 2.1);
      var rx4 = dx4 * mod4, ry4 = dy4 * mod4;
      n4.x = fx + rx4 * cR - ry4 * sR;
      n4.y = fy + rx4 * sR + ry4 * cR;
    }
  }

  /* 去重叠：保持自由分布，不做矩形裁剪（间距按节点对微抖，避免磨成整齐均匀的壳层） */
  for (var pass = 0; pass < 12; pass++){
    for (var p = 0; p < N; p++) for (var q = p + 1; q < N; q++){
      var p1 = nodes[p], p2 = nodes[q];
      var px = p1.x - p2.x, py = p1.y - p2.y;
      var pd = Math.sqrt(px*px + py*py);
      if (pd === 0){ px = (Math.random() - 0.5) * 2; py = (Math.random() - 0.5) * 2; pd = Math.sqrt(px*px + py*py) || 0.7; }
      var minD = p1.r + p2.r + 4 + nodeRand(p1.id + "|" + p2.id, 17) * 8;
      if (pd < minD){
        var push = (minD - pd) / 2, ux2 = px/pd, uy2 = py/pd;
        p1.x += ux2*push; p1.y += uy2*push;
        p2.x -= ux2*push; p2.y -= uy2*push;
      }
    }
  }
}

/* 维度聚团图：维度值大节点（半径 ∝ 关联文献数）→ 文献小节点
   维度值集合按【当前筛选结果】实时重算，保证每个大节点都真实挂着文献，不再出现空节点 */
function buildDimGraph(){
  var list = filteredPapers();
  var d = DIMS.filter(function(x){ return x.key===state.statDim; })[0];
  if (!d || !d.get) d = DIMS.filter(function(x){ return !!x.get; })[0];
  var dm = {}, dims = [];
  list.forEach(function(p){
    var vs = d.get(p); vs = (vs===undefined||vs===null) ? [] : (Array.isArray(vs)?vs:[vs]);
    vs.forEach(function(v){
      if (empty(v)) return;
      v = String(v);
      if (!dm[v]){ dm[v] = {id:"d_"+v, key:"d_"+v, name:v, type:"dim", count:0, papers:[]}; dims.push(dm[v]); }
      dm[v].count++;
    });
  });
  var maxC = 1; dims.forEach(function(n){ if (n.count>maxC) maxC = n.count; });
  dims.forEach(function(n){ n.r = 13 + 24*(Math.log(1+n.count)/Math.log(1+maxC)); });
  var nodes = dims.slice(), edges = [], nodeMap = {}, orphan = null;
  dims.forEach(function(n){ nodeMap[n.id] = n; });
  list.forEach(function(p){
    var pn = {id:"p"+p.id, key:"p"+p.id, name:p.title, type:"paper", paper:p,
              r: 7 + Math.round((p.conf||0)*7)};
    nodes.push(pn); nodeMap[pn.id] = pn;
    var vs = d.get(p); vs = (vs===undefined||vs===null) ? [] : (Array.isArray(vs)?vs:[vs]);
    var hit = 0;
    vs.forEach(function(v){
      if (empty(v)) return;
      var t = dm[String(v)];
      if (!t) return;
      t.papers.push(pn); edges.push({s:t.id, t:pn.id, etype:"dim"}); hit++;
    });
    if (!hit){
      if (!orphan){
        orphan = {id:"d__unlabeled", key:"d__unlabeled", name:"未标注", type:"dim", count:0, papers:[], r:13};
        nodes.push(orphan); nodeMap[orphan.id] = orphan; dims.push(orphan);
      }
      orphan.count++; orphan.papers.push(pn); edges.push({s:orphan.id, t:pn.id, etype:"dim"});
    }
  });
  layoutGraph(nodes, edges, nodeMap, {spread:0.40, dimAnchor:"none"});
  return {mode:"dim", nodes:nodes, edges:edges, nodeMap:nodeMap, dims:dims, dim:d};
}

/* 综合图：全量本体节点 + 全量关系边，对齐 semantica Knowledge Explorer */
var ALLGRAPH = null;
function buildAllGraph(){
  if (ALLGRAPH) return ALLGRAPH;
  var nodes = [], edges = [], nodeMap = {}, deg = {};
  RAW.edges.forEach(function(e){ deg[e.source_id]=(deg[e.source_id]||0)+1; deg[e.target_id]=(deg[e.target_id]||0)+1; });
  var maxDeg = 1; Object.keys(deg).forEach(function(k){ if (deg[k]>maxDeg) maxDeg = deg[k]; });
  RAW.nodes.forEach(function(nd){
    var pr = nd.properties || {}, r = 7;
    if (nd.type === "Paper"){
      var c = parseFloat(pr.confidence); r = 9 + (isFinite(c) ? c*11 : 4);
    } else if (nd.type === "LocalFile"){
      r = 6.5;
    } else {
      r = 6 + 11*(Math.log(1+(deg[nd.id]||0))/Math.log(1+maxDeg));
    }
    var nn = {id:nd.id, key:nd.id, name:nodeLabel(nd), type:"ns", nsType:nd.type, node:nd, r:r, deg:(deg[nd.id]||0)};
    nodes.push(nn); nodeMap[nd.id] = nn;
  });
  RAW.edges.forEach(function(e){
    if (nodeMap[e.source_id] && nodeMap[e.target_id]) edges.push({s:e.source_id, t:e.target_id, etype:e.type});
  });
  /* P1-6 综合视图按实体类型分区初始布局：各类型扇形区域排布，力导向在此基线上聚团，避免 320 节点单一团簇 */
  var TYPES = ["Paper","Author","Venue","Keyword","Organization","LocalFile"];
  var byType = {};
  nodes.forEach(function(n){ (byType[n.nsType] = byType[n.nsType] || []).push(n); });
  TYPES.forEach(function(t, ti){
    var arr = byType[t] || []; if (!arr.length) return;
    var a0 = -Math.PI / 2 + (ti + 0.5) * 2 * Math.PI / TYPES.length;
    arr.forEach(function(n, i){
      var a = a0 + (i - (arr.length - 1) / 2) * 0.09;
      n.x = Math.cos(a) * (70 + (i % 12) * 26); n.y = Math.sin(a) * (70 + (i % 12) * 26);
    });
  });
  layoutGraph(nodes, edges, nodeMap, {spread:0.44});
  ALLGRAPH = {mode:"all", nodes:nodes, edges:edges, nodeMap:nodeMap, dims:[], dim:{key:"all", name:"综合"}};
  return ALLGRAPH;
}
function buildAllGraphFallback(){
  if (ALLGRAPH) return ALLGRAPH;
  var nodes = [], edges = [], nodeMap = {}, deg = {};
  function add(id, name, nsType, r){
    if (nodeMap[id]) return nodeMap[id];
    var n = {id:id, key:id, name:name, type:"ns", nsType:nsType, r:r||7, node:null};
    nodes.push(n); nodeMap[id] = n; return n;
  }
  function link(a, b, t){
    if (!a || !b || a===b) return;
    edges.push({s:a.id, t:b.id, etype:t});
    deg[a.id]=(deg[a.id]||0)+1; deg[b.id]=(deg[b.id]||0)+1;
  }
  PAPERS.forEach(function(p){
    var pn = add("p"+p.id, p.title, "Paper", 10);
    p.authors.forEach(function(a){ link(pn, add("au_"+a, a, "Author", 7), "hasAuthor"); });
    p.kw.forEach(function(k){ link(pn, add("kw_"+k, k, "Keyword", 7), "hasKeyword"); });
    if (p.journal) link(pn, add("ve_"+p.journal, p.journal, "Venue", 8), "publishedIn");
    if (p.org && p.org !== "未标注") link(pn, add("og_"+p.org, p.org, "Organization", 8), "hasAffiliation");
    if (p.year) link(pn, add("yr_"+p.year, p.year+"年", "DomainCategory", 8), "hasResearchTopic");
  });
  var maxDeg = 1; Object.keys(deg).forEach(function(k){ if (deg[k]>maxDeg) maxDeg = deg[k]; });
  nodes.forEach(function(n){ if (n.nsType !== "Paper") n.r = 6 + 11*(Math.log(1+(deg[n.id]||0))/Math.log(1+maxDeg)); });
  layoutGraph(nodes, edges, nodeMap, {spread:0.44});
  ALLGRAPH = {mode:"all", nodes:nodes, edges:edges, nodeMap:nodeMap, dims:[], dim:{key:"all", name:"综合"}};
  return ALLGRAPH;
}

/* ================= 图谱：形状编码 / 交互 / 统一详情 ================= */

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
  var nw = Math.max(120, Math.min(20000, vb[2]*f)), nh = nw*(vb[3]/vb[2]);
  var ax = vb[0] + mx*vb[2], ay = vb[1] + my*vb[3];
  G.viewBox = [ax-mx*nw, ay-my*nh, nw, nh];
  graphApplyVB();
}
/* 内容包围盒（含节点半径与标签预留）——作为视口的唯一依据，不再使用固定 1000x660 画布 */
function graphBBox(g){
  var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  (g.nodes || []).forEach(function(n){
    var r = (typeof n.r === "number") ? n.r : 8;
    /* 每节点预留随 id 小幅抖动 → 内容外缘天然参差，不齐平 */
    var pad = r + (n.type === "dim" ? 18 : 20) + nodeRand(n.id, 23) * 12;
    if (n.x - pad < x1) x1 = n.x - pad;
    if (n.y - pad < y1) y1 = n.y - pad;
    if (n.x + pad > x2) x2 = n.x + pad;
    if (n.y + pad > y2) y2 = n.y + pad;
  });
  if (!isFinite(x1)) return {x:0, y:0, w:1000, h:660};
  var w = Math.max(2, x2 - x1), h = Math.max(2, y2 - y1);
  /* 有机留白：四边不等量（右侧/下方略多），内容不贴边也不齐平 → 消除"铺满矩形框"的观感，
     同时把四边差距控制在 ~1.7 倍内，避免某一边出现突兀的大片空白 */
  var padL = w * 0.055, padR = w * 0.085, padT = h * 0.072, padB = h * 0.098;
  return {x: x1 - padL, y: y1 - padT, w: w + padL + padR, h: h + padT + padB};
}

/* 适应视图：按内容包围盒 + 容器实际宽高比计算 viewBox（对齐 KE 的 Fit，内容铺满且不被裁切） */
function graphFitView(){
  var G = GRAPH; if (!G || !G.svg) return;
  var b = graphBBox(G.g);
  var cw = (G.wrap && G.wrap.clientWidth) || 1000;
  var ch = (G.wrap && G.wrap.clientHeight) || 660;
  var ar = cw / ch;
  /* b 已含四边不等量的有机留白；这里只做温和的宽高比修正，
     不再把视口强行拉成容器宽高比（那会让内容铺满整个矩形区） */
  var w = b.w * 1.02, h = b.h * 1.02;
  var arC = w / h;
  if (isFinite(arC) && arC > 0.05){
    var corr = Math.sqrt(ar / arC);
    if (corr > 1.12) corr = 1.12;
    if (corr < 0.90) corr = 0.90;
    if (corr > 1) w *= corr; else h /= corr;
  }
  /* 详情面板以浮层形式覆盖在右侧时，把内容中心对准可视区中心，避免节点被面板盖住 */
  var offX = 0;
  var rp = document.getElementById("relPanel");
  if (rp && rp.classList.contains("open") && document.getElementById("graphWrap")){
    offX = (rp.offsetWidth || 340) / 2;
  }
  G.viewBox = [b.x + b.w/2 - w/2 + offX, b.y + b.h/2 - h/2, w, h];
  graphApplyVB();
}
function graphFit(){ graphFitView(); }
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
  var focus = G.focusIds;
  /* P1-04：记录旧坐标，重布局后从旧位置平滑过渡到新位置 */
  var old = {};
  g.nodes.forEach(function(n){ old[n.id] = {x: n.x, y: n.y}; });
  g.nodes.forEach(function(n){ delete n.x; delete n.y; });
  layoutGraph(g.nodes, g.edges, g.nodeMap, {spread: (g.mode==="all" ? 0.44 : 0.40)});
  var host = document.getElementById("gHost");
  if (host) host.innerHTML = graphMarkup(g);
  bindGraph(g, focus);
  graphSelect(null);
  /* P1-04：旧坐标 → 新坐标 300ms easeOutCubic 平滑过渡（CSS 变量定位 + 强制 reflow 起手） */
  var svg = document.getElementById("graphSvg");
  if (!svg) return;
  svg.querySelectorAll(".g-node").forEach(function(el){
    var nid = el.getAttribute("data-id");
    var o = old[nid];
    if (!o) return;
    var nx = parseFloat(el.style.getPropertyValue("--gx")) || 0;
    var ny = parseFloat(el.style.getPropertyValue("--gy")) || 0;
    el.style.transition = "none";
    el.style.setProperty("--gx", o.x.toFixed(1)+"px");
    el.style.setProperty("--gy", o.y.toFixed(1)+"px");
    void el.getBoundingClientRect();
    el.style.transition = "transform .3s ease";
    el.style.setProperty("--gx", nx.toFixed(1)+"px");
    el.style.setProperty("--gy", ny.toFixed(1)+"px");
  });
}

/* --- HUD 按钮组：统一生成；busy 时整组保留（仅置禁用 + 刷新键转圈），避免按钮丢失 --- */
function graphHudHtml(busy){
  var d = busy ? ' disabled' : '';
  var hasFocus = !!(GRAPH && GRAPH.g && GRAPH.g._focus);
  var ctxOn = hasFocus && !!state._showContext;
  return '<button onclick="graphZoom(0.85)" title="放大"' + d + '>＋</button>'
    + '<button onclick="graphZoom(1.18)" title="缩小"' + d + '>－</button>'
    + '<button onclick="graphFit()" title="适应视图"' + d + '>⊞</button>'
    + (hasFocus ? '<button class="' + (ctxOn ? 'on' : '') + '" onclick="toggleCtx()" title="显示上下文：未选中但有关联的维度值以淡色呈现"' + d + '>ctx</button>' : '')
    + '<button class="' + (busy ? 'busy' : '') + '" onclick="graphRefresh()" title="'
    + (busy ? '正在刷新…' : '刷新：更新最新数据') + '"' + d + '>'
    + (busy ? '<span>⟳</span>' : '⟳') + '</button>';
}
/* P2-9 显示上下文开关：切换 state._showContext 后重渲染图谱 */
function toggleCtx(){
  state._showContext = !state._showContext;
  graphRefresh();
}
/* 底部轻提示（中性/错误两色），不遮挡页面内其它交互 */
function graphTip(msg, isErr){
  try{
    var eb = document.getElementById("errBar"); if (eb) eb.remove();
    var box = document.getElementById("tipBar");
    if (!box){ box = document.createElement("div"); box.id = "tipBar"; document.body.appendChild(box); }
    box.textContent = msg;
    box.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99998;background:"
      + (isErr ? "#b02a37" : "#1f6f43")
      + ";color:#fff;font:12px/1.6 -apple-system,sans-serif;padding:6px 12px;opacity:.94";
    setTimeout(function(){ try{ box.remove(); }catch(_e){} }, 4000);
  }catch(_e){}
}

/* --- 刷新按钮：重新拉取最新图谱数据（stats/nodes/edges）+ 重建文献与筛选索引 + 重新渲染 --- */
function graphRefresh(){
  var G = GRAPH; if (!G) return;              /* 图谱未就绪：静默忽略 */
  if (G.loading) return;                      /* 防重入：刷新中不再重复触发 */
  G.loading = true;
  var hud = document.getElementById("gHud");
  if (hud) hud.innerHTML = graphHudHtml(true);
  var finish = function(msg, isErr){
    if (GRAPH === G) G.loading = false;
    var h = document.getElementById("gHud");
    if (h) h.innerHTML = graphHudHtml(false); /* 成功/失败都恢复完整可点按钮组，保证可重试 */
    if (msg) graphTip(msg, isErr);
  };
  /* 先探活，后端不可用时直接提示，不破坏当前视图 */
  API.get("/api/graph/stats").then(function(st){
    if (!st || !st.ok) throw new Error((st && st.reason) || "后端未就绪");
    return reload(false);
  }).then(function(){
    if (!RAW.ok) throw new Error(RAW.failReason || "图谱数据读取失败");
    refreshArea();
    finish("图谱已刷新 · 节点 " + RAW.nodes.length + " / 边 " + RAW.edges.length, false);
  }).catch(function(err){
    finish("刷新失败：" + ((err && err.message) || "未知错误") + "，已保留当前视图", true);
  });
}

/* --- SVG 主体生成 --- */
/* 聚焦子图模式：维度视图 + 筛选命中（hasFocus）→ 以选中关键词取值节点为核心的三层径向结构。
   核心：选中维度值节点（放大 1.5 倍 + 深紫发光，钉在正中）；
   一跳：与核心直接关联的命中论文（正常大小实体色，角度均布环绕核心）；
   二跳：论文关联的其他维度值节点（缩小 0.8 倍 + 45% 透明，散落外环）；
   无关：无关联维度值节点（8% 透明，保留轮廓）。取消筛选后 hasFocus 为假，直接恢复聚团视图。 */
/* P0-1 多核心布局：每个选中值都渲染为核心级节点，多核心环形均布中心区；
   各核心命中论文环绕各自核心；同时命中多个核心的论文（交集）双色描边放中间；
   二跳按归属核心着色分组并做 Top-K 收敛（P1-4），其余折叠为"关联 +N"聚合节点（点击展开）；
   P0-2 选中词强制可见："无关"只用于非选中的其他取值；
   P2-10 已见节点位置尽量保持（none 沿用上次位置） */
function focusDimLayout(g){
  if (!g || g.mode !== "dim" || !g.dims || !g.dims.length) return false;
  var hasF = false;
  Object.keys(state.filters).forEach(function(k){ if (k !== "all" && state.filters[k] && state.filters[k].length) hasF = true; });
  if (!hasF) return false;
  var dimKey = g.dim ? g.dim.key : "";
  var vals = (state.filters[dimKey] || []).slice();
  if (!vals.length) return false;
  /* 定位所有选中值对应的维度节点，去重 */
  var cores = [];
  vals.forEach(function(v){
    v = String(v);
    for (var i = 0; i < g.dims.length; i++){
      if (String(g.dims[i].name) === v){
        if (cores.indexOf(g.dims[i]) < 0) cores.push(g.dims[i]);
        break;
      }
    }
  });
  if (!cores.length) return false;
  /* P2-10：缓存当前聚团位置，供下次聚焦布局保持已见节点位置 */
  g.dims.forEach(function(n){ if (!state._dimPos[n.id]) state._dimPos[n.id] = {x:n.x, y:n.y}; });
  var nC = cores.length;
  var coreIds = {}; cores.forEach(function(c){ coreIds[c.id] = 1; });
  /* 每篇命中论文的核心位掩码 */
  var paperMask = {};
  cores.forEach(function(c, ci){
    (c.papers || []).forEach(function(p){
      if (!paperMask[p.id]) paperMask[p.id] = 0;
      paperMask[p.id] |= (1 << ci);
    });
  });
  var maskCnt = function(m){ var c = 0; while (m){ c += (m & 1); m >>= 1; } return c; };
  /* 一跳（恰好命中一个核心）与交集（命中多个核心） */
  var hop1 = [], inter = [];
  Object.keys(paperMask).forEach(function(pid){
    var p = g.nodeMap[pid];
    if (!p) return;
    p._multi = paperMask[pid];
    if (maskCnt(paperMask[pid]) > 1) inter.push(p); else hop1.push(p);
  });
  /* 二跳：与任一命中论文共享的其他维度值（非选中）；none=无关联的其他取值 */
  var hop2 = [], none = [];
  g.dims.forEach(function(n){
    if (coreIds[n.id]) return;
    var shared = (n.papers || []).some(function(p){ return paperMask[p.id] !== undefined; });
    (shared ? hop2 : none).push(n);
  });
  var coreSharedCnt = function(n, ci){
    var c = 0;
    (n.papers || []).forEach(function(p){
      if (paperMask[p.id] !== undefined && (paperMask[p.id] & (1 << ci))) c++;
    });
    return c;
  };
  /* P1-4 二跳 Top-K 收敛：按关联论文数降序取 Top-K；其余先判归属核心，未展开的核心折叠为"关联 +N"聚合节点 */
  var TOPK = HOP2_TOPK;
  hop2.sort(function(a, b){
    return ((b.papers || []).length - (a.papers || []).length) || String(a.name).localeCompare(String(b.name));
  });
  hop2.forEach(function(n){
    var best = 0, bestCnt = -1;
    cores.forEach(function(c, ci){
      var cnt = coreSharedCnt(n, ci);
      if (cnt > bestCnt){ bestCnt = cnt; best = ci; }
    });
    n._coreIdx = best;
  });
  var expanded = {};
  cores.forEach(function(c, ci){ if (state._hop2Expand[dimKey + "#" + c.id]) expanded[ci] = true; });
  var hop2Top = hop2.slice(0, TOPK);
  var keep = [];
  hop2.slice(TOPK).forEach(function(n){
    if (expanded[n._coreIdx]){ hop2Top.push(n); n._aggr = false; }
    else { n._aggr = true; keep.push(n); }
  });
  /* 聚合节点：仅对未展开的核心创建；同时把折叠的二跳节点从图中移除（仅保留聚合占位） */
  var aggNodes = [];
  var aggCount = {};
  keep.forEach(function(n){ aggCount[n._coreIdx] = (aggCount[n._coreIdx] || 0) + 1; });
  cores.forEach(function(c, ci){
    if (!aggCount[ci] || expanded[ci]) return;
    var an = {id:"agg_"+c.id, key:"agg_"+c.id, name:"关联 +"+aggCount[ci], type:"dim", count:aggCount[ci],
              papers: keep.filter(function(x){ return x._coreIdx === ci; }), r:13,
              _agg:true, _aggCore:ci, _aggCoreName:String(c.name), _aggCount:aggCount[ci], _coreIdx:ci};
    g.dims.push(an); g.nodes.push(an); g.nodeMap[an.id] = an; aggNodes.push(an);
  });
  /* 折叠节点从图中移除（只保留聚合占位，避免半折叠残留渲染） */
  keep.forEach(function(n){
    var gi = g.dims.indexOf(n); if (gi >= 0) g.dims.splice(gi, 1);
    var ni = g.nodes.indexOf(n); if (ni >= 0) g.nodes.splice(ni, 1);
    delete g.nodeMap[n.id];
  });
  /* --- 径向多核心布局 --- */
  var coreR = Math.max(120, 84 + 36 * nC);
  var ca = [];
  cores.forEach(function(c, ci){
    var a = -Math.PI / 2 + ci * 2 * Math.PI / nC;   /* 从正上方顺时针均布 */
    ca.push(a);
    c.x = Math.cos(a) * coreR; c.y = Math.sin(a) * coreR;
    c._focus = "core"; c._coreIdx = ci;
  });
  /* 各核心的命中论文环绕各自核心（P0-1） */
  var hop1ByCore = {};
  hop1.forEach(function(p){
    var ci = 0;
    for (var b = 0; b < nC; b++){ if (paperMask[p.id] & (1 << b)){ ci = b; break; } }
    p._coreIdx = ci;
    (hop1ByCore[ci] = hop1ByCore[ci] || []).push(p);
    p._focus = "hop1";
  });
  cores.forEach(function(c, ci){
    var arr = hop1ByCore[ci] || [];
    var R1 = Math.max(118, c.r * 1.5 + 64 + Math.min(arr.length, 24) * 5);
    arr.forEach(function(p, i){
      var a = ca[ci] + (i - (arr.length - 1) / 2) * Math.min(0.36, 2 * Math.PI / Math.max(arr.length, 1));
      p.x = c.x + Math.cos(a) * R1; p.y = c.y + Math.sin(a) * R1;
    });
  });
  /* 交集论文：双色描边高亮放中间 */
  var Rm = Math.max(42, coreR * 0.52);
  inter.forEach(function(p, i){
    var a = i * 2 * Math.PI / Math.max(inter.length, 1) + 0.4;
    p.x = Math.cos(a) * Rm; p.y = Math.sin(a) * Rm;
    p._focus = "inter";
    var cs = [];
    for (var b = 0; b < nC; b++){ if (paperMask[p.id] & (1 << b)){ cs.push(b); if (cs.length >= 2) break; } }
    p._multiCores = cs;
  });
  /* 二跳按归属核心扇区摆放（P1-4 按核心着色分组） */
  var R2 = coreR + 175;
  var hop2ByCore = {};
  hop2Top.forEach(function(n){
    (hop2ByCore[n._coreIdx] = hop2ByCore[n._coreIdx] || []).push(n);
    n._focus = "hop2";
  });
  cores.forEach(function(c, ci){
    var arr = hop2ByCore[ci] || [];
    var spread = Math.min(0.9, (Math.PI / Math.max(nC, 1)) * 0.62);
    var stepA = Math.min(0.5, (spread * 2) / Math.max(arr.length, 1));
    arr.forEach(function(n, i){
      var a = ca[ci] + (i - (arr.length - 1) / 2) * stepA;
      var tx = Math.cos(a) * R2, ty = Math.sin(a) * R2;
      /* P2-10 布局稳定性：上次可见位置向新扇区目标插值 30%，减少筛选切换跳变 */
      var op = state._dimPos[n.id];
      if (op && isFinite(op.x) && isFinite(op.y)){
        n.x = op.x + (tx - op.x) * 0.3; n.y = op.y + (ty - op.y) * 0.3;
      } else {
        n.x = tx; n.y = ty;
      }
    });
  });
  /* 聚合节点：所属核心扇区外侧 */
  aggNodes.forEach(function(an){
    var a = ca[an._aggCore];
    an.x = Math.cos(a) * (R2 + 52); an.y = Math.sin(a) * (R2 + 52);
    an._focus = "agg";
  });
  /* none：最外圈淡色（P2-10 沿用上次位置，避免筛选切换结构跳变） */
  var nIdx = 0;
  none.forEach(function(n){
    var old = state._dimPos[n.id];
    if (old && isFinite(old.x) && isFinite(old.y)){
      n.x = old.x; n.y = old.y;
    } else {
      var a = nIdx * Math.PI * (3 - Math.sqrt(5)) + 4.2;
      n.x = Math.cos(a) * (R2 + 46); n.y = Math.sin(a) * (R2 + 46);
    }
    n._focus = "none";
    nIdx++;
  });
  g._focus = true; g._cores = cores; g._core = cores[0];
  g._hop1 = hop1; g._inter = inter; g._hop2 = hop2Top; g._none = none; g._agg = aggNodes; g._hop2All = hop2;
  return true;
}

function graphMarkup(g){
  var _bb = graphBBox(g);
  var labSet = {}, hubSet = {}, topDimLab = {};
  if (g.mode === "all"){
    g.nodes.slice().sort(function(a,b){ return (b.deg||0)-(a.deg||0); }).slice(0, 46).forEach(function(n){ labSet[n.id] = 1; hubSet[n.id] = 1; });
  }
  /* P1-6：未筛选维度图仅给关联文献数前 24 的取值渲染标签，避免 170 节点标签大面积重叠 */
  if (g.mode === "dim" && !g._focus){
    g.dims.slice().sort(function(a,b){ return ((b.count||0)-(a.count||0)) || String(a.name).localeCompare(String(b.name)); }).slice(0, 24).forEach(function(n){ topDimLab[n.id] = 1; });
  }
  var s = '<svg id="graphSvg" viewBox="' + [_bb.x,_bb.y,_bb.w,_bb.h].join(" ") + '" preserveAspectRatio="xMidYMid meet"><g id="gEdges">';
  g.edges.forEach(function(e){
    var a = g.nodeMap[e.s], b = g.nodeMap[e.t]; if (!a || !b) return;
    var col = (g.mode === "all") ? (EDGE_COLOR[e.etype] || "#ced4da") : "#b9c2f0";
    var op = (g.mode === "all") ? 0.72 : 0.82;
    var sw = 1.5, fe = "";
    if (g._focus){
      /* 连线分层（P0-1 多核心联动）：核心→其命中论文 3px/0.98 用核心色；
         核心→交集论文 2.5px/0.92；一跳/交集→二跳 1.4px/0.5；其余淡化隐藏 */
      fe = ' data-focus-edge="1"';
      var fa = a._focus || "", fb = b._focus || "";
      var coreIdxOf = function(x){ return (typeof x._coreIdx === "number") ? x._coreIdx : 0; };
      if ((fa === "core" && fb === "hop1") || (fb === "core" && fa === "hop1")){
        var ci0 = coreIdxOf(fa === "core" ? a : b);
        col = CORE_PALETTE[ci0 % CORE_PALETTE.length]; op = 0.98; sw = 3;
      } else if ((fa === "core" && fb === "inter") || (fb === "core" && fa === "inter")){
        var ci1 = coreIdxOf(fa === "core" ? a : b);
        col = CORE_PALETTE[ci1 % CORE_PALETTE.length]; op = 0.92; sw = 2.5;
      } else if ((fa === "hop1" && fb === "hop2") || (fb === "hop1" && fa === "hop2")
                 || (fa === "inter" && fb === "hop2") || (fb === "inter" && fa === "hop2")){
        op = 0.5; sw = 1.4;
      } else {
        op = 0.06; sw = 1;
      }
    }
    s += '<line class="g-edge" data-s="'+esc(e.s)+'" data-t="'+esc(e.t)+'" data-op="'+op+'"'+fe
       + ' x1="'+a.x.toFixed(1)+'" y1="'+a.y.toFixed(1)+'" x2="'+b.x.toFixed(1)+'" y2="'+b.y.toFixed(1)+'"'
       + ' stroke="'+col+'" stroke-opacity="'+op+'" stroke-width="'+sw+'"/>';
  });
  s += '</g><g id="gNodes">';

  /* 维度聚团图：大节点（维度值） */
  if (g.mode === "dim"){
    /* P0-A：维度取值节点按实体类型渲染形状+实体色（DIM_NS 映射），无类型（year/未标注）用实心灰圆 */
    var dimNs = DIM_NS[(g.dim && g.dim.key) || ""] || null;
    g.dims.forEach(function(n){
      /* 聚焦子图模式层级样式（P0-1/P1-4/P2-8/P2-9）：
         核心放大 1.5 倍 + 核心色描边发光 + 标签完整加粗；
         二跳缩小 0.8 倍 + 45% 透明 + 归属核心色描边（按核心着色分组）；
         聚合节点"关联 +N"虚线粗框可点击展开；无关 8% 透明极小色点不渲染标签（显示上下文开启时淡色呈现） */
      var coreMode = !!(g._focus && n._focus === "core");
      var hop2Mode = !!(g._focus && n._focus === "hop2");
      var noneMode = !!(g._focus && n._focus === "none");
      var aggMode = !!(g._focus && n._focus === "agg");
      var coreIdx = (typeof n._coreIdx === "number") ? n._coreIdx : 0;
      var coreCol = CORE_PALETTE[coreIdx % CORE_PALETTE.length];
      var rEff = n.r * (coreMode ? 1.5 : (aggMode ? 1.15 : (hop2Mode ? 0.8 : (noneMode ? (state._showContext ? 0.8 : 0.35) : 1))));
      var nsType = (n.key === "d__unlabeled") ? null : dimNs;
      var col = nsType ? (NS_COLOR[nsType] || "#868e96") : "#868e96";
      if (coreMode || aggMode) col = coreCol;
      var geo = nsType ? shapeGeom(nsType, rEff) : {t:"circle", geom:'<circle cx="0" cy="0" r="'+rEff.toFixed(1)+'"/>'};
      if (aggMode) geo = {t:"circle", geom:'<circle cx="0" cy="0" r="'+rEff.toFixed(1)+'"/>'};
      var fill = col, stroke = "#fff", sw = 1.1, fo = 0.9;
      if (geo.t === "ring"){ fill = "#fff"; stroke = col; sw = 1.6; }
      else if (geo.t === "dot"){ fill = "#fff"; stroke = col; sw = 1.4; }
      if (coreMode){ stroke = coreCol; sw = 3.2; fo = 0.95; }
      else if (hop2Mode){ stroke = coreCol; sw = 1.8; fo = 0.45; }
      else if (aggMode){ stroke = coreCol; sw = 2.4; fo = 0.92; }
      else if (noneMode){ fo = state._showContext ? 0.3 : 0.08; }
      var glow = "";
      if (coreMode){
        glow = '<circle cx="0" cy="0" r="'+(rEff*1.55).toFixed(1)+'" fill="none" stroke="'+coreCol+'" stroke-width="3" opacity="0.30"/>'
             + '<circle cx="0" cy="0" r="'+(rEff*1.28).toFixed(1)+'" fill="none" stroke="'+coreCol+'" stroke-width="2" opacity="0.55"/>';
      }
      var fs = Math.max(9.5, Math.min(13.5, n.r*0.55));
      var roleAttr = g._focus ? ' data-focus-role="'+n._focus+'"' : '';
      var aggAttr = aggMode ? ' data-agg="1" data-core-id="'+esc(n._aggCoreName)+'"' : '';
      var gOp = noneMode ? (state._showContext ? 0.3 : 0.08) : (hop2Mode ? 0.45 : 1);
      var lbFs = coreMode ? (fs*1.3) : (hop2Mode || noneMode ? fs*0.9 : fs);
      var lbY = coreMode ? (-rEff-10) : (-rEff-6);
      var noLb = (noneMode && !state._showContext) || (!g._focus && !topDimLab[n.id]);
      var fullName = String(n.name);
      s += '<g class="g-node dim'+(aggMode?" agg":"")+'" data-id="'+esc(n.id)+'" data-kind="dim" data-nstype="'+esc(nsType || "none")+'"'+roleAttr+aggAttr+' style="--gx:'+n.x.toFixed(1)+'px;--gy:'+n.y.toFixed(1)+'px" '
         + 'fill="'+fill+'" fill-opacity="'+fo+'" stroke="'+stroke+'" stroke-width="'+sw.toFixed(1)+'" opacity="'+gOp+'">'
         + glow + geo.geom;
      if ((geo.t === "ring" && rEff >= 8) && !aggMode){
        s += '<circle cx="0" cy="0" r="'+Math.max(1.6, rEff-4).toFixed(1)+'" fill="'+col+'" opacity=".9"/>';
      }
      if (aggMode){
        s += '<circle cx="0" cy="0" r="'+(rEff-3.5).toFixed(1)+'" fill="'+coreCol+'" opacity=".28"/>'
           + '<text x="0" y="'+(rEff*0.42).toFixed(1)+'" text-anchor="middle" fill="'+coreCol+'" font-weight="800" font-size="'+(fs*0.95).toFixed(1)+'">+</text>';
      }
      if (!noLb){
        var lbText = coreMode ? esc(fullName) : esc(short(fullName, 12));
        s += '<text class="g-label" x="0" y="'+lbY.toFixed(1)+'" text-anchor="middle"' + (coreMode ? ' font-weight="800" fill="'+coreCol+'"' : '') + ' font-size="'+lbFs.toFixed(1)+'">'
           + '<title>'+esc(fullName)+'</title>'
           + lbText
           + (n.count>1 && !coreMode && !aggMode ? '<tspan fill="#868e96" font-size="'+(lbFs*0.85).toFixed(1)+'"> '+n.count+'</tspan>' : '')
           + '</text>';
      }
      s += '</g>';
    });
  }

  /* 文献 / 本体节点 */
  g.nodes.forEach(function(n){
    if (n.type === "dim") return;
    var isPaper = (n.type === "paper") || (n.nsType === "Paper");
    var col = isPaper ? "#8b7cf6" : (NS_COLOR[n.nsType] || "#868e96");
    var nsType = isPaper ? "Paper" : n.nsType;
    var geo = shapeGeom(nsType, n.r);
    var fill, stroke = "#fff", sw = 1.1;
    if (geo.t === "ring"){ fill = "#fff"; stroke = col; sw = 1.6; }
    else if (geo.t === "dot"){ fill = "#fff"; stroke = col; sw = 1.4; }
    else { fill = col; }
    var gid = esc(n.id), pid = isPaper ? (n.type==="paper" ? n.paper.id : "") : "";
    /* P0-1 多核心联动：论文一跳按所属核心细描边着色；交集论文（同时命中多个核心）双色描边高亮放中间 */
    var focusRole = g._focus ? (n._focus || (isPaper ? "hop1" : "none")) : null;
    var roleAttr = focusRole ? ' data-focus-role="'+focusRole+'"' : '';
    var baseStroke = stroke, baseSw = sw, extra = "";
    if (g._focus && focusRole === "hop1" && isPaper && typeof n._coreIdx === "number"){
      baseStroke = CORE_PALETTE[n._coreIdx % CORE_PALETTE.length]; baseSw = 1.6;
    } else if (g._focus && focusRole === "inter" && n._multiCores && n._multiCores.length > 1){
      var cA = CORE_PALETTE[(n._multiCores[0]) % CORE_PALETTE.length];
      var cB = CORE_PALETTE[(n._multiCores[1]) % CORE_PALETTE.length];
      baseStroke = cA; baseSw = 2;
      extra = '<circle cx="0" cy="0" r="'+(n.r+3).toFixed(1)+'" fill="none" stroke="'+cA+'" stroke-width="2.6" opacity="0.9"/>'
            + '<circle cx="0" cy="0" r="'+(n.r+1.2).toFixed(1)+'" fill="none" stroke="'+cB+'" stroke-width="1.5"/>';
    }
    s += '<g class="g-node'+(isPaper?" paper":" ns")+(g.mode==="dim"?" pnode":"")+'" data-id="'+gid+'" data-kind="'+(isPaper?"paper":"ns")+'"'
       + (pid!=="" ? ' data-pid="'+esc(pid)+'"' : '')
       + (isPaper ? '' : ' data-nstype="'+esc(nsType)+'"')
       + roleAttr
       + ' style="--gx:'+n.x.toFixed(1)+'px;--gy:'+n.y.toFixed(1)+'px" '
       + (geo.t==="dot" ? 'stroke-dasharray="2 2" ' : '')
       + 'fill="'+fill+'" fill-opacity="'+(geo.t==="ring"||geo.t==="dot"?1:0.9)+'" stroke="'+baseStroke+'" stroke-width="'+baseSw+'">'
       + geo.geom
       + extra;
    /* 内芯（ring 类型加实心核，视觉权重按半径） */
    if (geo.t === "ring" && n.r >= 8){
      s += '<circle cx="0" cy="0" r="'+Math.max(1.6, n.r-4).toFixed(1)+'" fill="'+col+'" opacity=".9"/>';
    }
    var showLb = (g.mode === "dim") || !!labSet[n.id];
    if (showLb){
      var hub = !!hubSet[n.id];
      var fullTxt = String(n.name);
      s += '<text class="g-label'+(hub?" hub":"")+'" x="0" y="'+(-n.r-(geo.t==="capsule"?3:7)).toFixed(1)+'" text-anchor="middle">'
         + '<title>'+esc(fullTxt)+'</title>'
         + esc(short(fullTxt, hub ? 22 : 16)) + '</text>';
    }
    s += '</g>';
  });
  s += '</g></svg>';
  return s;
}

/* P1-01/P1-02：图例内嵌真实 SVG 形状预览（颜色即实体颜色，形状即节点形状） */
function legendShapeIcon(nsType, color, size){
  size = size || 15;
  var r = size/2 - 2.5;
  var geo = shapeGeom(nsType, r);
  var fill, stroke = color || "#868e96", sw = 1.5;
  if (geo.t === "ring" || geo.t === "dot"){ fill = "#fff"; stroke = color || "#868e96"; }
  else { fill = color || "#868e96"; stroke = "#fff"; }
  return '<svg class="lg-ico" width="'+size+'" height="'+size+'" viewBox="-9 -9 18 18" aria-hidden="true">'
    + '<g fill="'+fill+'" stroke="'+stroke+'" stroke-width="'+sw+'">'+geo.geom+'</g></svg>';
}
function graphLegend(g, hasFocus){
  /* P0-B：图例动态适配当前视图 —— 综合视图 TOP5 全类型；维度视图仅论文+当前维度实体类型（无类型维度补灰色圆点说明） */
  var s = "";
  var TOP, rest = [];
  if (g && g.mode === "dim"){
    TOP = ["Paper"];
    var dimNs = DIM_NS[(g.dim && g.dim.key) || ""] || null;
    if (dimNs && CLASS_ORDER.indexOf(dimNs) >= 0) TOP.push(dimNs);
  } else {
    TOP = ["Paper","Author","Organization","Venue","Keyword"].filter(function(c){ return CLASS_ORDER.indexOf(c) >= 0; });
    rest = CLASS_ORDER.filter(function(c){ return TOP.indexOf(c) < 0; });
  }
  s += TOP.map(function(c){
    var col = NS_COLOR[c] || "#868e96";
    return '<span class="lg-item" title="'+esc((NS_LABEL[c]||c)+" · "+(SHAPE_LABEL[NS_SHAPE[c]]||""))+'">'
      + legendShapeIcon(c, col)
      + '<span class="lg-name">'+esc(NS_LABEL[c]||c)+'</span>'
      + '<span class="lg-shape">'+esc(SHAPE_LABEL[NS_SHAPE[c]]||"")+'</span></span>';
  }).join("");
  if (g && g.mode === "dim" && !(DIM_NS[(g.dim && g.dim.key) || ""])){
    s += '<span class="lg-item" title="维度值（无实体类型，灰色圆形）">'
      + '<span class="lg-dot" style="background:#868e96"></span>'
      + '<span class="lg-name">'+esc((g.dim && g.dim.name ? g.dim.name : "维度")+"值")+'</span></span>';
  } else if (rest.length){
    s += '<span class="lg-item" title="'+esc(rest.map(function(c){ return NS_LABEL[c]||c; }).join("、"))+'">'
      + '<span class="lg-dot" style="background:#adb5bd"></span>其他</span>';
  }
  if (g && g._focus && g._core){
    /* P0-3 图例多核心联动：列出全部选中词（核心①=xxx、核心②=xxx…），"无关"改为"未选中的其他取值" */
    var coreTxt = "";
    var cArr = g._cores || [g._core];
    cArr.forEach(function(c, ci){
      coreTxt += '<span style="display:inline-block;margin-right:8px;white-space:nowrap">'
        + '<span class="lg-dot" style="background:'+CORE_PALETTE[ci % CORE_PALETTE.length]+';display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:3px"></span>'
        + '核心'+(ci+1)+'='+esc(String(c.name))+'</span>';
    });
    var dimName = g.dim && g.dim.name ? g.dim.name : "维度";
    s += '<span class="lg-note" style="display:block;margin-top:6px;padding-top:6px;border-top:1px solid #dee2e6;font-size:11px;line-height:1.6;color:#495057">'
      + '<b style="color:#7048e8">聚焦子图</b>：'+coreTxt+'<br>'
      + '相关=命中论文（环绕各自核心；多核心交集论文双色描边居中）<br>'
      + '二跳=关联'+esc(dimName)+'值（Top-'+HOP2_TOPK+' 按核心着色分组外环）<br>'
      + (g._agg && g._agg.length ? '聚合=关联 +N（虚线节点，点击展开/收起）<br>' : '')
      + '无关=未选中的其他取值（8% 透明）</span>';
  }
  return s;
}
function legendCollapsed(){
  try{ return localStorage.getItem("wb_legend_collapsed") === "1"; }catch(e){ return false; }
}
function isSmallGraph(){ return (window.innerHeight || 900) < 820; }
function toggleLegend(){
  var el = document.getElementById("gLegend");
  if (!el) return;
  var c = !el.classList.contains("collapsed");
  el.classList.toggle("collapsed", c);
  state._legendForced = true;
  try{ localStorage.setItem("wb_legend_collapsed", c ? "1" : "0"); }catch(e){}
}

/* --- 统一高亮绘制：baseIds 为高亮核心集（自动并入一跳邻居），null = 全部复原 --- */
function graphPaint(baseIds, selId){
  var G = GRAPH; if (!G || !G.svg) return;
  var svg = G.svg;
  G.selId = selId || null;
  var base = {}, nb = null;
  if (baseIds && baseIds.length){
    nb = {};
    baseIds.forEach(function(id){
      id = String(id);
      base[id] = 1; nb[id] = 1;
      (G.adj[id] || []).forEach(function(x){ nb[String(x.id)] = 1; });
    });
  }
  svg.querySelectorAll(".g-node").forEach(function(el){
    var id = el.getAttribute("data-id");
    if (el.getAttribute("data-focus-role")) return;   /* 聚焦子图层级透明度由渲染固定，不参与统一高亮 */
    el.style.opacity = (!nb || nb[id]) ? 1 : 0.22;   /* P0-03：非高亮 22%，保留图谱轮廓 */
    el.classList.toggle("sel", !!G.selId && id === String(G.selId));
  });
  svg.querySelectorAll(".g-edge").forEach(function(el){
    if (el.getAttribute("data-focus-edge")) return;   /* 聚焦子图连线分层由渲染固定 */
    var op = parseFloat(el.getAttribute("data-op")) || 0.72;
    if (!nb){ el.setAttribute("stroke-opacity", op); el.setAttribute("stroke-width", 1.5); return; }
    var hit = base[el.getAttribute("data-s")] || base[el.getAttribute("data-t")];
    el.setAttribute("stroke-opacity", hit ? 0.98 : 0.14);
    el.setAttribute("stroke-width", hit ? 2.2 : 1.2);
  });
  if (gtip) gtip.style.opacity = 0;
}
/* 选中单节点（清除选中时自动回落到筛选/搜索高亮） */
function graphSelect(selId){
  var G = GRAPH; if (!G) return;
  graphPaint(selId ? [String(selId)] : (G.focusIds || null), selId || null);
}

function bindGraph(g, focusIds){
  var wrap = document.getElementById("graphWrap"), svg = document.getElementById("graphSvg");
  if (!wrap || !svg) return;
  gtip = gtip || document.getElementById("gtip");
  var prevG = GRAPH;
  if (prevG && prevG._ro){ try{ prevG._ro.disconnect(); }catch(_e){} }
  var _bb = graphBBox(g);
  GRAPH = {g:g, svg:svg, wrap:wrap, viewBox:[_bb.x, _bb.y, _bb.w, _bb.h], selId:null, adj:graphAdj(g),
           focusIds:(focusIds && focusIds.length) ? focusIds : null};
  var G = GRAPH;
  graphApplyVB();
  requestAnimationFrame(function(){ if (GRAPH === G) graphFitView(); });

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
    graphHover(id);
    var html = "";
    var kind = el.getAttribute("data-kind");
    if (kind === "dim"){
      var dn = g.nodeMap[id];
      if (dn && dn._agg){
        html = "<b>关联 +"+dn._aggCount+"</b><br>已折叠的二跳"+esc((g.dim && g.dim.name ? g.dim.name : "维度")+"值")+"（归属核心 "+esc(dn._aggCoreName)+"）<br><span style='color:#adb5bd'>单击展开 / 再次单击收起</span>";
      } else {
        html = "<b>"+esc(dn.name)+"</b><br>维度值 · 关联 "+dn.papers.length+" 篇文献<br><span style='color:#adb5bd'>单击查看详情</span>";
      }
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
  var nodeOf = function(t){
    while (t && t !== svg && !(t.classList && t.classList.contains("g-node"))) t = t.parentNode;
    return (t && t !== svg) ? t : null;
  };
  svg.onmouseout = function(e){
    /* 同一节点内部（图形↔文字）移动不重置高亮，避免闪烁 */
    if (e.relatedTarget && svg.contains(e.relatedTarget) && nodeOf(e.relatedTarget) === nodeOf(e.target)) return;
    if (gtip) gtip.style.opacity = 0;
    graphHover(null);
  };

  /* 单击：统一进右侧详情，不再跳转 tab */
  svg.onclick = function(e){
    var el = e.target;
    while (el && el !== svg && !(el.classList && el.classList.contains("g-node"))) el = el.parentNode;
    if (!el || el === svg || !el.classList){   /* 空白 / 边 → 清除选中 */
      closeRel();
      return;
    }
    var kind = el.getAttribute("data-kind"), id = el.getAttribute("data-id");
    /* P1-4 聚合节点交互：点击展开 / 收起折叠的二跳节点（graphSelect 展示详情前处理） */
    if (kind === "dim" && el.getAttribute("data-agg") === "1"){
      var an = g.nodeMap[id];
      var cname = an && an._aggCoreName;
      if (cname != null && typeof cname !== "undefined"){
        if (state._hop2Expand[cname]) delete state._hop2Expand[cname];
        else state._hop2Expand[cname] = true;
        graphSelect(id);
        graphRefresh();
        return;
      }
    }
    graphSelect(id);
    if (kind === "dim") openDimDetail(g.nodeMap[id], g);
    else if (kind === "ns") openNSDetail(g.nodeMap[id], g);
    else openPaperDetail(nodeToPaper(g.nodeMap[id]), g);
  };

  /* HUD 控件（每次渲染重建，用内联 onclick） */
  var hud = document.getElementById("gHud");
  if (hud){
    hud.innerHTML = graphHudHtml(false);
  }
  /* 容器尺寸变化（窗口缩放、右侧详情面板开合）自动重新适配内容 */
  if (window.ResizeObserver){
    G._ro = new ResizeObserver(function(){ if (GRAPH === G) graphFitView(); });
    try{ G._ro.observe(wrap); }catch(_e){}
  }
  /* 筛选 / 搜索命中：初次渲染即把命中文献作为高亮核心集 */
  if (G.focusIds && G.focusIds.length) graphPaint(G.focusIds, null);
}

/* hover 临时高亮（无选中时） */
function graphHover(id){
  var G = GRAPH; if (!G || !G.svg || G.selId) return;
  if (G._hv === id) return;
  G._hv = id;
  graphPaint(id ? [String(id)] : (G.focusIds || null), null);
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
    /* P0-01：维度视图同样触发图谱高亮 —— 综合图用本体节点 nid，维度图用文献小节点 "p"+id */
    var focusIds = null;
    if (hasFocus && list.length){
      focusIds = [];
      list.forEach(function(p){
        if (isAll){ if (p.nid) focusIds.push(p.nid); }
        else focusIds.push("p" + p.id);
      });
    }
    var markup = (function(){
      /* 聚焦子图模式：维度视图 + 筛选命中时对图就地做径向三层布局与层级标记 */
      focusDimLayout(g);
      return graphMarkup(g);
    })();
    var lg = graphLegend(g, hasFocus);
    var legendFold = legendCollapsed() || (isSmallGraph() && !state._legendForced);
    area.innerHTML = '<div class="graphbox"><div id="graphWrap">'
      + '<div id="gHost">'+markup+'</div>'
      + '<div class="ghud" id="gHud"></div>'
      + '<div class="legend'+(legendFold?' collapsed':'')+'" id="gLegend">'
        + '<div class="lg-head"><span>图例</span>'
        + '<button class="legend-toggle" id="lgToggle" title="折叠 / 展开图例">⌄</button></div>'
        + '<div class="lg-body">'+lg+'</div>'
      + '</div>'
      + '</div></div>';
    var lgt = document.getElementById("lgToggle");
    if (lgt) lgt.addEventListener("click", function(e){ e.stopPropagation(); toggleLegend(); });
    document.getElementById("viewHint").textContent = isAll
      ? ("共 "+PAPERS.length+" 篇 · 全量图谱 "+(RAW.ok ? ((RAW.stats.nodes||0)+" 节点 / "+(RAW.stats.edges||0)+" 边") : "（示例数据）"))
      : ("共 "+list.length+" 篇" + (RAW.ok?"（真实图谱）":"（示例）"));
    bindGraph(g, focusIds);
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
  if (GRAPH) graphSelect(null);
}
function relHead(color, label, title, sub, acts){
  /* acts：快捷操作区块 HTML，置顶渲染（关闭按钮之下、节点基础信息之上） */
  return '<div class="ui-head" style="margin-bottom:8px">'
    + '<button class="ui-ico-btn ui-back" title="返回" onclick="relBack()"><svg viewBox="0 0 24 24"><path d="M14 6l-6 6 6 6"/></svg></button>'
    + '<button class="ui-ico-btn" title="关闭" onclick="closeRel()"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
    + '</div>'
    + (acts || '')
    + '<div style="margin-bottom:8px"><span class="rel-badge" style="background:'+(color||"#f3f1fe")+'22;color:#3f3d52">'
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

/* 快捷操作区块：统一置顶渲染（关闭按钮之下、节点基础信息之上） */
function rdActsTop(inner){
  return '<div class="rel-sec" style="margin-top:0">快捷操作</div>' + (inner || '');
}
function rdActsPaper(p){
  var pid = esc(String(p.id));
  var s = '<div class="kv"><i>进入阅读</i><b class="act" style="cursor:pointer" onclick="openReaderPaper(\''+pid+'\')">去阅读 →</b></div>'
    + '<div class="kv"><i>在管理中打开</i><b class="act" style="cursor:pointer" onclick="openInManager(\''+pid+'\')">去编辑 →</b></div>'
    + '<div class="kv"><i>查看所有关联文献</i><b class="act" style="cursor:pointer" onclick="showPaperRelatedAll(\''+pid+'\')">查看 →</b></div>'
    + '<div class="kv"><i>查看引用文献</i><b class="act" style="cursor:pointer" onclick="showPaperCited(\''+pid+'\')">查看 →</b></div>';
  if (RAW.ok) s += '<div class="kv"><i>在访达中显示</i><b class="act" style="cursor:pointer" onclick="state.sel=findP(\''+pid+'\');revealFile()">显示 →</b></div>';
  return rdActsTop(s);
}
function rdActsNS(n){
  var s = '<div class="kv"><i>在管理中打开</i><b class="act" style="cursor:pointer" onclick="openInManagerNid(\''
    + esc(String(n.id))+'\',\''+esc(n.nsType||"")+'\')">去编辑 →</b></div>'
    + '<div class="kv"><i>查看所有关联文献</i><b class="act" style="cursor:pointer" onclick="showNSRelatedPapers(\''
    + esc(String(n.id))+'\')">查看 →</b></div>';
  return rdActsTop(s);
}
function rdActsDim(n){
  return rdActsTop('<div class="kv"><i>只高亮该维度下的文献</i><b class="act" style="cursor:pointer" onclick="graphSelect(\''
    + esc(String(n.id))+'\')">高亮 →</b></div>');
}

/* P2-03：文献快捷入口 —— 查看全部关联文献（图谱一跳邻居中的 Paper + 同目录/同关键词） */
function showPaperRelatedAll(pId){
  var p = findP(pId); if (!p) return;
  var r = document.getElementById("relPanel");
  var seen = {}, list = [];
  if (GRAPH && GRAPH.adj && p.nid != null && GRAPH.adj[String(p.nid)]){
    (GRAPH.adj[String(p.nid)]||[]).forEach(function(x){
      var nn = GRAPH.g.nodeMap[x.id]; if (!nn) return;
      var tp = nn.nsType || nn.type;
      if (tp === "Paper" && !seen[nn.id]){ seen[nn.id] = 1; list.push({title: nn.name || "", year: nn.year || "", gid: nn.id}); }
    });
  }
  PAPERS.forEach(function(x){
    if (x.id === p.id || seen["p"+x.id]) return;
    if (x.dir === p.dir || x.kw.some(function(k){ return p.kw.indexOf(k) >= 0; })){
      seen["p"+x.id] = 1;
      list.push({title: x.title, year: x.year || "", gid: x.nid ? "p"+x.id : ""});
    }
  });
  var h = relHead("#8b7cf6", "关联文献", short(p.title, 40), "共 "+list.length+" 篇", "");
  if (!list.length){ h += '<div class="rel-sec">无关联文献</div>'; }
  list.slice(0, 50).forEach(function(x){
    h += '<div class="kv"><i style="cursor:pointer" onclick="' + (x.gid ? "selectInGraph('"+esc(x.gid)+"')" : "") + '">'+esc(short(x.title, 30))+'</i><b>'+esc(x.year)+'</b></div>';
  });
  r.innerHTML = h;
  r.classList.add("open"); relOpen();
}
/* P2-03：查看引用文献（图谱中与该文献存在 cites 边的 Paper 节点） */
function showPaperCited(pId){
  var p = findP(pId); if (!p) return;
  var r = document.getElementById("relPanel");
  var list = [];
  if (GRAPH && GRAPH.adj && p.nid != null && GRAPH.adj[String(p.nid)]){
    (GRAPH.adj[String(p.nid)]||[]).forEach(function(x){
      var nn = GRAPH.g.nodeMap[x.id];
      if (x.etype === "cites" && nn && (nn.nsType === "Paper" || nn.type === "paper")){
        list.push({id: x.id, title: nn.name || "", year: nn.year || ""});
      }
    });
  }
  var h = relHead("#8b7cf6", "引用文献", short(p.title, 40), "共 "+list.length+" 篇", "");
  if (!list.length){ h += '<div class="rel-sec">暂无引用关系（该文献在图谱中无 cites 边）</div>'; }
  list.slice(0, 50).forEach(function(x){
    h += '<div class="kv"><i style="cursor:pointer" onclick="selectInGraph(\''+esc(x.id)+'\')">'+esc(short(x.title, 30))+'</i><b>'+esc(x.year)+'</b></div>';
  });
  r.innerHTML = h;
  r.classList.add("open"); relOpen();
}
/* P2-03：本体节点快捷入口 —— 查看该节点关联的全部文献 */
function showNSRelatedPapers(nId){
  var n = GRAPH && GRAPH.g && GRAPH.g.nodeMap[nId]; if (!n) return;
  var r = document.getElementById("relPanel");
  var list = [];
  (GRAPH.adj[nId]||[]).forEach(function(x){
    var nn = GRAPH.g.nodeMap[x.id];
    if (nn && (nn.nsType === "Paper" || nn.type === "paper")){
      list.push({id: x.id, title: nn.name || "", year: nn.year || ""});
    }
  });
  var h = relHead(NS_COLOR[n.nsType]||"#868e96", "关联文献", n.name, "共 "+list.length+" 篇", "");
  if (!list.length){ h += '<div class="rel-sec">无关联文献</div>'; }
  list.slice(0, 50).forEach(function(x){
    h += '<div class="kv"><i style="cursor:pointer" onclick="selectInGraph(\''+esc(x.id)+'\')">'+esc(short(x.title, 30))+'</i><b>'+esc(x.year)+'</b></div>';
  });
  r.innerHTML = h;
  r.classList.add("open"); relOpen();
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
  var h = relHead("#8b7cf6", "文献 Paper", short(p.title,46),
    (p.authors.join(", ")||"未标注作者")+" · "+(p.year||"—")+" · "+(p.journal||"—")+" · "+(p.org||""), rdActsPaper(p));
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
  var h = relHead(col, NS_LABEL[n.nsType]||n.nsType, n.name, "本体节点 · "+(n.nsType||"")+" · 关联 "+deg+" 条边", rdActsNS(n));

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
      var c = (nn.nsType === "Paper") ? "#8b7cf6" : (NS_COLOR[nn.nsType] || "#868e96");
      (byType[et] = byType[et] || []).push({id:x.id, name:nn.name, color:c});
    });
    Object.keys(byType).forEach(function(t){ h += relAdjGroup("关联 · "+t, byType[t]); });
  }
  r.innerHTML = h;
  r.classList.add("open"); relOpen();
}

/* 维度值详情（聚团图大节点） */
function openDimDetail(n, g){
  if (!n) return;
  var r = document.getElementById("relPanel");
  var d = (g && g.dim) ? g.dim : {key:"dim", name:"维度"};
  var h = relHead("#748ffc", "维度值 · " + d.name, n.name, "关联 "+(n.papers||[]).length+" 篇文献", rdActsDim(n));
  h += '<div class="rel-sec">关联文献（'+(n.papers||[]).length+'）</div>';
  (n.papers||[]).slice(0, 20).forEach(function(pn){
    var p = pn.paper || findP(pn.id);
    if (!p) return;
    h += '<div class="kv"><i style="cursor:pointer" onclick="selectInGraph(\'p'+esc(String(p.id))+'\')">'+esc(short(p.title, 26))+'</i><b>'+esc(p.year||"—")+'</b></div>';
  });
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

/* ================= 管理：本体结构画布 ================= */
function ontoClassList(){
  var names = [];
  if (RAW.schema && RAW.schema.classes) names = Object.keys(RAW.schema.classes);
  if (!names.length) {
    var seen = {};
    RAW.nodes.forEach(function(n){ if (!seen[n.type]) { seen[n.type]=1; names.push(n.type); } });
  }
  if (!names.length) names = CLASS_ORDER.slice();
  names = names.filter(function(x){ return x; });
  names.sort(function(a,b){
    var ia = CLASS_ORDER.indexOf(a), ib = CLASS_ORDER.indexOf(b);
    if (ia<0) ia = 99; if (ib<0) ib = 99;
    return ia-ib || a.localeCompare(b);
  });
  return names;
}
function ontoObjProps(){
  var out = [];
  if (RAW.schema && RAW.schema.object_props){
    Object.keys(RAW.schema.object_props).forEach(function(k){
      var v = RAW.schema.object_props[k] || {};
      if (v.domain && v.range) out.push([v.domain, v.range, k]);
    });
  }
  FALLBACK_EDGES.forEach(function(e){
    if (!out.some(function(x){ return x[2]===e[2]; })) out.push(e);
  });
  return out;
}
function ontoPos(W,H,keys){
  var known = {
    LocalFile:{x:Math.round(W/2),y:Math.round(H*0.10)},
    Author:{x:Math.round(Math.max(94,W*0.16)),y:Math.round(H*0.27)},
    Venue:{x:Math.round(Math.min(W-94,W*0.84)),y:Math.round(H*0.27)},
    Paper:{x:Math.round(W/2),y:Math.round(H*0.50)},
    Organization:{x:Math.round(Math.max(94,W*0.16)),y:Math.round(H*0.74)},
    Keyword:{x:Math.round(Math.min(W-94,W*0.84)),y:Math.round(H*0.74)},
    DomainCategory:{x:Math.round(W/2),y:Math.round(H*0.90)}
  };
  var out = {}, extra = [];
  keys.forEach(function(k){ if (known[k]) out[k]=known[k]; else extra.push(k); });
  extra.forEach(function(k,i){
    var ang = 2*Math.PI*i/Math.max(extra.length,1);
    out[k] = {x:Math.round(W/2 + W*0.34*Math.cos(ang)), y:Math.round(H/2 + H*0.38*Math.sin(ang))};
  });
  return out;
}
/* ============ P1-3：类间拖拽连线（画布） ============ */
var ONTO_LINK = {moved:false, dragging:false};
/* 轻量提示条（不阻塞交互，用于拖拽连线等即时反馈） */
var _wbToastEl = null, _wbToastTimer = null;
function wbToast(msg){
  try{
    if (!_wbToastEl){
      _wbToastEl = document.createElement("div");
      _wbToastEl.id = "wbToast";
      _wbToastEl.style.cssText = "position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:9999;"
        + "background:rgba(28,26,45,.94);color:#fff;font-size:12.5px;line-height:1.5;padding:9px 15px;"
        + "border-radius:9px;max-width:72vw;box-shadow:0 6px 22px rgba(0,0,0,.22);pointer-events:none;"
        + "transition:opacity .2s;opacity:1";
      document.body.appendChild(_wbToastEl);
    }
    _wbToastEl.textContent = msg;
    _wbToastEl.style.opacity = "1";
    clearTimeout(_wbToastTimer);
    _wbToastTimer = setTimeout(function(){ if (_wbToastEl) _wbToastEl.style.opacity = "0"; }, 2800);
  }catch(e){}
}
function ontoNodeClassAt(x, y){
  var el = document.elementFromPoint(x, y);
  while (el){
    if (el.classList && el.classList.contains("o-node")) return el.getAttribute("data-k");
    el = el.parentNode;
  }
  return null;
}
function startOntoLink(src, ev){
  var svg = document.getElementById("ontoCanvas");
  if (!svg) return;
  var r = svg.getBoundingClientRect();
  var vb = svg.viewBox && svg.viewBox.baseVal;
  var sx = (r.width && vb && vb.width) ? (vb.width/r.width) : 1;
  var sy = (r.height && vb && vb.height) ? (vb.height/r.height) : 1;
  var p0 = {x:(ev.clientX-r.left)*sx, y:(ev.clientY-r.top)*sy};
  var line = document.createElementNS("http://www.w3.org/2000/svg","line");
  line.setAttribute("class","o-edge pend");
  line.setAttribute("x1",p0.x); line.setAttribute("y1",p0.y);
  line.setAttribute("x2",p0.x); line.setAttribute("y2",p0.y);
  svg.appendChild(line);
  document.body.classList.add("linking");
  ONTO_LINK.dragging = true;
  var moved = false;
  function onMove(e){
    var p = {x:(e.clientX-r.left)*sx, y:(e.clientY-r.top)*sy};
    if (Math.abs(p.x-p0.x) + Math.abs(p.y-p0.y) > 6) moved = true;
    line.setAttribute("x2",p.x); line.setAttribute("y2",p.y);
  }
  function onUp(e){
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("linking");
    ONTO_LINK.dragging = false;
    ONTO_LINK.moved = moved;
    try{ svg.removeChild(line); }catch(_){}
    if (!moved) return;                 /* 未产生位移 → 视为单击，交回 click 选中逻辑 */
    var dst = ontoNodeClassAt(e.clientX, e.clientY);
    if (dst) ontoLinkClasses(src, dst);
    else wbToast("连线已取消：请把线拖到另一个类节点上");
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
/* 连线落点 → 生成待提交的对象属性（domain=起点类，range=终点类；属性名默认由类标签生成） */
function ontoLinkClasses(src, dst){
  if (src === dst){ wbToast("不能把类连到自身，请拖到另一个类节点"); return; }
  var s = schData();
  if (!s){ wbToast("本体结构尚未就绪（后端未连接）"); return; }
  var guess = "has" + String(dst).replace(/[^A-Za-z0-9]/g, "");
  if (!/^[A-Za-z]/.test(guess)) guess = "rel" + guess;
  MGT.askInput("新建类间对象关系", "域：" + schemaLabel(src) + "（" + src + "）<br>值域：" + schemaLabel(dst) + "（" + dst + "）<br><br>请确认属性名（英文，字母开头，仅含字母/数字/下划线）：", guess, function(name){
    if (name === null || name === undefined) return;
    name = String(name).trim();
    if (!name){ return; }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)){ wbToast("属性名不合法：须字母开头，仅含字母/数字/下划线"); return; }
    var dup = (s.object_props && s.object_props[name]) || (s.data_props && s.data_props[name]);
    if (dup){ wbToast("属性 " + name + " 已存在，请换一个属性名"); return; }
    SCH.changes.push({operation:"add_obj_prop", name:name, label:name, domain:src, range:dst});
    saveSchDraft();
    wbToast("已加入待提交：对象关系 " + name + "（" + src + " → " + dst + "），画布上显示为虚线，需点「提交」/「发布草稿」才生效");
    renderSchemaModal();
    renderOntoCanvas();
  });
}

function renderOntoCanvas(){
  var svg = document.getElementById("ontoCanvas");
  if (!svg) return;
  var rect = svg.getBoundingClientRect();
  var W = Math.max(420, Math.round(rect.width)||1000);
  var H = Math.max(380, Math.round(rect.height)||600);
  svg.setAttribute("viewBox","0 0 "+W+" "+H);
  var keys = ontoClassList();
  var POS = ontoPos(W,H,keys);
  var h = "";
  var edgeSeen = {};
  /* P1-3：边渲染统一入口；pend=true 表示「待提交」的拖拽连线预览（虚线） */
  function pushEdge(a, b, key, pend, sig){
    if (!a || !b) return;
    edgeSeen[sig] = 1;
    var mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
    h += '<line class="o-edge'+(pend?' pend':'')+'" x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'"/>';
    h += '<text class="o-edge-label" x="'+mx+'" y="'+(my-6)+'" text-anchor="middle">'+esc(key)+(pend?'（待提交）':'')+'</text>';
  }
  ontoObjProps().forEach(function(e){
    pushEdge(POS[e[0]], POS[e[1]], e[2], false, e[0]+"|"+e[1]+"|"+e[2]);
  });
  /* P1-3：拖拽连线尚未提交的对象关系，以虚线边预览 */
  (SCH.changes||[]).forEach(function(c){
    if (c.operation !== "add_obj_prop") return;
    var sig = (c.domain||"")+"|"+(c.range||"")+"|"+(c.name||"");
    if (edgeSeen[sig]) return;
    pushEdge(POS[c.domain], POS[c.range], c.name, true, sig);
  });
  var S = Math.max(1, Math.min(1.45, Math.min(W/1000, H/700)));
  var bw = Math.round(116*S), bh = Math.round(48*S), rr = Math.round(12*S), cr = Math.round(9*S);
  keys.forEach(function(k){
    var p = POS[k]; if (!p) return;
    var cnt = nodesOfType(k).length;
    var color = NS_COLOR[k] || "#495057";
    var sel = k===state.ontoClass ? " sel" : "";
    h += '<g class="o-node'+sel+'" data-k="'+esc(k)+'">'
      + '<rect x="'+(p.x-bw/2)+'" y="'+(p.y-bh/2)+'" width="'+bw+'" height="'+bh+'" rx="'+rr+'" fill="#fff" stroke="'+color+'" stroke-width="2"/>'
      + '<circle cx="'+(p.x-bw/2+14*S)+'" cy="'+(p.y-bh/2)+'" r="'+cr+'" fill="'+color+'" opacity=".9"/>'
      + '<text x="'+(p.x-bw/2+28*S)+'" y="'+(p.y-bh/2+6*S)+'" style="font-size:'+(11*S)+'px">'+esc(schemaLabel(k))+'</text>'
      + '<text class="cnt" x="'+(p.x-bw/2+28*S)+'" y="'+(p.y-bh/2+23*S)+'" style="font-size:'+(10.5*S)+'px">'+cnt+' 实例</text>'
      + '</g>';
  });
  svg.innerHTML = h;
  svg.querySelectorAll(".o-node").forEach(function(n){
    var k = n.getAttribute("data-k");
    n.addEventListener("click", function(){
      /* P1-3：若刚完成一次拖拽连线，则不改变选中态 */
      if (ONTO_LINK.moved){ ONTO_LINK.moved = false; return; }
      state.ontoClass = k;
      state.ontoInst = null; state.edit = null;
      renderOntoCanvas(); renderOntoPanel();
    });
    /* P1-3：按住类节点拖到另一个类节点 → 生成待提交对象属性（domain/range 自动预填） */
    n.addEventListener("mousedown", function(ev){
      if (ev.button !== 0) return;
      if (ev.preventDefault) ev.preventDefault();
      startOntoLink(k, ev);
    });
  });
  var st = document.getElementById("ontoStats");
  if (st){
    if (RAW.ok){
      var mg = RAW.manage || {};
      st.innerHTML = '<span>节点 <b>'+(RAW.stats.nodes||0)+'</b></span><span>边 <b>'+(RAW.stats.edges||0)+'</b></span>'
        + '<span>版本记录 <b>'+((mg.versions)||0)+'</b></span><span>更新 <b>'+esc(((RAW.stats.meta||{}).updated||(RAW.stats.meta||{}).created||"—"))+'</b></span>'
        + '<span>命名空间 <b>'+esc(NS_PREFIX)+'</b></span>';
    } else {
      st.innerHTML = '<span>后端未连接 · 无可读写数据</span>';
    }
  }
}
var _rz = null;
window.addEventListener("resize", function(){
  clearTimeout(_rz);
  _rz = setTimeout(function(){ if (state.tab==="onto") renderOntoCanvas(); }, 160);
});

/* ================= 管理：实例列表 + 编辑器 ================= */
function instListOf(cls){
  var q = (document.getElementById("instSearch").value||"").toLowerCase();
  return nodesOfType(cls).filter(function(n){
    if (!q) return true;
    return nodeLabel(n).toLowerCase().indexOf(q)>=0 || String(n.id).toLowerCase().indexOf(q)>=0;
  });
}
function renderOntoPanel(){
  var cls = state.ontoClass;
  document.getElementById("ontoTitle").textContent = schemaLabel(cls)+" 实例（"+nodesOfType(cls).length+"）";
  document.getElementById("ontoSub").textContent = "本体类 "+cls+" · 点击实例进入编辑 · 保存将经过一致性校验并记录版本";
  var list = document.getElementById("instList");
  var items = instListOf(cls);
  if (!items.length){
    list.innerHTML = '<div style="font-size:12.5px;color:var(--muted);padding:14px 0;text-align:center">'
      + (RAW.ok ? '该类暂无实例' + (cls==="DomainCategory" ? '（当前数据未实例化研究方向类，检索页的「研究方向」维度由 autoResearchArea 派生）' : '') : '后端未连接') + '</div>';
  } else {
    var h = "";
    items.forEach(function(n){
      var p = n.properties||{};
      var low = cls==="Paper" && p.confidence!==undefined && parseFloat(p.confidence)<0.7;
      h += '<div class="inst-item'+(state.ontoInst===n.id?" sel":"")+'" data-nid="'+esc(SID[n.id])+'"><span class="nm">'+esc(nodeLabel(n))+'</span>'+(low?'<span class="flag">⚠ 低置信度</span>':"")+'</div>';
    });
    list.innerHTML = h;
    list.querySelectorAll(".inst-item").forEach(function(it){
      it.addEventListener("click", function(){
        state.ontoInst = NID[it.getAttribute("data-nid")];
        state.edit = null;
        renderOntoPanel();
      });
    });
  }
  renderOntoEditor();
}

var SHACL_REQUIRED = {Paper:["title","year"], Author:["name"], Venue:["name"], Keyword:["name"], Organization:["name"]};

function renderOntoEditor(){
  var area = document.getElementById("editorArea");
  if (!RAW.ok){ area.innerHTML = '<div style="font-size:12.5px;color:var(--muted);padding:20px 0;text-align:center">后端未连接，无法读写本体实例。<br>启动桌面端（Electron 会自动拉起 Python 后端）后重试。</div>'; return; }
  if (!state.ontoInst){
    area.innerHTML = '<div style="font-size:12.5px;color:var(--muted);padding:20px 0;text-align:center">点击上方实例查看详情与编辑</div>';
    return;
  }
  var node = RAW.byId[state.ontoInst];
  if (!node){ area.innerHTML = '<div style="font-size:12.5px;color:var(--danger);padding:20px 0;text-align:center">实例已不存在（可能已被其他提交删除）</div>'; return; }

  var cls = node.type, props = node.properties || {};
  var spec = fieldSpecFor(cls);
  var required = SHACL_REQUIRED[cls] || [];
  var outE = RAW.outIdx[node.id] || [], inE = RAW.inIdx[node.id] || [];
  var groups = groupEdges(outE, node.id).concat(groupEdges(inE, node.id));

  var h = '<div class="detail-card"><div class="ui-head"><button class="ui-ico-btn ui-back" title="返回实例列表" onclick="ontoInstBack()"><svg viewBox="0 0 24 24"><path d="M14 6l-6 6 6 6"/></svg></button><span class="ui-title">实例详情</span></div><div class="dc-head"><span class="dc-title">实例标识</span><span class="dc-tag">'+esc(cls)+'</span></div>'
    + '<div class="dc-row"><span class="k">实体 ID</span><span class="v">'+esc(node.id)+'</span></div>'
    + '<div class="dc-row"><span class="k">出边 / 入边</span><span class="v">'+outE.length+' / '+inE.length+'</span></div>'
    + ((cls==="Paper" && props.file) ? '<div class="dc-row"><span class="k">阅读</span><span class="v"><button class="mini-btn primary" data-read-file="'+esc(props.file)+'" data-read-title="'+esc(props.title||"")+'">进入阅读</button></span></div>' : "")
    + '</div>';

  h += '<div class="detail-card"><div class="dc-head"><span class="dc-title">数据属性（可编辑）</span><span class="dc-tag">'+esc(cls)+'</span></div>';
  spec.forEach(function(f){
    var k = f[0], label = f[1], kind = f[2];
    var val = props[k]===undefined ? "" : props[k];
    var req = required.indexOf(k)>=0 ? '<span class="req">*</span>' : "";
    h += '<div class="form-row"><label>'+esc(label)+req+'</label>';
    if (kind==="textarea") h += '<textarea id="f_'+k+'" rows="3">'+esc(val)+'</textarea>';
    else h += '<input id="f_'+k+'" value="'+esc(val)+'">';
    h += '</div>';
  });
  /* 其余属性（只读展示，避免误改 prov 元数据） */
  var others = Object.keys(props).filter(function(k){ return !spec.some(function(f){return f[0]===k;}) && k.indexOf("prov:")<0; });
  if (others.length){
    h += '<div class="dc-row" style="border-top:1px solid var(--line);padding-top:8px"><span class="k">其他属性</span><span class="v">'+others.map(function(k){return esc(k)+"="+esc(short(props[k],40));}).join("；")+'</span></div>';
  }
  h += '</div>';

  /* 对象关系 */
  h += '<div class="detail-card"><div class="dc-head"><span class="dc-title">对象关系</span><span class="dc-tag">'+esc(cls)+'</span></div>';
  if (outE.length||inE.length){
    groups.forEach(function(g){
      h += '<div class="rel-line" data-group="'+esc(g.dir)+"|"+esc(g.type)+"|"+esc(g.other)+'">'
        + '<span class="rel-name">'+esc(g.type)+' '+(g.dir==="out"?"↗":"↘")+'</span>'
        + '<span class="rel-obj">'+esc(labelOfId(g.other))+(g.ids.length>1?' <span style="color:#adb5bd">×'+g.ids.length+' 条重复</span>':"")+'</span>'
        + '<button class="del" data-type="'+esc(g.type)+'" data-edges="'+esc(g.ids.join(","))+'">×</button></div>';
    });
  } else {
    h += '<div class="dc-row"><span class="v" style="color:#adb5bd">暂无对象关系</span></div>';
  }
  h += '<div class="add-rel"><select id="addRelType">'+ontoObjProps().map(function(e){return '<option value="'+esc(e[2])+'">'+esc(e[2])+'（'+esc(e[0])+'→'+esc(e[1])+'）</option>'}).join("")+'</select>'
    + '<select id="addRelTarget">'+instanceOptions(node.id)+'</select>'
    + '<button id="btnAddRel">+ 添加</button></div>';
  h += '</div>';

  /* 溯源 */
  var prov = Object.keys(props).filter(function(k){ return k.indexOf("prov:")===0 || k==="createdBy" || k==="sourcedFrom"; });
  if (prov.length){
    h += '<div class="detail-card"><div class="dc-head"><span class="dc-title">数据溯源</span><span class="dc-tag">prov</span></div>'
      + prov.map(function(k){ return '<div class="dc-row"><span class="k">'+esc(k.replace("prov:",""))+'</span><span class="v">'+esc(short(props[k],90))+'</span></div>'; }).join("")
      + '</div>';
  }

  h += '<div id="diffBox"></div>'
    + '<div class="form-row" style="margin-top:12px"><label>提交说明</label><input id="f_desc" placeholder="例如：修正标题 / 补充作者"></div>'
    + '<div class="act-row"><button class="btn-ghost" id="btnRollbackEdit">放弃改动</button><button class="btn-primary" id="btnCommit">提交修改</button></div>'
    + '<div id="commitResult"></div>'
    + '<div class="act-row"><button class="btn-ghost" id="btnDeleteInst" style="color:var(--danger)">删除该实例</button></div>';
  area.innerHTML = h;

  /* 编辑监听 → diff 预览 */
  function collect(){
    var out = {};
    spec.forEach(function(f){
      var el = document.getElementById("f_"+f[0]);
      if (el) out[f[0]] = el.value;
    });
    return out;
  }
  function currentDiff(){
    var nv = collect(), diffs = [];
    spec.forEach(function(f){
      var k = f[0];
      var ov = props[k]===undefined ? "" : String(props[k]);
      var v = nv[k]===undefined ? "" : String(nv[k]);
      if (ov!==v) diffs.push({k:f[1], old:ov, new:v});
    });
    return diffs;
  }
  function renderDiff(){
    var diffs = currentDiff();
    var box = document.getElementById("diffBox");
    if (!diffs.length){
      box.className = "diffbox hidden"; box.innerHTML = ""; return false;
    }
    var h2 = '<h5>改动预览（字段 '+diffs.length+' 处）</h5>';
    diffs.forEach(function(d){
      h2 += '<div class="diff-line"><span class="k">'+esc(d.k)+'</span><span class="old">'+esc(short(d.old,60))+'</span><span class="new">'+esc(short(d.new,60))+'</span></div>';
    });
    box.className = "diffbox"; box.innerHTML = h2;
    return true;
  }
  spec.forEach(function(f){
    var el = document.getElementById("f_"+f[0]);
    if (el) el.addEventListener("input", renderDiff);
  });
  area.querySelectorAll(".del[data-edges]").forEach(function(b){
    b.addEventListener("click", function(){
      var type = b.getAttribute("data-type"), ids = (b.getAttribute("data-edges")||"").split(",").filter(function(x){return x;});
      if (!ids.length) return;
      var edgeId = ids[0];
      var g = b.parentNode;
      MGT.askConfirm("删除对象关系", "确定删除该条 <b>"+esc(type)+"</b> 关系？<br>（通过关系接口立即生效，可回滚）", function(){
        var btn0 = g.querySelector(".del"); if (btn0){ btn0.disabled = true; btn0.textContent = "…"; }
        API.del("/api/relations/" + encodeURIComponent(type) + "/instances/" + encodeURIComponent(edgeId)).then(function(r){
          if (r && r.ok){
            wbToast("已删除关系，剩余 " + (r.total != null ? r.total : "?") + " 条");
            return reload(false).then(function(){
              state.ontoInst = node.id; state.edit = null;
              renderOntoCanvas(); renderOntoPanel(); renderFilters(); refreshArea(); renderAI("onto");
            });
          }
          wbToast("删除失败：" + ((r && r.reason) || "未知原因"));
          if (btn0){ btn0.disabled = false; btn0.textContent = "×"; }
        }).catch(function(e){
          wbToast("删除失败：" + e.message);
          if (btn0){ btn0.disabled = false; btn0.textContent = "×"; }
        });
      });
    });
  });
  document.getElementById("btnAddRel").addEventListener("click", async function(){
    var t = document.getElementById("addRelType").value;
    var tgt = document.getElementById("addRelTarget").value;
    if (!tgt){ wbToast("先选择目标实例"); return; }
    var btn = this; btn.disabled = true; btn.textContent = "添加中…";
    var res = await API.post("/api/relations/" + encodeURIComponent(t) + "/instances", {source_id: node.id, target_id: tgt});
    btn.disabled = false; btn.textContent = "+ 添加";
    if (res && res.ok){
      wbToast("已添加关系，剩余 " + (res.total != null ? res.total : "?") + " 条");
      await reload(false);
      state.ontoInst = node.id; state.edit = null;
      renderOntoCanvas(); renderOntoPanel(); renderFilters(); refreshArea(); renderAI("onto");
    } else {
      wbToast("添加失败：" + ((res && res.reason) || "未知原因"));
    }
  });
  document.getElementById("btnRollbackEdit").addEventListener("click", function(){
    state.edit = null; renderOntoPanel();
  });
  document.getElementById("btnCommit").addEventListener("click", async function(){
    var changes = [];
    var nv = collect();
    var upd = {};
    spec.forEach(function(f){
      var k = f[0];
      var ov = props[k]===undefined ? "" : String(props[k]);
      var v = nv[k]===undefined ? "" : String(nv[k]);
      if (ov!==v) upd[k] = v;
    });
    if (Object.keys(upd).length) changes.push({operation:"update", id:node.id, properties:upd});
    if (!changes.length){ wbToast("没有改动，无需保存"); return; }
    if (cls === "Paper"){
      var tEl = document.getElementById("f_title");
      if (!tEl || !tEl.value.trim()){ wbToast("文献类实例的 title 为必填，不能清空"); return; }
    }
    var desc = (document.getElementById("f_desc").value||"").trim() || ("编辑 " + cls + "：" + short(nodeLabel(node),30));
    var btn = this; btn.disabled = true; btn.textContent = "保存中…";
    var res = await API.post("/api/commit", {changes:changes, author:"web", description:desc});
    btn.disabled = false; btn.textContent = "保存修改";
    var box = document.getElementById("commitResult");
    if (res && res.ok){
      box.innerHTML = '<div class="commit-ok">✅ 已保存 · 版本 #'+esc(res.version||"")+'<br>'
        + '校验通过 · 已更新 '+esc(res.n_nodes||0)+' 个对象 / '+esc(res.n_edges||0)+' 条关系</div>';
      await reload(false);
      state.ontoInst = node.id; state.edit = null;
      renderOntoCanvas(); renderOntoPanel(); renderFilters(); refreshArea(); renderAI("onto");
    } else {
      var errs = (res && res.errors) || [];
      box.innerHTML = '<div class="commit-err">❌ 保存被拒（'+(res&&res.status||"error")+'）：'+esc((res&&res.reason)||"校验未通过")
        + (errs.length ? '<ul>'+errs.map(function(e){return '<li>'+esc(e)+'</li>'}).join("")+'</ul>' : '')
        + '<div style="margin-top:6px;font-size:11.5px">提示：文献类实例必须有 title、year（年份），且至少 1 条作者关系。</div></div>';
    }
  });
  document.getElementById("btnDeleteInst").addEventListener("click", function(){
    MGT.askConfirm("删除该实例", "确定删除 <b>"+esc(nodeLabel(node))+"</b>？<br>相关关系会一并移除，删除后可在版本记录中回滚。", function(){
      var btn = document.getElementById("btnDeleteInst"); if (btn){ btn.disabled = true; btn.textContent = "删除中…"; }
      API.post("/api/commit", {changes:[{operation:"delete_node", id:node.id}], author:"web", description:"删除实例 "+short(nodeLabel(node),30)}).then(function(res){
        if (btn){ btn.disabled = false; btn.textContent = "删除该实例"; }
        if (res && res.ok){
          wbToast("已删除实例 · 版本 #" + (res.version || ""));
          return reload(false).then(function(){
            state.ontoInst = null;
            renderOntoCanvas(); renderOntoPanel(); renderFilters(); refreshArea(); renderAI("onto");
          });
        }
        wbToast("删除失败：" + ((res && res.reason) || "未知原因"));
      });
    });
  });
  renderDiff();
}
function labelOfId(id){
  var n = RAW.byId[id];
  return n ? nodeLabel(n) : stripNS(id);
}
function instanceOptions(excludeId){
  var h = "";
  ontoClassList().forEach(function(cls){
    var items = nodesOfType(cls).filter(function(n){ return n.id!==excludeId; });
    if (!items.length) return;
    h += '<optgroup label="'+esc(schemaLabel(cls))+'">';
    items.slice(0,300).forEach(function(n){
      h += '<option value="'+esc(n.id)+'">'+esc(short(nodeLabel(n),34))+'</option>';
    });
    h += '</optgroup>';
  });
  return h;
}
var FIELD_SPEC = {
  Paper: [["title","标题","text"],["year","年份","text"],["venue","期刊/会议","text"],["doi","DOI","text"],
          ["paperType","文献类型","text"],["confidence","置信度","text"],["autoResearchArea","研究方向","text"],
          ["autoKeywords","自动关键词","text"],["aiSummary","AI 摘要","textarea"],["abstract","原文摘要","textarea"]],
  Author: [["name","姓名","text"],["affiliation","机构","text"],["researchArea","研究领域","textarea"]],
  Organization: [["name","名称","text"]],
  Venue: [["name","期刊/会议名","text"]],
  Keyword: [["name","关键词","text"]],
  LocalFile: [["file","文件名","text"],["filePath","文件路径","text"]],
  DomainCategory: [["name","研究方向","text"]]
};

/* 类 → 可编辑字段：基线 FIELD_SPEC + 扩展类的数据属性（domain 指向该类） */
function fieldSpecFor(cls){
  var out = (FIELD_SPEC[cls] || []).map(function(f){ return f.slice(); });
  var s = schData();
  var have = {};
  out.forEach(function(f){ have[f[0]] = 1; });
  if (s && s.data_props){
    Object.keys(s.data_props).forEach(function(k){
      var name = String(k).split("#").pop();
      var meta = s.data_props[k] || {};
      var dom = String(meta.domain || "").split("#").pop();
      if (dom !== cls || have[name]) return;
      out.push([name, meta.label || name, "text"]);
      have[name] = 1;
    });
  }
  return out;
}

/* P1-1：扩展类无 data_props 时的兜底字段规格。
   口径与 SHACL 对齐：先取该类已声明的必填属性（schema.shapes[cls].required / ext.required，
   对应扩展区 sh:minCount 1），再补 label / name 两个标识字段（id 由后端按 NS+类+name 自动生成），
   保证空扩展类也能建实例、可作关系端点。 */
function fallbackSpecFor(cls){
  var out = [], have = {}, req = [];
  var s = schData();
  if (s){
    var sh = (s.shapes || {})[cls];
    if (sh && sh.required) req = req.concat(sh.required);
    var extReq = (s.required || {})[cls];
    if (extReq) req = req.concat(extReq);
  }
  req.forEach(function(f){
    if (!have[f]){ have[f] = 1; out.push([f, f + "（必填）", "text"]); }
  });
  [["label", "名称 label（留空自动生成）"], ["name", "标识 name（留空自动生成，决定实例 id）"]].forEach(function(p){
    if (!have[p[0]]){ have[p[0]] = 1; out.push([p[0], p[1], "text"]); }
  });
  return out;
}

/* 新建实例弹窗用：真实字段优先；扩展类无任何数据属性时用兜底规格（isFallback=true） */
function newSpecFor(cls){
  var real = fieldSpecFor(cls);
  if (real.length) return {spec:real, fallback:false};
  /* 兜底规格本身不含真实 data_props，恒标记 fallback=true */
  return {spec:fallbackSpecFor(cls), fallback:true};
}

/* ================= 本体结构编辑（类 / 属性） ================= */
var SCH = { changes: [] };

function schData(){ return (RAW.schema && RAW.schema.ok) ? RAW.schema : null; }
function schemaLabel(k){
  var s = schData();
  var c = s && s.classes ? s.classes[k] : null;
  return (c && c.label) || NS_LABEL[k] || k;
}
function schClassNames(){ var s = schData(); return s ? Object.keys(s.classes||{}).sort() : CLASS_ORDER.slice(); }

function openSchemaModal(){
  document.getElementById("schemaModal").classList.add("open");
  /* P1-4：不再重置内存队列，改为从 localStorage（key 含工作区标识）恢复待提交项 */
  var d = loadSchDraft();
  SCH.changes = (d && d.changes) ? d.changes : [];
  renderSchemaModal();
  if (SCH.changes.length){
    schResult("已从本地草稿恢复 " + SCH.changes.length + " 项待提交变更（保存于 " + schStampText(d && d.saved_at) + "）", false);
  } else {
    schResult("", false);
  }
  schRefreshServerDraft();
}
/* P1-4：待提交变更持久化到 localStorage（key 含工作区标识 + 后端地址） */
function schWsKey(){
  var s = schData();
  var wk = (s && s.workspace_key) || "default";
  return "wb_sch_changes::" + wk + "::" + (API_BASE || "same-origin");
}
function schStampText(t){
  return String(t || "").replace("T", " ").slice(0, 19) || "—";
}
function saveSchDraft(){
  try{
    if (!SCH.changes.length){ localStorage.removeItem(schWsKey()); return; }
    localStorage.setItem(schWsKey(), JSON.stringify({saved_at:new Date().toISOString(), changes:SCH.changes}));
  }catch(e){}
}
function loadSchDraft(){
  try{
    var raw = localStorage.getItem(schWsKey());
    if (!raw) return null;
    var d = JSON.parse(raw);
    if (d && d.changes && d.changes.length) return d;
  }catch(e){}
  return null;
}
/* P0-3 + P1-4：关窗保护——保留（本地草稿）或明确放弃，不再静默丢弃 */
function closeSchemaModal(){
  if (SCH.changes.length){
    var n = SCH.changes.length;
    MGT.askConfirm("有 " + n + " 项未提交变更", "点「确认」= 保存为本地草稿并关闭（重开可继续）；点「取消」= 继续编辑。", function(){
      saveSchDraft();
      schResult("已保留 " + n + " 项待提交变更（本地草稿），重开弹窗可继续。", false);
      document.getElementById("schemaModal").classList.remove("open");
    });
    return;
  }
  document.getElementById("schemaModal").classList.remove("open");
}

/* 结构下拉候选：基线/已提交扩展类 + 待提交的新增类 − 待提交的删除类 */
function schClassNamesEff(){
  var set = {};
  schClassNames().forEach(function(n){ set[n] = 1; });
  SCH.changes.forEach(function(c){
    if (c.operation === "add_class") set[c.name] = 1;
    if (c.operation === "delete_class") delete set[c.name];
  });
  return Object.keys(set).sort();
}

function renderSchSelects(){
  var s = schData();
  if (!s) return;
  var domSel = document.getElementById("schPropDomain");
  var rngSel = document.getElementById("schPropRangeObj");
  var dPrev = domSel.value, rPrev = rngSel.value;
  var opts = schClassNamesEff().map(function(n){
    var lb = (s.classes[n]||{}).label;
    var pending = SCH.changes.some(function(c){ return c.operation==="add_class" && c.name===n; });
    return '<option value="'+esc(n)+'">'+esc(n)+(lb? " · "+esc(lb) : "")+(pending? " · 待提交" : "")+'</option>';
  }).join("");
  domSel.innerHTML = opts;
  rngSel.innerHTML = opts;
  if (dPrev) domSel.value = dPrev;
  if (rPrev) rngSel.value = rPrev;
  var dataSel = document.getElementById("schPropRangeData");
  if (!dataSel.options.length){
    dataSel.innerHTML = (s.xsd_types||["string","integer","decimal","boolean","date","gYear","anyURI"])
      .map(function(t){ return '<option value="'+esc(t)+'">'+esc(t)+'</option>'; }).join("");
  }
}

function renderSchemaModal(){
  var s = schData();
  if (!s){
    document.getElementById("schClasses").innerHTML = '<div class="sch-tip">本体结构未加载（后端未就绪或接口异常）</div>';
    document.getElementById("schDataProps").innerHTML = '<div class="sch-tip">暂时读不到结构</div>';
    document.getElementById("schObjProps").innerHTML = '<div class="sch-tip">暂时读不到结构</div>';
    return;
  }
  var counts = s.instance_counts || {};
  var h = "";
  Object.keys(s.classes||{}).sort().forEach(function(k){
    var c = s.classes[k] || {};
    var pendDel = SCH.changes.some(function(x){ return x.operation==="delete_class" && x.name===k; });
    h += '<div class="sch-row'+(pendDel? ' pending-del' : '')+'"><span class="k">'+esc(k)+'</span><span class="m">'
      + esc(c.label||"") + ' · 实例 ' + (counts[k]||0) + (c.ext? ' · 扩展' : ' · 基线') + '</span>'
      + (pendDel? '<span class="sch-badge-del">待删除</span>'
        : (c.ext? '<button class="mini-btn" onclick="schRename(\''+esc(k)+'\')">改标签</button>'
              + '<button class="mini-btn danger" onclick="schDel(\'class\',\''+esc(k)+'\')">删除</button>' : ''))
      + '</div>';
  });
  document.getElementById("schClasses").innerHTML = h || '<div class="sch-tip">暂无</div>';
  function rows(map){
    var o = "";
    Object.keys(map||{}).sort().forEach(function(k){
      var p = map[k] || {};
      var pendDel = SCH.changes.some(function(x){ return x.operation==="delete_prop" && x.name===k; });
      o += '<div class="sch-row'+(pendDel? ' pending-del' : '')+'"><span class="k">'+esc(k)+'</span><span class="m">'
        + esc(p.domain||"—") + ' → ' + esc(p.range||"—") + (p.ext? ' · 扩展' : ' · 基线') + '</span>'
        + (pendDel? '<span class="sch-badge-del">待删除</span>'
          : (p.ext? '<button class="mini-btn danger" onclick="schDel(\'prop\',\''+esc(k)+'\')">删除</button>' : ''))
        + '</div>';
    });
    return o || '<div class="sch-tip">暂无</div>';
  }
  document.getElementById("schDataProps").innerHTML = rows(s.data_props);
  document.getElementById("schObjProps").innerHTML = rows(s.object_props);
  renderSchSelects();
  schKindToggle();
  renderSchPending();
}

function schKindToggle(){
  var k = document.getElementById("schPropKind").value;
  var a = document.getElementById("schPropRangeData"), b = document.getElementById("schPropRangeObj");
  if (a) a.classList.toggle("hidden", k !== "data");
  if (b) b.classList.toggle("hidden", k !== "obj");
}

function schAddClass(){
  var name = (document.getElementById("schClsName").value||"").trim();
  var label = (document.getElementById("schClsLabel").value||"").trim();
  if (!name){ schResult("请填写类名（英文）", true); return; }
  SCH.changes.push({operation:"add_class", name:name, label:label||name});
  document.getElementById("schClsName").value = "";
  document.getElementById("schClsLabel").value = "";
  schResult("已加入待提交：新增类 "+name, false);
  renderSchPending();
  renderSchSelects();
  saveSchDraft();
}

function schAddProp(){
  var name = (document.getElementById("schPropName").value||"").trim();
  var label = (document.getElementById("schPropLabel").value||"").trim();
  var kind = document.getElementById("schPropKind").value;
  var dom = document.getElementById("schPropDomain").value;
  var rng = kind==="data" ? document.getElementById("schPropRangeData").value
                          : document.getElementById("schPropRangeObj").value;
  if (!name){ schResult("请填写属性名（英文）", true); return; }
  if (!dom){ schResult("缺少“从”类", true); return; }
  SCH.changes.push({operation: kind==="data" ? "add_data_prop" : "add_obj_prop",
                    name:name, label:label||name, domain:dom, range:rng});
  document.getElementById("schPropName").value = "";
  document.getElementById("schPropLabel").value = "";
  schResult("已加入待提交："+(kind==="data"?"数据属性 ":"对象关系 ")+name, false);
  renderSchPending();
  saveSchDraft();
}

function schRename(name){
  MGT.askInput("修改中文名", "新的中文名（留空则不改）：", "", function(lb){
    if (lb === null || lb === undefined) return;
    SCH.changes.push({operation:"update_class", name:name, label:String(lb).trim()});
    schResult("已加入待提交：修改 "+name+" 的中文名", false);
    renderSchPending();
    saveSchDraft();
  });
}

function schDel(kind, name){
  /* P0-5：点删除前先给出影响面预告，文案与后端 schema_delete_guard 保持一致 */
  var doDel = function(){
    SCH.changes.push(kind==="class" ? {operation:"delete_class", name:name}
                                    : {operation:"delete_prop", name:name});
    schResult("已加入待提交：删除 "+(kind==="class"?"类 ":"属性 ")+name+"（该行已标记「待删除」，需点上方「提交」或底部「提交结构修改」才生效）", false);
    renderSchemaModal();
    saveSchDraft();
  };
  if (kind === "class"){
    var s = schData();
    var nInst = (s && s.instance_counts && s.instance_counts[name]) || 0;
    var nRef = 0;
    if (s){
      ["object_props","data_props"].forEach(function(grp){
        Object.keys(s[grp]||{}).forEach(function(pk){
          var m = s[grp][pk] || {};
          var dom = String(m.domain||"").split("#").pop();
          var rng = String(m.range||"").split("#").pop();
          if (dom === name || rng === name) nRef += 1;
        });
      });
    }
    if (nInst > 0 || nRef > 0){
      var lines = ["删除类 " + name + " 前的影响面预告：", ""];
      if (nInst > 0) lines.push("· 类 " + name + " 下仍有 " + nInst + " 个实例，请先在管理页删除这些实例再删类");
      else lines.push("· 该类下没有实例");
      lines.push("· 被 " + nRef + " 处扩展属性引用（从 / 到 指向该类），删除类时这些扩展属性会一并删除");
      lines.push("");
      lines.push("确定将其加入待删除队列吗？（尚未提交，可在「待提交变更」点 × 撤销）");
      MGT.askConfirm("删除类 " + name + " 的影响面", lines.join("<br>"), doDel);
      return;
    }
  }
  doDel();
}
/* P0-2：待提交条「放弃」——清空全部待提交变更（尚未提交，不产生任何后端影响） */
function schDiscard(){
  if (!SCH.changes.length){ schResult("当前没有待提交的变更", true); return; }
  MGT.askConfirm("放弃待提交变更", "放弃全部 " + SCH.changes.length + " 项待提交变更？<br>这些变更尚未提交，放弃后不会生效。", function(){
    SCH.changes = [];
    saveSchDraft();
    renderSchemaModal();
    schResult("已放弃全部待提交变更（本地草稿已同步清空）", false);
  });
}

function schUndo(i){ SCH.changes.splice(i,1); saveSchDraft(); renderSchemaModal(); }

/* ============ P1-5：服务端草稿（/api/ontology/draft）——存草稿 / 继续 / 发布 ============ */
function schDraftBarText(txt, has){
  var bar = document.getElementById("schDraftBar");
  var t = document.getElementById("schDraftBarText");
  if (!bar || !t) return;
  bar.classList.toggle("has-pend", !!has);
  t.textContent = txt;
}
async function schRefreshServerDraft(){
  schDraftBarText("服务端草稿：读取中…", false);
  var res = await API.get("/api/ontology/draft");
  if (!res || res.ok === false){
    schDraftBarText("服务端草稿：接口不可用（" + ((res && res.reason) || "未知原因") + "）", false);
    return;
  }
  var d = res.draft;
  var n = (d && d.count) || 0;
  var lv = (res.versions && res.versions.length) || 0;
  schDraftBarText(n
    ? ("服务端草稿：" + n + " 项 · " + schStampText(d.saved_at) + "（版本记录 " + lv + " 个）")
    : ("服务端草稿：无（版本记录 " + lv + " 个）"), n > 0);
}
async function schSaveServerDraft(){
  if (!SCH.changes.length){ schResult("没有可存的服务端草稿内容（待提交 0 项）", true); return; }
  try{
    var res = await API.post("/api/ontology/draft", {changes:SCH.changes, author:"web", note:"manual save"});
    if (res && res.ok){
      schResult("已存为服务端草稿 · " + res.count + " 项 · " + schStampText(res.saved_at), false);
      schRefreshServerDraft();
    } else {
      schResult("存草稿失败：" + ((res && (res.reason || res.error)) || "未知错误"), true);
    }
  }catch(e){ schResult("存草稿失败：" + e.message, true); }
}
async function schLoadServerDraft(){
  try{
    var res = await API.get("/api/ontology/draft");
    var d = res && res.draft;
    if (!d || !(d.changes || []).length){ schResult("服务端暂无草稿可载入", true); return; }
    var sig = {};
    SCH.changes.forEach(function(c){ sig[(c.operation||"")+"|"+(c.name||"")] = 1; });
    var added = 0;
    d.changes.forEach(function(c){
      var k = (c.operation||"")+"|"+(c.name||"");
      if (!sig[k]){ SCH.changes.push(c); sig[k] = 1; added += 1; }
    });
    saveSchDraft();
    renderSchemaModal();
    schResult("已载入服务端草稿 " + added + " 项（去重后待提交 " + SCH.changes.length + " 项，点「提交」或「发布」生效）", false);
  }catch(e){ schResult("载入草稿失败：" + e.message, true); }
}
async function schPublishServerDraft(){
  var d = null;
  try{ d = await API.get("/api/ontology/draft"); }catch(e){}
  var n = (d && d.draft && d.draft.count) || 0;
  if (!n && !SCH.changes.length){ schResult("没有可发布的内容", true); return; }
  var pubMsg = "发布" + (n ? "（服务端草稿 " + n + " 项）" : "（将使用当前待提交 " + SCH.changes.length + " 项）")
    + "？<br>发布后结构修改将正式生效并记录新版本，可在版本记录中回滚。";
  MGT.askConfirm("发布结构修改", pubMsg, async function(){
    try{
      var res = await API.post("/api/ontology/draft/publish", {author:"web", changes:SCH.changes});
      if (res && res.ok){
        SCH.changes = [];
        saveSchDraft();
        renderSchPending();
        schResult("已发布 · 类 "+(res.classes||[]).length+" / 对象关系 "+(res.object_props||[]).length
          + " / 数据属性 "+(res.data_props||[]).length + (res.draft_cleared?" · 待发布草稿已归档":"") + "（版本已记录，可在版本记录中回滚）", false);
        await reload(false);
        renderSchemaModal();
        schRefreshServerDraft();
      } else {
        schResult("发布失败：" + (((res && res.errors) || []).join("；") || (res && res.reason) || "未知错误"), true);
        schRefreshServerDraft();
      }
    }catch(e){ schResult("发布失败：" + e.message, true); }
  });
}

function renderSchPending(){
  var box = document.getElementById("schPending");
  document.getElementById("schPendCount").textContent = SCH.changes.length;
  /* P0-2：顶部固定条同步待提交数量与状态 */
  var bar = document.getElementById("schPendBar");
  if (bar){
    bar.classList.toggle("has-pend", SCH.changes.length > 0);
    var bt = document.getElementById("schPendBarText");
    if (bt) bt.textContent = SCH.changes.length
      ? ("待提交 " + SCH.changes.length + " 项（点「提交」才生效）")
      : "待提交 0 项";
  }
  if (!SCH.changes.length){
    box.innerHTML = '<div class="sch-tip">暂无。新增 / 删除项会显示在这里，点 × 可撤销。</div>';
    return;
  }
  var names = {add_class:"新增类", update_class:"改中文名", delete_class:"删除类",
               add_data_prop:"新增数据属性", add_obj_prop:"新增对象关系", delete_prop:"删除属性"};
  box.innerHTML = SCH.changes.map(function(c,i){
    var extra = c.range ? "（"+esc(c.domain||"")+" → "+esc(c.range)+"）" : (c.label? "（"+esc(c.label)+"）" : "");
    return '<div class="pend"><span class="t">'+(names[c.operation]||c.operation)+'：'+esc(c.name)+extra
      + '</span><span class="pend-x" onclick="schUndo('+i+')">×</span></div>';
  }).join("");
}

function schResult(msg, isErr){
  var box = document.getElementById("schResult");
  if (!msg){ box.innerHTML = ""; return; }
  box.innerHTML = '<div class="'+(isErr?"commit-err":"commit-ok")+'">'+esc(msg)+'</div>';
}

async function schCommit(){
  if (!SCH.changes.length){ schResult("没有待提交的变更", true); return; }
  var btn = document.getElementById("btnSchemaCommit");
  btn.disabled = true; btn.textContent = "提交中…";
  try {
    var res = await API.post("/api/ontology/schema", {changes:SCH.changes, author:"web"});
    if (res && res.ok){
      SCH.changes = [];
      saveSchDraft();
      renderSchPending();
      schResult("结构已提交 · 类 "+(res.classes||[]).length+" / 对象关系 "+(res.object_props||[]).length
        +" / 数据属性 "+(res.data_props||[]).length+" · 版本已记录", false);
      await reload(false);
      renderFilters(); refreshArea(); renderOntoCanvas(); renderOntoPanel(); renderAI("onto");
      renderSchemaModal();
    } else {
      var errs = (res && (res.errors||[])) || [];
      schResult("结构提交被拒绝：" + (errs.length? errs.join("；") : ((res&&res.reason)||"未知原因")), true);
    }
  } catch(e){
    schResult("提交失败：" + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "提交结构修改";
  }
}

/* ================= 版本 / 回滚 ================= */
async function openVerModal(){
  try {
  document.getElementById("verModal").classList.add("open");
  var box = document.getElementById("verList");
  box.innerHTML = '<div class="loading">读取中…</div>';
  var res = await API.get("/api/commit/versions");
  if (!res || !res.ok){ box.innerHTML = '<div class="commit-err">读取失败：'+esc((res&&res.reason)||"后端未就绪")+'</div>'; return; }
  var vs = res.versions || [];
  if (!vs.length){ box.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:16px 0">暂无版本</div>'; return; }
  var h = "";
  vs.slice(0,40).forEach(function(v){
    var key = v.version || String(v.file||"").split("_")[0];
    h += '<div class="ver-item"><span class="v">'+esc(v.version||"—")+'</span>'
      + '<span class="m">'+esc(v.taken_at||"")+' · '+esc(v.n_nodes||0)+' 节点 / '+esc(v.n_edges||0)+' 边<br>'+esc(String(v.sha||"").slice(0,20))+'…</span>'
      + '<button class="mini-btn" data-v="'+esc(key)+'">回滚到此版本</button></div>';
  });
  box.innerHTML = h;
  box.querySelectorAll("button[data-v]").forEach(function(b){
    b.addEventListener("click", function(){
      var v = b.getAttribute("data-v");
      MGT.askConfirm("回滚到该版本", "确定回滚到版本 " + v + "？<br>当前图谱将被该版本整体覆盖（回滚会生成新的版本记录，可再次回滚）。", async function(){
        b.disabled = true; b.textContent = "回滚中…";
        var res2 = await API.post("/api/commit/rollback", {version:v});
        if (res2 && res2.ok){
          await reload(false);
          renderOntoCanvas(); renderOntoPanel(); renderFilters(); refreshArea();
          wbToast("已回滚到版本 " + v + " · 当前 " + ((res2.n_nodes)||0) + " 个对象 / " + ((res2.n_edges)||0) + " 条关系");
          openVerModal();
        } else {
          b.disabled = false; b.textContent = "回滚到此版本";
          wbToast("回滚失败：" + ((res2&&res2.reason)||"未知原因"));
        }
      });
    });
  });
  } catch(e){ box.innerHTML = '<div class="commit-err">读取失败：'+ esc(String((e && e.message) || e)) + '。可按 ⌘R 刷新后重试。</div>'; }
}
function closeVerModal(){ document.getElementById("verModal").classList.remove("open"); }

/* ================= 新建实例 ================= */
function openNewModal(){
  var sel = document.getElementById("newType");
  sel.innerHTML = ontoClassList().map(function(k){ return '<option value="'+esc(k)+'">'+esc(schemaLabel(k)+"（"+k+"）")+'</option>'; }).join("");
  sel.value = ontoClassList().indexOf(state.ontoClass)>=0 ? state.ontoClass : ontoClassList()[0];
  renderNewFields();
  document.getElementById("newResult").innerHTML = "";
  document.getElementById("newModal").classList.add("open");
}
function closeNewModal(){ document.getElementById("newModal").classList.remove("open"); }
function renderNewFields(){
  var cls = document.getElementById("newType").value;
  var ns = newSpecFor(cls);
  var spec = ns.spec.slice(0, ns.fallback ? 6 : 4);
  document.getElementById("newFields").innerHTML = spec.map(function(f){
    var req = /（必填）/.test(f[1]) ? '<span class="req">*</span>' : "";
    return '<div class="form-row"><label>'+esc(f[1])+req+'</label><input id="n_'+f[0]+'"></div>';
  }).join("");
  var hint = document.getElementById("newHint");
  if (hint){
    hint.innerHTML = ns.fallback
      ? '该扩展类暂无数据属性：已提供兜底字段（label / name，留空则自动生成，实例 id 由后端按「命名空间 + 类 + name」生成）。可直接建实例，稍后在实例编辑器补属性。'
      : '';
  }
}
async function submitNew(){
  var cls = document.getElementById("newType").value;
  var ns = newSpecFor(cls);
  var spec = ns.spec.slice(0, ns.fallback ? 6 : 4);
  var props = {}, missing = [];
  spec.forEach(function(f){
    var el = document.getElementById("n_"+f[0]);
    var v = el ? String(el.value||"").trim() : "";
    if (v) props[f[0]] = v;
    else if (/（必填）/.test(f[1])) missing.push(f[0]);
  });
  /* P1-1：与 SHACL（扩展区 sh:minCount 1）同口径——必填缺失时需显式确认“仅建实例，稍后补属性” */
  if (missing.length){
    MGT.askConfirm("必填属性未填写", "以下必填属性尚未填写：" + missing.join("、")
      + "<br>点「确认」= 仅建实例，稍后补属性（可能被校验拒绝）；点「取消」= 返回补填。", function(){ createInstGo(); });
    return;
  } else if (!Object.keys(props).length){
    if (!ns.fallback){ wbToast("至少填写一个属性"); return; }
    MGT.askConfirm("按兜底规则创建", "尚未填写任何内容，将自动生成标识后创建实例：<br>· 标识 → 自动生成唯一名称<br>· 中文名 → 缺省为类标签<br><br>继续创建？", function(){ createInstGo(); });
    return;
  }
  var createInstGo = async function(){
  /* 兜底路径：label / name 留空时自动生成，保证实例可辨识、可作关系端点 */
  var stamp = String(Date.now()).slice(-6);
  if (ns.fallback){
    if (!props.name){ props.name = cls + "_" + stamp; }
    if (!props.label){ props.label = schemaLabel(cls) + "-" + stamp; }
  }
  /* P1-1：顶层 name 决定后端实例 id（NS + 类 + name，见 apply_commit）。
     缺省时按「类名 + 时间戳」兜底，避免同类型的多个界面新建实例共用同一个
     id（旧行为恒为 …:node）而互相覆盖，导致新实例实际上无法作为独立端点参与关系编辑。 */
  var instName = props.name || (cls + "_" + stamp);
  var res = await API.post("/api/commit", {changes:[{operation:"add_node", type:cls, name:instName, properties:props}], author:"web", description:"新建实例 "+cls});
  var box = document.getElementById("newResult");
  if (res && res.ok){
    box.innerHTML = '<div class="commit-ok">✅ 已新建 · 版本 #'+esc(res.version||"")+' · 当前 '+esc(res.n_nodes||0)+' 个对象 / '+esc(res.n_edges||0)+' 条关系'
      + (ns.fallback ? ' · 该实例已可作为关系端点' : '') + '</div>';
    await reload(false);
    state.ontoClass = cls;
    renderOntoCanvas(); renderOntoPanel(); renderFilters(); refreshArea();
  } else {
    var errs = (res && res.errors) || [];
    box.innerHTML = '<div class="commit-err">❌ 新建被拒：'+esc((res&&res.reason)||"校验未通过")
      + (errs.length ? '<ul>'+errs.map(function(e){return '<li>'+esc(e)+'</li>'}).join("")+'</ul>' : '') + '</div>';
  }
  };
}

/* ================= 导航 / AI ================= */
document.querySelectorAll(".tab").forEach(function(b){
  b.addEventListener("click", function(){
    document.querySelectorAll(".tab").forEach(function(x){ x.classList.remove("active"); });
    b.classList.add("active");
    switchTab(b.getAttribute("data-tab"));
  });
});
/* ===== Another 品牌化：统一返回导航 ===== */
function uiBackToLib(){
  var b = document.querySelector('.tab[data-tab="lib"]');
  if (b){
    document.querySelectorAll(".tab").forEach(function(x){ x.classList.remove("active"); });
    b.classList.add("active");
  }
  switchTab("lib");
}
function relBack(){ closeRel(); if (typeof graphSelect === "function") graphSelect(null); }
function ontoInstBack(){ state.ontoInst = null; state.edit = null; renderOntoEditor(); }
/* ===== 三板块会话常驻保留（切换板块/页面不丢，仅点「新建」清空） ===== */
var AI_HIST = { lib: { msgs: "", gap: "" }, onto: { msgs: "", gap: "" } };
var _aiObs = null, _aiObsCtx = "";
function aiHistRec(ctx){
  if (!AI_HIST[ctx]) AI_HIST[ctx] = { msgs: "", gap: "" };
  return AI_HIST[ctx];
}
/* 流式过程中同步写回会话记录：切走时正在生成的回答，切回后仍可见 */
function aiSaveMsgs(ctx, box){
  if (!ctx) return;
  var b = box || document.getElementById("aiMsgs");
  if (b) aiHistRec(ctx).msgs = b.innerHTML;
}
function aiSnapshotCur(){
  var ctx = state.tab === "onto" ? "onto" : (state.tab === "lib" ? "lib" : "");
  if (ctx){
    var rec = aiHistRec(ctx), box = document.getElementById("aiMsgs"), gap = document.getElementById("aiGapBox");
    if (box) rec.msgs = box.innerHTML;
    if (gap) rec.gap = gap.innerHTML;
  }
  if (_aiObs){ _aiObs.disconnect(); _aiObs = null; }
  _aiObsCtx = "";
}
function aiRestoreHist(ctx, scope){
  var rec = aiHistRec(ctx), box = document.getElementById("aiMsgs"), gap = document.getElementById("aiGapBox");
  if (box && rec.msgs){ box.innerHTML = rec.msgs; box.scrollTop = box.scrollHeight; }
  if (gap && rec.gap){ gap.innerHTML = rec.gap; }
  var root = scope || document.getElementById("aiBody");
  if (!root || typeof MutationObserver === "undefined") return;
  _aiObsCtx = ctx;
  _aiObs = new MutationObserver(function(){
    if (_aiObsCtx !== ctx) return;
    var b = document.getElementById("aiMsgs"), g = document.getElementById("aiGapBox");
    if (b) rec.msgs = b.innerHTML;
    if (g) rec.gap = g.innerHTML;
  });
  _aiObs.observe(root, { childList: true, subtree: true, characterData: true });
}
function switchTab(t){
  aiSnapshotCur();
  state.tab = t;
  document.getElementById("content").classList.toggle("reading", t==="read");
  document.getElementById("view-lib").classList.toggle("hidden", t!=="lib");
  document.getElementById("view-read").classList.toggle("hidden", t!=="read");
  document.getElementById("view-onto").classList.toggle("hidden", t!=="onto");
  closeRel();
  if (t==="lib"){ renderCtrlBar(); refreshArea(); renderAI("lib"); }
  else if (t==="read"){ renderAI("read"); rdPickerAutoRestore(); }
  else { renderOntoCanvas(); renderOntoPanel(); renderAI("onto"); }
}
/* ===== 面板头：新建对话 / 模型设置（三板块统一） ===== */
function aiNewChat(){
  if (state.tab === "onto" || state.tab === "lib"){
    var m = document.getElementById("aiMsgs"); if (m) m.innerHTML = "";
    var g = document.getElementById("aiGapBox"); if (g) g.innerHTML = "";
    var rec = aiHistRec(state.tab); rec.msgs = ""; rec.gap = "";
  }
  if (state.tab === "read"){
    if (typeof rdNewChat === "function") rdNewChat();
    else if (typeof rdClearChat === "function") rdClearChat();
  }
  aiToast("已开始新对话");
}
/* 三板块统一的模型设置弹窗：复用既有模型面板实现（经后端 /api/llm/* 读写配置） */
function openModelPanel(){
  if (typeof rdOpenModelPanel === "function"){ rdOpenModelPanel(); return; }
  aiToast("模型设置暂不可用，请确认后端已启动");
}
function aiModelBtn(){ openModelPanel(); }
function aiToast(t){ if (typeof rdToast === "function") return rdToast(t); if (typeof wbToast === "function") return wbToast(t); }
function toggleAI(){ var p = document.getElementById("aiPanel"); if (!p) return; p.classList.toggle("on"); aiPeekSync(); }
function aiPeekSync(){ var p = document.getElementById("aiPanel"); var k = document.getElementById("aiPeek"); if (k) k.classList.toggle("show", !(p && p.classList.contains("on"))); }
var AI_TITLES = { lib: "AI 查询", read: "AI 精读", onto: "AI 本体工程" };
function aiSetTitle(ctx){
  var el = document.getElementById("aiTitle");
  if (el) el.textContent = AI_TITLES[ctx] || "AI";
}
function renderAI(ctx){
  aiSetTitle(ctx);
  var b = document.getElementById("aiBody");
  b.classList.remove("rd");
  if (ctx==="read"){ renderAIRead(b); return; }
  aiRenderNewPanel(ctx);
}
/* ===== 重设计：极简面板（默认仅底部悬浮输入框 + 占位符） ===== */
var AI_DIMSEL = { lib: [] };
function aiNewShell(ctx){
  var ph = ctx === "onto" ? "描述你要修改的本体..." : "描述你的研究问题...";
  var h = '<div class="ai-msgs" id="aiMsgs"></div>';
  h += '<div class="ai-input-wrap">';
  if (ctx === "lib") h += '<div class="ai-dim-sel" id="aiDimSel"></div>';
  h += '<div class="ai-read-ad' + (ctx === "onto" ? " no-btns" : "") + '" id="aiReadAd">'
     +   '<span class="ad-text" id="aiAdText"></span>'
     +   '<span class="ad-btns">'
     +     '<button class="ad-btn" data-ad="ask" title="带入输入框">🔍</button>'
     +     '<button class="ad-btn" data-ad="tr" title="翻译">🌐</button>'
     +     '<button class="ad-btn" data-ad="an" title="批注">✏️</button>'
     +   '</span>'
     + '</div>'
     +   '<div class="ai-cx-ind" id="aiCxInd" title="关联上下文"><span class="cx-ico">▤</span><span class="cx-text" id="aiCxText"></span></div>'
     +   '<div class="ai-input-box">'
     +     '<input id="aiInput" autocomplete="off" placeholder="' + ph + '">'
     +     '<button class="ib-btn new" id="aiNewChatBtn" title="新建">＋</button>'
     +     '<button class="ib-btn model" id="aiModelBtnBtn" title="模型">⚙</button>'
     +   '</div>'
     + '</div>';
  return h;
}
function aiRenderNewPanel(ctx){
  var b = document.getElementById("aiBody");
  if (!b) return;
  b.classList.add("ai-new");
  b.innerHTML = aiNewShell(ctx);
  aiBindPanel(ctx);
  aiRestoreHist(ctx, b);
  aiRenderCx(ctx);
  aiRenderDimSel(ctx);
}
function aiBindPanel(ctx){
  var inp = document.getElementById("aiInput");
  if (inp && !inp._wired){
    inp._wired = 1;
    inp.addEventListener("keydown", function(e){
      if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); aiHandleSend(); }
    });
  }
  var nb = document.getElementById("aiNewChatBtn");
  if (nb && !nb._wired){ nb._wired = 1; nb.addEventListener("click", function(){ aiNewChat(); }); }
  var mb = document.getElementById("aiModelBtnBtn");
  if (mb && !mb._wired){ mb._wired = 1; mb.addEventListener("click", function(){ aiModelBtn(); }); }
  var cx = document.getElementById("aiCxInd");
  if (cx && !cx._wired){
    cx._wired = 1;
    cx.addEventListener("click", function(){
      cx.classList.toggle("open");
      var sel = document.getElementById("aiDimSel");
      if (sel) sel.classList.toggle("show", cx.classList.contains("open"));
    });
  }
  var ad = document.getElementById("aiReadAd");
  if (ad){
    ad.querySelectorAll(".ad-btn").forEach(function(btn){
      if (btn._wired) return; btn._wired = 1;
      btn.addEventListener("click", function(){ aiAdAction(btn.getAttribute("data-ad")); });
    });
  }
}
function aiDimNames(){
  try {
    var dims = aiRealDims();
    return (dims || []).map(function(d){ return d.name || d.key || String(d); }).filter(Boolean);
  } catch (e){ return []; }
}
function aiRenderDimSel(ctx){
  ctx = ctx || (state.tab === "onto" ? "onto" : "lib");
  var box = document.getElementById("aiDimSel");
  if (!box) return;
  var names = aiDimNames();
  var h = "";
  names.forEach(function(nm){
    var on = AI_DIMSEL.lib.indexOf(nm) >= 0 ? " class=\"on\"" : "";
    h += '<button data-dim="' + esc(nm) + '"' + on + '>' + esc(nm) + '</button>';
  });
  box.innerHTML = h;
  box.querySelectorAll("button[data-dim]").forEach(function(el){
    el.addEventListener("click", function(){
      var d = el.getAttribute("data-dim");
      var i = AI_DIMSEL.lib.indexOf(d);
      if (i >= 0) AI_DIMSEL.lib.splice(i, 1); else AI_DIMSEL.lib.push(d);
      el.classList.toggle("on");
      aiRenderCx("lib");
    });
  });
}
function aiOntoSelName(){
  try {
    if (state.ontoInst && RAW.byId && RAW.byId[state.ontoInst]) return nodeLabel(RAW.byId[state.ontoInst]);
  } catch (e){}
  return "";
}
function aiRenderCx(ctx){
  ctx = ctx || (state.tab === "onto" ? "onto" : "lib");
  var txt = document.getElementById("aiCxText");
  if (!txt) return;
  var hint = document.getElementById("aiCxHint");
  if (ctx === "lib"){
    var kws = Object.keys(state.filters || {}).filter(function(k){ return state.filters[k]; });
    var parts = ["文献库 " + PAPERS.length + " 篇"];
    if (AI_DIMSEL.lib.length) parts.push("维度：" + AI_DIMSEL.lib.join("、"));
    if (kws.length) parts.push("关键词：" + kws.join("、"));
    txt.textContent = parts.join(" · ");
    if (hint) hint.textContent = AI_DIMSEL.lib.length ? ("维度 " + AI_DIMSEL.lib.length) : "";
  } else {
    var nm = aiOntoSelName();
    var insts = RAW.ok ? RAW.nodes.length : PAPERS.length;
    txt.textContent = "本体 " + ontoClassList().length + " 类 · " + insts + " 实例" + (nm ? (" · 选中节点：" + nm) : "");
    if (hint) hint.textContent = nm ? nm : "";
    var ad = document.getElementById("aiReadAd");
    var adt = document.getElementById("aiAdText");
    if (ad && adt){
      if (nm){ ad.classList.add("show"); adt.textContent = "当前节点：" + nm; }
      else ad.classList.remove("show");
    }
  }
}
function aiCtxPrefix(ctx){
  ctx = ctx || (state.tab === "onto" ? "onto" : "lib");
  if (ctx === "lib"){
    var kws = Object.keys(state.filters || {}).filter(function(k){ return state.filters[k]; });
    var s = "【当前上下文】文献库共 " + PAPERS.length + " 篇";
    if (AI_DIMSEL.lib.length) s += "；已选维度：" + AI_DIMSEL.lib.join("、");
    if (kws.length) s += "；已选关键词：" + kws.join("、");
    return s + "\n\n";
  }
  var nm = aiOntoSelName();
  return "【当前上下文】本体工程" + (nm ? ("；当前选中节点：" + nm) : "") + "\n\n";
}
function aiBubbleInto(box, role, text){
  if (!box) return null;
  var d = document.createElement("div");
  d.className = "ai-msg-bubble " + (role === "u" ? "u" : "a");
  d.innerHTML = esc(text).replace(/\n/g, "<br>");
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  return d;
}
function aiHandleSend(){
  var ctx = state.tab === "onto" ? "onto" : "lib";
  var inp = document.getElementById("aiInput");
  if (!inp) return;
  var q = (inp.value || "").trim();
  if (!q) return;
  inp.value = "";
  var box = document.getElementById("aiMsgs");
  aiBubbleInto(box, "u", q);
  var holder = document.createElement("div");
  holder.className = "ai-msg-bubble a";
  holder.innerHTML = "<b>思考中…</b>";
  box.appendChild(holder);
  box.scrollTop = box.scrollHeight;
  var acc = "";
  var onDelta = function(d){
    acc += d;
    holder.innerHTML = esc(acc).replace(/\n/g, "<br>");
    box.scrollTop = box.scrollHeight;
    aiSaveMsgs(ctx, box);
  };
  var msgs = [
    { role: "system", content: (ctx === "onto" ? (typeof aiOntoSys === "function" ? aiOntoSys() : "") : (typeof aiLibSys === "function" ? aiLibSys() : (typeof LIB_SYS !== "undefined" ? LIB_SYS : ""))) },
    { role: "user", content: aiCtxPrefix(ctx) + (ctx === "lib" ? aiLibContext() + "\n\n【问题】" : "【变更诉求】") + q }
  ];
  aiStream(msgs, onDelta).then(function(){
    if (!acc) holder.innerHTML = "（模型未返回内容，请检查模型连通性）";
    aiSaveMsgs(ctx, box);
  }).catch(function(e){
    holder.innerHTML = "<b>调用失败：</b>" + esc((e && e.message) || String(e));
    aiSaveMsgs(ctx, box);
  });
}
function aiAdAction(kind){
  var ad = document.getElementById("aiReadAd");
  var text = ad ? (ad.getAttribute("data-text") || "") : "";
  if (state.tab === "read"){
    if (kind === "ask"){
      var i = rdEl("rdInput");
      if (i){ i.value = "请解释这段选中文字：\n" + text; i.focus(); }
    } else if (kind === "tr"){
      var i2 = rdEl("rdInput");
      if (i2){ i2.value = "请将这段文字翻译为中文：\n" + text; if (typeof rdSendFromInput === "function") rdSendFromInput(); }
    } else if (kind === "an"){
      if (typeof rdAnnotOpen === "function") rdAnnotOpen(text, null);
    }
    return;
  }
  if (kind === "ask"){ var i3 = document.getElementById("aiInput"); if (i3 && text){ i3.value = text; i3.focus(); } }
}
/* ================= 三板块统一 AI 面板骨架 ================= */
function aiStat(t){ return '<div class="ai-status">'+t+'</div>'; }
function aiShell(p){
  var h = "";
  if (p.status) h += aiStat(p.status);
  if (p.insight) h += '<div class="ai-card insight"><div class="hd">'+p.insight.hd+'</div>'+p.insight.bd+'</div>';
  (p.cards||[]).forEach(function(c){
    h += '<div class="ai-card'+(c.fold?' fold open':'')+'">'
       + '<div class="hd">'+c.hd+(c.fold?'<span class="fold-ar">▾</span>':'')+'</div>'
       + '<div class="bd">'+c.bd+'</div></div>';
  });
  if (p.acts && p.acts.length){
    h += '<div class="ai-actions">';
    p.acts.forEach(function(a){ h += '<button class="ai-act" data-act="'+a.k+'">'+a.t+'</button>'; });
    h += '</div>';
  }
  return h;
}
/* 折叠卡展开 + 建议动作路由（事件委托，幂等） */
function aiWire(scope){
  var root = scope || document;
  root.querySelectorAll(".ai-card.fold .hd").forEach(function(el){
    if (el._wired) return; el._wired = 1;
    el.addEventListener("click", function(){ el.parentNode.classList.toggle("open"); });
  });
  root.querySelectorAll(".ai-act").forEach(function(el){
    if (el._wired) return; el._wired = 1;
    el.addEventListener("click", function(){
      var k = el.getAttribute("data-act");
      if (k === "lib"){ uiBackToLib(); }
      else if (k === "onto"){ switchTab("onto"); }
      else if (k === "read"){ aiOpenNewest(); }
      else if (k === "gap"){ aiGap(); }
      else if (k === "low"){ aiReviewLow(); }
      else if (k === "compare"){ aiCompare(); }
    });
  });
}
/* 通用 SSE 流式（与 rdStreamChat 同协议；新板块统一用它） */
async function aiStream(messages, onDelta){
  if (typeof rdStreamChat === "function") return rdStreamChat(messages, onDelta);
  throw new Error("流式通道未就绪");
}
/* 在指定容器内追加一条流式 AI 消息，返回 {set} */
function aiStreamInto(box, prompt){
  var msg = document.createElement("div");
  msg.className = "ai-msg";
  msg.innerHTML = "<b>思考中…</b>";
  box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
  return {
    set: function(t){ msg.innerHTML = esc(t).replace(/\n/g, "<br>"); box.scrollTop = box.scrollHeight; },
    raw: msg
  };
}
/* 文献库上下文（供 AI 查询板块） */
function aiLibContext(){
  var ds = aiDimStats();
  var out = "【文献库】共 " + PAPERS.length + " 篇\n【研究方向分布】"
    + (ds.length ? ds.map(function(x){ return x.name + " " + x.n + " 篇"; }).join("；") : "暂无归类") + "\n【文献清单】\n";
  PAPERS.slice(0, 120).forEach(function(p, i){
    out += (i+1) + ". " + p.title + " | " + (p.year||"年份未知") + " | "
      + ((p.kw||[]).join("/")||"无关键词") + " | 维度:" + (p.dir||"未归类") + "\n";
  });
  return out;
}
function aiCard(hd,body,cls){ return '<div class="ai-card '+(cls||"")+'"><div class="hd">'+hd+'</div>'+body.replace(/\n/g,"<br>")+'</div>'; }
function aiAsk(){
  var ph = state.tab === "onto"
    ? "一句话描述要改的本体，例如：把 2024 年后的论文关联到 Keyword:AI"
    : "描述你的研究问题，我帮你找文献、找缺口…";
  return '<div class="ai-q"><input id="aiInput" placeholder="' + ph + '">'
       + '<button class="send" onclick="aiSend()">发送</button></div><div id="aiMsgs"></div>';
}
async function aiSend(){
  if (state.tab === "onto") return aiSendOnto();
  return aiSendLib();
}
async function aiSendLib(){
  var inp = document.getElementById("aiInput"); if (!inp) return;
  var q = inp.value.trim(); if (!q) return;
  var box = document.getElementById("aiMsgs"); if (!box) return;
  inp.value = "";
  var u = document.createElement("div"); u.className = "ai-msg u"; u.innerHTML = esc(q); box.appendChild(u);
  var msg = document.createElement("div"); msg.className = "ai-msg a"; msg.innerHTML = "<b>思考中…</b>"; box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
  var acc = "";
  try {
    await aiStream([
      { role: "system", content: LIB_SYS },
      { role: "user", content: aiLibContext() + "\n\n【问题】" + q }
    ], function(d){ acc += d; msg.innerHTML = esc(acc).replace(/\n/g, "<br>"); box.scrollTop = box.scrollHeight; aiSaveMsgs("lib", box); });
    if (!acc) msg.innerHTML = "（模型未返回内容，请检查模型连通性）";
  } catch (e){
    msg.innerHTML = "<b>调用失败：</b>" + esc((e && e.message) || String(e));
  }
  box.scrollTop = box.scrollHeight;
  aiSaveMsgs("lib", box);
}
async function aiGap(){
  var q = "请基于我的文献库，分析当前最明显的 3 个研究缺口，并各给一条可执行的补全建议。";
  var box = document.getElementById("aiGapBox");
  if (box){
    box.innerHTML = '<div class="ai-msg a"><b>分析中…</b></div>';
    var acc = "";
    try {
      await aiStream([
        { role: "system", content: LIB_SYS },
        { role: "user", content: aiLibContext() + "\n\n【问题】" + q }
      ], function(d){ acc += d; box.innerHTML = '<div class="ai-msg a">' + esc(acc).replace(/\n/g, "<br>") + '</div>'; aiHistRec("lib").gap = box.innerHTML; });
      if (!acc) box.innerHTML = '<div class="ai-msg a">（模型未返回内容）</div>';
    } catch (e){ box.innerHTML = '<div class="ai-msg a"><b>调用失败：</b>' + esc((e && e.message) || String(e)) + '</div>'; }
    return;
  }
  var main = document.getElementById("aiMsgs");
  if (main){
    var inp = document.getElementById("aiInput");
    if (inp){ inp.value = q; }
    aiSendLib();
  }
}
function aiOpenNewest(){
  if (!PAPERS.length) return;
  var ys = PAPERS.slice().sort(function(a,b){ return (parseInt(b.year,10)||0) - (parseInt(a.year,10)||0); });
  var p = ys[0];
  if (p && p.file && p.id != null && typeof openReaderPaper === "function"){ openReaderPaper(p.id); return; }
  if (p && p.file && typeof openReader === "function"){
    var node = (RAW.byId && p.nid) ? RAW.byId[p.nid] : null;
    openReader({ name: p.file, title: p.title, pid: p.id, nid: p.nid, node: node, from: "lib" });
    return;
  }
  switchTab("read");
}
/* ---------- 检索板块：统计辅助 + 库上下文系统提示 ---------- */
function aiYearSpan(){
  var ys = PAPERS.map(function(p){ return parseInt(p.year, 10) || 0; }).filter(function(y){ return y > 0; });
  if (!ys.length) return "年份未知";
  return "年份 " + Math.min.apply(null, ys) + "–" + Math.max.apply(null, ys);
}
/* 统计口径：只认真实维度（剔除 synthetic「综合」项，它不是文献的真实归类） */
function aiRealDims(){
  return (DIMS || []).filter(function(d){ return !!d && !d.synthetic && !!d.get; });
}
/* 主题分布/库洞察统一口径：聚焦「研究方向」维度 */
function aiDirDim(){
  var ds = aiRealDims();
  return ds.filter(function(d){ return d.key === "dir"; })[0]
      || ds.filter(function(d){ return d.cls === "autoResearchArea" || /研究方向/.test(String(d.name||"")); })[0]
      || null;
}
function aiDirStats(){
  var d = aiDirDim(); if (!d) return [];
  return (CACHE[d.key] || []).map(function(x){
    return { name: String(x && x.v == null ? "" : (x && x.v)) || "未归类", n: (x && x.n) || 0 };
  }).sort(function(a, b){ return b.n - a.n; });
}
function aiDimStats(){ return aiDirStats(); }
function aiDimBars(){
  var st = aiDimStats();
  if (!st.length) return "暂无可用的「研究方向」归类数据，建议先在精读板块补充归类。";
  var mx = Math.max.apply(null, st.map(function(x){ return x.n; })) || 1;
  var h = "";
  st.forEach(function(x){
    h += '<div class="ai-row"><span>' + esc(x.name) + '</span><span class="v">' + x.n + ' 篇</span></div>'
       + '<div class="ai-bar"><i style="width:' + Math.round(x.n / mx * 100) + '%"></i></div>';
  });
  return h;
}
function aiLibInsight(){
  var d = aiDirDim();
  if (!PAPERS.length) return "文献库为空，建议先上传 PDF。";
  if (!d) return "未识别到「研究方向」维度，无法给出方向覆盖洞察。";
  var st = aiDimStats();
  if (!st.length) return "文献库中暂无「研究方向」归类，建议先补全归类以获得方向级洞察。";
  var lowConf = PAPERS.filter(function(p){ return p.conf && p.conf < 0.7; }).length;
  var top = st[0];
  var out = "在「研究方向」维度上，你的库以「" + esc(top.name) + "」覆盖最广（" + top.n + " 篇）";
  if (st.length > 1){
    var tail = st[st.length - 1];
    out += "；「" + esc(tail.name) + "」最薄，仅 " + tail.n + " 篇，是潜在缺口。";
  } else {
    out += "。";
  }
  return out + (lowConf ? "<br>另有 <b>" + lowConf + "</b> 篇归类置信度 &lt; 0.7，建议复核。" : "");
}
var LIB_SYS = "你是研究选题助手。严格基于用户提供的文献库清单作答：先给结论，再分点展开；"
  + "指出研究缺口时须说明依据（哪些维度薄、哪些关键词缺失）；不得编造清单外的文献、作者或数据；"
  + "清单不足以回答时，直接说明缺少哪些信息。";
/* ---------- 管理板块：本体健康度 / 待办 ---------- */
function aiOntoHealth(){
  if (!RAW.ok) return "后端未连接，展示内置示例，健康度暂不可评。";
  var low = PAPERS.filter(function(p){ return p.conf && p.conf < 0.7; }).length;
  var iso = 0;
  (RAW.nodes || []).forEach(function(n){
    var has = (RAW.outIdx && RAW.outIdx[n.id]) || (RAW.inIdx && RAW.inIdx[n.id]);
    if (!has || !has.length) iso++;
  });
  var score = Math.max(40, 100 - low * 3 - iso * 2);
  var tail = score >= 90 ? "结构完整，可继续扩充实例。" : (score >= 75 ? "整体可用，存在少量待复核项。" : "结构性缺口较多，建议先补全关系与复核低置信度。");
  return '<div class="ai-score">' + score + '<small>/100</small></div>'
       + tail + "<br>低置信度 <b>" + low + "</b> 篇 · 孤立实例 <b>" + iso + "</b> 个。";
}
function aiOntoTodo(){
  if (!RAW.ok) return "后端未连接。";
  var low = PAPERS.filter(function(p){ return p.conf && p.conf < 0.7; });
  var iso = [];
  (RAW.nodes || []).forEach(function(n){
    var has = (RAW.outIdx && RAW.outIdx[n.id]) || (RAW.inIdx && RAW.inIdx[n.id]);
    if (!has || !has.length) iso.push(n);
  });
  var h = "";
  h += '<div class="ai-todo"><span>低置信度文献待复核</span><span class="v">' + low.length + ' 篇</span></div>';
  h += '<div class="ai-todo"><span>孤立实例（无任何关系）</span><span class="v">' + iso.length + ' 个</span></div>';
  return h;
}
function aiReviewLow(){
  var low = PAPERS.filter(function(p){ return p.conf && p.conf < 0.7; });
  if (!low.length){ aiToast("没有低置信度文献"); return; }
  var box = document.getElementById("aiMsgs");
  if (!box) return;
  var h = '<div class="ai-msg a"><b>置信度 &lt; 0.7 的文献（' + low.length + ' 篇）：</b><br>'
    + low.slice(0, 20).map(function(p){
        return "· " + esc(short(p.title, 40)) + "（" + (p.conf || 0) + "）";
      }).join("<br>") + "</div>";
  box.innerHTML = h;
}
/* ---------- 管理板块：自然语言 → 本体变更草案 ---------- */
function aiOntoSys(){
  var cls = ontoClassList().join(" / ");
  var props = ontoObjProps().map(function(x){ return x[0] + "-" + x[2] + "->" + x[1]; }).join("；");
  return "你是本体工程师。把用户的自然语言需求翻译为 JSON 变更指令，只输出一个 JSON 对象，不要任何解释文字。"
    + '格式：{"description":"一句话说明","changes":[{"operation":"add_node","type":"Paper","name":"...","properties":{...}}]}。'
    + "可用类：" + cls + "。可用对象关系：" + props + "。"
    + "可用 operation：add_node（需 type/name/properties）、update（需 id/properties）、"
    + "add_edge（需 source_id/target_id/type）、delete_edge（需 id）、delete_node（需 id）。"
    + "id 形如 ns:Paper:slug。无法确定时输出 {\"description\":\"无法解析\",\"changes\":[]}。";
}
function aiExtractJson(t){
  if (!t) return null;
  var m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  var raw = m ? m[1] : t;
  var a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch (e) { return null; }
}
async function aiSendOnto(){
  var inp = document.getElementById("aiInput"); if (!inp) return;
  var q = inp.value.trim(); if (!q) return;
  var box = document.getElementById("aiMsgs"); if (!box) return;
  inp.value = "";
  var u = document.createElement("div"); u.className = "ai-msg u"; u.innerHTML = esc(q); box.appendChild(u);
  var msg = document.createElement("div"); msg.className = "ai-msg a"; msg.innerHTML = "<b>生成变更草案…</b>"; box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
  var acc = "";
  try {
    await aiStream([
      { role: "system", content: aiOntoSys() },
      { role: "user", content: "当前图谱概览：节点 " + RAW.nodes.length + " 个，边 " + RAW.edges.length + " 个。\n【需求】" + q }
    ], function(d){ acc += d; msg.innerHTML = "<b>生成中…</b>"; aiSaveMsgs("onto", box); });
  } catch (e){
    msg.innerHTML = "<b>调用失败：</b>" + esc((e && e.message) || String(e));
    aiSaveMsgs("onto", box);
    return;
  }
  var plan = aiExtractJson(acc);
  if (!plan || !plan.changes || !plan.changes.length){
    msg.innerHTML = "<b>未能解析出变更指令。</b>请换个说法，例如「新建一个 Paper 实例，标题为 XXX」。";
    aiSaveMsgs("onto", box);
    return;
  }
  aiRenderPlan(msg, plan, q);
  aiSaveMsgs("onto", box);
}
/* 变更草案：改为内联 onclick + 全局草案表，保证会话还原后按钮仍可点击 */
var AI_PLANS = {}, _aiPlanSeq = 0;
function aiPlanNo(el){
  var msg = (el && el.closest) ? el.closest(".ai-msg") : null;
  if (msg) msg.innerHTML = "<b>已放弃该草案。</b>";
}
async function aiPlanOk(pid, el){
  var rec = AI_PLANS[pid]; if (!rec) return;
  var plan = rec.plan, q = rec.q, msg = (el && el.closest) ? el.closest(".ai-msg") : null;
  var danger = plan.changes.some(function(c){ return String(c.operation || "").indexOf("delete") === 0; });
  var doExec = async function(){
    el.textContent = "提交中…";
    try {
      var res = await API.post("/api/commit", { changes: plan.changes, author: "web", description: plan.description || q });
      if (res && res.ok){
        if (msg) msg.innerHTML += '<div class="ai-msg" style="margin-top:8px">已提交 · 版本 #' + esc(res.version || "") + ' · 对象 ' + esc(res.n_nodes || 0) + ' / 关系 ' + esc(res.n_edges || 0) + "</div>";
        if (typeof reload === "function") await reload(false);
        if (typeof renderOntoCanvas === "function") renderOntoCanvas();
        if (typeof renderOntoPanel === "function") renderOntoPanel();
      } else {
        var errs = (res && res.errors) || [];
        if (msg) msg.innerHTML += '<div class="ai-warn">提交被拒：' + esc((res && res.reason) || errs.join("；") || "未知原因") + "</div>";
      }
    } catch (e){
      if (msg) msg.innerHTML += '<div class="ai-warn">提交异常：' + esc((e && e.message) || String(e)) + "</div>";
    }
  };
  if (danger){
    MGT.askConfirm("草案包含删除操作", "确认执行该草案？<br>提交后可通过版本记录回滚。" + "<br><code>" + esc(JSON.stringify(plan.changes)) + "</code>", doExec);
    return;
  }
  doExec();
}
function aiRenderPlan(msg, plan, q){
  var danger = plan.changes.some(function(c){ return String(c.operation || "").indexOf("delete") === 0; });
  var pid = "pl" + (++_aiPlanSeq);
  AI_PLANS[pid] = { plan: plan, q: q };
  msg.innerHTML = "<b>" + esc(plan.description || "变更草案") + "</b>"
    + '<div class="ai-plan' + (danger ? " danger" : "") + '">' + esc(JSON.stringify(plan.changes, null, 2)) + "</div>"
    + (danger ? '<div class="ai-warn">注意：草案包含删除操作，提交后不可直接撤销（可通过版本回滚）。</div>' : "")
    + '<span class="ai-ev" onclick="aiPlanOk(\'' + pid + '\', this)">确认执行</span>'
    + '<span class="ai-ev" style="margin-left:6px" onclick="aiPlanNo(this)">放弃</span>';
}
/* ---------- 阅读板块：与库对照（建议动作入口） ---------- */
async function aiCompare(){
  switchTab("read");
  var inp = document.getElementById("rdInput");
  if (inp){ inp.value = "请结合本页内容，说明这篇文献与同类研究的关键差异。"; }
  if (typeof rdSendFromInput === "function") rdSendFromInput();
}

/* ================= 上传 ================= */
document.getElementById("btnUpload").addEventListener("click", openModal);
var _b1 = document.getElementById("aiNewChatBtn"); if (_b1) _b1.addEventListener("click", aiNewChat);
var _b2 = document.getElementById("aiModelBtnBtn"); if (_b2) _b2.addEventListener("click", aiModelBtn);
document.getElementById("dropZone").addEventListener("click", function(){
  var api = window.workbenchDesktop || {};
  if (api.pickAndUploadProgress || api.submitPdfs){ nativeUpload(); }
  else document.getElementById("fileInput").click();  /* 旧主进程壳：回退系统文件选择器，仍可逐文件实时进度 */
});
document.getElementById("fileInput").addEventListener("change", function(){
  var files = Array.prototype.slice.call(this.files||[]);
  if (files.length) startPipe(files);
  this.value = "";
});
document.getElementById("dropZone").addEventListener("dragover", function(e){
  e.preventDefault(); this.style.borderColor = "var(--accent)";
});
document.getElementById("dropZone").addEventListener("dragleave", function(){ this.style.borderColor = "#ddd6fe"; });
document.getElementById("dropZone").addEventListener("drop", function(e){
  e.preventDefault(); this.style.borderColor = "#ddd6fe";
  var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files)||[]).filter(function(f){ return /\.pdf$/i.test(f.name); });
  if (files.length) startPipe(files);
});
function openModal(){
  document.getElementById("modal").classList.add("open");
  if (UP.running || (UP.order.length && UP.order.some(function(k){ return UP.byKey[k].status === "done" || UP.byKey[k].status === "failed"; }) === false)){
    document.getElementById("uploadStep").classList.add("hidden");
    document.getElementById("pipeStep").classList.remove("hidden");
    upRender();
  }
  document.getElementById("uploadHint").textContent = (window.workbenchDesktop && window.workbenchDesktop.pickAndUploadProgress)
    ? "桌面端：提交后按文件逐条显示解析进度（排队 / 解析阶段 / 完成 / 失败），可最小化窗口等待。"
    : (window.workbenchDesktop && window.workbenchDesktop.pickAndUpload)
      ? "桌面端：点击上方区域将调用系统文件选择器，由主进程提交后端 /upload。"
      : "浏览器：点击上方区域选择 PDF，逐个异步提交 /upload 并实时显示每篇进度。";
}
function closeModal(){ document.getElementById("modal").classList.remove("open"); setTimeout(resetModal,300); }
function resetModal(){
  document.getElementById("uploadStep").classList.remove("hidden");
  document.getElementById("pipeStep").classList.add("hidden");
  document.getElementById("uploadResult").classList.add("hidden");
  var ul = document.getElementById("upList"); if (ul && !UP.running) ul.innerHTML = "";
  var t = document.getElementById("upTitle");
  if (t && !UP.running) t.textContent = "AI 解析治理中…";
  var m = document.getElementById("upMeta"); if (m && !UP.running) m.textContent = "";
}
/* ================= 逐文件解析进度引擎（v1.7） ================= */
/* 后端阶段 → 百分比（与 serve_workbench.py UPLOAD_STAGES 对齐） */
var UP_STAGE_PERCENT = [6, 14, 30, 72, 86, 96, 99, 100];
var UP_LLM_DURATION = 60;    /* AI 补全阶段预期耗时（秒），用于进度条平滑爬升 */
var UP_TICK_MS = 400;        /* 本地重绘间隔 */
var UP_POLL_MS = 1200;       /* 轮询后端间隔 */
var UP = {byKey:{}, order:[], byId:{}, poll:null, t0:0, running:false};

function upPrepare(files){
  UP.byKey = {}; UP.order = []; UP.byId = {}; UP.t0 = Date.now(); UP.running = true;
  var now = Date.now();
  files.forEach(function(f, i){
    var k = "f" + i;
    UP.byKey[k] = {key:k, file:(f && f.name) || ("文件 " + (i + 1)), file_id:"", status:"preparing",
                   status_text:"提交中…", stage:"receive", stage_name:"接收文件", stage_index:0,
                   percent:2, queue_position:0, elapsed:0, title:"", reason:"", detail:"",
                   result_status:"", stage_since:now};
    UP.order.push(k);
  });
  var t = document.getElementById("upTitle"); if (t) t.textContent = "AI 解析治理中…";
  upRender();
}
function upDisplayPercent(it){
  var p = it.percent || 0;
  if (it.status !== "parsing" && it.status !== "preparing") return p;
  var idx = it.stage_index || 0;
  var next = UP_STAGE_PERCENT[Math.min(idx + 1, UP_STAGE_PERCENT.length - 1)];
  var dur = (idx === 3) ? UP_LLM_DURATION : 6;
  var frac = Math.min(0.92, (Date.now() - (it.stage_since || Date.now())) / 1000 / dur);
  return Math.max(p, p + Math.max(0, next - p - 1) * frac);
}
function upItemHtml(it){
  var st = it.status;
  var cls = (st === "done") ? "done" : (st === "failed") ? "failed" : (st === "parsing") ? "parsing" : "queued";
  var badge = (st === "done") ? (it.status_text || "解析完成") : (st === "failed") ? "失败"
            : (st === "parsing") ? "解析中" : (st === "preparing") ? "提交中" : "排队中";
  var pct = Math.max(0, Math.min(100, Math.round(upDisplayPercent(it))));
  var secs = Math.max(0, Math.round(it.elapsed || ((Date.now() - UP.t0) / 1000)));
  var stageTxt;
  if (st === "done" && (it.llm_status === "pending" || it.llm_status === "running"))
    stageTxt = "已入库 · " + (it.llm_status_text || "AI 摘要后台补全中…") + (it.title ? ("｜" + it.title) : "");
  else if (st === "done" && it.llm_status === "done")
    stageTxt = "已入库 · AI 摘要已补全" + (it.title ? ("｜" + it.title) : "");
  else if (st === "done" && it.llm_status === "failed")
    stageTxt = "已入库 · AI 摘要补全失败（可在检索页手动重试）" + (it.title ? ("｜" + it.title) : "");
  else if (st === "done") stageTxt = it.title ? ("完成 · " + it.title) : (it.status_text || "解析完成");
  else if (st === "failed") stageTxt = "失败 · " + (it.reason || it.status_text || "未知原因");
  else if (st === "parsing") stageTxt = (it.stage_name || "解析中") + "…（阶段 " + ((it.stage_index || 0) + 1) + "/8）";
  else if (st === "preparing") stageTxt = "正在提交到后端…";
  else stageTxt = it.queue_position > 1 ? ("排队等待（前方 " + (it.queue_position - 1) + " 篇）") : "排队等待";
  return '<div class="up-item ' + cls + '">'
    + '<div class="up-line"><span class="up-name" title="' + esc(it.file) + '">' + esc(it.file) + '</span>'
    + '<span class="up-badge">' + esc(badge) + '</span><span class="up-time">' + secs + 's</span></div>'
    + '<div class="up-bar"><i style="width:' + pct + '%"></i></div>'
    + '<div class="up-stage" title="' + esc(stageTxt) + '">' + esc(stageTxt) + ' · ' + pct + '%</div></div>';
}
function upRender(){
  var box = document.getElementById("upList"); if (!box) return;
  var h = "", doneN = 0, failN = 0, parseN = 0, queueN = 0;
  UP.order.forEach(function(k){
    var it = UP.byKey[k]; if (!it) return;
    if (it.status === "done") doneN++;
    else if (it.status === "failed") failN++;
    else if (it.status === "queued") queueN++;
    else parseN++;
    h += upItemHtml(it);
  });
  box.innerHTML = h;
  var n = UP.order.length;
  var t = document.getElementById("upTitle");
  if (t) t.textContent = UP.running ? ("AI 解析治理中…（完成 " + doneN + "/" + n + "）")
                                    : ("解析结束 · 成功 " + doneN + " / 失败 " + failN);
  var m = document.getElementById("upMeta");
  if (m) m.textContent = "已用 " + Math.round((Date.now() - UP.t0) / 1000) + "s"
    + (parseN ? " · 解析中 " + parseN : "") + (queueN ? " · 排队 " + queueN : "")
    + " · 元数据约 2 秒入库，AI 摘要由后台自动补全";
}
function upApply(r){
  var k = UP.byId[r.file_id];
  if (k == null) return;
  var it = UP.byKey[k];
  if (!it) return;
  /* S3：done 之后仍需接收 AI 摘要后台补全状态（llm_status / llm_status_text） */
  if (it.status === "done" || it.status === "failed"){
    if (r.llm_status) it.llm_status = r.llm_status;
    if (r.llm_status_text) it.llm_status_text = r.llm_status_text;
    if (typeof r.llm_elapsed === "number") it.llm_elapsed = r.llm_elapsed;
    return;
  }
  var prevStage = it.stage_index || 0;
  it.status = r.status || it.status;
  it.status_text = r.status_text || it.status_text;
  if (typeof r.percent === "number") it.percent = r.percent;
  it.stage = r.stage || it.stage;
  it.stage_name = r.stage_name || it.stage_name;
  if (typeof r.stage_index === "number" && r.stage_index > prevStage){
    it.stage_index = r.stage_index;
    it.stage_since = Date.now();
  }
  it.queue_position = r.queue_position || 0;
  if (typeof r.elapsed === "number") it.elapsed = r.elapsed;
  if (r.title) it.title = r.title;
  if (r.reason) it.reason = r.reason;
  if (r.result_status) it.result_status = r.result_status;
  if (r.detail) it.detail = r.detail;
  if (r.llm_status) it.llm_status = r.llm_status;
  if (r.llm_status_text) it.llm_status_text = r.llm_status_text;
  if (typeof r.llm_elapsed === "number") it.llm_elapsed = r.llm_elapsed;
}
function upCollect(){
  return UP.order.map(function(k){
    var it = UP.byKey[k];
    var rs = it.result_status || (it.status === "done" ? "ingested" : "error");
    return {ok: it.status === "done", file: it.file, status: rs, statusText: it.status_text,
            title: it.title, reason: it.reason, detail: it.detail, elapsed: it.elapsed,
            llm_status: it.llm_status || "", llm_status_text: it.llm_status_text || ""};
  });
}
/* 轮询后端直到每个文件都进入终态（done / failed） */
function upPoll(){
  return new Promise(function(resolve){
    var ticker = setInterval(function(){ if (UP.running) upRender(); }, UP_TICK_MS);
    var stop = function(){ clearInterval(UP.poll); clearInterval(ticker); UP.poll = null; UP.running = false; upRender(); resolve(); };
    UP.poll = setInterval(async function(){
      var ids = Object.keys(UP.byId);
      if (!ids.length){ stop(); return; }
      var j = await API.progress(ids);
      if (j && j.ok && j.items && j.items.length){ j.items.forEach(upApply); }
      var pend = UP.order.filter(function(k){
        var it = UP.byKey[k], s = it.status;
        /* S3：已入库但 AI 摘要仍在后台补全的，继续轮询到补全终态 */
        if (s === "done") return it.llm_status === "pending" || it.llm_status === "running";
        return s === "queued" || s === "parsing" || s === "preparing";
      });
      upRender();
      if (!pend.length) stop();
    }, UP_POLL_MS);
  });
}
/* 全部终态后：回显结果 + 刷新图谱/检索页 */
async function upSettle(){
  UP.running = false; upRender();
  var results = upCollect();
  renderUploadResults(results);
  if (results.some(function(x){ return x.ok; })){ await reload(false); renderFilters(); refreshArea(); }
}
function renderUploadResults(results){
  var r = document.getElementById("uploadResult");
  r.classList.remove("hidden");
  var stMap = {ingested:["ok","已入库（新增）"],duplicate:["warn","已入库（去重命中，跳过新增）"],
               updated:["ok","已入库（修正噪声旧记录）"],failed:["bad","入库失败"],error:["bad","处理异常"]};
  var okN = 0, dupN = 0, failN = 0;
  results.forEach(function(x){
    if (!x.ok) failN++;
    else if (x.status === "duplicate") dupN++;
    else okN++;
  });
  var h = '<h5>解析完成 · 入库结果（新增 ' + okN + ' · 去重 ' + dupN + ' · 失败 ' + failN + '）</h5>';
  results.forEach(function(x){
    var m = stMap[x.status] || (x.ok? ["ok", x.statusText||"处理完成"] : ["bad", (x.reason||"处理失败")]);
    var used = (typeof x.elapsed === "number" && x.elapsed > 0)
      ? ' <span style="color:var(--muted)">· ' + Math.round(x.elapsed) + 's</span>' : "";
    var llmNote = (x.llm_status === "done") ? ' <span style="color:var(--muted)">· AI 摘要已补全</span>'
                : (x.llm_status === "pending" || x.llm_status === "running")
                  ? ' <span style="color:var(--muted)">· AI 摘要后台补全中…</span>'
                  : (x.llm_status === "failed") ? ' <span style="color:var(--muted)">· AI 摘要补全失败</span>' : "";
    h += '<div class="row '+m[0]+'"><span class="dot"></span><span class="nm">'+esc(x.file||x.saved_at||"?")
      + (x.title? ' <span style="color:var(--muted)">｜'+esc(short(x.title,40))+'</span>':"")+'</span>'
      + '<span class="act">'+esc(m[1])+used+llmNote
      + ((x.ok && x.file) ? ' <b class="up-read" data-read="'+esc(x.file)+'" data-title="'+esc(x.title||"")+'">阅读</b>' : "")
      + '</span></div>';
    if (x.detail){
      h += '<div class="row" style="display:block;font-size:11.5px;color:var(--muted)">'+esc(short(String(x.detail),300))+'</div>';
    }
  });
  h += '<p style="margin-top:10px;font-size:12px;color:var(--muted)">进度与结果均来自后端 /upload + /api/upload/progress 的真实响应；入库成功后图谱与检索页数据已刷新。</p>';
  r.innerHTML = h;
  r.querySelectorAll(".up-read[data-read]").forEach(function(b){
    b.addEventListener("click", function(){
      openReader({ name: b.getAttribute("data-read"), title: b.getAttribute("data-title") || "", from: "upload" });
    });
  });
}
/* 把已受理的 file_id 登记进进度卡（提交失败的直接落终态）；keys 可选，指定行 key */
function upRegister(items, keys){
  items.forEach(function(x, i){
    var k = keys ? keys[i] : ("f" + i);
    var it = UP.byKey[k]; if (!it) return;
    if (x && x.file) it.file = x.file;
    if (x && x.ok && x.file_id){
      it.file_id = x.file_id; UP.byId[x.file_id] = it.key;
      it.status = "queued"; it.status_text = "排队中"; it.percent = 2;
      if (typeof x.queue_position === "number" && x.queue_position > 0) it.queue_position = x.queue_position;
    } else {
      it.status = "failed"; it.status_text = "提交失败"; it.percent = 0;
      it.reason = (x && x.reason) || "上传失败";
    }
  });
  upRender();
}
/* 桌面端：主进程选取文件 → 异步提交（拿 file_id）→ 渲染层统一轮询逐文件进度 */
async function nativeUpload(){
  var api = window.workbenchDesktop || {};
  openModal();
  if (api.pickAndUploadProgress){
    var picked = await api.pickAndUploadProgress();
    if (!picked || picked.canceled) return;
    document.getElementById("uploadStep").classList.add("hidden");
    document.getElementById("pipeStep").classList.remove("hidden");
    document.getElementById("uploadResult").classList.add("hidden");
    var items = picked.items || [];
    upPrepare(items.map(function(x){ return {name: x.file}; }));
    upRegister(items);
    if (Object.keys(UP.byId).length) await upPoll();
    await upSettle();
    return;
  }
  /* 旧主进程壳（既无 pickAndUploadProgress 也无 submitPdfs）：回退系统文件选择器，
     由 startPipe 逐文件异步 POST + 轮询，保留逐文件实时进度 */
  closeModal();
  document.getElementById("fileInput").click();
}
/* 浏览器端：逐个异步 POST /upload（立即返回 file_id），随后统一轮询真实阶段 */
async function startPipe(files){
  document.getElementById("uploadStep").classList.add("hidden");
  document.getElementById("pipeStep").classList.remove("hidden");
  document.getElementById("uploadResult").classList.add("hidden");
  upPrepare(files);
  for (var i = 0; i < files.length; i++){
    var j = await API.uploadFile(files[i]);
    upRegister([{file:files[i].name, ok:!!(j && j.file_id), file_id:(j && j.file_id) || "",
                 reason:(j && j.reason) || "上传失败", queue_position:(j && j.queue_position) || 0}],
               ["f" + i]);
  }
  if (Object.keys(UP.byId).length) await upPoll();
  await upSettle();
}
window.addEventListener("workbench-data-changed", async function(){
  await reload(false); renderFilters(); refreshArea(); renderOntoCanvas(); renderOntoPanel();
});

/* ================= 上传记录弹窗（常驻入口，v1.9） ================= */
/* 数据源为后端 /api/upload/progress（最近 50 条），因此关闭弹窗不丢状态、上传完成后仍可回看 */
var UH = {open:false, timer:null, items:[], err:""};

function uhIsActive(it){
  if (it.status === "queued" || it.status === "parsing") return true;
  if (it.status === "done" && (it.llm_status === "pending" || it.llm_status === "running")) return true;
  return false;
}
function uhResultText(it){
  if (it.status === "failed") return "失败 · " + (it.reason || it.status_text || "未知原因");
  if (it.status === "queued") return "排队等待" + (it.queue_position > 1 ? ("（前方 " + (it.queue_position - 1) + " 篇）") : "");
  if (it.status === "parsing") return (it.stage_name || "解析中") + "…（阶段 " + ((it.stage_index || 0) + 1) + "/8）";
  var base = ({ingested:"已入库（新增）", duplicate:"已入库（去重命中，跳过新增）",
               updated:"已入库（修正噪声旧记录）", failed:"入库失败", error:"处理异常",
               unknown:"处理完成（状态未知）"})[it.result_status] || (it.status_text || "解析完成");
  if (it.llm_status === "done") base += " · AI 摘要已补全";
  else if (it.llm_status === "pending" || it.llm_status === "running") base += " · AI 摘要后台补全中…";
  else if (it.llm_status === "failed") base += " · AI 摘要补全失败";
  return base;
}
function uhItemHtml(it){
  var st = it.status;
  var cls = (st === "done") ? "done" : (st === "failed") ? "failed" : (st === "parsing" ? "parsing" : "queued");
  var badge = (st === "done") ? (it.status_text || "解析完成") : (st === "failed") ? "失败"
            : (st === "parsing") ? "解析中" : "排队中";
  var pct = Math.max(0, Math.min(100, Math.round(st === "done" ? 100 : (it.percent || 0))));
  var dur = (it.finished_at && it.started_at) ? Math.round(it.finished_at - it.started_at)
                                               : Math.round(it.elapsed || 0);
  var when = "";
  var tsv = it.finished_at || it.created_at;
  if (tsv){
    var d = new Date(tsv * 1000);
    var hhmm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    when = (it.finished_at ? "完成 " : "提交 ") + hhmm;
  }
  var line = uhResultText(it) + (it.title ? ("｜" + it.title) : "");
  return '<div class="up-item ' + cls + '">'
    + '<div class="up-line"><span class="up-name" title="' + esc(it.file) + '">' + esc(it.file) + '</span>'
    + '<span class="uh-when">' + esc(when) + '</span>'
    + '<span class="up-badge">' + esc(badge) + '</span><span class="up-time">' + dur + 's</span></div>'
    + '<div class="up-bar"><i style="width:' + pct + '%"></i></div>'
    + '<div class="up-stage" title="' + esc(line) + '">' + esc(line) + ' · ' + pct + '%</div></div>';
}
function uhRender(){
  var box = document.getElementById("uhList"); if (!box) return;
  var items = UH.items || [];
  box.innerHTML = items.length
    ? items.slice().reverse().map(uhItemHtml).join("")
    : '<div class="uh-empty">暂无上传记录</div>';
  var act = items.filter(uhIsActive).length, done = 0, fail = 0;
  items.forEach(function(x){ if (x.status === "done") done++; else if (x.status === "failed") fail++; });
  var t = document.getElementById("uhTitle");
  if (t) t.textContent = "全部上传任务（共 " + items.length + " 条）";
  var m = document.getElementById("uhMeta");
  if (m) m.textContent = "进行中 " + act + " · 已完成 " + done + " · 失败 " + fail + (UH.err ? (" · " + UH.err) : "");
}
function uhBadgeRender(){
  var el = document.getElementById("upHistBadge"); if (!el) return;
  var act = (UH.items || []).filter(uhIsActive).length;
  if (act > 0){ el.textContent = String(act); el.classList.remove("hidden"); }
  else { el.classList.add("hidden"); }
  var btn = document.getElementById("btnUpHist");
  if (btn){ if (act > 0) btn.classList.add("has-run"); else btn.classList.remove("has-run"); }
}
async function uhFetch(){
  var j = await API.progressAll(50);
  if (j && j.ok && j.items){ UH.items = j.items; UH.err = ""; }
  else { UH.err = "读取失败，稍后自动重试"; }
  uhBadgeRender();
  if (UH.open) uhRender();
}
function uhTick(){
  if (document.hidden && !UH.open) return;   /* 窗口在后台且弹窗未打开时省去无谓请求 */
  uhFetch();
}
function uhSchedule(){
  if (UH.timer) clearInterval(UH.timer);
  UH.timer = setInterval(uhTick, UH.open ? 1200 : 4000);
}
function openUpHist(){
  UH.open = true;
  document.getElementById("upHistModal").classList.add("open");
  uhSchedule(); uhFetch();
}
function closeUpHist(){
  UH.open = false;
  document.getElementById("upHistModal").classList.remove("open");
  uhSchedule();
}
document.getElementById("btnUpHist").addEventListener("click", openUpHist);
document.getElementById("upHistModal").addEventListener("click", function(e){
  if (e.target === this) closeUpHist();
});
document.addEventListener("visibilitychange", function(){ if (!document.hidden) uhFetch(); });
uhSchedule(); uhFetch();

/* ================= 弹窗按钮绑定 ================= */
document.getElementById("btnVersions").addEventListener("click", openVerModal);
document.getElementById("instSearch").addEventListener("input", function(){ renderOntoPanel(); });
document.getElementById("newType").addEventListener("change", renderNewFields);
document.getElementById("btnNewSubmit").addEventListener("click", submitNew);
document.addEventListener("keydown", function(e){
  if (e.key==="Escape"){ closeModal(); closeVerModal(); closeNewModal(); closeRel(); closeUpHist(); }
});

/* ================= 初始化 ================= */
window.WB_V6 = {
  status: function(){
    return {mode:RAW.mode, nodes:RAW.nodes.length, edges:RAW.edges.length,
            papers:PAPERS.length, classes:ontoClassList().length, tab:state.tab};
  }
};
(async function init(){
  await reload(true);
  renderCtrlBar(); syncView();
  renderAI(state.tab);
  renderOntoCanvas(); renderOntoPanel();
})();
/* ===== 右边缘「展开 AI 面板」把手绑定（原初始化无 switchTab("lib")，按规格 §3.4 回退至 load 包装） ===== */
window.addEventListener("load", function(){
  var _peekEl = document.getElementById("aiPeek"); if (_peekEl) _peekEl.onclick = toggleAI; aiPeekSync();
});

/* ===== 管理页实例 → 进入阅读（事件委托，免疫动态重渲染） ===== */
(function(){
  var ea = document.getElementById("editorArea");
  if (!ea) return;
  ea.addEventListener("click", function(e){
    var t = e.target;
    while (t && t !== ea && !(t.getAttribute && t.getAttribute("data-read-file"))) t = t.parentNode;
    if (!t || t === ea || !t.getAttribute) return;
    openReader({ name: t.getAttribute("data-read-file"),
                 title: t.getAttribute("data-read-title") || "",
                 nid: state.ontoInst, from: "onto" });
  });
})();

/* =============================================================================
   阅读板块（ReX × 工作台 融合实现）  —— File Agent
   入口：openReader(ctx)
   布局：隐藏 ReX 顶栏/左栏/右栏，融入工作台外壳；工具条悬浮在阅读视口内；
        右栏复用工作台 AI 面板（阅读伴随，不含本文摘要）
   锚点：不设锚点列表；锚点标记就地呈现在被划词文字正上方，悬浮时高亮正文对应区域
   通道：字节走后端 HTTP（/api/read/file，支持 Range）；模型走后端 9173 代理
   ============================================================================= */

var RD = {
  key: "", name: "", title: "", pid: null, nid: null,
  ready: false, host: null, booted: false, busy: false,
  msgs: [], sending: false, pages: 0, page: 1, anchor: null, marks: [],
  restorePage: 0, fromRestore: false,     /* 阅读选择器：待跳转页码 / 是否来自「上次阅读」自动恢复 */
  viewFixing: false                       /* 打开后视口校正进行中（等渲染/尺寸稳定 → 适应宽度 → 定位第 1 页） */
};

/* 阅读伴随 system prompt：先结论后展开，禁止编造 */
var RD_SYS = "你是严谨的学术文献伴读助手。请严格基于用户随消息提供的文献内容作答："
  + "先给出结论，再分点展开；引用原文时保持原样。"
  + "若提供的内容不足以支撑回答，请直接说明缺少哪些信息，绝不编造数据、结论或参考文献。";

/* 全量携带的字符上限（约 3 万 token 量级，与后端 num_ctx=32768 对齐） */
var RD_CTX_MAX = 48000;

var RD_CFG = null;

/* ------------------------------------------------------------------ 工具 */
function rdEl(id){ return document.getElementById(id); }

function rdToast(msg){
  var t = rdEl("rdToast");
  if (!t){
    t = document.createElement("div");
    t.id = "rdToast";
    t.className = "rd-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._tm);
  t._tm = setTimeout(function(){ t.classList.remove("on"); }, 2600);
}

function rdCap(t, max){
  t = String(t || "");
  if (t.length <= max) return t;
  var head = Math.floor(max * 0.7), tail = max - head;
  return t.slice(0, head) + "\n……（此处省略中间部分，如需请针对具体页提问）……\n" + t.slice(-tail);
}

/* ------------------------------------------------------- 入口：openReader */
/**
 * 统一阅读入口。ctx 支持字段：
 *   name  : 本地文件名（basename，取自图谱 Paper.file / 上传回执）
 *   title : 文献标题（可选，用于展示）
 *   pid   : 检索列表文献 id（可选）
 *   nid   : 图谱节点 id（可选）
 *   from  : 入口来源标记（lib / graph / onto / upload）
 */
function openReader(ctx){
  ctx = ctx || {};
  var raw = String(ctx.name || ctx.file || "").trim();
  if (!raw){
    rdToast("该条目未关联本地文件，无法进入阅读");
    return;
  }
  var base = raw.replace(/\\/g, "/").split("/").pop();
  if (!/\.(pdf|md|txt|html?)$/i.test(base)){
    rdToast("仅支持 PDF / Markdown / 文本类文献阅读");
    return;
  }
  var key = base.toLowerCase();
  var same = (key === RD.key);
  var wantPage = parseInt(ctx.page || 0, 10) || 0;
  RD.fromRestore = (ctx.from === "restore");

  if (!same){
    /* 多文档切换：清空 AI 会话上下文 + 清空阅读器内文档与锚点 */
    RD.key = key;
    RD.name = base;
    RD.title = ctx.title || "";
    RD.pid = ctx.pid || null;
    RD.nid = ctx.nid || null;
    RD.anchor = null;
    RD.msgs = [];
    RD.restorePage = wantPage > 1 ? wantPage : 0;   /* 阅读选择器：打开后跳回上次页码 */
    rdResetHostDoc();
  } else {
    if (ctx.title) RD.title = ctx.title;
    if (ctx.pid) RD.pid = ctx.pid;
    if (ctx.nid) RD.nid = ctx.nid;
    if (wantPage > 1){ try { RD.host && RD.host.gotoPage(wantPage); } catch (e) {} setTimeout(rdSyncBar, 200); }
  }

  closeRel();
  switchTab("read");
  rdEnsureAiPanel();
  if (!same || !RD.ready || !RD.pages) rdLoad(same);
  else { rdRenderPanelHead(); rdSyncBar(); rdViewportRefit(); }
}

/** 从检索列表 / 上传回执的 paper 对象打开阅读 */
function openReaderPaper(pid){
  var p = findP(pid);
  if (!p){ rdToast("未找到该文献记录"); return; }
  openReader({ name: p.file, title: p.title, pid: p.id, nid: p.nid, from: "lib" });
}

/** 从图谱节点打开阅读（节点属性里取 file / title） */
function openReaderNid(nid){
  var n = RAW && RAW.byId ? RAW.byId[nid] : null;
  if (!n){ rdToast("未找到该图谱节点"); return; }
  var pr = n.properties || {};
  var f = pr.file || pr.local_file || "";
  if (!f){ rdToast("该节点未关联本地文件"); return; }
  var title = pr.title || nodeLabel(n) || "";
  openReader({ name: f, title: title, nid: nid, from: "graph" });
}

function rdEnsureAiPanel(){
  var p = rdEl("aiPanel");
  if (p && !p.classList.contains("on")) p.classList.add("on");
  aiPeekSync();
  /* 确保阅读输入框已创建 */
  if (!rdEl("rdInput") && typeof rdBuildInput === "function") rdBuildInput();
}

function rdResetHostDoc(){
  try { if (RD.host && RD.host.reset) RD.host.reset(); } catch (e) {}
  RD.pages = 0; RD.page = 1;
  var f = rdEl("readFrame");
  if (f && !RD.host){ /* 尚未初始化，交由 rdLoad 处理 */ }
}

function rdHostReadyDoc(){
  try {
    if (!RD.ready || !RD.host) return false;
    var st = RD.host.getState ? RD.host.getState() : null;
    return !!(st && st.docs > 0 && String(st.name || "").toLowerCase() === RD.key);
  } catch (e) { return false; }
}

/* ------------------------------------------------------------ 阅读器加载 */
function rdEnsureFrame(){
  return new Promise(function(resolve){
    var f = rdEl("readFrame");
    if (!f) return resolve(false);
    if (RD.ready && RD.host){
      try { RD.host.setHost({ onAsk: rdOnAsk, onDropFiles: rdOnDrop }); } catch (e) {}
      return resolve(true);
    }
    if (!f.getAttribute("data-init")){
      f.setAttribute("data-init", "1");
      /* 同源 HTTP 提供：file:// 为 opaque origin，父页无法访问 iframe 内容 */
      f.src = "/rex/index.html?embed=1";
    }
    var n = 0;
    (function poll(){
      n++;
      var w = null;
      try { w = f.contentWindow; } catch (e) { w = null; }
      if (w && w.ReX && typeof w.ReX.open === "function"){
        RD.host = w.ReX;
        RD.ready = true;
        try { RD.host.setHost({ onAsk: rdOnAsk, onDropFiles: rdOnDrop }); } catch (e) {}
        return resolve(true);
      }
      if (n > 150) return resolve(false);
      setTimeout(poll, 100);
    })();
  });
}

async function rdLoad(keepDoc){
  if (RD.busy) return;
  RD.busy = true;
  rdShowLoading("正在初始化阅读器…");
  try {
    var ok = await rdEnsureFrame();
    if (!ok) throw new Error("阅读器初始化超时，请重启工作台后重试");
    if (!keepDoc){
      try { RD.host.reset(); } catch (e) {}
      RD.marks = [];
    }
    rdShowLoading("正在定位文献…");
    var info = await API.get("/api/read/probe?name=" + encodeURIComponent(RD.name));
    if (!info || !info.ok) throw new Error((info && info.reason) || "未找到该文献的本地文件");
    if (!RD.title) RD.title = info.name || RD.name;

    rdShowLoading("正在读取文献字节…");
    var res = await fetch(API_BASE + "/api/read/file?name=" + encodeURIComponent(RD.name));
    if (!res.ok) throw new Error("字节通道异常 HTTP " + res.status);
    var buf = new Uint8Array(await res.arrayBuffer());

    rdShowLoading("正在渲染阅读视口…");
    var r = await RD.host.open({ bytes: buf, name: info.name || RD.name });
    if (!r || r.ok !== true) throw new Error("渲染失败：该文件可能已损坏或格式不受支持");

    var emp = rdEl("readEmpty"); if (emp){ emp.classList.add("hidden"); emp.innerHTML = ""; }
    var bar = rdEl("readBar"); if (bar) bar.classList.remove("hidden");
    rdShowLoading("");
    rdRenderPanelHead();
    rdSyncMarks();
    rdLoadMarks();
    rdViewportFix(RD.restorePage > 1 ? RD.restorePage : 1);
    setTimeout(rdSyncBar, 600);
  } catch (e){
    rdShowLoading("");
    rdError(e && e.message ? e.message : String(e));
  } finally {
    RD.busy = false;
  }
}

function rdShowLoading(t){
  var el = rdEl("readLoading");
  if (!el) return;
  if (!t){ el.classList.add("hidden"); return; }
  var tx = rdEl("readLoadingText"); if (tx) tx.textContent = t;
  el.classList.remove("hidden");
}

function rdError(msg){
  if (RD.fromRestore){ rdHistDrop(); RD.fromRestore = false; }
  var bar = rdEl("readBar"); if (bar) bar.classList.add("hidden");
  var emp = rdEl("readEmpty");
  if (emp){
    emp.classList.remove("hidden");
    emp.innerHTML = '<div class="rd-err"><div class="rd-err-t">无法打开该文献</div>'
      + '<div class="rd-err-m">' + esc(msg) + '</div>'
      + '<div class="rd-tip">请确认文件位于 data_test/论文 目录内，且后端（9173）已启动。</div></div>';
  }
  rdRenderPanelHead();
}

/* ------------------------------------------------------------ 工具条联动 */
function rdSyncBar(){
  if (!RD.ready || !RD.host) return;
  var st = null;
  try { st = RD.host.getState ? RD.host.getState() : null; } catch (e) { st = null; }
  if (!st) return;
  RD.pages = st.pages || 0;
  RD.page = st.page || 1;

  var lb = rdEl("rdZoomLabel");
  if (lb) lb.textContent = (Math.round(st.percent || st.zoom || 100)) + "%";
  var pi = rdEl("rdPage");
  if (pi && document.activeElement !== pi) pi.value = RD.page;
  var pt = rdEl("rdPageTotal");
  if (pt) pt.textContent = "/ " + (RD.pages || 0);
  var nm = rdEl("rdName");
  if (nm){ nm.textContent = RD.title || RD.name; nm.title = RD.name; }
  rdPickerPageSync(RD.page, RD.pages);
}

function rdBindBar(){
  var q = rdEl;
  if (q("rdZoomIn")) q("rdZoomIn").onclick = function(){ try{ RD.host.zoomIn(); }catch(e){} setTimeout(rdSyncBar, 90); };
  if (q("rdZoomOut")) q("rdZoomOut").onclick = function(){ try{ RD.host.zoomOut(); }catch(e){} setTimeout(rdSyncBar, 90); };
  if (q("rdFit")) q("rdFit").onclick = function(){ try{ RD.host.fitWidth(); }catch(e){} setTimeout(rdSyncBar, 140); };
  if (q("rdPage")) q("rdPage").addEventListener("change", function(){
    var v = parseInt(this.value, 10);
    if (RD.ready && v >= 1){ try{ RD.host.gotoPage(v); }catch(e){} }
    setTimeout(rdSyncBar, 180);
  });
  if (q("rdReload")) q("rdReload").onclick = function(){ if (RD.key) rdLoad(false); };

  var stage = rdEl("readStage");
  if (stage){
    stage.addEventListener("dragover", function(e){ e.preventDefault(); });
    stage.addEventListener("drop", function(e){
      e.preventDefault();
      rdOnDrop(e.dataTransfer && e.dataTransfer.files);
    });
  }
  setInterval(function(){ if (state.tab === "read") rdSyncBar(); }, 900);
}

/* --------------------------------------------------------- ReX → 宿主回调 */
function rdOnAsk(info){
  if (!info || !info.text) return;
  var kind = info.kind || "ask";
  if (info.page) RD.anchor = { page: info.page, text: info.text, kind: kind, rect: info.rect || null };
  if (kind === "translate"){ rdDoTranslate(info); return; }
  if (kind === "annotate"){ rdDoAnnotate(info); return; }
  /* ==== 以下为原提问逻辑，保持不变 ==== */
  rdEnsureAiPanel();
  if (info.source === "anchor"){
    /* 点击锚点：回填输入框，便于二次编辑后再问 */
    var inp = rdEl("rdInput");
    if (inp){ inp.value = info.quote || info.text; inp.focus(); }
    return;
  }
  /* 划词提问：预填充输入框 */
  var inp = rdEl("rdInput");
  if (inp){
    if (inp.dataset.quote) return;  // 已预填充过，不重复
    var prefix = "【选中文本】\n" + info.text + "\n\n";
    inp.value = prefix + (inp.value || "");
    inp.dataset.quote = "1";
    inp.focus();
    inp.scrollTop = inp.scrollHeight;
  }
  /* 同步锚点标记：仅划词（selection）入账，点击锚点回填不入账 */
  if (info.page && info.text) RD.anchor = { page: info.page, text: info.text };
  if (typeof rdSyncCx === "function") rdSyncCx();
  if (info.source === "selection" && info.page){
    rdPushMark({ kind: "ask", quote: info.text, content: "",
                 page: info.page, fx: info.fx, fy: info.fy, rect: info.rect });
  }
}

/* --------------------------------------------------- 锚点集合：翻译 / 批注 */
/* 翻译：调后端 /api/read/translate，结果落成 T 锚点并悬浮展示 */
function rdDoTranslate(info){
  var quote = info.text;
  if (RD._trBusy) return;
  RD._trBusy = true;
  rdToast("正在翻译…");
  fetch(API_BASE + "/api/read/translate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: quote, to: "中文" })
  }).then(function(r){ return r.json(); }).then(function(j){
    RD._trBusy = false;
    if (!j || j.ok !== true || !j.text){ rdToast("翻译失败：" + ((j && j.reason) || "无返回")); return; }
    var mk = rdPushMark({ kind: "translate", quote: quote, content: j.text,
                          page: info.page, fx: info.fx, fy: info.fy, rect: info.rect });
    /* 持久化：翻译结果与批注同库保存（kind=translate），跨会话可恢复 */
    fetch(API_BASE + "/api/read/annotate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: RD.key, page: info.page, fx: info.fx, fy: info.fy,
                             rect: info.rect, quote: quote, note: j.text, kind: "translate" })
    }).then(function(r){ return r.json(); }).then(function(k){
      if (k && k.ok === true){ if (mk) mk.id = k.id; rdToast("翻译完成（已保存）"); }
      else { rdToast("翻译完成，但保存失败：" + ((k && k.reason) || "无返回")); }
    }).catch(function(){ rdToast("翻译完成，但保存失败：网络错误"); });
  }).catch(function(e){ RD._trBusy = false; rdToast("翻译请求失败：" + e.message); });
}

/* 批注：弹出输入层 → POST /api/read/annotate → 落成 A 锚点 */
var RDAN = { cb: null };
function rdAnnotOpen(quote, cb){
  var m = document.getElementById("rdAnnotModal");
  if (!m){ rdToast("当前环境不支持页内批注输入层"); if (cb) cb(null); return; }
  RDAN.cb = cb || null;
  var qt = document.getElementById("rdAnnotQuote");
  if (qt) qt.textContent = String(quote || "").replace(/\s+/g, " ").slice(0, 300);
  var ta = document.getElementById("rdAnnotText");
  if (ta){
    ta.value = "";
    ta.onkeydown = function(e){
      if (e.key === "Escape"){ e.stopPropagation(); rdAnnotCancel(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)){ e.preventDefault(); rdAnnotOk(); }
    };
  }
  m.classList.add("open");
  setTimeout(function(){ try { if (ta) ta.focus(); } catch (e) {} }, 30);
}
function rdAnnotClose(){ var m = document.getElementById("rdAnnotModal"); if (m) m.classList.remove("open"); }
function rdAnnotCancel(){ RDAN.cb = null; rdAnnotClose(); }
function rdAnnotOk(){
  var ta = document.getElementById("rdAnnotText");
  var note = ta ? ta.value : "";
  if (!String(note || "").trim()){ rdToast("批注内容不能为空"); try { ta.focus(); } catch (e) {} return; }
  var cb = RDAN.cb; RDAN.cb = null;
  rdAnnotClose();
  if (cb) cb(note);
}
/* 批注：弹出页内输入层 → POST /api/read/annotate → 落成 A 锚点 */
function rdDoAnnotate(info){
  rdAnnotOpen(info && info.text, function(note){ rdAnnotCommit(info, note); });
}
function rdAnnotCommit(info, note){
  note = String(note || "").trim();
  if (!note){ rdToast("批注为空，已取消"); return; }
  fetch(API_BASE + "/api/read/annotate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: RD.key, page: info.page, fx: info.fx, fy: info.fy,
                           rect: info.rect, quote: info.text, note: note })
  }).then(function(r){ return r.json(); }).then(function(j){
    if (!j || j.ok !== true){ rdToast("批注保存失败：" + ((j && j.reason) || "无返回")); return; }
    rdPushMark({ kind: "annotate", quote: info.text, content: note, id: j.id,
                 page: info.page, fx: info.fx, fy: info.fy, rect: info.rect });
    rdToast("批注已保存");
  }).catch(function(e){ rdToast("批注请求失败：" + e.message); });
}

RD.marks = RD.marks || [];
function rdPushMark(m){
  var it = { page: m.page, fx: m.fx, fy: m.fy, rect: m.rect || null,
             kind: m.kind, quote: m.quote || "", content: m.content || "", id: m.id || null };
  RD.marks.push(it);
  rdSyncMarks();
  return it;
}
function rdSyncMarks(){
  try { if (RD.host && RD.host.setMarks) RD.host.setMarks(RD.marks); } catch (e) {}
}
function rdSaveEvidence(i){
  var m = RD.msgs[i];
  if (!m || !m.content) return;
  fetch(API_BASE + "/api/read/annotate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: RD.key, kind: "evidence", note: m.content,
                           quote: m.quote || "", page: RD.page || 1 })
  }).then(function(r){ return r.json(); }).then(function(j){
    if (j && j.ok){ rdPushMark({ page: RD.page || 1, fx: 0.5, fy: 0.5, kind: "evidence", quote: m.quote || "", content: m.content, id: j.id }); rdToast("已存为证据"); }
    else rdToast("存储失败");
  }).catch(function(){ rdToast("存储失败"); });
}
function rdLoadMarks(){
  if (!RD.key) return;
  fetch(API_BASE + "/api/read/annotate?file=" + encodeURIComponent(RD.key))
    .then(function(r){ return r.json(); }).then(function(j){
      if (!j || j.ok !== true) return;
      (j.items || []).forEach(function(it){
        RD.marks.push({ page: it.page, fx: it.fx, fy: it.fy, rect: it.rect || null,
                        kind: it.kind || "annotate", quote: it.quote || "",
                        content: it.content || "", id: it.id || null });
      });
      rdSyncMarks();
    }).catch(function(){});
}

function rdOnDrop(files){
  var arr = Array.prototype.slice.call(files || []).filter(function(f){
    return /\.pdf$/i.test(f && f.name || "");
  });
  if (!arr.length){ rdToast("仅支持 PDF 文件入库"); return; }
  if (typeof startPipe === "function"){
    openModal && openModal();
    startPipe(arr);
  } else {
    rdToast("当前环境不支持直接入库，请使用顶部上传入口");
  }
}

/* -------------------------------------------------------------- AI 会话 */
function rdAddMsg(role, content, quote){
  RD.msgs.push({ role: role, content: content || "", quote: quote || "" });
  rdRenderMsgs();
  return RD.msgs.length - 1;
}

function rdSetMsg(i, content){
  if (!RD.msgs[i]) return;
  RD.msgs[i].content = content;
  var el = RD.msgs[i].el;
  if (el) el.innerHTML = rdMsgHtml(RD.msgs[i], i);
  var box = rdEl("rdMsgs");
  if (box) box.scrollTop = box.scrollHeight;
}

function rdMsgHtml(m, idx){
  var h = "";
  if (m.quote) h += '<div class="rd-quote">' + esc(m.quote) + '</div>';
  h += '<div class="rd-text">' + esc(m.content).replace(/\n/g, "<br>") + '</div>';
  if (m.role === "ai" && m.content && m.content !== "…" && idx != null){
    h += '<span class="ai-ev" onclick="rdSaveEvidence(' + idx + ')">存为证据</span>';
  }
  return h;
}

function rdRenderMsgs(){
  var box = rdEl("rdMsgs");
  if (!box) return;
  if (!RD.msgs.length){
    box.innerHTML = '<div class="rd-welcome">'
      + '<div class="rd-w-t">AI 精读已就绪</div>'
      + '<div class="rd-w-l">· 在左侧正文中<b>选中文字</b> → 点浮动按钮「划词提问」<br>'
      + '· 紫色<b>锚点</b>悬停可高亮正文对应位置，点击可回填问题<br>'
      + '· 切换文献会自动清空本会话上下文</div>'
      + '<div class="rd-sugs">'
      + '<button class="ai-act" data-q="这篇文献的创新点与局限是什么？">→ 这篇的创新点与局限</button>'
      + '<button class="ai-act" data-q="请结合本页内容与常见研究范式，说明这篇文献与同类研究的关键差异。">→ 与库中同类文献的差异</button>'
      + '<button class="ai-act" data-q="逐条检查本文结论的证据强度，指出证据不足的地方。">→ 结论是否有充分证据</button>'
      + '</div></div>';
    box.querySelectorAll(".rd-sugs .ai-act").forEach(function(el){
      el.addEventListener("click", function(){
        var inp = rdEl("rdInput");
        if (inp) inp.value = el.getAttribute("data-q") || "";
        if (typeof rdSendFromInput === "function") rdSendFromInput();
      });
    });
    return;
  }
  var h = "";
  RD.msgs.forEach(function(m, i){
    h += '<div class="ai-msg ' + (m.role === "user" ? "u" : "a") + '">' + rdMsgHtml(m, i) + '</div>';
  });
  box.innerHTML = h;
  var els = box.querySelectorAll(".ai-msg");
  RD.msgs.forEach(function(m, i){ m.el = els[i]; });
  box.scrollTop = box.scrollHeight;
}

function rdClearChat(){
  RD.msgs = [];
  RD.anchor = null;
  rdRenderMsgs();
  rdRenderPanelHead();
  rdToast("已开启新对话，上下文已清空");
}

function rdSendFromInput(){
  var inp = rdEl("rdInput");
  if (!inp || RD.sending) return;
  var q = inp.value.trim();
  if (!q) return;
  inp.value = "";
  rdAddMsg("user", q);
  rdAsk(q, RD.anchor);
}

/* 上下文组装：全文全量携带 + 锚点页优先 */
async function rdBuildContext(info){
  var out = "【文献】" + (RD.title || RD.name) + "\n【文件名】" + RD.name + "\n";
  var pageTexts = null, full = "";
  try { pageTexts = await RD.host.getPageTexts(); } catch (e) { pageTexts = null; }
  try { full = RD.host.getFullText() || ""; } catch (e) { full = ""; }
  if (!full && pageTexts && pageTexts.length) full = pageTexts.join("\n");

  if (info && info.text){
    out += "\n【我在第 " + (info.page || "?") + " 页选中的原文】\n" + info.text + "\n";
    var ap = (info.page && pageTexts) ? (pageTexts[(info.page | 0) - 1] || "") : "";
    if (ap) out += "\n【该页完整内容（优先参考）】\n" + rdCap(ap, 8000) + "\n";
  }
  if (full) out += "\n【文献全文】\n" + rdCap(full, RD_CTX_MAX);
  return out;
}

async function rdAsk(q, info){
  if (RD.sending) return;
  if (!RD.ready || !RD.host){
    rdAddMsg("ai", "阅读器尚未就绪，请稍候重试。");
    return;
  }
  RD.sending = true;
  rdRenderPanelHead();
  var idx = rdAddMsg("ai", "…");
  var acc = "";
  try {
    var ctx = await rdBuildContext(info);
    var msgs = [
      { role: "system", content: RD_SYS },
      { role: "user", content: ctx + "\n\n【问题】" + q }
    ];
    await rdStreamChat(msgs, function(d){
      acc += d;
      rdSetMsg(idx, acc);
    });
    if (!acc) acc = "（模型未返回内容，请检查模型连通性）";
    rdSetMsg(idx, acc);
  } catch (e){
    var m = (e && e.message) ? e.message : String(e);
    rdSetMsg(idx, acc ? (acc + "\n\n[中断] " + m) : ("请求失败：" + m));
  } finally {
    RD.sending = false;
    rdRenderPanelHead();
  }
}

/* 统一 OpenAI SSE 帧解析（后端已归一化） */
async function rdStreamChat(messages, onDelta){
  var payload = { messages: messages, stream: true };
  var res = await fetch(API_BASE + "/api/llm/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok){
    var txt = "";
    try { txt = await res.text(); } catch (e) {}
    throw new Error("模型接口 HTTP " + res.status + (txt ? "：" + txt.slice(0, 180) : ""));
  }
  if (!res.body) throw new Error("当前环境不支持流式响应");
  var reader = res.body.getReader();
  var dec = new TextDecoder("utf-8");
  var buf = "";
  for (;;){
    var r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    var lines = buf.split("\n");
    buf = lines.pop() || "";
    for (var i = 0; i < lines.length; i++){
      var L = lines[i].trim();
      if (!L || L.indexOf("data:") !== 0) continue;
      var pl = L.slice(5).trim();
      if (pl === "[DONE]") return;
      var o = null;
      try { o = JSON.parse(pl); } catch (e) { continue; }
      if (o && o.error) throw new Error(o.error.message || "模型返回错误");
      var d = o && o.choices && o.choices[0] && o.choices[0].delta && o.choices[0].delta.content;
      if (d) onDelta(d);
    }
  }
}

/* ------------------------------------------------------------ AI 面板渲染 */
function renderAIRead(b){
  b.classList.add("rd");
  b.classList.remove("ai-new");
  b.innerHTML = ''
    + '<div class="rd-msgs" id="rdMsgs"></div>'
    + '<div class="ai-input-wrap">'
    + '<div class="ai-read-ad" id="aiReadAd">'
    +   '<span class="ad-text" id="aiAdText"></span>'
    +   '<span class="ad-btns">'
    +     '<button class="ad-btn" data-ad="ask" title="提问">🔍</button>'
    +     '<button class="ad-btn" data-ad="tr" title="翻译">🌐</button>'
    +     '<button class="ad-btn" data-ad="an" title="批注">✏️</button>'
    +   '</span>'
    + '</div>'
    +   '<div class="ai-cx-ind" id="aiCxInd" title="关联上下文"><span class="cx-ico">▤</span><span class="cx-text" id="aiCxText"></span></div>'
    +   '<div class="ai-input-box">'
    +     '<input id="rdInput" autocomplete="off" placeholder="选中文献，描述你想了解什么...">'
    +     '<button class="ib-btn new" id="aiNewChatBtn" title="新建">＋</button>'
    +     '<button class="ib-btn model" id="aiModelBtnBtn" title="模型">⚙</button>'
    +   '</div>'
    + '</div>';

  var q = function(id){ return document.getElementById(id); };
  if (q("aiNewChatBtn")) q("aiNewChatBtn").onclick = aiNewChat;
  if (q("aiModelBtnBtn")) q("aiModelBtnBtn").onclick = aiModelBtn;
  if (q("rdInput")) q("rdInput").addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); rdSendFromInput(); }
  });
  var cxBtn = q("aiCxInd");
  if (cxBtn) cxBtn.addEventListener("click", function(){ cxBtn.classList.toggle("open"); });
  var adBar = q("aiReadAd");
  if (adBar) adBar.querySelectorAll(".ad-btn").forEach(function(btn){
    btn.addEventListener("click", function(){ aiAdAction(btn.getAttribute("data-ad")); });
  });
  rdRenderMsgs();
  rdRenderPanelHead();
  rdRefreshModelName();
  rdSyncCx();
}

/* 阅读板块：上下文指示器 + 选中文本吸附条 */
function rdSyncCx(){
  var t = rdEl("aiCxText");
  if (t) t.textContent = (RD.name ? (RD.title || RD.name) : "未打开文献");
  var ad = rdEl("aiReadAd");
  if (!ad) return;
  var a = RD.anchor;
  if (a && a.text){
    ad.classList.add("show");
    ad.setAttribute("data-text", a.text);
    var at = rdEl("aiAdText");
    if (at) at.textContent = String(a.text).slice(0, 60) + (a.text.length > 60 ? "…" : "") + (a.page ? ("（第 " + a.page + " 页）") : "");
  } else {
    ad.classList.remove("show");
    ad.removeAttribute("data-text");
  }
}

function rdRenderPanelHead(){
  var n = rdEl("rdDocName");
  if (n) n.textContent = RD.name ? (RD.title ? short(RD.title, 30) : RD.name) : "未打开文献";
  var s = rdEl("rdSend");
  if (s){ s.disabled = !!RD.sending; s.textContent = RD.sending ? "回答中…" : "提问"; }
}

/* -------------------------------------------------------------- 模型设置 */
async function rdRefreshModelName(){
  var el = rdEl("rdModelName");
  if (!el) return;
  try {
    if (!RD_CFG) RD_CFG = await API.get("/api/llm/config");
    if (!RD_CFG || !RD_CFG.ok) throw new Error("配置读取失败");
    var k = RD_CFG.active, p = (RD_CFG.profiles || {})[k] || {};
    el.textContent = (k === "local" ? "本地 · " : "云 · ") + (p.model || "未指定模型");
    el.title = "配置来源：" + (RD_CFG.config_path || "llm_config.json");
  } catch (e){
    el.textContent = "模型配置不可用";
  }
}

async function rdOpenModelPanel(){
  try { RD_CFG = await API.get("/api/llm/config"); } catch (e) { RD_CFG = null; }
  if (!RD_CFG || !RD_CFG.ok){ rdToast("无法读取模型配置，请确认后端已启动"); return; }

  var mask = rdEl("rdModelMask");
  if (!mask){
    mask = document.createElement("div");
    mask.id = "rdModelMask";
    mask.className = "rd-mask";
    mask.innerHTML = '<div class="rd-modal" id="rdModalBox"></div>';
    document.body.appendChild(mask);
    mask.addEventListener("click", function(e){ if (e.target === mask) rdCloseModelPanel(); });
  }
  rdDrawModelPanel(mask);
  mask.classList.add("on");
}

function rdCloseModelPanel(){
  var m = rdEl("rdModelMask");
  if (m) m.classList.remove("on");
}

function rdDrawModelPanel(mask){
  var cfg = RD_CFG, act = cfg.active;
  var box = rdEl("rdModalBox");
  var h = '<div class="rd-m-head"><div class="ui-head" style="flex:1"><button class="ui-ico-btn ui-back" id="rdMBack" title="返回" onclick="rdCloseModelPanel()"><svg viewBox="0 0 24 24"><path d="M14 6l-6 6 6 6"/></svg></button><b>模型设置</b></div><button class="ui-ico-btn" id="rdMClose" title="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
  h += '<div class="rd-m-sub">所有模型调用经后端 9173 代理，前端不保存 API Key。</div>';
  h += '<div class="rd-m-tabs">'
    + '<button class="rd-m-tab' + (act === "local" ? " on" : "") + '" data-k="local">本地模型（Ollama）</button>'
    + '<button class="rd-m-tab' + (act === "cloud" ? " on" : "") + '" data-k="cloud">云模型（OpenAI 兼容）</button>'
    + '</div>';

  ["local", "cloud"].forEach(function(k){
    var p = (cfg.profiles || {})[k] || {};
    h += '<div class="rd-m-form' + (k === act ? "" : " hidden") + '" data-form="' + k + '">';
    h += '<label>接口地址 Base URL<input id="rdP_' + k + '_base" value="' + esc(p.base_url || "") + '" placeholder="'
       + (k === "local" ? "http://127.0.0.1:11434/v1" : "https://api.openai.com/v1") + '"></label>';
    h += '<label>模型名<input id="rdP_' + k + '_model" value="' + esc(p.model || "") + '" placeholder="'
       + (k === "local" ? "qwen3:8b" : "gpt-4o-mini") + '"></label>';
    h += '<label>API Key<input id="rdP_' + k + '_key" type="password" placeholder="'
       + (p.api_key_set ? ("已设置（" + esc(p.api_key_masked || "") + "），留空则不变") : "未设置") + '"></label>';
    h += '<div class="rd-m-row">'
       + '<label>num_ctx<input id="rdP_' + k + '_ctx" value="' + esc(p.num_ctx === undefined ? "" : p.num_ctx) + '" placeholder="32768"></label>'
       + '<label>temperature<input id="rdP_' + k + '_temp" value="' + esc(p.temperature === undefined ? "" : p.temperature) + '"></label>'
       + '<label>max_tokens<input id="rdP_' + k + '_mt" value="' + esc(p.max_tokens === undefined ? "" : p.max_tokens) + '"></label>'
       + '</div>';
    h += '<div class="rd-m-acts">'
       + '<button class="mini-btn" id="rdP_' + k + '_models">列出模型</button>'
       + '<button class="mini-btn" id="rdP_' + k + '_test">测试连通</button>'
       + '<button class="mini-btn primary" id="rdP_' + k + '_save">保存并启用</button>'
       + '</div>';
    h += '<div class="rd-m-out" id="rdP_' + k + '_out"></div>';
    h += '</div>';
  });
  h += '<div class="rd-m-foot">配置文件：' + esc(cfg.config_path || "llm_config.json") + '</div>';
  box.innerHTML = h;

  var q = function(id){ return document.getElementById(id); };
  q("rdMClose").onclick = rdCloseModelPanel;
  box.querySelectorAll(".rd-m-tab").forEach(function(b){
    b.onclick = function(){
      var k = b.getAttribute("data-k");
      box.querySelectorAll(".rd-m-tab").forEach(function(x){ x.classList.toggle("on", x === b); });
      box.querySelectorAll(".rd-m-form").forEach(function(f){ f.classList.toggle("hidden", f.getAttribute("data-form") !== k); });
    };
  });

  ["local", "cloud"].forEach(function(k){
    var out = q("rdP_" + k + "_out");
    q("rdP_" + k + "_models").onclick = async function(){
      out.textContent = "正在拉取模型列表…";
      try {
        var r = await API._fetch(API_BASE + "/api/llm/models?kind=" + k, {headers:{"Accept":"application/json"}}, 180000);
        var names = (r && (r.models || r.data || [])) || [];
        names = names.map(function(x){ return typeof x === "string" ? x : (x.id || x.name || ""); }).filter(Boolean);
        out.textContent = names.length ? ("可用模型：" + names.join("、")) : ((r && (r.error || r.note)) || "未获取到模型列表");
      } catch (e){ out.textContent = "拉取失败：" + (e.message || e); }
    };
    q("rdP_" + k + "_test").onclick = async function(){
      out.textContent = "正在测试连通性（本地模型首次加载可能较慢）…";
      try {
        var r = await API._fetch(API_BASE + "/api/llm/test?kind=" + k + "&model=" + encodeURIComponent(q("rdP_" + k + "_model").value || ""), {headers:{"Accept":"application/json"}}, 300000);
        out.textContent = (r && r.ok)
          ? ("连通正常 · " + (r.model || "") + " · 延迟 " + (r.latency_ms ? (r.latency_ms / 1000).toFixed(1) + "s" : "?")
             + (r.num_ctx ? (" · num_ctx " + r.num_ctx) : "") + (r.reply ? (" · 回复：" + r.reply) : ""))
          : ("连通失败：" + ((r && (r.error || r.reason)) || "未知原因"));
      } catch (e){ out.textContent = "测试失败：" + (e.message || e); }
    };
    q("rdP_" + k + "_save").onclick = async function(){
      var profile = {
        base_url: q("rdP_" + k + "_base").value.trim(),
        model: q("rdP_" + k + "_model").value.trim()
      };
      var kv = q("rdP_" + k + "_key").value;
      if (kv) profile.api_key = kv;
      var ctxv = q("rdP_" + k + "_ctx").value.trim();
      if (ctxv !== "") profile.num_ctx = Number(ctxv);
      var tv = q("rdP_" + k + "_temp").value.trim();
      if (tv !== "") profile.temperature = Number(tv);
      var mv = q("rdP_" + k + "_mt").value.trim();
      if (mv !== "") profile.max_tokens = Number(mv);
      out.textContent = "正在保存…";
      try {
        var r = await API.post("/api/llm/config", { kind: k, active: k, profile: profile });
        if (!r || !r.ok) throw new Error((r && r.reason) || "保存失败");
        RD_CFG = r;
        out.textContent = "已保存并切换为「" + (k === "local" ? "本地" : "云") + "」模型。";
        rdRefreshModelName();
        rdToast("模型配置已更新");
      } catch (e){ out.textContent = "保存失败：" + (e.message || e); }
    };
  });
}

/* ---------------------------------------------------------------- 启动 */
/* =============================================================================
   阅读选择器（悬浮按钮 + 面板）—— 阅读视口左上角
   · 面板：搜索框（debounce 300ms，命中本体 Paper 实例的 title/abstract/author/
     keyword/organization/year 等字段，命中词高亮）+「最近阅读」/「分类浏览」双标签页
   · 阅读历史持久化在 localStorage，工作台进入阅读页时自动恢复上次文献与页码
   ============================================================================= */
var RD_HIST_KEY = "wb_read_history";
var RD_HIST_MAX = 40;
var RDP = { open:false, tab:"recent", q:"", timer:null, seq:0, results:null,
            folded:{}, dimFolded:{}, inited:false, total:0, lastSync:0 };

/* ---------------- 阅读历史持久化 ---------------- */
function rdHistLoad(){
  try {
    var a = JSON.parse(localStorage.getItem(RD_HIST_KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch (e){ return []; }
}
function rdHistSave(a){
  try { localStorage.setItem(RD_HIST_KEY, JSON.stringify((a || []).slice(0, RD_HIST_MAX))); } catch (e){}
}
function rdHistTouch(){
  if (!RD.name) return;
  var k = String(RD.name).toLowerCase(), prev = null;
  var a = rdHistLoad().filter(function(x){
    if (String(x.name || "").toLowerCase() === k){ prev = x; return false; }
    return true;
  });
  a.unshift({
    name: RD.name, title: RD.title || RD.name,
    pid: RD.pid || null, nid: RD.nid || null,
    page: (prev && prev.page) || RD.page || 1,
    pages: RD.pages || (prev && prev.pages) || 0,
    time: Date.now()
  });
  rdHistSave(a);
}
function rdHistPage(page, pages){
  if (!RD.name || !page) return;
  var k = String(RD.name).toLowerCase(), a = rdHistLoad(), hit = null;
  for (var i = 0; i < a.length; i++){ if (String(a[i].name || "").toLowerCase() === k){ hit = a[i]; break; } }
  if (!hit){ rdHistTouch(); return; }
  hit.page = page;
  if (pages) hit.pages = pages;
  hit.time = Date.now();
  rdHistSave(a);
}
function rdHistDrop(){
  if (!RD.name) return;
  var k = String(RD.name).toLowerCase();
  rdHistSave(rdHistLoad().filter(function(x){ return String(x.name || "").toLowerCase() !== k; }));
}
function rdHistTop(){
  return rdHistLoad().sort(function(x, y){ return (y.time || 0) - (x.time || 0); });
}
function rdAgo(t){
  if (!t) return "";
  var d = Date.now() - t;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
  if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
  if (d < 172800000) return "昨天";
  if (d < 604800000) return Math.floor(d / 86400000) + " 天前";
  var dt = new Date(t);
  return (dt.getMonth() + 1) + "月" + dt.getDate() + "日";
}
/* 页码变更同步到历史（节流，避免翻页时频繁写盘） */
function rdPickerPageSync(page, pages){
  if (RD.restorePage > 1) return;      /* 正在恢复上次页码，暂不回写 */
  var now = Date.now();
  if (now - RDP.lastSync < 900) return;
  RDP.lastSync = now;
  rdHistPage(page, pages);
}
/* 历史索引：文件名(小写) -> 历史记录 */
function rdPickHistMap(){
  var m = {}, a = rdHistTop();
  a.forEach(function(x){ m[String(x.name || "").toLowerCase()] = x; });
  return m;
}
/* ---------------- 阅读视口校正（打开即第 1 页 + 适配容器宽度） ---------------- */
function rdFrameWin(){
  var f = rdEl("readFrame");
  try { return (f && f.contentWindow) ? f.contentWindow : null; } catch (e) { return null; }
}
function rdFrameDoc(){
  var w = rdFrameWin();
  try { return w ? w.document : null; } catch (e) { return null; }
}
/* iframe 内已渲染的页面块数量（等真实渲染完成，而非仅 ready 标志） */
function rdRenderedPages(){
  var d = rdFrameDoc(); if (!d) return 0;
  try { return d.querySelectorAll(".pdf-page, .sheet").length; } catch (e) { return 0; }
}
/* 阅读区滚动位置归零（第 1 页顶部） */
function rdViewportScrollReset(){
  var d = rdFrameDoc(); if (!d) return;
  try {
    var v = d.querySelector(".viewer");
    if (v) v.scrollTop = 0;
    if (d.documentElement) d.documentElement.scrollTop = 0;
    if (d.body) d.body.scrollTop = 0;
  } catch (e) {}
}
/* 容器尺寸变化时：若处于「适应宽度」模式，按当前页重新适配，避免重排后错位 */
function rdViewportRefit(){
  if (!RD.key || RD.busy || RD.viewFixing) return;
  var st = null;
  try { st = RD.host && RD.host.getState(); } catch (e) {}
  if (!st || st.fitWidth !== true) return;   /* 用户手动缩放过，不干预 */
  var page = RD.page || 1;
  try { RD.host.fitWidth(); } catch (e) {}
  if (page > 1) setTimeout(function(){ try { RD.host.gotoPage(page); } catch (e) {} }, 220);
}
function rdViewportWatch(){
  var f = rdEl("readFrame");
  if (!f || !window.ResizeObserver || f.__rdRO) return;
  try {
    var t = 0;
    var ro = new ResizeObserver(function(){ clearTimeout(t); t = setTimeout(rdViewportRefit, 320); });
    ro.observe(f);
    f.__rdRO = ro;
  } catch (e) {}
}
/* 打开文献后统一校正：等渲染与容器尺寸稳定 → 适应宽度 → 跳到目标页（默认第 1 页，仅续读才 >1） */
function rdViewportFix(target){
  var want = parseInt(target || 1, 10) || 1;
  var tries = 0, stable = 0, lastW = -1, lastH = -1;
  RD.viewFixing = true;
  rdViewportWatch();
  var timer = setInterval(function(){
    tries++;
    var f = rdEl("readFrame");
    var w = f ? f.clientWidth : 0, h = f ? f.clientHeight : 0;
    var ok = RD.host && RD.ready && RD.pages > 0 && w > 0 && h > 0 && rdRenderedPages() > 0;
    if (!ok || w !== lastW || h !== lastH){ lastW = w; lastH = h; stable = 0; }
    else stable++;
    if (stable < 2){
      if (tries > 140){ clearInterval(timer); RD.restorePage = 0; RD.viewFixing = false; rdSyncBar(); }
      return;
    }
    clearInterval(timer);
    try { RD.host.fitWidth(); } catch (e) {}
    var jumps = 0;
    (function jump(){
      var page = Math.min(want, RD.pages || want);
      if (RD.page !== page && jumps < 4){
        jumps++;
        try { RD.host.gotoPage(page); } catch (e) {}
        setTimeout(jump, 260);
        return;
      }
      if (want <= 1) rdViewportScrollReset();
      RD.restorePage = 0;
      RD.viewFixing = false;
      rdSyncBar();
      rdPickerAfterOpen();
    })();
  }, 120);
}
/* 恢复上次阅读页码：等阅读器就绪后轮询跳页，避免过早调用被忽略 */
function rdRestorePage(target){
  if (!(target > 1)){ RD.restorePage = 0; return; }
  var tries = 0, timer = setInterval(function(){
    tries++;
    if (!RD.host || !RD.ready || !RD.pages){ if (tries > 90){ clearInterval(timer); RD.restorePage = 0; } return; }
    var want = Math.min(target, RD.pages);
    if (RD.page !== want){ try { RD.host.gotoPage(want); } catch (e) {} }
    else {
      clearInterval(timer);
      RD.restorePage = 0;
      rdSyncBar();
      rdPickerAfterOpen();
      return;
    }
    if (tries > 90){ clearInterval(timer); RD.restorePage = 0; }
  }, 250);
}

/* ---------------- 面板开关 ---------------- */
function rdPickOpen(){
  var el = rdEl("rdPick"); if (!el) return;
  RDP.open = true;
  el.classList.add("on");
  var m = rdEl("rdPickMask"); if (m) m.classList.add("on");
  var b = rdEl("rdPickBtn"); if (b) b.classList.add("on");
  rdPickRender();
  var q = rdEl("rdPickQ"); if (q) q.focus();
}
function rdPickClose(){
  RDP.open = false;
  var el = rdEl("rdPick"); if (el) el.classList.remove("on");
  var m = rdEl("rdPickMask"); if (m) m.classList.remove("on");
  var b = rdEl("rdPickBtn"); if (b) b.classList.remove("on");
}
function rdPickToggle(){ if (RDP.open) rdPickClose(); else rdPickOpen(); }
function rdPickTab(t){
  RDP.tab = t;
  var a = rdEl("rdPickTabRecent"), c = rdEl("rdPickTabCat");
  if (a) a.classList.toggle("on", t === "recent");
  if (c) c.classList.toggle("on", t === "cat");
  var q = rdEl("rdPickQ");
  if (q && q.value){ q.value = ""; RDP.q = ""; }
  rdPickQState();
  RDP.seq++;
  rdPickRender();
}
function rdPickQState(){
  var w = rdEl("rdPickSearchWrap");
  if (w) w.classList.toggle("hasq", !!String(RDP.q || "").trim());
}

/* ---------------- 搜索（debounce 300ms + 后端 /api/read/search） ---------------- */
function rdPickOnInput(v){
  RDP.q = String(v == null ? "" : v);
  rdPickQState();
  clearTimeout(RDP.timer);
  var q = RDP.q.trim();
  if (!q){
    RDP.seq++;
    RDP.results = null;
    rdPickRender();
    return;
  }
  var body = rdEl("rdPickBody");
  if (body) body.innerHTML = '<div class="rdp-empty">检索中…</div>';
  RDP.timer = setTimeout(function(){ rdPickSearch(q); }, 300);
}
function rdPickClear(){
  var q = rdEl("rdPickQ");
  if (q) q.value = "";
  rdPickOnInput("");
  if (q) q.focus();
}
async function rdPickSearch(q){
  var my = ++RDP.seq, r = null;
  try { r = await API.get("/api/read/search?limit=60&q=" + encodeURIComponent(q)); } catch (e){ r = null; }
  if (my !== RDP.seq) return;                    /* 丢弃过期响应 */
  if (!r || !r.ok || !r.results) r = rdPickLocalSearch(q);   /* 后端不可用：降级本地匹配 */
  RDP.results = r.results || [];
  RDP.q = q;
  rdPickRender();
}
function rdPickLocalSearch(q){
  var terms = String(q || "").toLowerCase().split(/[\s,，;；、\/|]+/).filter(Boolean);
  var out = [];
  (PAPERS || []).forEach(function(p){
    var fields = {
      title: p.title || "", abstract: p.sum || "", author: rdJoinArr(p.authors),
      keyword: rdJoinArr(p.kw), organization: p.org || "", year: String(p.year || ""),
      venue: p.journal || "", researchArea: p.dir || "", file: p.file || ""
    };
    var hits = {}, score = 0, miss = false;
    terms.forEach(function(t){
      var fs = [];
      Object.keys(fields).forEach(function(k){
        if (String(fields[k] || "").toLowerCase().indexOf(t) >= 0){
          fs.push(k);
          score += (k === "title" || k === "file") ? 3
                 : ((k === "author" || k === "keyword" || k === "organization") ? 2 : 1);
        }
      });
      if (!fs.length) miss = true; else hits[t] = fs;
    });
    if (miss || !terms.length) return;
    out.push({ name: p.file, file: p.file, title: p.title, pid: p.id || null, nid: p.nid || null,
               year: p.year || "", venue: p.journal || "", authors: rdArr(p.authors),
               keywords: rdArr(p.kw), orgs: p.org ? [p.org] : [], summary: p.sum || "",
               score: score, hits: hits });
  });
  out.sort(function(a, b){ return b.score - a.score; });
  return { ok: true, q: q, total: out.length, results: out.slice(0, 60), local: true };
}
function rdArr(v){ return Array.isArray(v) ? v : (v ? [v] : []); }
function rdJoinArr(v){ return rdArr(v).join(" "); }

/* ---------------- 渲染 ---------------- */
function rdPickTerms(){
  return String(RDP.q || "").toLowerCase().split(/[\s,，;；、\/|]+/).filter(Boolean);
}
function rdPickHi(text, terms){
  var t = esc(text || "");
  var ts = (terms || []).map(function(x){ return esc(x); }).filter(Boolean);
  if (!ts.length) return t;
  var re = new RegExp("(" + ts.map(function(x){ return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + ")", "gi");
  return t.replace(re, "<mark>$1</mark>");
}
function rdPickItemHtml(it, terms, pageLabel, extraCls){
  var meta = [];
  if (pageLabel) meta.push('<span class="pg">' + esc(pageLabel) + '</span>');
  if (it.year) meta.push('<span>' + esc(it.year) + '</span>');
  if (it.venue) meta.push('<span>' + esc(short(it.venue, 24)) + '</span>');
  if (it.time) meta.push('<span>' + esc(rdAgo(it.time)) + '</span>');
  var tags = "";
  if (it.hits){
    var names = { title:"标题", abstract:"摘要", author:"作者", keyword:"关键词", organization:"机构",
                  year:"年份", venue:"期刊", researchArea:"领域", file:"文件名" };
    var seen = {}, list = [];
    Object.keys(it.hits).forEach(function(t){
      (it.hits[t] || []).forEach(function(f){ if (!seen[f]){ seen[f] = 1; list.push(names[f] || f); } });
    });
    if (list.length) tags = '<div class="rdp-m">' + list.slice(0, 4).map(function(x){
      return '<span class="rdp-tag">' + esc(x) + '</span>'; }).join("") + '</div>';
  }
  var sub = it.summary ? '<div class="rdp-m"><span>' + rdPickHi(short(it.summary, 92), terms) + '</span></div>' : "";
  return '<div class="rdp-item' + (extraCls ? " " + extraCls : "") + '"'
    + ' data-name="' + esc(it.name || it.file || "") + '"'
    + ' data-title="' + esc(it.title || "") + '"'
    + ' data-page="' + esc(it.page || 0) + '"'
    + ' data-pid="' + esc(it.pid || "") + '" data-nid="' + esc(it.nid || "") + '">'
    + '<div class="rdp-i"><div class="rdp-t">' + rdPickHi(short(it.title || it.name || "未命名文献", 96), terms) + '</div>'
    + (meta.length ? '<div class="rdp-m">' + meta.join("") + '</div>' : "")
    + tags + sub
    + '</div><span class="rdp-go">›</span></div>';
}
function rdPickRender(){
  var q = String(RDP.q || "").trim();
  if (q) return rdPickRenderSearch();
  if (RDP.tab === "recent") return rdPickRenderRecent();
  return rdPickRenderCat();
}
function rdPickRenderRecent(){
  var body = rdEl("rdPickBody"); if (!body) return;
  var list = rdHistTop().slice(0, 20);
  if (!list.length){
    body.innerHTML = '<div class="rdp-empty">暂无阅读记录<br>从「分类浏览」或搜索结果中选择文献开始阅读</div>';
    return;
  }
  var h = '<div class="rdp-dim">最近阅读 · ' + list.length + ' 篇</div>';
  list.forEach(function(it){
    var pg = it.pages ? ((it.page || 1) + "/" + it.pages) : ((it.page || 1) + " 页");
    h += rdPickItemHtml(it, [], pg, String(it.name || "").toLowerCase() === RD.key ? "on" : "");
  });
  body.innerHTML = h;
}
function rdPickDimValues(d){
  var m = {};
  (PAPERS || []).forEach(function(p){
    var vs = null;
    try { vs = d.get(p); } catch (e){ vs = null; }
    if (!vs) return;
    rdArr(vs).forEach(function(v){
      v = String(v == null ? "" : v).trim();
      if (v) m[v] = (m[v] || 0) + 1;
    });
  });
  return m;
}
function rdPickGroupList(d, v){
  return (PAPERS || []).filter(function(p){
    var vs = null;
    try { vs = d.get(p); } catch (e){ vs = null; }
    if (!vs) return false;
    return rdArr(vs).some(function(x){ return String(x == null ? "" : x).trim() === v; });
  });
}
function rdPickRenderCat(){
  var body = rdEl("rdPickBody"); if (!body) return;
  var dims = (DIMS || []).filter(function(d){ return d && d.get && !d.synthetic; });
  if (!dims.length){ body.innerHTML = '<div class="rdp-empty">暂无可用于分类的维度</div>'; return; }
  var h = "";
  dims.forEach(function(d){
    var m = rdPickDimValues(d);
    var keys = Object.keys(m).sort(function(a, b){ return m[b] - m[a] || (a < b ? -1 : 1); });
    if (!keys.length) return;
    var shown = keys.slice(0, 20);
    var dimOpen = RDP.dimFolded[d.key] === true;
    var total = keys.reduce(function(a, k){ return a + (m[k] || 0); }, 0);
    h += '<div class="rdp-dim' + (dimOpen ? " open" : "") + '" data-dim="' + esc(d.key) + '">'
      + '<span class="cv">▶</span><span class="nm">' + esc(d.name) + '</span>'
      + '<span class="nn">' + keys.length + ' 组 · ' + total + ' 篇</span></div>';
    if (!dimOpen) return;
    shown.forEach(function(v){
      var gk = d.key + "::" + v, open = RDP.folded[gk] === true, items;
      h += '<div class="rdp-grp' + (open ? " open" : "") + '" data-grp="' + esc(gk) + '">'
        + '<div class="rdp-grp-h"><span class="cv">▶</span><span class="nm">' + esc(v)
        + '</span><span class="n">' + m[v] + ' 篇</span></div><div class="rdp-grp-b">';
      if (open){
        items = rdPickGroupList(d, v);
        var hm2 = rdPickHistMap();
        h += items.length ? items.map(function(p){
          var hh = hm2[String(p.file || "").toLowerCase()];
          var lbl = hh ? ("已读 · " + rdAgo(hh.time)) : "";
          return rdPickItemHtml({ name: p.file, file: p.file, title: p.title, year: p.year,
                                  venue: p.journal, pid: p.id || null, nid: p.nid || null,
                                  authors: p.authors }, [], lbl,
                                String(p.file || "").toLowerCase() === RD.key ? "on" : "");
        }).join("") : '<div class="rdp-empty">该分组暂无文献</div>';
      }
      h += '</div></div>';
    });
    if (keys.length > shown.length)
      h += '<div class="rdp-more">仅显示前 ' + shown.length + ' 组（共 ' + keys.length + ' 组）</div>';
  });
  body.innerHTML = h || '<div class="rdp-empty">暂无分类数据</div>';
}
function rdPickRenderSearch(){
  var body = rdEl("rdPickBody"); if (!body) return;
  var list = RDP.results || [];
  if (!list.length){
    body.innerHTML = '<div class="rdp-empty">未找到匹配的文献<br>可换关键词，或清空搜索回到「最近阅读 / 分类浏览」</div>';
    return;
  }
  var terms = rdPickTerms();
  var h = '<div class="rdp-dim">搜索命中 ' + list.length + ' 篇 · 关键词「' + esc(RDP.q) + '」</div>';
  var hmS = rdPickHistMap();
  list.forEach(function(it){
    var hh = hmS[String(it.name || it.file || "").toLowerCase()];
    var lbl = hh ? ("已读 · " + rdAgo(hh.time)) : "";
    h += rdPickItemHtml(it, terms, lbl,
                        String(it.name || it.file || "").toLowerCase() === RD.key ? "on" : "");
  });
  body.innerHTML = h;
}
function rdPickGroupToggle(gk){ RDP.folded[gk] = !RDP.folded[gk]; rdPickRender(); }
/* 本体维度大组折叠：默认展开，点击维度名收起/展开（收起时二级内容不渲染） */
function rdPickDimToggle(dk){ if (!dk) return; RDP.dimFolded[dk] = RDP.dimFolded[dk] !== true; rdPickRender(); }

/* ---------------- 交互绑定 ---------------- */
function rdPickOpenItem(el){
  var name = el.getAttribute("data-name") || "";
  if (!name){ rdToast("该条目未关联本地文件"); return; }
  var page = parseInt(el.getAttribute("data-page") || "0", 10) || 0;
  rdPickClose();
  openReader({ name: name, title: el.getAttribute("data-title") || "",
               pid: el.getAttribute("data-pid") || null,
               nid: el.getAttribute("data-nid") || null,
               page: page, from: "picker" });
}
function rdPickBadgeLoad(){
  var b = rdEl("rdPickBadge"); if (!b) return;
  b.textContent = (PAPERS && PAPERS.length) ? PAPERS.length : 0;
  API.get("/api/read/list").then(function(r){
    var n = (r && r.ok && r.docs) ? r.docs.length : 0;
    if (n){ b.textContent = n; RDP.total = n; }
  });
}
function rdPickBoot(){
  if (RDP.inited) return;
  var b = rdEl("rdPickBtn"); if (!b) return;
  RDP.inited = true;

  b.onclick = function(e){ e.preventDefault(); e.stopPropagation(); rdPickToggle(); };
  var c = rdEl("rdPickClose"); if (c) c.onclick = function(e){ e.stopPropagation(); rdPickClose(); };
  var cb = rdEl("rdPickBack"); if (cb) cb.onclick = function(e){ e.stopPropagation(); rdPickClose(); };
  var m = rdEl("rdPickMask"); if (m) m.onclick = function(){ rdPickClose(); };
  var tr = rdEl("rdPickTabRecent"); if (tr) tr.onclick = function(){ rdPickTab("recent"); };
  var tc = rdEl("rdPickTabCat"); if (tc) tc.onclick = function(){ rdPickTab("cat"); };
  var clr = rdEl("rdPickClear"); if (clr) clr.onclick = function(e){ e.stopPropagation(); rdPickClear(); };

  var q = rdEl("rdPickQ");
  if (q){
    q.addEventListener("input", function(){ rdPickOnInput(q.value); });
    q.addEventListener("keydown", function(e){
      if (e.key === "Escape"){ e.stopPropagation(); rdPickClear(); }
      else if (e.key === "Enter"){
        e.preventDefault();
        clearTimeout(RDP.timer);
        if (q.value.trim()) rdPickSearch(q.value.trim());
      }
    });
  }
  var body = rdEl("rdPickBody");
  if (body){
    body.addEventListener("click", function(e){
      /* 面板内点击一律不冒泡到 document 的「点击外部关闭」监听：
         分组切换会重建 body.innerHTML，脱离文档的 e.target 会让 contains() 判定失效而误关闭面板 */
      e.stopPropagation();
      var t = e.target;
      var it = t && t.closest ? t.closest(".rdp-item") : null;
      if (it){ rdPickOpenItem(it); return; }
      var dh = t && t.closest ? t.closest(".rdp-dim[data-dim]") : null;
      if (dh){ rdPickDimToggle(dh.getAttribute("data-dim")); return; }
      var gh = t && t.closest ? t.closest(".rdp-grp-h") : null;
      if (gh && gh.parentNode && gh.parentNode.getAttribute){
        var gk = gh.parentNode.getAttribute("data-grp");
        if (gk) rdPickGroupToggle(gk);
      }
    });
  }
  /* 面板外点击收起（面板与按钮之外） */
  document.addEventListener("click", function(e){
    if (!RDP.open) return;
    var el = rdEl("rdPick");
    /* 用 composedPath 判定派发时的原始链路：即使监听途中面板被重绘，
       也不会把「面板内点击」误判为「外部点击」而导致弹窗闪退 */
    var path = (e.composedPath && e.composedPath()) || null;
    if (path && el && path.indexOf(el) >= 0) return;
    if (el && el.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest("#rdPickBtn")) return;
    rdPickClose();
  });
  document.addEventListener("keydown", function(e){ if (e.key === "Escape" && RDP.open) rdPickClose(); });
  rdPickBadgeLoad();
}
/* 文献载入完成：写入阅读历史 + 刷新面板 */
function rdPickerAfterOpen(){
  rdHistTouch();
  if (RDP.open) rdPickRender();
}
/* 进入阅读页：默认显示上一次阅读的文献与页码 */
function rdPickerAutoRestore(){
  if (RD.key || RD.busy) return;
  var list = rdHistTop();
  if (!list.length) return;
  var it = list[0];
  if (!it || !it.name) return;
  openReader({ name: it.name, title: it.title || "", pid: it.pid || null,
               nid: it.nid || null, page: parseInt(it.page || 0, 10) || 0, from: "restore" });
}

function rdBoot(){
  if (RD.booted) return;
  RD.booted = true;
  rdBindBar();
  rdPickBoot();
  rdRefreshModelName();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", rdBoot);
else rdBoot();

/* ============================================================================
   P2 批次（本轮新增，独立代码块；对既有函数只做「包装增强」，不修改既有函数体）
     P2-1 编辑—暂存—发布三段式（服务端草稿 / 提案 / 评审 / 发布 + 版本快照与审计）
     P2-2 双层同构编辑器（TBox 画布 + ABox 画布，统一右键菜单 / 拖拽连线 / 撤销重做）
     P2-3 一致性校验与推理看板（覆盖率 / 一致性 / 孤儿实例 / 域值冲突 + 提交前预检）
     P2-4 乐观并发（base_rev / expected_checksum，冲突 409 不静默覆盖）
     P2-5 语义能力扩展（rdfs:subClassOf / 等价类 / 互斥类 / 域值约束 可视化编辑）
   ============================================================================ */
var P2 = {
  layer: "tbox",        /* tbox | abox */
  pending: [],          /* ABox 待提交变更队列 */
  redo: [],             /* 撤销后的重做栈 */
  lastBatch: null,      /* 上次提交成功的变更（供「撤销上次提交」reverse 使用） */
  preImage: null,       /* 上次提交前的节点/边镜像（用于计算反向变更） */
  baseRev: null,        /* P2-4：结构版本基线 */
  graphEtag: null,      /* P2-4：图谱 checksum 基线 */
  preValidate: true,    /* P2-3：结构提交前是否跑 SHACL+OWL 预检 */
  semA: null,           /* P2-5：类公理构建器的基准类（子类 / 左操作数） */
  menuEl: null,
  linkFrom: null
};

/* ---------------- 通用浮层菜单 ---------------- */
function p2CloseMenu(){
  if (P2.menuEl && P2.menuEl.parentNode) P2.menuEl.parentNode.removeChild(P2.menuEl);
  P2.menuEl = null;
}
function p2ShowMenu(x, y, items){
  p2CloseMenu();
  var d = document.createElement("div");
  d.style.cssText = "position:fixed;z-index:9999;left:"+x+"px;top:"+y+"px;background:#fff;border:1px solid #ced4da;"
    + "border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);padding:4px;min-width:200px;font-size:12.5px;line-height:1.5";
  items.forEach(function(it){
    if (it === "-"){
      var hr = document.createElement("div");
      hr.style.cssText = "height:1px;background:#e9ecef;margin:4px 2px";
      d.appendChild(hr); return;
    }
    var b = document.createElement("div");
    b.textContent = it.label;
    b.style.cssText = "padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;color:"+(it.danger?"#c92a2a":"#212529");
    b.onmouseenter = function(){ b.style.background = "#f1f3f5"; };
    b.onmouseleave = function(){ b.style.background = "transparent"; };
    b.onclick = function(){ p2CloseMenu(); try{ it.fn(); }catch(e){ wbToast("操作失败："+e.message); } };
    d.appendChild(b);
  });
  document.body.appendChild(d);
  var r = d.getBoundingClientRect();
  if (x + r.width  > window.innerWidth)  d.style.left = Math.max(4, window.innerWidth  - r.width  - 8) + "px";
  if (y + r.height > window.innerHeight) d.style.top  = Math.max(4, window.innerHeight - r.height - 8) + "px";
  P2.menuEl = d;
}
document.addEventListener("click", function(e){
  if (P2.menuEl && P2.menuEl.contains(e.target)) return;
  p2CloseMenu();
});
document.addEventListener("keydown", function(e){ if (e.key === "Escape") p2CloseMenu(); });

/* ---------------- P1-4/P1-5/P2-1：待提交清单（扩展结构操作名） ---------------- */
function p2RenderSchPending(){
  var box = document.getElementById("schPending");
  var cnt = document.getElementById("schPendCount");
  if (cnt) cnt.textContent = SCH.changes.length;
  var bar = document.getElementById("schPendBar");
  if (bar){
    bar.classList.toggle("has-pend", SCH.changes.length > 0);
    var bt = document.getElementById("schPendBarText");
    if (bt) bt.textContent = SCH.changes.length
      ? ("待提交 " + SCH.changes.length + " 项（点「提交 / 存草案 / 发布」才生效）")
      : "待提交 0 项";
  }
  if (!box) return;
  if (!SCH.changes.length){
    box.innerHTML = '<div class="sch-tip">暂无。新增 / 删除项会显示在这里，点 × 可撤销。</div>';
    return;
  }
  var names = {add_class:"新增类", update_class:"改中文名", delete_class:"删除类",
               add_data_prop:"新增数据属性", add_obj_prop:"新增对象关系", delete_prop:"删除属性",
               add_subclass:"增设父类", delete_subclass:"删除父类",
               add_equivalent:"等价类", delete_equivalent:"删除等价类",
               add_disjoint:"互斥类", delete_disjoint:"删除互斥类",
               set_value_constraint:"设取值约束", delete_value_constraint:"删除取值约束"};
  box.innerHTML = SCH.changes.map(function(c,i){
    var extra = "";
    if (c.range) extra = "（"+esc(c.domain||"")+" → "+esc(c.range)+"）";
    else if (c.label) extra = "（"+esc(c.label)+"）";
    else if (c.child || c.parent) extra = "（"+esc(c.child||c.name||"")+" ⊑ "+esc(c.parent||"")+"）";
    else if (c.a || c.b) extra = "（"+esc(c.a||"")+" ↔ "+esc(c.b||"")+"）";
    else if (c.datatype || c["in"] || c.min != null || c.max != null || c.pattern) {
      extra = "（" + [c.datatype?("datatype="+esc(c.datatype)):"",
                      (c["in"]?("in="+esc((c["in"]||[]).join("|"))):""),
                      (c.min!=null?("min="+esc(c.min)):""), (c.max!=null?("max="+esc(c.max)):""),
                      (c.pattern?("pattern="+esc(c.pattern)):"")].filter(function(x){return x;}).join(" · ") + "）";
    }
    var label = c.name || c.child || c.a || c.prop || "";
    return '<div class="pend"><span class="t">'+(names[c.operation]||c.operation)+'：'+esc(label)+extra
      + '</span><span class="pend-x" onclick="schUndo('+i+')">×</span></div>';
  }).join("");
}
renderSchPending = p2RenderSchPending;

/* ---------------- P2-4：请求侧自动携带并发基线 ---------------- */
var _p2_apiPost = API.post;
API.post = function(url, body){
  try{
    if (url === "/api/ontology/schema" || url.indexOf("/api/ontology/draft/publish") === 0
        || url.indexOf("/api/ontology/proposal") === 0){
      body = body || {};
      if (P2.baseRev != null && body.base_rev === undefined) body.base_rev = P2.baseRev;
    }
    if (url === "/api/ontology/schema" && P2.preValidate && body && body.validate === undefined){
      body.validate = true;   /* P2-3：发布前 SHACL + OWL 预检（不触碰真实文件） */
    }
    if (url === "/api/commit"){
      body = body || {};
      if (P2.graphEtag && body.expected_checksum === undefined) body.expected_checksum = P2.graphEtag;
    }
  }catch(e){}
  var _p2r = _p2_apiPost.call(API, url, body);
  try{
    if (url === "/api/commit" && _p2r && _p2r.then){
      _p2r = _p2r.then(function(res){
        /* P2-4：提交成功后刷新图谱基线；并发冲突时用服务端回传的 etag 自动纠偏，
           避免一次冲突导致后续所有提交连续 409。 */
        if (res && res.ok && res.etag) P2.graphEtag = res.etag;
        else if (res && (res.status === "conflict" || res.expected_checksum)){
          P2.graphEtag = res.etag || P2.graphEtag;
          try{ wbToast("检测到并发冲突，已刷新基线，请确认后重试"); }catch(e){}
        }
        return res;
      });
    }
  }catch(e){}
  return _p2r;
};
async function p2RefreshRevs(){
  try{
    var r = await API.get("/api/ontology/rev");
    if (r && r.ok){ P2.baseRev = r.rev; P2.graphEtag = r.graph_etag || ""; }
  }catch(e){}
  try{
    var st = await API.get("/api/graph/stats");
    if (st && st.ok){ P2.graphEtag = st.etag || P2.graphEtag; }
  }catch(e){}
  p2RenderRevLine();
}
function p2RenderRevLine(){
  var el = document.getElementById("p2RevInfo");
  if (!el) return;
  el.textContent = "结构基线已就绪 · 其他会话若已发布新结构，本次提交会提示冲突而不会静默覆盖。";
}

/* ---------------- 包装：打开弹窗时刷新 rev / 看板 / 语义清单 ---------------- */
var _p2_openSchemaModal = openSchemaModal;
openSchemaModal = function(){
  _p2_openSchemaModal.apply(this, arguments);
  p2RenderRevLine();
  p2RenderSemantics();
  p2RenderProposals();
  p2LoadHealth();
};

/* ---------------- P2-5：语义清单渲染 ---------------- */
function p2Ext(){
  return (RAW.schema && RAW.schema.ext) || {};
}
/* --- P2-5 收尾①：类公理构建器（⊑ / ≡ / ⊥ 的选择与按钮） --- */
function p2ClassTag(k){
  var sc = (RAW.schema && RAW.schema.classes) || {};
  return (sc[k] && sc[k].ext) ? "扩展" : "原生";
}
function p2PendAxiomKeys(){
  var out = {};
  (SCH.changes || []).forEach(function(c){
    if (!c) return;
    if (c.operation === "add_subclass") out["sub|" + c.child + "|" + c.parent] = true;
    if (c.operation === "add_equivalent") out["equivalent|" + [c.a, c.b].sort().join("|")] = true;
    if (c.operation === "add_disjoint") out["disjoint|" + [c.a, c.b].sort().join("|")] = true;
  });
  return out;
}
function p2HasAxiom(kind, x, y){
  var e = p2Ext();
  if (kind === "sub" || kind === "subclass")
    return ((e.subclass || {})[x] || []).indexOf(y) >= 0;
  var arr = (e[kind === "disjoint" ? "disjoint" : "equivalent"] || []);
  var key = [x, y].sort().join("|");
  return arr.some(function(p){ return p && p.length === 2 && [p[0], p[1]].sort().join("|") === key; });
}
function p2RenderSemBuilder(){
  var bd = document.getElementById("p2SemBuilder");
  var hint = document.getElementById("p2SemHint");
  if (!bd){
    if (hint) hint.textContent = "管理区块缺失（#p2SemBuilder 未找到）";
    return;
  }
  var cls = Object.keys((RAW.schema && RAW.schema.classes) || {});
  var a = P2.semA || null;
  var pend = p2PendAxiomKeys();
  if (hint){
    hint.textContent = a
      ? ("当前基准 A = " + a + "（" + p2ClassTag(a) + "类）。A 是子类 / 左操作数：点目标行 ⊑ 生成「" + a
         + " ⊑ 目标」，≡ 生成等价类，⊥ 生成互斥类；点「清除 A」可重选。")
      : "先点某行类名右侧的「设为 A」选定基准类（A 作为子类 / 左操作数），再点目标行的「⊑ / ≡ / ⊥」生成规则；原生类与扩展类均可参与。";
  }
  if (!cls.length){
    bd.innerHTML = '<div class="sch-tip">类清单尚未加载（请先点「刷新」或重新打开本弹窗）。</div>';
    return;
  }
  bd.innerHTML = cls.map(function(k){
    var isA = (a === k);
    var marks = [];
    if (a && a !== k){
      if (p2HasAxiom("subclass", a, k)) marks.push("⊑ 已存在");
      else if (pend["sub|" + a + "|" + k]) marks.push("⊑ 待提交");
      if (p2HasAxiom("equivalent", a, k)) marks.push("≡ 已存在");
      else if (pend["equivalent|" + [a, k].sort().join("|")]) marks.push("≡ 待提交");
      if (p2HasAxiom("disjoint", a, k)) marks.push("⊥ 已存在");
      else if (pend["disjoint|" + [a, k].sort().join("|")]) marks.push("⊥ 待提交");
    }
    return '<div class="pend"' + (isA ? ' style="background:#eef6ff"' : '') + '>'
      + '<span class="t">' + esc(schemaLabel ? schemaLabel(k) : k)
      + ' <span style="color:var(--muted)">（' + esc(k) + ' · ' + p2ClassTag(k) + '类）</span>'
      + (isA ? ' <span style="color:#1c7ed6">[基准 A]</span>' : "")
      + (marks.length ? ' <span style="color:#1c7ed6">[' + esc(marks.join(" · ")) + ']</span>' : "")
      + '</span>'
      + '<span style="display:flex;gap:4px;flex:0 0 auto">'
      + (isA
          ? '<button class="mini-btn" onclick="schP2SetA(null)">清除 A</button>'
          : '<button class="mini-btn" data-cls="' + esc(k) + '" onclick="schP2SetA(this.getAttribute(\'data-cls\'))">设为 A</button>')
      + '<button class="mini-btn" data-cls="' + esc(k) + '" data-kind="sub" title="设为该行的父类（A 是子类）" onclick="schP2Sem(this)">⊑</button>'
      + '<button class="mini-btn" data-cls="' + esc(k) + '" data-kind="equivalent" title="设为该行的等价类" onclick="schP2Sem(this)">≡</button>'
      + '<button class="mini-btn" data-cls="' + esc(k) + '" data-kind="disjoint" title="设为该行的互斥类" onclick="schP2Sem(this)">⊥</button>'
      + '</span></div>';
  }).join("");
}
/* --- P2-5 收尾②：取值约束表单的候选提示（id 口径与 HTML 完全一致） --- */
function p2RenderVcOptions(){
  var dl = document.getElementById("p2VcNameList");
  if (dl){
    var dp = Object.keys((RAW.schema && RAW.schema.data_props) || {});
    dl.innerHTML = dp.map(function(n){ return '<option value="' + esc(n) + '"></option>'; }).join("");
  }
  var sel = document.getElementById("p2VcDatatype");
  if (sel && sel.getAttribute("data-filled") !== "1"){
    var xs = (RAW.schema && RAW.schema.xsd_types) || [];
    sel.innerHTML = '<option value="">（不限制 datatype）</option>'
      + xs.map(function(t){ return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join("");
    sel.setAttribute("data-filled", "1");
  }
}
function p2RenderSemantics(){
  p2RenderSemBuilder();
  p2RenderVcOptions();
  var box = document.getElementById("p2SemList");
  if (!box) return;
  var e = p2Ext();
  var rows = [];
  Object.keys(e.subclass || {}).forEach(function(child){
    (e.subclass[child] || []).forEach(function(parent){
      rows.push(['子类关系', schemaLabel(child) + " ⊑ " + schemaLabel(parent),
                 'schP2DelSub("'+esc(child)+'","'+esc(parent)+'")']);
    });
  });
  (e.equivalent || []).forEach(function(p){
    if (!p || p.length < 2) return;
    rows.push(['等价关系', schemaLabel(p[0]) + " ≡ " + schemaLabel(p[1]),
               'schP2DelPair("equivalent","'+esc(p[0])+'","'+esc(p[1])+'")']);
  });
  (e.disjoint || []).forEach(function(p){
    if (!p || p.length < 2) return;
    rows.push(['互斥关系', schemaLabel(p[0]) + " ⊥ " + schemaLabel(p[1]),
               'schP2DelPair("disjoint","'+esc(p[0])+'","'+esc(p[1])+'")']);
  });
  Object.keys(e.value_constraints || {}).forEach(function(pn){
    var s = e.value_constraints[pn] || {};
    var d = [s.datatype?("datatype="+s.datatype):"", s["in"]?("in="+(s["in"]||[]).join("|")):"",
             (s.min!=null?("min="+s.min):""), (s.max!=null?("max="+s.max):""),
             (s.pattern?("pattern="+s.pattern):"")].filter(function(x){return x;}).join(" · ");
    rows.push(['取值规则', pn + "：" + d, 'schP2DelVC("'+esc(pn)+'")']);
  });
  box.innerHTML = rows.length ? rows.map(function(r){
    return '<div class="pend"><span class="t">'+esc(r[0])+'：'+esc(r[1])+'</span>'
      + '<span class="pend-x" onclick=\''+r[2]+'\'>×</span></div>';
  }).join("") : '<div class="sch-tip">暂无子类 / 等价 / 互斥 / 取值规则。用上方表单添加，提交后正式生效。</div>';
}
function schP2Push(ch, tip){
  SCH.changes.push(ch);
  saveSchDraft();
  renderSchPending();
  schResult(tip || "已加入待提交（点「提交」生效）", false);
}
/* --- P2-5 收尾③：⊑ / ≡ / ⊥ 的交互入口（替换原 schP2AddSub / schP2AddPair 的选择框依赖） --- */
function schP2SetA(cls){
  P2.semA = cls || null;
  p2RenderSemantics();
}
function schP2Sem(btn){
  var target = (btn && btn.getAttribute("data-cls")) || "";
  var kind = (btn && btn.getAttribute("data-kind")) || "";
  var a = P2.semA;
  if (!a){ schResult("请先点某一行的「设为 A」选定基准类（A 为子类）", true); return; }
  if (!target || target === a){ schResult("两端类不能相同（A = " + a + "）", true); return; }
  var pend = p2PendAxiomKeys();
  if (kind === "sub"){
    if (p2HasAxiom("subclass", a, target)){ schResult("子类关系已存在：" + a + " ⊑ " + target, true); return; }
    if (pend["sub|" + a + "|" + target]){ schResult("已加入待提交：" + a + " ⊑ " + target, true); return; }
    schP2Push({operation:"add_subclass", child:a, parent:target},
              "已加入待提交：子类关系 " + a + " ⊑ " + target + "（" + a + " 是子类）");
  } else {
    if (kind !== "equivalent" && kind !== "disjoint"){ schResult("未知语义关系：" + kind, true); return; }
    var isDj = (kind === "disjoint");
    var sym = isDj ? " ⊥ " : " ≡ ";
    if (p2HasAxiom(kind, a, target) || pend[kind + "|" + [a, target].sort().join("|")]){
      schResult((isDj ? "互斥类" : "等价类") + "已存在或已在待提交：" + a + sym + target, true); return;
    }
    schP2Push({operation: (isDj ? "add_disjoint" : "add_equivalent"), a:a, b:target},
              "已加入待提交：" + (isDj ? "互斥类 " : "等价类 ") + a + sym + target);
  }
  p2RenderSemantics();
}
function schP2DelSub(child, parent){
  schP2Push({operation:"delete_subclass", child:child, parent:parent}, "已加入待提交：删除 " + child + " ⊑ " + parent);
  p2RenderSemantics();
}
function schP2DelPair(kind, a, b){
  schP2Push({operation: (kind === "disjoint" ? "delete_disjoint" : "delete_equivalent"), a:a, b:b},
            "已加入待提交：删除 " + kind + " " + a + " / " + b);
  p2RenderSemantics();
}
/* --- P2-5 收尾④：取值约束表单（读取 id 与 HTML 完全对齐：p2VcName / p2VcDatatype / p2VcIn / p2VcMin / p2VcMax / p2VcPattern） --- */
function schP2AddVC(){
  var nameEl = document.getElementById("p2VcName");
  var name = (nameEl ? nameEl.value : "").trim();
  if (!name){ schResult("请填写数据属性名（取值约束仅支持数据属性）", true); return; }
  var dp = Object.keys((RAW.schema && RAW.schema.data_props) || {});
  if (dp.length && dp.indexOf(name) < 0){
    schResult("取值约束仅支持数据属性；已加载的数据属性：" + dp.join("、"), true); return;
  }
  var ch = {operation:"set_value_constraint", name:name};
  var dtEl = document.getElementById("p2VcDatatype");
  var dt = (dtEl ? dtEl.value : "").trim();
  var inEl = document.getElementById("p2VcIn");
  var inRaw = (inEl ? inEl.value : "").trim();
  var mnEl = document.getElementById("p2VcMin");
  var mn = (mnEl ? mnEl.value : "").trim();
  var mxEl = document.getElementById("p2VcMax");
  var mx = (mxEl ? mxEl.value : "").trim();
  var patEl = document.getElementById("p2VcPattern");
  var pat = (patEl ? patEl.value : "").trim();
  if (dt) ch.datatype = dt;
  if (inRaw) ch["in"] = inRaw.split(",").map(function(s){ return s.trim(); }).filter(function(s){ return s; });
  if (mn !== "") ch.min = mn;
  if (mx !== "") ch.max = mx;
  if (pat) ch.pattern = pat;
  if (!dt && !inRaw && mn === "" && mx === "" && !pat){
    schResult("取值约束至少填一项（datatype / 枚举 / min / max / pattern）", true); return;
  }
  if (mn !== "" && isNaN(Number(mn))){ schResult("min 必须为数字", true); return; }
  if (mx !== "" && isNaN(Number(mx))){ schResult("max 必须为数字", true); return; }
  if (pat){ try{ new RegExp(pat); }catch(e){ schResult("pattern 不是合法正则：" + e.message, true); return; } }
  schP2Push(ch, "已加入待提交：取值约束 " + name);
  ["p2VcName", "p2VcIn", "p2VcMin", "p2VcMax", "p2VcPattern"].forEach(function(i){
    var el = document.getElementById(i); if (el) el.value = "";
  });
  var dEl = document.getElementById("p2VcDatatype"); if (dEl) dEl.value = "";
  p2RenderSemantics();
}
function schP2DelVC(name){
  schP2Push({operation:"delete_value_constraint", name:name}, "已加入待提交：删除取值约束 " + name);
  p2RenderSemantics();
}

/* ---------------- P2-3：一致性 / 覆盖看板 ---------------- */
async function p2LoadHealth(){
  var box = document.getElementById("p2Health");
  if (!box) return;
  box.innerHTML = '<div class="sch-tip">正在计算覆盖 / 一致性指标（JSON 层 + rdflib/owlrl/pyshacl 推理层）…</div>';
  try{
    var r = await API.get("/api/ontology/health?ttl=1");
    if (!r || r.ok === false){ box.innerHTML = '<div class="sch-tip">看板不可用：'+esc((r&&r.reason)||"未知原因")+'</div>'; return; }
    var cov = r.coverage || {}, iss = r.issues || {}, tt = r.ttl || {};
    function pct(x){ return x == null ? "—" : (Math.round(x*1000)/10) + "%"; }
    var vio = (tt.violations || []);
    var bad = vio.filter(function(v){ return v.level === "error"; });
    var h = [];
    h.push('<div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0">'
      + '<span class="k">规模：节点 '+(r.scale&&r.scale.nodes)+' / 边 '+(r.scale&&r.scale.edges)
      + ' / 类 '+(r.scale&&r.scale.classes)+' / 对象属性 '+(r.scale&&r.scale.obj_props)+'</span>'
      + '<span class="k">类覆盖率 <b>'+pct(cov.class_coverage)+'</b></span>'
      + '<span class="k">实例挂接率 <b>'+pct(cov.instance_attached_rate)+'</b></span>'
      + '<span class="k">对象属性使用率 <b>'+pct(cov.obj_prop_usage)+'</b></span>'
      + '<span class="k">必填填充率 <b>'+pct(cov.required_fill_rate)+'</b></span>'
      + '<span class="k">一致性 <b>'+(tt.available?(tt.inconsistent?"不一致":"一致"):"依赖不可用")+'</b></span>'
      + '<span class="k">取值错误 <b>'+bad.length+'</b></span>'
      + '</div>');
    if (tt.available === false && tt.error) h.push('<div class="sch-tip">推理层不可用：'+esc(tt.error)+'</div>');
    var lines = [];
    (iss.orphan_nodes || []).slice(0,8).forEach(function(o){ lines.push('孤儿实例：'+o); });
    if ((iss.orphan_count||0) > 8) lines.push('（孤儿实例共 '+iss.orphan_count+' 个，仅列前 8）');
    (iss.domain_range_conflicts || []).slice(0,8).forEach(function(c){
      lines.push('域/值冲突：边 '+c.edge+' 用 '+c.prop+'，'+(c.kind==="domain"?"主体":"客体")+'应为 '+c.expect+'，实际 '+c.actual);
    });
    (iss.missing_required || []).slice(0,8).forEach(function(m){
      lines.push('必填缺失：'+m.cls+'/'+m.node+' 缺「'+m.field+'」');
    });
    (iss.duplicate_labels || []).slice(0,5).forEach(function(d){
      lines.push('疑似重复：'+d.type+'「'+d.label+'」→ '+(d.nodes||[]).join(', '));
    });
    if ((cov.unused_obj_props||[]).length) lines.push('未被使用的对象属性：'+(cov.unused_obj_props||[]).join('、'));
    if ((cov.empty_classes||[]).length) lines.push('无实例的类：'+(cov.empty_classes||[]).join('、'));
    bad.slice(0,8).forEach(function(v){ lines.push('取值错误：'+v.msg); });
    (tt.violations||[]).filter(function(v){ return v.level !== "error"; }).slice(0,5)
      .forEach(function(v){ lines.push('取值规则 '+v.level+'：'+v.msg); });
    box.innerHTML = h.join("") + (lines.length
      ? '<div class="sch-tip" style="white-space:pre-wrap">'+lines.map(esc).join("\n")+'</div>'
      : '<div class="sch-tip">未发现孤儿实例 / 域值冲突 / 必填缺失。</div>');
  }catch(e){
    box.innerHTML = '<div class="sch-tip">看板读取失败：'+esc(e.message)+'</div>';
  }
}


;

/* ================= 管理区 v5 重构交互逻辑（复用 v6 后端链路） ================= */
(function(){
  if (!document.getElementById("view-onto")) return;
  var MGT = window.MGT = window.MGT || {};
  function $(id){ return document.getElementById(id); }
  function esc2(s){ return esc(s); }

  /* ---------- 状态 ---------- */
  MGT.sel = null; MGT.tab = "structure"; MGT.zoom = 1;
  var RULE = {step:1, a:null, b:null, kind:null};
  var CONS = {step:1, kind:null, k:null};

  /* ---------- 浮层工具 ---------- */
  MGT.toast = function(msg){ if (window.wbToast) wbToast(msg); };
  MGT.openModal = function(id){ var m = $(id); if (m) m.classList.add("open"); };
  MGT.closeModal = function(id){ var m = $(id); if (m) m.classList.remove("open"); };
  function closeAllModals(){
    ["modal-class","modal-rel","modal-rule","modal-cons","modal-relinfo","modal-confirm","modal-input"].forEach(function(id){ MGT.closeModal(id); });
  }
  MGT.askConfirm = function(title, msg, onOk, okLabel){
    $("cfm-title").textContent = title || "确认";
    $("cfm-msg").innerHTML = msg || "";
    var ok = $("cfm-ok"); ok.textContent = okLabel || "确认执行";
    ok.onclick = function(){ MGT.closeModal("modal-confirm"); if (onOk) onOk(); };
    $("cfm-cancel").onclick = function(){ MGT.closeModal("modal-confirm"); };
    MGT.openModal("modal-confirm");
  };
  MGT.askInput = function(title, msg, initial, onOk){
    $("inp-title").textContent = title || "输入";
    $("inp-msg").innerHTML = msg || "";
    var inp = $("inp-value"); inp.value = initial == null ? "" : String(initial);
    inp.onkeydown = function(ev){ if (ev.key === "Enter"){ MGT.closeModal("modal-input"); if (onOk) onOk(inp.value); } };
    $("inp-ok").onclick = function(){ MGT.closeModal("modal-input"); if (onOk) onOk(inp.value); };
    $("inp-cancel").onclick = function(){ MGT.closeModal("modal-input"); };
    MGT.openModal("modal-input");
    setTimeout(function(){ try{ inp.focus(); inp.select(); }catch(e){} }, 30);
  };

  /* ---------- Inspector ---------- */
  MGT.openInspector = function(k, tab){
    if (!k) return;
    MGT.sel = k;
    if (state) { state.ontoClass = k; state.ontoInst = null; state.edit = null; }
    MGT.tab = tab || MGT.tab;
    var s = schData();
    var c = (s && s.classes && s.classes[k]) || {};
    $("inspTitle").textContent = schemaLabel(k) + "（" + k + "）";
    $("inspSub").textContent = c.ext ? "扩展对象类型（可增删改）" : "对象类型";
    $("inspector").classList.add("open");
    MGT.switchInspTab(MGT.tab);
    MGT.renderStat();
  };
  MGT.closeInspector = function(){ var i = $("inspector"); if (i) i.classList.remove("open"); MGT.sel = null; };
  MGT.switchInspTab = function(tab){
    MGT.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll("#insp-tabs .insp-tab"), function(b){
      b.classList.toggle("on", b.getAttribute("data-tab") === tab);
    });
    ["insp-structure","insp-instance","insp-rule"].forEach(function(p){
      $(p).classList.toggle("on", p === "insp-" + tab);
    });
    if (tab === "structure") MGT.renderStructure();
    else if (tab === "instance"){ if (window.renderOntoPanel) renderOntoPanel(); MGT.renderInspFoot(); }
    else if (tab === "rule") MGT.renderRule();
    MGT.renderInspFoot();
  };

  /* ---------- 结构 Tab ---------- */
  MGT.renderStructure = function(){
    var k = MGT.sel, box = $("insp-structure");
    if (!box || !k) return;
    var s = schData();
    if (!s || !s.classes){ box.innerHTML = '<div class="sch-tip">本体结构未加载（请先点「刷新」或重开管理页）。</div>'; return; }
    var c = s.classes[k] || {};
    var counts = s.instance_counts || {};
    var e = p2Ext();
    var h = "";
    h += '<div class="sec-card"><div class="sec-title">基本信息</div>'
      + '<div class="kv"><span class="k">标识</span><span class="v">' + esc(k) + '</span></div>'
      + '<div class="kv"><span class="k">中文名</span><span class="v">' + esc(schemaLabel(k)) + '</span></div>'
      + '<div class="kv"><span class="k">实例数</span><span class="v">' + (counts[k] || 0) + '</span></div>'
      + '<div class="kv"><span class="k">来源</span><span class="v">' + (c.ext ? '扩展（可增删改）' : '基线（只读）') + '</span></div></div>';
    var parents = (e.subclass || {})[k] || [];
    if (parents.length){
      h += '<div class="sec-card"><div class="sec-title">上级类型</div>';
      parents.forEach(function(p){
        h += '<div class="axiom-line"><span class="ax-t">' + esc(schemaLabel(k)) + ' ⊑ ' + esc(schemaLabel(p)) + ' <span class="ax-id">（' + esc(p) + '）</span></span>'
          + '<button class="mini-btn danger" data-ax="sub" data-a="' + esc(k) + '" data-b="' + esc(p) + '">删除</button></div>';
      });
      h += '</div>';
    }
    var eqD = [];
    (e.equivalent || []).forEach(function(p){ if (p && p.length === 2 && (p[0] === k || p[1] === k)) eqD.push({kind:"equivalent", a:p[0], b:p[1], t: schemaLabel(p[0]) + " ≡ " + schemaLabel(p[1])}); });
    (e.disjoint || []).forEach(function(p){ if (p && p.length === 2 && (p[0] === k || p[1] === k)) eqD.push({kind:"disjoint", a:p[0], b:p[1], t: schemaLabel(p[0]) + " ⊥ " + schemaLabel(p[1])}); });
    if (eqD.length){
      h += '<div class="sec-card"><div class="sec-title">等价 / 互斥</div>';
      eqD.forEach(function(r){
        h += '<div class="axiom-line"><span class="ax-t">' + esc(r.t) + '</span>'
          + '<button class="mini-btn danger" data-ax="' + r.kind + '" data-a="' + esc(r.a) + '" data-b="' + esc(r.b) + '">删除</button></div>';
      });
      h += '</div>';
    }
    var dprops = [];
    Object.keys(s.data_props || {}).forEach(function(n){
      var m = s.data_props[n] || {};
      if (String(m.domain || "").split("#").pop() === k) dprops.push([n, m]);
    });
    if (dprops.length){
      h += '<div class="sec-card"><div class="sec-title">数据属性（' + dprops.length + '）</div>';
      dprops.forEach(function(p){
        var n = p[0], m = p[1];
        var vc = (s.value_constraints || {})[n];
        var badge = vc ? '<span class="ax-id">（约束：' + esc((vc["in"] && vc["in"].length) ? "枚举" : (vc.pattern ? "格式" : (vc.min != null || vc.max != null ? "范围" : (vc.datatype ? "类型" : "约束")))) + '）</span>' : '';
        h += '<div class="axiom-line"><span class="ax-t">' + esc(n) + ' <span class="ax-id">· ' + esc(m.label || n) + ' · 到=' + esc(m.range || "—") + '</span>' + badge + '</span></div>';
      });
      h += '</div>';
    }
    var oprops = [];
    Object.keys(s.object_props || {}).forEach(function(n){
      var m = s.object_props[n] || {};
      var dom = String(m.domain || "").split("#").pop(), rng = String(m.range || "").split("#").pop();
      if (dom === k || rng === k) oprops.push([n, m, dom, rng]);
    });
    if (oprops.length){
      h += '<div class="sec-card"><div class="sec-title">对象关系（' + oprops.length + '）</div>';
      oprops.forEach(function(p){
        var n = p[0], m = p[1], dom = p[2], rng = p[3];
        h += '<div class="axiom-line"><span class="ax-t">' + esc(n) + ' <span class="ax-id">· ' + esc(m.label || n) + ' · ' + esc(schemaLabel(dom)) + ' → ' + esc(schemaLabel(rng)) + '</span></span>'
          + '<button class="mini-btn" data-goto="' + esc(dom === k ? rng : dom) + '">查看</button></div>';
      });
      h += '</div>';
    }
    var pendN = (SCH.changes || []).filter(function(ch){
      return ch && (ch.name === k || ch.child === k || ch.parent === k || ch.a === k || ch.b === k || ch.domain === k || ch.range === k);
    }).length;
    if (pendN) h += '<div class="sec-card" style="background:#eef3ff;border-color:#a5b8f0"><div class="sec-title">待提交</div><div class="sch-tip" style="margin:0">有 ' + pendN + ' 项变更涉及该类，可在「提交结构变更」后生效。</div></div>';
    h += '<div class="sec-acts">'
      + '<button class="mini-btn" onclick="MGT.openRelModal(\'' + esc(k) + '\')">+ 对象关系</button>'
      + '<button class="mini-btn" onclick="MGT.openRuleWizard(\'' + esc(k) + '\')">+ 关系规则</button>'
      + '<button class="mini-btn" onclick="MGT.openConsWizard(\'' + esc(k) + '\')">+ 数据规则</button>'
      + '<button class="mini-btn primary" onclick="openSchemaModal()">编辑本体结构</button></div>';
    box.innerHTML = h;
    box.querySelectorAll(".mini-btn[data-ax]").forEach(function(b){
      b.addEventListener("click", function(){
        var kind = b.getAttribute("data-ax"), a = b.getAttribute("data-a"), bb = b.getAttribute("data-b");
        if (kind === "sub"){ if (window.schP2DelSub) schP2DelSub(a, bb); }
        else if (window.schP2DelPair) schP2DelPair(kind, a, bb);
        MGT.toast("已加入待删除队列（可在本体编辑弹窗待提交清单撤销）");
        MGT.renderStructure(); MGT.renderRule();
      });
    });
    box.querySelectorAll(".mini-btn[data-goto]").forEach(function(b){
      b.addEventListener("click", function(){ MGT.openInspector(b.getAttribute("data-goto"), "structure"); });
    });
    MGT.renderInspFoot();
  };

  /* ---------- 规则 Tab ---------- */
  MGT.vcFor = function(k){
    var s = schData(); if (!s) return [];
    var fields = {};
    try { (fieldSpecFor(k) || []).forEach(function(f){ if (f && f[0]) fields[f[0]] = 1; }); } catch(e){}
    Object.keys(s.data_props || {}).forEach(function(n){
      var m = s.data_props[n] || {};
      if (String(m.domain || "").split("#").pop() === k) fields[n] = 1;
    });
    var out = [];
    Object.keys(s.value_constraints || {}).forEach(function(n){
      if (!fields[n]) return;
      var c = s.value_constraints[n] || {};
      var d = [c.datatype ? ("类型=" + c.datatype) : "",
               (c["in"] && c["in"].length) ? ("枚举=" + c["in"].join(" / ")) : "",
               (c.min != null ? "最小值=" + c.min : ""),
               (c.max != null ? "最大值=" + c.max : ""),
               (c.pattern ? "格式=" + c.pattern : "")].filter(Boolean).join(" · ");
      out.push({name: n, text: schemaLabel(k) + " 的 " + n + "：" + d});
    });
    return out;
  };
  MGT.renderRule = function(){
    var k = MGT.sel, box = $("insp-rule");
    if (!box || !k) return;
    var s = schData(); if (!s) return;
    var e = p2Ext();
    var h = '<div class="sec-card"><div class="sec-title">关系规则</div>';
    var ax = [];
    Object.keys(e.subclass || {}).forEach(function(ch){
      (e.subclass[ch] || []).forEach(function(pa){ if (ch === k) ax.push({kind:"sub", a:ch, b:pa, t: schemaLabel(ch) + " ⊑ " + schemaLabel(pa)}); });
    });
    (e.equivalent || []).forEach(function(p){ if (p && p.length === 2 && (p[0] === k || p[1] === k)) ax.push({kind:"equivalent", a:p[0], b:p[1], t: schemaLabel(p[0]) + " ≡ " + schemaLabel(p[1])}); });
    (e.disjoint || []).forEach(function(p){ if (p && p.length === 2 && (p[0] === k || p[1] === k)) ax.push({kind:"disjoint", a:p[0], b:p[1], t: schemaLabel(p[0]) + " ⊥ " + schemaLabel(p[1])}); });
    if (ax.length){
      ax.forEach(function(r){
        h += '<div class="axiom-line"><span class="ax-t">' + esc(r.t) + '</span>'
          + '<button class="mini-btn danger" data-ax="' + r.kind + '" data-a="' + esc(r.a) + '" data-b="' + esc(r.b) + '">删除</button></div>';
      });
    } else {
      h += '<div class="sch-tip" style="margin:0">该类暂无关系规则。用「+ 关系规则」三步向导添加（⊑ 子类 / ≡ 等价 / ⊥ 互斥），提交后正式生效。</div>';
    }
    h += '<div style="margin-top:8px"><button class="mini-btn primary" onclick="MGT.openRuleWizard(\'' + esc(k) + '\')">+ 关系规则</button></div></div>';
    h += '<div class="sec-card"><div class="sec-title">数据规则（取值约束）</div>';
    var vcs = MGT.vcFor(k);
    if (vcs.length){
      vcs.forEach(function(v){
        h += '<div class="axiom-line"><span class="ax-t">' + esc(v.text) + '</span>'
          + '<button class="mini-btn danger" data-vc="' + esc(v.name) + '">删除</button></div>';
      });
    } else {
      h += '<div class="sch-tip" style="margin:0">该类暂无取值约束。用「+ 数据规则」向导添加（取值范围 / 枚举 / 格式 / 类型），提交后参与取值校验。</div>';
    }
    h += '<div style="margin-top:8px"><button class="mini-btn primary" onclick="MGT.openConsWizard(\'' + esc(k) + '\')">+ 数据规则</button></div></div>';
    box.innerHTML = h;
    box.querySelectorAll(".mini-btn[data-ax]").forEach(function(b){
      b.addEventListener("click", function(){
        var kind = b.getAttribute("data-ax"), a = b.getAttribute("data-a"), bb = b.getAttribute("data-b");
        if (kind === "sub"){ if (window.schP2DelSub) schP2DelSub(a, bb); }
        else if (window.schP2DelPair) schP2DelPair(kind, a, bb);
        MGT.toast("已加入待删除队列（可在本体编辑弹窗待提交清单撤销）");
        MGT.renderRule(); MGT.renderStructure();
      });
    });
    box.querySelectorAll(".mini-btn[data-vc]").forEach(function(b){
      b.addEventListener("click", function(){
        if (window.schP2DelVC) schP2DelVC(b.getAttribute("data-vc"));
        MGT.toast("已加入待删除队列（可在本体编辑弹窗待提交清单撤销）");
        MGT.renderRule(); MGT.renderStructure();
      });
    });
    MGT.renderInspFoot();
  };

  /* ---------- Inspector 底部 ---------- */
  MGT.renderInspFoot = function(){
    var save = $("insp-save"), hint = $("inspHint");
    if (!save) return;
    var n = (SCH.changes || []).length;
    if (MGT.tab === "instance"){
      save.textContent = "保存实例变更";
      save.onclick = function(){
        if (typeof reload === "function") reload(false);
        if (typeof renderOntoCanvas === "function") renderOntoCanvas();
        if (typeof renderOntoPanel === "function") renderOntoPanel();
        MGT.toast("实例与关系改动已保存生效");
      };
      hint.textContent = "实例与关系改动保存后立即生效并记录版本";
    } else {
      save.textContent = n ? ("提交 " + n + " 项结构变更") : "编辑本体结构";
      save.onclick = function(){
        if (n){
          MGT.askConfirm("提交结构变更", "将提交 " + n + " 项待提交变更（类 / 属性 / 关系规则 / 取值规则）。提交后正式生效并生成版本记录，可在「版本 / 回滚」中回滚。", function(){
            if (window.schCommit) schCommit();
            MGT.renderStructure(); MGT.renderRule();
            MGT.renderStat();
          });
        } else {
          if (window.openSchemaModal) openSchemaModal();
        }
      };
      hint.textContent = n ? ("有 " + n + " 项待提交变更") : "无待提交变更";
    }
  };

  /* ---------- 统计行 ---------- */
  MGT.renderStat = function(){
    var s = schData(), n = 0;
    if (s && s.classes) n = Object.keys(s.classes).length;
    var t = $("stat-text");
    if (t) t.textContent = n + " 个对象类型 · " + ((RAW.stats && RAW.stats.nodes) || 0) + " 条实例 · " + ((RAW.stats && RAW.stats.edges) || 0) + " 条关系";
  };

  /* ---------- FAB / 新建对象类型 ---------- */
  MGT.openClassModal = function(){
    $("mgtClsName").value = ""; $("mgtClsLabel").value = ""; $("mgtClassErr").innerHTML = "";
    MGT.openModal("modal-class");
  };
  MGT.saveClass = function(){
    var name = $("mgtClsName").value.trim(), label = $("mgtClsLabel").value.trim();
    var err = $("mgtClassErr");
    if (!name){ err.innerHTML = "请填写类名（英文）"; return; }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)){ err.innerHTML = "类名须字母开头，仅含字母 / 数字 / 下划线"; return; }
    var s = schData();
    if (s && (s.classes || {})[name]){ err.innerHTML = "类 " + name + " 已存在"; return; }
    if ((SCH.changes || []).some(function(c){ return c && c.operation === "add_class" && c.name === name; })){ err.innerHTML = "类 " + name + " 已在待提交队列"; return; }
    SCH.changes.push({operation: "add_class", name: name, label: label || name});
    saveSchDraft(); renderSchPending();
    MGT.closeModal("modal-class");
    MGT.toast("已加入待提交：新增对象类型 " + name + "（提交后生效）");
    renderOntoCanvas(); MGT.renderStat();
  };

  /* ---------- 新建对象关系 ---------- */
  MGT.openRelModal = function(def){
    var opts = schClassNamesEff().map(function(n){
      var lb = schemaLabel(n);
      return '<option value="' + esc(n) + '">' + esc(n) + (lb && lb !== n ? " · " + esc(lb) : "") + '</option>';
    }).join("");
    $("mgtRelDomain").innerHTML = opts;
    $("mgtRelRange").innerHTML = opts;
    if (def && $("mgtRelDomain").querySelector('option[value="' + def + '"]')) $("mgtRelDomain").value = def;
    $("mgtRelName").value = ""; $("mgtRelLabel").value = ""; $("mgtRelErr").innerHTML = "";
    MGT.openModal("modal-rel");
  };
  MGT.saveRel = function(){
    var name = $("mgtRelName").value.trim(), label = $("mgtRelLabel").value.trim();
    var dom = $("mgtRelDomain").value, rng = $("mgtRelRange").value;
    var err = $("mgtRelErr");
    if (!name){ err.innerHTML = "请填写关系名（英文）"; return; }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)){ err.innerHTML = "关系名须字母开头，仅含字母 / 数字 / 下划线"; return; }
    if (dom === rng){ err.innerHTML = "“从”与“到”不能是同一个类"; return; }
    var s = schData();
    if (s && ((s.object_props || {})[name] || (s.data_props || {})[name])){ err.innerHTML = "属性 " + name + " 已存在"; return; }
    if ((SCH.changes || []).some(function(c){ return c && (c.operation === "add_obj_prop" || c.operation === "add_data_prop") && c.name === name; })){ err.innerHTML = name + " 已在待提交队列"; return; }
    SCH.changes.push({operation: "add_obj_prop", name: name, label: label || name, domain: dom, range: rng});
    saveSchDraft(); renderSchPending();
    MGT.closeModal("modal-rel");
    MGT.toast("已加入待提交：对象关系 " + name + "（" + dom + " → " + rng + "），提交后生效");
    renderOntoCanvas(); MGT.renderStat();
  };

  /* ---------- 关系规则三步向导 ---------- */
  MGT.openRuleWizard = function(defA){
    RULE = {step:1, a: defA || null, b: null, kind: null};
    var opts = schClassNamesEff().map(function(n){
      return '<option value="' + esc(n) + '">' + esc(n) + " · " + esc(schemaLabel(n)) + '</option>';
    }).join("");
    $("wiz-a").innerHTML = opts; $("wiz-b").innerHTML = opts;
    if (RULE.a && $("wiz-a").querySelector('option[value="' + RULE.a + '"]')) $("wiz-a").value = RULE.a;
    MGT.updateWizard();
    MGT.openModal("modal-rule");
  };
  MGT.updateWizard = function(){
    var st = $("wiz-steps");
    if (st) st.innerHTML = ["关系主体", "关系客体", "关系类型"].map(function(t, i){
      return '<span class="step-chip' + (i + 1 <= RULE.step ? " on" : "") + '">' + (i + 1) + ". " + t + '</span>';
    }).join("");
    [1, 2, 3].forEach(function(s){ var el = $("wiz-step-" + s); if (el) el.classList.toggle("on", RULE.step === s); });
    var pv = $("wiz-prev"), nx = $("wiz-next"), ok = $("wiz-ok");
    if (pv) pv.style.display = RULE.step <= 1 ? "none" : "";
    if (nx) nx.style.display = RULE.step >= 3 ? "none" : "";
    if (ok) ok.style.display = RULE.step >= 3 ? "" : "none";
    if (RULE.step >= 2 && $("wiz-a")) RULE.a = $("wiz-a").value;
    if (RULE.step >= 3 && $("wiz-b")) RULE.b = $("wiz-b").value;
    MGT.renderWizEcho();
  };
  MGT.setRelKind = function(kind){
    RULE.kind = kind;
    Array.prototype.forEach.call(document.querySelectorAll("#rel-btns .rel-btn"), function(b){
      b.classList.toggle("on", b.getAttribute("data-rel") === kind);
    });
    MGT.renderWizEcho();
  };
  MGT.renderWizEcho = function(){
    var box = $("wiz-echo"); if (!box) return;
    var parts = [];
    if (RULE.a) parts.push("主体：<b>" + esc(schemaLabel(RULE.a)) + "</b>（" + esc(RULE.a) + "）");
    if (RULE.b) parts.push("客体：<b>" + esc(schemaLabel(RULE.b)) + "</b>（" + esc(RULE.b) + "）");
    if (RULE.kind && RULE.a && RULE.b){
      var sym = RULE.kind === "sub" ? "⊑" : (RULE.kind === "equivalent" ? "≡" : "⊥");
      parts.push("关系：<b>" + esc(schemaLabel(RULE.a)) + " " + sym + " " + esc(schemaLabel(RULE.b)) + "</b>");
    }
    box.innerHTML = parts.length ? parts.join("　") : "选择关系主体、客体与关系类型后，这里会显示规则回显";
  };
  MGT.wizNext = function(){
    if (RULE.step === 1){
      RULE.a = $("wiz-a").value;
      if (!RULE.a){ MGT.toast("请选择关系主体"); return; }
    }
    if (RULE.step === 2){
      RULE.b = $("wiz-b").value;
      if (!RULE.b){ MGT.toast("请选择关系客体"); return; }
      if (RULE.a === RULE.b){ MGT.toast("主体与客体不能相同"); return; }
    }
    RULE.step = Math.min(3, RULE.step + 1);
    MGT.updateWizard();
  };
  MGT.wizPrev = function(){ RULE.step = Math.max(1, RULE.step - 1); MGT.updateWizard(); };
  MGT.saveAxiom = function(){
    var a = $("wiz-a").value, b = $("wiz-b").value, kind = RULE.kind;
    if (!kind){ MGT.toast("请选择关系类型（⊑ 子类 / ≡ 等价 / ⊥ 互斥）"); return; }
    if (a === b){ MGT.toast("主体与客体不能相同"); return; }
    if (p2HasAxiom(kind === "sub" ? "subclass" : kind, a, b)){ MGT.toast("该规则已存在"); return; }
    var pend = p2PendAxiomKeys();
    if (kind === "sub" && pend["sub|" + a + "|" + b]){ MGT.toast("该规则已在待提交队列"); return; }
    if (kind !== "sub" && pend[kind + "|" + [a, b].sort().join("|")]){ MGT.toast("该规则已在待提交队列"); return; }
    var ch = kind === "sub" ? {operation: "add_subclass", child: a, parent: b}
      : kind === "equivalent" ? {operation: "add_equivalent", a: a, b: b}
      : {operation: "add_disjoint", a: a, b: b};
    var sym = kind === "sub" ? "⊑" : (kind === "equivalent" ? "≡" : "⊥");
    schP2Push(ch, "已加入待提交：关系规则 " + schemaLabel(a) + " " + sym + " " + schemaLabel(b) + "（提交后正式生效）");
    MGT.closeModal("modal-rule");
    if (MGT.sel) MGT.renderRule();
    renderOntoCanvas(); MGT.renderStat();
  };

  /* ---------- 数据规则两步向导 ---------- */
  MGT.TPL = [
    {kind: "range", name: "取值范围", desc: "限定数值 / 日期在 min～max 之间", icon: "↕"},
    {kind: "enum", name: "只能选这些", desc: "白名单枚举（逗号分隔选项）", icon: "☰"},
    {kind: "pattern", name: "格式", desc: "正则 / 预设（DOI、ISSN 等）", icon: "#"},
    {kind: "datatype", name: "类型", desc: "限定数据类型（string / integer / …）", icon: "T"},
    {kind: "required", name: "必填", desc: "必填（在结构编辑弹窗声明）", icon: "!"},
    {kind: "unique", name: "不重复", desc: "唯一性建议（v6 后端暂未支持，可用格式约束近似）", icon: "1"}
  ];
  MGT.openConsWizard = function(defK){
    CONS = {step: 1, kind: null, k: defK || MGT.sel || null};
    MGT.renderConsTpls();
    MGT.updateConsSteps();
    MGT.openModal("modal-cons");
  };
  MGT.renderConsTpls = function(){
    var box = $("cons-tpls");
    box.innerHTML = MGT.TPL.map(function(t){
      return '<button class="tpl-btn' + (CONS.kind === t.kind ? " on" : "") + '" data-kind="' + t.kind + '">'
        + '<span class="tpl-ic">' + t.icon + '</span><span class="tpl-name">' + t.name + '</span><span class="tpl-desc">' + t.desc + '</span></button>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll(".tpl-btn"), function(b){
      b.addEventListener("click", function(){
        CONS.kind = b.getAttribute("data-kind");
        MGT.renderConsTpls();
        MGT.gotoConsStep2();
      });
    });
  };
  MGT.updateConsSteps = function(){
    var st = $("cons-steps");
    if (st) st.innerHTML = ["规则模板", "参数与回显"].map(function(t, i){
      return '<span class="step-chip' + (CONS.step === i + 1 ? " on" : "") + '">' + (i + 1) + ". " + t + '</span>';
    }).join("");
    var s1 = $("cons-s1"), s2 = $("cons-s2");
    if (s1) s1.classList.toggle("on", CONS.step === 1);
    if (s2) s2.classList.toggle("on", CONS.step === 2);
  };
  MGT.gotoConsStep2 = function(){
    CONS.step = 2; MGT.updateConsSteps();
    MGT.consFieldSpec();
  };
  MGT.fieldOptions = function(k){
    var s = schData(); if (!s) return '<option value="">（暂无字段）</option>';
    var seen = {}, opts = [];
    try {
      (fieldSpecFor(k) || []).forEach(function(f){
        if (f && f[0] && !seen[f[0]]){ seen[f[0]] = 1; opts.push('<option value="' + esc(f[0]) + '">' + esc(f[0]) + '（' + esc(f[1]) + '）</option>'); }
      });
    } catch(e){}
    Object.keys(s.data_props || {}).forEach(function(n){
      var m = s.data_props[n] || {};
      if (String(m.domain || "").split("#").pop() !== k || seen[n]) return;
      seen[n] = 1; opts.push('<option value="' + esc(n) + '">' + esc(n) + '（' + esc(m.label || n) + '）</option>');
    });
    return opts.join("") || '<option value="">（暂无字段）</option>';
  };
  MGT.consFieldSpec = function(){
    var kind = CONS.kind, k = CONS.k || MGT.sel || null;
    var box = $("cons-fields");
    var err = $("cons-err"); if (err) err.innerHTML = "";
    if (!kind){ box.innerHTML = ""; return; }
    if (kind === "required" || kind === "unique"){
      box.innerHTML = '<div class="cons-note">' + (kind === "required"
        ? '「必填」由结构编辑弹窗中的必填声明维护，不在取值规则队列中。请在「编辑本体结构」弹窗中为该类声明必填字段。'
        : '「不重复」暂未支持为取值规则；建议改用「格式」模板近似表达。') + '</div>';
      MGT.consText(); return;
    }
    var h = '<div class="form-row"><label>目标字段</label><select id="cons-field">' + MGT.fieldOptions(k) + '</select></div>';
    if (kind === "range"){
      h += '<div class="form-row"><label>最小值 min</label><input id="cons-min" placeholder="如 1900" autocomplete="off"></div>'
        + '<div class="form-row"><label>最大值 max</label><input id="cons-max" placeholder="如 2100" autocomplete="off"></div>';
    } else if (kind === "enum"){
      h += '<div class="form-row"><label>允许取值（逗号分隔）</label><textarea id="cons-in" rows="3" placeholder="如 期刊论文, 会议论文, 综述"></textarea></div>';
    } else if (kind === "pattern"){
      h += '<div class="form-row"><label>模式来源</label><select id="cons-mode">'
        + '<option value="doi">DOI（预设）</option><option value="issn">ISSN（预设）</option>'
        + '<option value="custom">自定义正则</option></select></div>'
        + '<div class="form-row"><label>正则表达式（自定义时填写）</label><input id="cons-pattern" placeholder="如 ^[0-9]{4}-[0-9]{4}$" autocomplete="off"></div>';
    } else if (kind === "datatype"){
      var xs = (s && s.xsd_types && s.xsd_types.length) ? s.xsd_types : ["string", "integer", "decimal", "boolean", "date", "gYear", "anyURI"];
      h += '<div class="form-row"><label>数据类型</label><select id="cons-datatype">'
        + xs.map(function(t){ return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join("") + '</select></div>';
    }
    box.innerHTML = h;
    MGT.consText();
  };
  MGT.consText = function(){
    var kind = CONS.kind, box = $("cons-rule"), im = $("cons-impact"), wn = $("cons-warn");
    if (!kind){ if (box) box.innerHTML = ""; if (im) im.innerHTML = ""; if (wn) wn.innerHTML = ""; return; }
    var k = CONS.k || MGT.sel || null;
    var f = ($("cons-field") || {}).value || "";
    var txt = "";
    if (kind === "range"){
      var mn = ($("cons-min") || {}).value || "", mx = ($("cons-max") || {}).value || "";
      txt = (f || "字段") + " ∈ [" + (mn || "—") + ", " + (mx || "—") + "]";
    } else if (kind === "enum"){
      var inv = ($("cons-in") || {}).value || "";
      txt = (f || "字段") + " ∈ {" + (inv || "—") + "}";
    } else if (kind === "pattern"){
      var md = ($("cons-mode") || {}).value || "doi";
      txt = (f || "字段") + " 匹配 " + (md === "custom" ? (($("cons-pattern") || {}).value || "自定义正则") : (md === "doi" ? "DOI 格式" : "ISSN 格式"));
    } else if (kind === "datatype"){
      var dt = ($("cons-datatype") || {}).value || "";
      txt = (f || "字段") + " : xsd:" + dt;
    } else if (kind === "required"){ txt = "必填（需在结构编辑弹窗声明）"; }
    else if (kind === "unique"){ txt = "不重复（v6 后端暂未支持为取值约束，建议用格式近似）"; }
    if (box) box.innerHTML = "规则回显：<b>" + esc(txt) + "</b>";
    if (im) im.innerHTML = (k && f) ? ("影响：<b>" + esc(schemaLabel(k)) + "</b> 下字段 <b>" + esc(f) + "</b> 的取值规则（提交后校验）") : "影响：提交后参与取值校验";
    if (wn) wn.innerHTML = (kind === "required" || kind === "unique") ? '<div class="cons-warn-in">该模板不会写入取值约束队列，仅作能力说明</div>' : "";
  };
  MGT.saveCons = function(){
    var kind = CONS.kind;
    if (!kind){ MGT.toast("请先选择规则模板"); return; }
    if (kind === "required"){ MGT.closeModal("modal-cons"); MGT.toast("必填约束请在「编辑本体结构」弹窗的扩展区维护"); return; }
    if (kind === "unique"){ MGT.closeModal("modal-cons"); MGT.toast("v6 后端暂未支持 unique 约束，可用格式模板近似表达"); return; }
    var f = ($("cons-field") || {}).value;
    if (!f){ MGT.toast("请选择目标字段"); return; }
    var err = $("cons-err");
    var ch = {operation: "set_value_constraint", name: f};
    if (kind === "range"){
      var mn = ($("cons-min") || {}).value, mx = ($("cons-max") || {}).value;
      if ((mn === undefined || mn === "") && (mx === undefined || mx === "")){ err.innerHTML = "请至少填写 min 或 max"; return; }
      if (mn !== undefined && mn !== "") ch.min = Number(mn);
      if (mx !== undefined && mx !== "") ch.max = Number(mx);
    } else if (kind === "enum"){
      var inv = ($("cons-in") || {}).value.split(",").map(function(x){ return x.trim(); }).filter(Boolean);
      if (!inv.length){ err.innerHTML = "请填写允许取值（逗号分隔）"; return; }
      ch["in"] = inv;
    } else if (kind === "pattern"){
      var md = ($("cons-mode") || {}).value;
      var pat = md === "doi" ? "10.\\d{4,9}/[-._;()/:A-Z0-9]+" : (md === "issn" ? "\\d{4}-\\d{3}[\\dXx]" : (($("cons-pattern") || {}).value || "").trim());
      if (md === "custom" && !pat){ err.innerHTML = "请填写自定义正则"; return; }
      ch.pattern = pat;
    } else if (kind === "datatype"){
      ch.datatype = ($("cons-datatype") || {}).value;
    }
    schP2Push(ch, "已加入待提交：数据规则 " + f + "（提交后参与取值校验）");
    MGT.closeModal("modal-cons");
    if (MGT.sel) MGT.renderRule();
    MGT.renderStat();
  };

  /* ---------- 数据总览 ---------- */
  MGT.openDashboard = function(){
    $("dashboard").classList.add("open");
    MGT.renderDashboard();
    MGT.loadHealth();
    MGT.loadQuality();
  };
  MGT.renderDashboard = function(){
    var s = schData(); var box = $("dv-stats");
    if (!s || !box) return;
    var e = p2Ext();
    var nAx = Object.keys(e.subclass || {}).reduce(function(a, k){ return a + (e.subclass[k] || []).length; }, 0)
      + (e.equivalent || []).length + (e.disjoint || []).length;
    var cards = [
      ["对象类型", Object.keys(s.classes || {}).length],
      ["实例", (RAW.stats && RAW.stats.nodes) || 0],
      ["关系边", (RAW.stats && RAW.stats.edges) || 0],
      ["数据属性", Object.keys(s.data_props || {}).length],
      ["对象关系", Object.keys(s.object_props || {}).length],
      ["关系规则", nAx],
      ["数据规则", Object.keys(s.value_constraints || {}).length],
      ["版本记录", (RAW.manage && RAW.manage.versions && RAW.manage.versions.length) || 0]
    ];
    box.innerHTML = cards.map(function(c){
      return '<div class="dv-stat"><b>' + c[1] + '</b><span>' + c[0] + '</span></div>';
    }).join("");
    var rows = Object.keys(s.classes || {}).sort().map(function(k){
      var vcN = MGT.vcFor(k).length;
      var axN = ((e.subclass || {})[k] || []).length
        + (e.equivalent || []).filter(function(p){ return p && (p[0] === k || p[1] === k); }).length
        + (e.disjoint || []).filter(function(p){ return p && (p[0] === k || p[1] === k); }).length;
      return '<div class="dv-row" data-k="' + esc(k) + '"><span class="k">' + esc(schemaLabel(k)) + '</span><span class="id">' + esc(k) + '</span>'
        + '<span class="n">实例 ' + ((s.instance_counts && s.instance_counts[k]) || 0) + '</span>'
        + '<span class="n">数据规则 ' + vcN + '</span><span class="n">关系规则 ' + axN + '</span></div>';
    }).join("");
    $("dv-table").innerHTML = rows || '<div class="sch-tip">暂无</div>';
    Array.prototype.forEach.call($("dv-table").querySelectorAll(".dv-row"), function(r){
      r.addEventListener("click", function(){
        MGT.openInspector(r.getAttribute("data-k"), "structure");
        MGT.closeDashboard();
      });
    });
    $("dv-meta").textContent = "schema 更新：" + ((s.updated_at) || "—") + " · 点击行打开该类 Inspector";
  };
  MGT.loadHealth = function(){
    var box = $("dv-health"); if (!box) return;
    box.innerHTML = '<div class="sch-tip">正在计算覆盖 / 一致性指标（JSON 层 + rdflib / owlrl / pyshacl 推理层）…</div>';
    API.get("/api/ontology/health?ttl=1").then(function(r){
      if (!r || r.ok === false){ box.innerHTML = '<div class="sch-tip">看板不可用：' + esc((r && r.reason) || "未知原因") + '</div>'; return; }
      var cov = r.coverage || {}, iss = r.issues || {}, tt = r.ttl || {};
      function pct(x){ return x == null ? "—" : (Math.round(x * 1000) / 10) + "%"; }
      var vio = tt.violations || [];
      var bad = vio.filter(function(v){ return v.level === "error"; });
      var h = '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0">'
        + '<span class="k">规模：节点 ' + (r.scale && r.scale.nodes) + ' / 边 ' + (r.scale && r.scale.edges)
        + ' / 类 ' + (r.scale && r.scale.classes) + ' / 对象属性 ' + (r.scale && r.scale.obj_props) + '</span>'
        + '<span class="k">类覆盖率 <b>' + pct(cov.class_coverage) + '</b></span>'
        + '<span class="k">实例挂接率 <b>' + pct(cov.instance_attached_rate) + '</b></span>'
        + '<span class="k">对象属性使用率 <b>' + pct(cov.obj_prop_usage) + '</b></span>'
        + '<span class="k">必填填充率 <b>' + pct(cov.required_fill_rate) + '</b></span>'
        + '<span class="k">一致性 <b>' + (tt.available ? (tt.inconsistent ? "不一致" : "一致") : "依赖不可用") + '</b></span>'
        + '<span class="k">取值错误 <b>' + bad.length + '</b></span></div>';
      var lines = [];
      (iss.orphan_nodes || []).slice(0, 6).forEach(function(o){ lines.push("孤儿实例：" + o); });
      if ((iss.orphan_count || 0) > 6) lines.push("（孤儿实例共 " + iss.orphan_count + " 个，仅列前 6）");
      (iss.domain_range_conflicts || []).slice(0, 6).forEach(function(c){
        lines.push("域/值冲突：边 " + c.edge + " 用 " + c.prop + "，" + (c.kind === "domain" ? "主体" : "客体") + "应为 " + c.expect + "，实际 " + c.actual);
      });
      (iss.missing_required || []).slice(0, 6).forEach(function(m){
        lines.push("必填缺失：" + m.cls + "/" + m.node + " 缺「" + m.field + "」");
      });
      if ((cov.unused_obj_props || []).length) lines.push("未被使用的对象属性：" + cov.unused_obj_props.join("、"));
      if ((cov.empty_classes || []).length) lines.push("无实例的类：" + cov.empty_classes.join("、"));
      bad.slice(0, 6).forEach(function(v){ lines.push("取值错误：" + v.msg); });
      box.innerHTML = h + (lines.length
        ? '<div class="sch-tip" style="white-space:pre-wrap">' + lines.map(esc).join("\n") + '</div>'
        : '<div class="sch-tip">未发现孤儿实例 / 域值冲突 / 必填缺失。</div>');
    }).catch(function(e){
      box.innerHTML = '<div class="sch-tip">看板读取失败：' + esc(e.message) + '</div>';
    });
  };

  MGT.loadQuality = function(){
    var box = $("dv-quality"); if (!box) return;
    box.innerHTML = '<div class="sch-tip">正在读取质量统计…</div>';
    API.get("/api/quality/stats").then(function(r){
      if (!r || r.ok === false){ box.innerHTML = '<div class="sch-tip">质量统计不可用：' + esc((r && r.reason) || "未知原因") + '</div>'; return; }
      var d = r.payload || r;
      var q = '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0">'
        + '<span class="k">上次检查 <b>' + esc(d.last_check || "—") + '</b></span>'
        + '<span class="k">实例 <b>' + (d.total || 0) + '</b></span>'
        + '<span class="k">通过 <b>' + (d.passed || 0) + '</b></span>'
        + '<span class="k">违规 <b>' + (d.failed || 0) + '</b></span>'
        + '<span class="k">符合率 <b>' + (d.compliance_rate == null ? "—" : d.compliance_rate + "%") + '</b></span>'
        + '<span class="k">规则总数 <b>' + (d.rules_total || 0) + '</b></span></div>';
      var by = (d.by_type || []).slice(0, 8).map(function(b){
        return '<div class="dv-row"><span class="k">' + esc(b.type) + '</span><span class="n">通过 ' + b.passed + ' / ' + b.total + '</span>'
          + '<span class="n">违规 ' + b.failed + '</span>' + (b.failed ? '<span class="n" style="color:var(--danger)">见规则一览</span>' : '<span class="n" style="color:#adb5bd">良好</span>') + '</div>';
      }).join("");
      box.innerHTML = q + (by ? '<div class="dv-table" style="margin-top:4px">' + by + '</div>' : '');
    }).catch(function(e){
      box.innerHTML = '<div class="sch-tip">质量统计读取失败：' + esc(e.message) + '</div>';
    });
  };
  MGT.exportExcel = function(){
    var btn = $("btn-export");
    var prev = btn.textContent; btn.disabled = true; btn.textContent = "导出中…";
    fetch((window.API_BASE || "") + "/api/data/export?type=all").then(function(res){
      if (!res.ok) throw new Error("HTTP " + res.status);
      var cd = res.headers.get("Content-Disposition") || "";
      var m = cd.match(/filename\*=UTF-8''([^;]+)/) || cd.match(/filename="([^"]+)"/);
      var fname = m ? decodeURIComponent(m[1]) : ("Another_数据导出_" + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "") + ".xlsx");
      return res.blob().then(function(blob){ return {blob: blob, fname: fname}; });
    }).then(function(o){
      var url = URL.createObjectURL(o.blob);
      var a = document.createElement("a");
      a.href = url; a.download = o.fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 5000);
      if (window.wbToast) wbToast("已导出 Excel：" + o.fname);
    }).catch(function(e){
      if (window.wbToast) wbToast("导出失败：" + e.message);
    }).finally(function(){
      btn.disabled = false; btn.textContent = prev;
    });
  };
  MGT.rerunCheck = function(){
    var btn = $("btn-rerun-check");
    var box = $("ov-check"); if (!box) return;
    var prev = btn.textContent; btn.disabled = true; btn.textContent = "复检中…";
    box.innerHTML = '<div class="sch-tip">正在执行全量复检…</div>';
    API.post("/api/rules/check", {type: "all"}).then(function(r){
      if (!r || r.ok === false){ box.innerHTML = '<div class="sch-tip">复检失败：' + esc((r && r.reason) || "未知原因") + '</div>'; return; }
      var h = '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0">'
        + '<span class="k">实例 <b>' + (r.total || 0) + '</b></span>'
        + '<span class="k">通过 <b>' + (r.passed || 0) + '</b></span>'
        + '<span class="k">违规 <b>' + (r.failed || 0) + '</b></span>'
        + '<span class="k">符合率 <b>' + (r.compliance_rate == null ? "—" : r.compliance_rate + "%") + '</b></span>'
        + '<span class="k">规则总数 <b>' + (r.rules_total || 0) + '</b></span></div>';
      var lines = [];
      (r.by_type || []).forEach(function(b){
        if (!b.failed) return;
        lines.push("【" + b.type + "】违规 " + b.failed + " / " + b.total + "：");
        (b.violations || []).slice(0, 5).forEach(function(v){
          lines.push("  · " + v.label + "：" + (v.rules || []).join("；"));
        });
        if ((b.violations || []).length > 5) lines.push("  · （该类型共 " + b.violations.length + " 条违规，仅列前 5）");
      });
      box.innerHTML = h + (lines.length
        ? '<div class="sch-tip" style="white-space:pre-wrap">' + lines.map(esc).join("\n") + '</div>'
        : '<div class="sch-tip">全量复检通过，未发现违规。</div>');
      if (window.MGT && MGT.loadQuality) MGT.loadQuality();
    }).catch(function(e){
      box.innerHTML = '<div class="sch-tip">复检失败：' + esc(e.message) + '</div>';
    }).finally(function(){
      btn.disabled = false; btn.textContent = prev;
    });
  };

  /* ---------- 规则一览 ---------- */
  MGT.openOverview = function(){ $("rule-overview").classList.add("open"); MGT.renderOverview(); };
  MGT.renderOverview = function(){
    var s = schData(); var box = $("ov-body");
    if (!s || !box) return;
    var e = p2Ext();
    var rows = [];
    Object.keys(s.classes || {}).sort().forEach(function(k){
      ((e.subclass || {})[k] || []).forEach(function(pa){ rows.push({k: k, txt: schemaLabel(k) + " ⊑ " + schemaLabel(pa), kind: "关系规则 · 子类"}); });
      (e.equivalent || []).forEach(function(p){ if (p && p[0] === k) rows.push({k: k, txt: schemaLabel(p[0]) + " ≡ " + schemaLabel(p[1]), kind: "关系规则 · 等价"}); });
      (e.disjoint || []).forEach(function(p){ if (p && p[0] === k) rows.push({k: k, txt: schemaLabel(p[0]) + " ⊥ " + schemaLabel(p[1]), kind: "关系规则 · 互斥"}); });
      MGT.vcFor(k).forEach(function(v){ rows.push({k: k, txt: v.text, kind: "数据规则 · 取值约束"}); });
    });
    box.innerHTML = rows.length ? rows.map(function(r){
      return '<div class="ov-row" data-k="' + esc(r.k) + '"><span class="ov-kind">' + esc(r.kind) + '</span><span class="ov-txt">' + esc(r.txt) + '</span><span class="ov-goto">查看 →</span></div>';
    }).join("") : '<div class="sch-tip">暂无任何规则。用 Inspector 规则 Tab 或画布右键添加。</div>';
    Array.prototype.forEach.call(box.querySelectorAll(".ov-row"), function(r){
      r.addEventListener("click", function(){
        MGT.openInspector(r.getAttribute("data-k"), "rule");
        $("rule-overview").classList.remove("open");
      });
    });
  };

  /* ---------- 连线详情 ---------- */
  MGT.openRelInfo = function(edgeEl){
    var s = schData(); if (!s) return;
    var label = (edgeEl.textContent || "").replace(/（待提交）$/, "").trim();
    var meta = null, all = ontoObjProps();
    if (label){
      all.some(function(p){ if (p[2] === label){ meta = {name: p[2], domain: p[0], range: p[1]}; return true; } return false; });
    }
    var box = $("relinfo-body");
    if (!meta){
      box.innerHTML = '<div class="sch-tip">未识别该连线对应的对象关系（可能为待提交虚线，请提交后重试）。</div>';
      MGT.openModal("modal-relinfo"); return;
    }
    var nEdges = (RAW.edges || []).filter(function(e2){ return e2.type === meta.name; }).length;
    var pendN = (SCH.changes || []).filter(function(c){ return c && c.operation === "add_obj_prop" && c.name === meta.name; }).length;
    box.innerHTML =
      '<div class="kv"><span class="k">对象关系</span><span class="v">' + esc(meta.name) + '</span></div>'
      + '<div class="kv"><span class="k">从</span><span class="v">' + esc(schemaLabel(meta.domain)) + '（' + esc(meta.domain) + '）</span></div>'
      + '<div class="kv"><span class="k">到</span><span class="v">' + esc(schemaLabel(meta.range)) + '（' + esc(meta.range) + '）</span></div>'
      + '<div class="kv"><span class="k">实例边数</span><span class="v">' + nEdges + '</span></div>'
      + (pendN ? '<div class="kv"><span class="k">待提交</span><span class="v">' + pendN + ' 项属性变更</span></div>' : "")
      + '<div class="sec-acts">'
      + '<button class="mini-btn" onclick="MGT.openInspector(\'' + esc(meta.domain) + '\',\'structure\')">查看“从”类</button>'
      + '<button class="mini-btn" onclick="MGT.openInspector(\'' + esc(meta.range) + '\',\'structure\')">查看“到”类</button></div>';
    MGT.openModal("modal-relinfo");
  };

  /* ---------- 右键菜单 ---------- */
  MGT.closeMenu = function(){ var m = $("mgtMenu"); if (m) m.style.display = "none"; };
  MGT.showMenu = function(x, y, ctx, k){
    var m = $("mgtMenu"), items = [];
    if (ctx === "node"){
      items = [
        {label: "查看结构（Inspector）", act: function(){ MGT.openInspector(k, "structure"); }},
        {label: "查看实例", act: function(){ MGT.openInspector(k, "instance"); }},
        {label: "查看规则", act: function(){ MGT.openInspector(k, "rule"); }},
        {sep: true},
        {label: "新建对象关系（从=" + k + "）", act: function(){ MGT.openRelModal(k); }},
        {label: "添加关系规则", act: function(){ MGT.openRuleWizard(k); }},
        {label: "添加数据规则", act: function(){ MGT.openConsWizard(k); }},
        {sep: true},
        {label: "删除类（影响面预告）", danger: true, act: function(){ MGT.closeMenu(); if (window.schDel) schDel("class", k); }}
      ];
    } else {
      items = [
        {label: "编辑本体结构（类 / 属性）", act: function(){ openSchemaModal(); }},
        {label: "数据总览", act: function(){ MGT.openDashboard(); }},
        {label: "规则一览", act: function(){ MGT.openOverview(); }},
        {sep: true},
        {label: "版本 / 回滚", act: function(){ openVerModal(); }},
        {label: "新建对象类型", act: function(){ MGT.openClassModal(); }}
      ];
    }
    m.innerHTML = items.map(function(it){
      if (it.sep) return '<div class="ctx-sep"></div>';
      return '<button class="ctx-item' + (it.danger ? " danger" : "") + '">' + esc(it.label) + '</button>';
    }).join("");
    m.style.display = "block";
    var r = m.getBoundingClientRect();
    m.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 12)) + "px";
    m.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 12)) + "px";
    m.__items = items;
    Array.prototype.forEach.call(m.querySelectorAll(".ctx-item"), function(b, i){
      b.addEventListener("click", function(){ MGT.closeMenu(); items[i].act(); });
    });
  };

  /* ---------- 缩放 / 画布 ---------- */
  MGT.applyZoom = function(){
    var svg = $("ontoCanvas"); if (!svg) return;
    var r = svg.getBoundingClientRect();
    var W = Math.max(420, Math.round(r.width) || 1000), H = Math.max(380, Math.round(r.height) || 600);
    svg.setAttribute("viewBox", "0 0 " + (W / MGT.zoom) + " " + (H / MGT.zoom));
    var zr = $("btn-zoom-reset"); if (zr) zr.textContent = Math.round(MGT.zoom * 100) + "%";
  };
  MGT.zoomBy = function(f){
    MGT.zoom = Math.min(2.5, Math.max(0.5, MGT.zoom * f));
    renderOntoCanvas();
  };
  MGT.fitScreen = function(){ MGT.zoom = 1; renderOntoCanvas(); };
  var __origCanvas = renderOntoCanvas;
  renderOntoCanvas = function(){
    __origCanvas();
    MGT.applyZoom();
    MGT.renderStat();
    MGT.bindCanvasGuard();
  };
  MGT.bindCanvasGuard = function(){
    var svg = $("ontoCanvas"); if (!svg || svg.__mgtGuard) return;
    svg.__mgtGuard = true;
    svg.addEventListener("click", function(ev){
      if (ONTO_LINK.moved) return;
      var t = ev.target;
      var node = t.closest ? t.closest(".o-node") : null;
      if (node){
        var k = node.getAttribute("data-k");
        setTimeout(function(){ MGT.openInspector(k, "structure"); }, 0);
        return;
      }
      var edge = t.closest ? (t.closest(".o-edge") || t.closest(".o-edge-label")) : null;
      if (edge) MGT.openRelInfo(edge);
    }, true);
    svg.addEventListener("contextmenu", function(ev){
      ev.preventDefault();
      var t = ev.target;
      var node = t.closest ? t.closest(".o-node") : null;
      if (node){ MGT.showMenu(ev.clientX, ev.clientY, "node", node.getAttribute("data-k")); }
      else { MGT.showMenu(ev.clientX, ev.clientY, "canvas", null); }
    });
  };

  /* ---------- 类型搜索 ---------- */
  function initSearch(){
    var _timer = null;
    $("typeSearch").addEventListener("input", function(){
      var q = this.value.trim();
      var box = $("searchResults");
      if (!q){ box.classList.remove("open"); box.innerHTML = ""; return; }
      clearTimeout(_timer);
      _timer = setTimeout(function(){ MGT.globalSearch(q); }, 300);
    });
    $("searchResults").addEventListener("click", function(e){
      var it = e.target.closest(".sr-item"); if (!it) return;
      var k = it.getAttribute("data-type"), id = it.getAttribute("data-id");
      $("typeSearch").value = it.getAttribute("data-label") || "";
      $("searchResults").classList.remove("open"); $("searchResults").innerHTML = "";
      MGT.openInspector(k, "instance");
      if (id){
        state.ontoInst = id; state.edit = null;
        if (window.renderOntoPanel) renderOntoPanel();
        if (window.renderOntoCanvas) renderOntoCanvas();
      }
    });
  }
  MGT.globalSearch = function(q){
    var box = $("searchResults"); if (!box) return;
    box.innerHTML = '<div class="sr-empty">检索中…</div>'; box.classList.add("open");
    API.get("/api/search?q=" + encodeURIComponent(q)).then(function(r){
      if (!r || r.ok === false){ throw new Error((r && r.reason) || "检索失败"); }
      var groups = r.groups || [];
      if (!groups.length){ box.innerHTML = '<div class="sr-empty">未找到匹配的实例或对象类型</div>'; return; }
      var h = "";
      groups.forEach(function(g){
        h += '<div class="sr-group">' + esc(g.type) + '（' + g.count + '）</div>';
        g.items.slice(0, 12).forEach(function(it){
          h += '<div class="sr-item" data-type="' + esc(it.type) + '" data-id="' + esc(it.id) + '" data-label="' + esc(it.label) + '">'
            + esc(it.label) + '<span class="sr-id">' + esc(it.id) + '</span></div>';
        });
      });
      box.innerHTML = h;
    }).catch(function(e){
      /* 后端检索不可用时回退为本地对象类型匹配 */
      var q2 = String(q || "").toLowerCase();
      var hits = schClassNamesEff().filter(function(n){
        var lb = schemaLabel(n).toLowerCase();
        return n.toLowerCase().indexOf(q2) >= 0 || lb.indexOf(q2) >= 0;
      }).slice(0, 12);
      box.innerHTML = hits.length
        ? hits.map(function(n){ return '<div class="sr-item" data-type="' + esc(n) + '" data-id="" data-label="' + esc(schemaLabel(n)) + '">' + esc(schemaLabel(n)) + '<span class="sr-id">' + esc(n) + '</span></div>'; }).join("")
        : '<div class="sr-empty">后端检索不可用且无本地匹配：' + esc(e.message) + '</div>';
    });
  };

  /* ---------- 事件绑定 / 初始化 ---------- */
  function init(){
    initSearch();
    $("insp-close").addEventListener("click", MGT.closeInspector);
    Array.prototype.forEach.call(document.querySelectorAll("#insp-tabs .insp-tab"), function(b){
      b.addEventListener("click", function(){ MGT.switchInspTab(b.getAttribute("data-tab")); });
    });
    $("btn-dashboard").addEventListener("click", MGT.openDashboard);
    $("dv-close").addEventListener("click", function(){ $("dashboard").classList.remove("open"); });
    $("btn-health").addEventListener("click", MGT.loadHealth);
    $("btn-export").addEventListener("click", MGT.exportExcel);
    $("btn-rerun-check").addEventListener("click", MGT.rerunCheck);
    $("btn-overview").addEventListener("click", MGT.openOverview);
    $("ov-close").addEventListener("click", function(){ $("rule-overview").classList.remove("open"); });
    $("btn-zoom-in").addEventListener("click", function(){ MGT.zoomBy(1.25); });
    $("btn-zoom-out").addEventListener("click", function(){ MGT.zoomBy(0.8); });
    $("btn-zoom-reset").addEventListener("click", MGT.fitScreen);
    $("btn-fit").addEventListener("click", MGT.fitScreen);
    $("btnClassOk").addEventListener("click", MGT.saveClass);
    $("btnRelOk").addEventListener("click", MGT.saveRel);
    $("wiz-prev").addEventListener("click", MGT.wizPrev);
    $("wiz-next").addEventListener("click", MGT.wizNext);
    $("wiz-ok").addEventListener("click", MGT.saveAxiom);
    $("wiz-cancel").addEventListener("click", function(){ MGT.closeModal("modal-rule"); });
    $("cons-ok").addEventListener("click", MGT.saveCons);
    $("cons-cancel").addEventListener("click", function(){ MGT.closeModal("modal-cons"); });
    $("cons-prev").addEventListener("click", function(){ CONS.step = 1; MGT.updateConsSteps(); });
    Array.prototype.forEach.call(document.querySelectorAll("#rel-btns .rel-btn"), function(b){
      b.addEventListener("click", function(){ MGT.setRelKind(b.getAttribute("data-rel")); });
    });
    $("wiz-a").addEventListener("change", function(){ RULE.a = this.value; MGT.renderWizEcho(); });
    $("wiz-b").addEventListener("change", function(){ RULE.b = this.value; MGT.renderWizEcho(); });
    $("cons-fields").addEventListener("input", MGT.consText);
    $("cons-fields").addEventListener("change", MGT.consText);
    Array.prototype.forEach.call(document.querySelectorAll(".modal-overlay"), function(m){
      m.addEventListener("click", function(e){ if (e.target === m) m.classList.remove("open"); });
    });
    $("fab-add").addEventListener("click", function(){ $("fab-menu").classList.toggle("open"); });
    Array.prototype.forEach.call(document.querySelectorAll("#fab-menu [data-fab]"), function(b){
      b.addEventListener("click", function(){
        var k = b.getAttribute("data-fab");
        $("fab-menu").classList.remove("open");
        if (k === "class") MGT.openClassModal();
        else if (k === "inst") openNewModal();
        else MGT.openRelModal(MGT.sel);
      });
    });
    document.addEventListener("click", function(e){
      var fm = $("fab-menu");
      if (fm && fm.classList.contains("open") && !e.target.closest("#fab-add") && !e.target.closest("#fab-menu")) fm.classList.remove("open");
      var sr = $("searchResults");
      if (sr && sr.classList.contains("open") && !e.target.closest("#typeSearch") && !e.target.closest("#searchResults")){ sr.classList.remove("open"); sr.innerHTML = ""; }
      if (!e.target.closest("#mgtMenu")) MGT.closeMenu();
    });
    document.addEventListener("keydown", function(e){
      if (e.key === "Escape"){
        MGT.closeMenu();
        ["dashboard", "rule-overview", "inspector"].forEach(function(id){
          var el = $(id); if (el) el.classList.remove("open");
        });
        closeAllModals();
      }
    });
  }
  init();
})();

