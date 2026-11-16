/* zone: graph — 知识图谱：画布浏览 + 列表浏览 + 关系边「管理关联实例」浮层（P0-1）
 * 边右键 → 查看/添加/删除关联实例对（POST/DELETE /api/relations/{rel_type}/instances），
 * 数量 badge 实时更新；画布节点点击查看详情；列表视图保留原有检索能力。
 * 零依赖纯 JS。 */
(function(){
  var Z = window.MarvisZone["graph"] = { title: "知识图谱" };
  var schemaCache = null;

  function render(el){
    el.innerHTML = '<div class="loading">加载图谱…</div>';
    fetch("/api/graph/stats").then(function(r){ return r.json(); }).then(function(d){
      var html = '<div class="panel" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">';
      html += '<div class="seg" id="g_viewseg">';
      html += '<button class="seg-btn active" data-v="canvas">画布</button>';
      html += '<button class="seg-btn" data-v="list">列表</button>';
      html += '</div>';
      html += '<input type="search" id="g_search" placeholder="搜索节点标题/名称…" style="flex:1;min-width:200px">';
      html += '<select id="g_type"><option value="">全部类型</option></select>';
      html += '<button class="act" id="g_go">检索</button>';
      html += '<span class="hint" style="margin:0">共 '+d.nodes+' 节点 · '+d.edges+' 关系边</span>';
      html += '</div>';
      html += '<div id="g_canvas_box" class="panel g-canvas-box"></div>';
      html += '<div id="g_list_box" class="panel" style="display:none"></div>';
      html += '<div id="g_detail" style="margin-top:10px"></div>';
      el.innerHTML = html;
      Object.keys(d.counts_by_type || {}).sort().forEach(function(t){
        appendOption(document.getElementById("g_type"), t, t + " (" + d.counts_by_type[t] + ")");
      });

      function doSearch(cb){
        var q = document.getElementById("g_search").value.trim();
        var ty = document.getElementById("g_type").value;
        var url = "/api/graph/nodes?q=" + encodeURIComponent(q) + (ty ? "&type=" + encodeURIComponent(ty) : "");
        fetch(url).then(function(r){ return r.json(); }).then(function(res){
          if (cb) cb(res.nodes || [], res.total || 0);
        });
      }
      function currentView(){
        var b = el.querySelector("#g_viewseg .seg-btn.active");
        return b ? b.getAttribute("data-v") : "canvas";
      }
      function switchView(v){
        el.querySelectorAll("#g_viewseg .seg-btn").forEach(function(b){
          b.classList.toggle("active", b.getAttribute("data-v") === v);
        });
        el.querySelector("#g_canvas_box").style.display = v === "canvas" ? "" : "none";
        el.querySelector("#g_list_box").style.display = v === "list" ? "" : "none";
        if (v === "canvas") loadCanvas();
        else loadList();
      }
      el.querySelector("#g_viewseg").addEventListener("click", function(ev){
        var b = ev.target.closest(".seg-btn"); if (!b) return;
        switchView(b.getAttribute("data-v"));
      });
      document.getElementById("g_go").addEventListener("click", function(){ doSearch(); });
      document.getElementById("g_search").addEventListener("keydown", function(e){ if (e.key === "Enter") doSearch(); });

      /* 数据加载（全量，供画布与列表） */
      function loadAll(cb){
        Promise.all([
          fetch("/api/graph/nodes").then(function(r){ return r.json(); }),
          fetch("/api/graph/edges").then(function(r){ return r.json(); })
        ]).then(function(rs){
          cb(rs[0].nodes || [], rs[1].edges || []);
        });
      }
      function loadCanvas(){
        var box = el.querySelector("#g_canvas_box");
        box.innerHTML = '<div class="loading">布局画布…</div>';
        loadAll(function(nodes, edges){
          if (currentView() !== "canvas") return;
          renderCanvas(box, nodes, edges);
        });
      }
      function loadList(){
        var box = el.querySelector("#g_list_box");
        box.innerHTML = '<div class="loading">加载列表…</div>';
        doSearch(function(nodes, total){
          renderList(box, nodes, total);
        });
      }
      Z._refreshCanvas = loadCanvas;

      /* 初始检索词（来自全局检索跳转） */
      var initQ = window._graphInitialSearch;
      if (initQ){
        window._graphInitialSearch = null;
        var si = document.getElementById("g_search");
        si.value = initQ;
        setTimeout(function(){ switchView("canvas"); si.focus(); }, 0);
      } else {
        switchView("canvas");
      }
    });
  }

  /* ========================================================
   * 画布（SVG 力导向）
   * ======================================================== */
  function renderCanvas(box, nodes, edges){
    var W = Math.max(600, box.clientWidth || 900);
    var H = Math.max(480, Math.min(720, 260 + nodes.length * 3));
    var pos = forceLayout(nodes, edges, W, H);
    var byId = {};
    nodes.forEach(function(n){ byId[n.id] = n; });
    box._gByid = byId;
    var ns = new Set(nodes.map(function(n){ return n.id; }));
    var visEdges = edges.filter(function(e){ return ns.has(e.source_id) && ns.has(e.target_id); });

    var h = '<div class="g-canvas-tip">提示：右键关系边 → 管理关联实例；点击节点 → 查看详情</div>';
    h += '<svg id="g_svg" width="' + W + '" height="' + H + '" style="width:100%;background:#fafbff;border:1px solid #e7e5f2;border-radius:10px">';
    h += '<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#845ef7"/></marker></defs>';
    visEdges.forEach(function(e, i){
      var a = pos[e.source_id], b = pos[e.target_id];
      if (!a || !b) return;
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      h += '<g class="g-edge" data-idx="' + i + '" data-type="' + esc(e.type) + '" data-s="' + esc(e.source_id) + '" data-t="' + esc(e.target_id) + '">';
      h += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="#845ef7" stroke-width="' + (e.weight > 1 ? 2.5 : 1.4) + '" marker-end="url(#arrow)"/>';
      h += '<text x="' + mx + '" y="' + (my - 5) + '" text-anchor="middle" class="g-edge-label">' + esc(e.type) + '</text>';
      h += '</g>';
    });
    nodes.forEach(function(n){
      var p = pos[n.id]; if (!p) return;
      var label = instLabel(n.properties, n.id);
      h += '<g class="g-node" data-id="' + esc(n.id) + '" transform="translate(' + p.x + ',' + p.y + ')">';
      h += '<circle r="13" fill="' + nodeColor(n.type) + '" stroke="#fff" stroke-width="2"/>';
      h += '<text y="28" text-anchor="middle" class="g-node-label">' + esc(label.length > 14 ? label.slice(0, 13) + "…" : label) + '</text>';
      h += '</g>';
    });
    h += '</svg>';
    box.innerHTML = h;

    var svg = box.querySelector("#g_svg");
    svg.addEventListener("contextmenu", function(ev){ ev.preventDefault(); });
    /* 边右键 → 管理关联实例 */
    Array.prototype.forEach.call(box.querySelectorAll(".g-edge"), function(g){
      g.addEventListener("contextmenu", function(ev){
        ev.preventDefault(); ev.stopPropagation();
        var e = visEdges[parseInt(g.getAttribute("data-idx"), 10)];
        if (e) openEdgeManager(box, e, function(){ loadCanvas(); });
      });
    });
    /* 节点点击 → 详情 */
    Array.prototype.forEach.call(box.querySelectorAll(".g-node"), function(g){
      g.addEventListener("click", function(ev){
        ev.stopPropagation();
        openNodeDetail(box, g.getAttribute("data-id"));
      });
    });
    svg.addEventListener("click", function(){ box.querySelector("#g_detail_holder") && (box.querySelector("#g_detail_holder").innerHTML = ""); });
  }

  function forceLayout(nodes, edges, W, H){
    var pos = {}, n = nodes.length;
    nodes.forEach(function(nd, i){
      var ang = (2 * Math.PI * i) / Math.max(1, n) + (i % 2 ? 0.35 : 0);
      var r = Math.min(W, H) * 0.34;
      pos[nd.id] = { x: W / 2 + r * Math.cos(ang), y: H / 2 + r * Math.sin(ang) };
    });
    var k = Math.sqrt((W * H) / Math.max(1, n)) * 0.9;
    for (var iter = 0; iter < 120; iter++){
      for (var i = 0; i < n; i++){
        for (var j = i + 1; j < n; j++){
          var a = pos[nodes[i].id], b = pos[nodes[j].id];
          var dx = b.x - a.x, dy = b.y - a.y;
          var d2 = dx * dx + dy * dy + 1e-6, d = Math.sqrt(d2);
          var f = (k * k) / d2, fx = f * dx / d, fy = f * dy / d;
          a.x -= fx; a.y -= fy; b.x += fx; b.y += fy;
        }
      }
      edges.forEach(function(e){
        var a = pos[e.source_id], b = pos[e.target_id];
        if (!a || !b) return;
        var dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy + 1e-6);
        var f = (d - k) * 0.06, fx = f * dx / d, fy = f * dy / d;
        a.x += fx; a.y += fy; b.x -= fx; b.y -= fy;
      });
      nodes.forEach(function(nd){
        var p = pos[nd.id];
        p.x += (W / 2 - p.x) * 0.02; p.y += (H / 2 - p.y) * 0.02;
        p.x = Math.max(40, Math.min(W - 40, p.x)); p.y = Math.max(40, Math.min(H - 40, p.y));
      });
    }
    return pos;
  }

  /* ========================================================
   * P0-1 关系边「管理关联实例」浮层
   * ======================================================== */
  function openEdgeManager(box, edge, onDone){
    var relType = edge.type;
    var mask = document.createElement("div");
    mask.className = "rel-mask";
    var panel = document.createElement("div");
    panel.className = "rel-panel";
    panel.innerHTML =
      '<div class="rel-title">管理关联实例 · <span class="tag">' + esc(relType) + '</span> <span class="rel-badge" id="rel_badge">…</span>' +
      '<button class="ghost" id="rel_close" style="float:right">关闭</button></div>' +
      '<div class="rel-cur">当前边：<b>' + esc(instLabel(byIdOf(box)[edge.source_id], edge.source_id)) + '</b> → ' +
      '<span class="tag">' + esc(relType) + '</span> → <b>' + esc(instLabel(byIdOf(box)[edge.target_id], edge.target_id)) + '</b></div>' +
      '<div class="rel-body" id="rel_body"><div class="loading">加载中…</div></div>' +
      '<div class="rel-add" id="rel_add">' +
      '<h4>添加关联实例对</h4>' +
      '<div class="rel-add-form">' +
      '<select id="rel_src"><option value="">加载候选…</option></select>' +
      '<span class="rel-arrow">→</span>' +
      '<select id="rel_dst"><option value="">—</option></select>' +
      '<button class="act" id="rel_add_btn">添加</button>' +
      '</div><div class="rel-msg" id="rel_msg"></div>' +
      '</div>';
    mask.appendChild(panel);
    document.body.appendChild(mask);

    var badge = panel.querySelector("#rel_badge");
    var body = panel.querySelector("#rel_body");
    var msg = panel.querySelector("#rel_msg");
    var srcSel = panel.querySelector("#rel_src");
    var dstSel = panel.querySelector("#rel_dst");

    function showMsg(ok, text){
      msg.className = "rel-msg " + (ok ? "ok" : "err");
      msg.innerHTML = text;
      setTimeout(function(){ msg.innerHTML = ""; }, 4000);
    }
    function refresh(){
      fetch("/api/relations/" + encodeURIComponent(relType) + "/instances").then(function(r){ return r.json(); }).then(function(d){
        if (!d || !d.ok){ body.innerHTML = '<div class="error">加载失败：' + esc((d && d.reason) || "未知错误") + '</div>'; return; }
        badge.textContent = d.total + " 对";
        var h = '<div class="rel-list-head">全部关联实例对（' + d.total + '）</div>';
        if (!d.instances.length){ h += '<div class="rel-empty">暂无关联实例对</div>'; }
        else {
          d.instances.forEach(function(it){
            h += '<div class="rel-row" data-eid="' + esc(it.id) + '">';
            h += '<span class="tag">' + esc(it.source_type || "?") + '</span> <b>' + esc(it.source_label) + '</b>';
            h += '<span class="rel-arrow">→</span>';
            h += '<span class="tag">' + esc(it.target_type || "?") + '</span> <b>' + esc(it.target_label) + '</b>';
            h += '<span style="flex:1"></span>';
            h += '<button class="btn-danger rel-del">删除</button>';
            h += '</div>';
          });
        }
        body.innerHTML = h;
        Array.prototype.forEach.call(body.querySelectorAll(".rel-del"), function(btn){
          btn.addEventListener("click", function(){
            var eid = btn.closest(".rel-row").getAttribute("data-eid");
            if (!confirm("删除该关联实例对？\n（将生成版本快照，可回滚）")) return;
            fetch("/api/relations/" + encodeURIComponent(relType) + "/instances/" + encodeURIComponent(eid), { method: "DELETE" })
              .then(function(r){ return r.json(); }).then(function(d){
                if (d && d.ok){
                  showMsg(true, "已删除，剩余 " + (d.total != null ? d.total : "?") + " 对");
                  refresh();
                  onDone && onDone();
                } else {
                  showMsg(false, (d && (d.errors || [d.reason]).join("；")) || "删除失败");
                }
              });
          });
        });
      });
    }

    /* 候选实例：按 schema 中该关系类型的 domain / range 过滤 */
    function loadSchema(){
      if (schemaCache) return Promise.resolve(schemaCache);
      return fetch("/api/ontology/schema").then(function(r){ return r.json(); }).then(function(d){
        schemaCache = d;
        return d;
      });
    }
    loadSchema().then(function(sch){
      var op = (sch.object_props || {})[relType] || {};
      var dom = op.domain || "", rng = op.range || "";
      if (!dom || !rng){
        showMsg(false, "Schema 未定义该关系类型的 domain/range，无法选择候选实例（可在本体区先定义）。");
        return;
      }
      Promise.all([
        fetch("/api/ontology/instances?type=" + encodeURIComponent(dom)).then(function(r){ return r.json(); }),
        fetch("/api/ontology/instances?type=" + encodeURIComponent(rng)).then(function(r){ return r.json(); })
      ]).then(function(rs){
        srcSel.innerHTML = '<option value="">来源（' + dom + '）…</option>';
        (rs[0].instances || []).forEach(function(it){
          srcSel.innerHTML += '<option value="' + esc(it.id) + '">' + esc(instLabel(it.props, it.id)) + '</option>';
        });
        dstSel.innerHTML = '<option value="">目标（' + rng + '）…</option>';
        (rs[1].instances || []).forEach(function(it){
          dstSel.innerHTML += '<option value="' + esc(it.id) + '">' + esc(instLabel(it.props, it.id)) + '</option>';
        });
      });
    });

    panel.querySelector("#rel_add_btn").addEventListener("click", function(){
      var s = srcSel.value, t = dstSel.value;
      if (!s || !t){ showMsg(false, "请选择来源与目标实例"); return; }
      fetch("/api/relations/" + encodeURIComponent(relType) + "/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: s, target_id: t })
      }).then(function(r){ return r.json(); }).then(function(d){
        if (d && d.ok){
          showMsg(true, "已添加（当前共 " + (d.total != null ? d.total : "?") + " 对）");
          srcSel.value = ""; dstSel.value = "";
          refresh();
          onDone && onDone();
        } else {
          showMsg(false, (d && (d.errors || [d.reason]).join("；")) || "添加失败");
        }
      });
    });
    panel.querySelector("#rel_close").addEventListener("click", function(){ mask.remove(); });
    mask.addEventListener("click", function(ev){ if (ev.target === mask) mask.remove(); });

    refresh();
  }

  /* 节点详情 */
  function openNodeDetail(box, nid){
    var holder = box.querySelector("#g_detail_holder") || (function(){
      var h = document.createElement("div");
      h.id = "g_detail_holder";
      box.appendChild(h);
      return h;
    })();
    holder.innerHTML = '<div class="loading">加载详情…</div>';
    Promise.all([
      fetch("/api/graph/node/" + encodeURIComponent(nid)).then(function(r){ return r.json(); }),
      fetch("/api/graph/neighbors/" + encodeURIComponent(nid)).then(function(r){ return r.json(); })
    ]).then(function(rs){
      var node = rs[0].node, nb = rs[1];
      var p = node.properties || {};
      var h = '<div class="panel" style="margin-top:10px"><span class="tag">' + esc(node.type) + '</span> <b style="font-size:15px">' +
              esc(instLabel(p, node.id)) + '</b> <span class="grey">' + esc(node.id) + '</span>' +
              '<button class="ghost" style="float:right" id="g_detail_close">关闭</button></div>';
      h += '<div class="grid2"><div class="panel"><h3>属性</h3><div class="kv">';
      Object.keys(p).forEach(function(k){
        var v = p[k];
        if (v && typeof v === "object") v = JSON.stringify(v);
        h += '<dt>' + esc(k) + '</dt><dd>' + esc("" + v) + '</dd>';
      });
      h += '</div></div><div class="panel"><h3>邻接关系（' + (nb.neighbors || []).length + '）</h3><table class="tbl">';
      h += '<tr><th>关系</th><th>对端</th><th>类型</th></tr>';
      (nb.neighbors || []).forEach(function(x){
        h += '<tr><td><span class="tag">' + esc(x.via) + '</span></td><td>' + esc(x.name || x.id) + '</td><td>' + esc(x.type) + '</td></tr>';
      });
      h += '</table></div></div>';
      holder.innerHTML = h;
      holder.querySelector("#g_detail_close").addEventListener("click", function(){ holder.innerHTML = ""; });
    }).catch(function(e){ holder.innerHTML = '<div class="error">加载详情失败</div>'; });
  }

  /* ========================================================
   * 列表视图（保留原能力）
   * ======================================================== */
  function renderList(box, nodes, total){
    var h = '<h3 style="margin-top:0">节点列表（' + total + '）</h3>';
    if (!nodes.length){ box.innerHTML = h + '<div class="hint">无结果</div>'; return; }
    h += '<table class="tbl"><tr><th>类型</th><th>标题/名称</th><th>key 属性</th><th></th></tr>';
    nodes.forEach(function(n){
      var p = n.properties || {};
      var label = instLabel(p, n.id);
      var key = p.year ? ("year=" + p.year) : (p.doi ? "doi=" + p.doi : "");
      h += '<tr><td><span class="tag">' + esc(n.type) + '</span></td><td>' + esc(label) + '</td><td>' + esc(key) + '</td>' +
           '<td><button class="ghost" data-id="' + esc(n.id) + '">详情</button></td></tr>';
    });
    h += '</table>';
    box.innerHTML = h;
    Array.prototype.forEach.call(box.querySelectorAll("button[data-id]"), function(btn){
      btn.addEventListener("click", function(){
        openNodeDetail(box, btn.getAttribute("data-id"));
      });
    });
  }

  /* ========================================================
   * helpers
   * ======================================================== */
  function byIdOf(box){
    /* 最近一次画布节点映射（在 renderCanvas 缓存到 box） */
    return box._gByid || {};
  }
  function instLabel(p, id){
    return p.title || p.name || p.keywordName || p.filePath || id;
  }
  function nodeColor(type){
    var palette = ["#845ef7", "#339af0", "#20c997", "#f59f00", "#e64980", "#37b24d", "#f76707", "#748ffc", "#0ca678", "#e8590c"];
    var s = 0;
    for (var i = 0; i < type.length; i++) s = (s * 31 + type.charCodeAt(i)) >>> 0;
    return palette[s % palette.length];
  }
  function appendOption(sel, val, text){
    var o = document.createElement("option"); o.value = val; o.textContent = text; sel.appendChild(o);
  }
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
})();
