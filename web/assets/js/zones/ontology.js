/* zone: ontology — 本体工作台（M3a 实例编辑闭环）
 * 浏览类 → 选实例 → 表单编辑数据属性 + 增删对象关系 → diff 预览 → 提交
 * （POST /api/commit 统一闸门：备份 → 校验 → 写回 JSON → 派生 TTL）。
 * 零依赖纯 JS。 */
(function(){
  var Z = window.MarvisZone["ontology"] = { title: "本体工作台" };
  var schema = null;          // /api/ontology/schema
  var curType = "";           // 当前筛选类
  var listState = { ids: [] }; // 实例列表 id
  var S = null;               // 编辑会话 { id, type, origProps, added, removed, inputs }

  /* ---------- 样式注入 ---------- */
  (function injectStyle(){
    if (document.getElementById("ont-edit-style")) return;
    var st = document.createElement("style");
    st.id = "ont-edit-style";
    st.textContent = [
      ".ont-toolbar{display:flex;gap:10px;align-items:center;margin:8px 0 14px;flex-wrap:wrap}",
      ".ont-main{display:grid;grid-template-columns:300px 1fr;gap:16px;align-items:start}",
      ".ont-list .row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-bottom:1px solid #eee;cursor:pointer;border-radius:6px}",
      ".ont-list .row:hover{background:#f3f0ff}",
      ".ont-list .row .lb{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ont-edit .fld{margin:6px 0}",
      ".ont-edit .fld label{display:block;font-size:12px;color:#666;margin-bottom:3px}",
      ".ont-edit .fld label.req::after{content:' *';color:#e8590c}",
      ".ont-edit input[type=text],.ont-edit input[type=number],.ont-edit select{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px}",
      ".ont-edit input:focus,.ont-edit select:focus{outline:none;border-color:#7048e8}",
      ".ont-edit .sec{margin-bottom:16px}",
      ".ont-edit .sec h4{font-size:13px;margin:0 0 8px;color:#495057;border-left:3px solid #7048e8;padding-left:8px}",
      ".ont-edit .edgerow{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid #eee;border-radius:6px;margin:4px 0;font-size:13px;background:#fafafa}",
      ".ont-edit .edgerow .tag{margin:0}",
      ".ont-edit .grey{color:#868e96;font-size:12px}",
      ".ont-diff{background:#fff9db;border:1px solid #e6cf7a;border-radius:8px;padding:10px 12px;font-size:12px;margin:12px 0}",
      ".ont-diff .diff-line{font-family:Menlo,Consolas,monospace;line-height:1.6}",
      ".ont-diff .plus{color:#2b8a3e}.ont-diff .minus{color:#c92a2a}.ont-diff .mod{color:#e8590c}",
      ".ont-result{background:#e7f5ff;border:1px solid #74c0fc;border-radius:8px;padding:10px 12px;font-size:13px;margin:12px 0}",
      ".ont-result.err{background:#fff0f0;border-color:#ffa8a8}",
      ".ont-result li{margin:2px 0}",
      ".ont-addbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}",
      ".ont-addbar select{max-width:200px}",
      ".btn-danger{background:#fff;color:#e03131;border:1px solid #faa2c1;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}",
      ".btn-danger:hover{background:#fff0f6}",
      ".ont-chk{flex:0 0 auto;margin-right:6px;accent-color:#7048e8}",
      ".ont-batchbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#f1f3ff;border:1px solid #c0c8ff;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:13px}",
      ".ont-batchbar select,.ont-batchbar input{padding:5px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px}",
      ".ont-batchbar .act{padding:5px 10px;font-size:12px}",
      ".ont-export-btn{margin-left:auto}"
    ].join("\n");
    document.head.appendChild(st);
  })();

  /* ---------- helpers ---------- */
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function api(url, opt){
    return fetch(url, opt || {}).then(function(r){ return r.json().catch(function(){ return {ok:false, reason:"响应解析失败"}; }); });
  }
  function instLabel(p, id){
    return p.title || p.name || p.keywordName || p.filePath || id;
  }
  function diffProps(oldP, newP){
    var plus=[], minus=[], mod=[];
    var keys={};
    Object.keys(oldP||{}).forEach(function(k){ keys[k]=1; });
    Object.keys(newP||{}).forEach(function(k){ keys[k]=1; });
    Object.keys(keys).forEach(function(k){
      var a = oldP&&oldP[k]!=null ? String(oldP[k]) : "";
      var b = newP&&newP[k]!=null ? String(newP[k]) : "";
      if (a==="" && b!=="") plus.push(k+" = "+b);
      else if (a!=="" && b==="") minus.push(k+"（删除）");
      else if (a!==b) mod.push(k+": "+a+" → "+b);
    });
    return { plus:plus, minus:minus, mod:mod, n: plus.length+minus.length+mod.length };
  }

  /* ---------- 字段表：某类可编辑的数据属性 ---------- */
  function fieldsFor(cls){
    var shape = (schema.shapes||{})[cls] || {required:[]};
    var required = shape.required || [];
    var out=[], seen={};
    Object.keys(schema.data_props||{}).forEach(function(dn){
      var d = schema.data_props[dn];
      var isReq = required.indexOf(dn) >= 0;
      if ((d && d.domain === cls) || isReq){
        out.push({ name:dn, label:(d&&d.label)||dn, req:isReq,
                   hint:(d&&d.comment)||"", range:(d&&d.range)||"string" });
        seen[dn]=1;
      }
    });
    // 实例已有但 schema 未收录的键：附加非必填
    return out;
  }

  /* ---------- 对象属性选择 ---------- */
  function outPropsFor(cls){
    var out=[];
    Object.keys(schema.object_props||{}).forEach(function(pn){
      var p = schema.object_props[pn];
      if (p && p.domain === cls) out.push({ name:pn, label:(p.label||pn)+" → "+(p.range||"?") , range:p.range});
    });
    return out.sort(function(a,b){ return a.name<b.name?-1:1; });
  }
  function inPropsFor(cls){
    var out=[];
    Object.keys(schema.object_props||{}).forEach(function(pn){
      var p = schema.object_props[pn];
      if (p && p.domain !== cls && p.range === cls) out.push({ name:pn, label:(p.domain||"?")+" → "+(p.label||pn) , domain:p.domain});
    });
    return out.sort(function(a,b){ return a.name<b.name?-1:1; });
  }

  /* ========================================================
   * 渲染入口
   * ======================================================== */
  function render(el){
    el.innerHTML = '<div class="loading">加载本体 Schema…</div>';
    api("/api/ontology/schema").then(function(d){
      if (!d || !d.ok){ el.innerHTML = '<div class="error">Schema 加载失败</div>'; return; }
      schema = d;
      Z._schema = d;
      curType = Array.isArray(d.classes) ? "" : (Object.keys(d.classes)[0] || "");
      el.innerHTML = layoutHTML(d);
      bindToolbar(el);
      loadList(el);
    });
  }

  function layoutHTML(d){
    var h = '<div class="ont-toolbar">';
    h += '<select id="ont_type" title="按类筛选">';
    h += '<option value="">全部类型</option>';
    Object.keys(d.classes||{}).forEach(function(c){
      var cl = d.classes[c];
      var cnt = (d.instance_counts||{})[c]||0;
      h += '<option value="'+esc(c)+'">'+esc((cl&&cl.label)||c)+' ('+cnt+')</option>';
    });
    h += '</select>';
    h += '<input id="ont_q" type="text" placeholder="搜索实例…" style="width:200px;padding:6px 8px;border:1px solid #ccc;border-radius:6px">';
    h += '<button class="act" id="ont_new">＋ 新增实例</button>';
    h += '<button class="act ont-export-btn" id="ont_export">导出当前类型</button>';
    h += '</div>';
    h += '<div class="ont-main">';
    h += '<div class="panel"><h3 style="margin-top:0">实例（可编辑）</h3><div id="ont_list_col"></div></div>';
    h += '<div class="ont-edit" id="ont_edit_col"><div class="hint">选择左侧实例进行编辑，或点击「新增实例」创建。</div></div>';
    h += '</div>';
    return h;
  }

  function bindToolbar(el){
    el.querySelector("#ont_type").value = curType;
    el.querySelector("#ont_type").addEventListener("change", function(){
      curType = this.value; loadList(el);
    });
    el.querySelector("#ont_q").addEventListener("input", function(){ loadList(el); });
    el.querySelector("#ont_new").addEventListener("click", function(){ openCreate(el); });
    el.querySelector("#ont_export").addEventListener("click", function(){
      var t = el.querySelector("#ont_type").value || "";
      if (window.MarvisZone && MarvisZone.export && MarvisZone.export.triggerExport){
        MarvisZone.export.triggerExport(t);
      } else {
        alert("导出模块未加载，请检查 export.js");
      }
    });
  }

  function loadList(el){
    var box = el.querySelector("#ont_list_col");
    box.innerHTML = '<div class="loading" style="padding:10px">…</div>';
    var url = "/api/ontology/instances" + (curType ? "?type="+encodeURIComponent(curType) : "");
    api(url).then(function(d){
      var q = (el.querySelector("#ont_q").value||"").toLowerCase();
      var arr = (d.instances||[]).filter(function(it){
        if(!q) return true;
        var hay = (instLabel(it.props, it.id)+" "+it.id+" "+JSON.stringify(it.props||{})).toLowerCase();
        return hay.indexOf(q) >= 0;
      });
      listState.ids = arr.map(function(it){ return it.id; });
      var h = '';
      if (arr.length){
        h += '<div class="ont-batchbar" id="ont_batchbar" style="display:none">';
        h += '已选 <b id="ont_sel_n">0</b> 项 ';
        h += '<select id="b_fld"><option value="">— 批量补字段 —</option>';
        (batchFieldOptions(curType)).forEach(function(f){
          h += '<option value="'+esc(f.name)+'">'+esc(f.label||f.name)+(f.req?"（必填）":"")+'</option>';
        });
        h += '</select>';
        h += '<input id="b_val" type="text" placeholder="字段值（留空则补空串）" style="width:180px">';
        h += '<button class="act" id="b_apply">批量补字段</button>';
        h += '<button class="btn-danger" id="b_del">批量删除所选</button>';
        h += '<button class="ghost" id="b_clear">清除选择</button>';
        h += '</div>';
      }
      arr.slice(0,500).forEach(function(it){
        h += '<div class="row" data-id="'+esc(it.id)+'">';
        h += '<input type="checkbox" class="ont-chk" data-id="'+esc(it.id)+'" title="多选">';
        h += '<span class="tag">'+esc(it.type)+'</span>';
        h += '<span class="lb">'+esc(instLabel(it.props, it.id))+'</span>';
        h += '</div>';
      });
      box.innerHTML = h || '<div class="hint">无匹配实例</div>';
      bindBatch(el, box);
      Array.prototype.forEach.call(box.querySelectorAll(".row"), function(r){
        r.addEventListener("click", function(ev){
          if (ev.target.classList && ev.target.classList.contains("ont-chk")) return;
          openEditor(el, r.getAttribute("data-id"));
        });
      });
    });
  }

  /* ---------- 批量补字段可选字段（当前筛选类型内的可编辑字段） ---------- */
  function batchFieldOptions(type){
    var out=[], seen={};
    Object.keys(schema.data_props||{}).forEach(function(dn){
      var d = schema.data_props[dn];
      if (type && (!d || d.domain !== type)) return;
      if (seen[dn]) return; seen[dn]=1;
      out.push({name:dn, label:(d&&d.label)||dn, req:false});
    });
    return out;
  }

  /* ---------- 多选批量操作 ---------- */
  function bindBatch(el, box){
    var bar = box.querySelector("#ont_batchbar");
    if (!bar) return;
    var selN = box.querySelector("#ont_sel_n");
    var chks = Array.prototype.slice.call(box.querySelectorAll(".ont-chk"));
    function selectedIds(){
      return chks.filter(function(c){ return c.checked; }).map(function(c){ return c.getAttribute("data-id"); });
    }
    function refresh(){
      var n = selectedIds().length;
      selN.textContent = n;
      bar.style.display = n ? "" : "none";
    }
    chks.forEach(function(c){ c.addEventListener("change", refresh); });
    box.querySelector("#b_clear").addEventListener("click", function(){
      chks.forEach(function(c){ c.checked=false; });
      refresh();
    });
    box.querySelector("#b_apply").addEventListener("click", function(){
      var ids = selectedIds();
      var fn = box.querySelector("#b_fld").value;
      if (!ids.length){ alert("请先勾选实例"); return; }
      if (!fn){ alert("请选择要补的字段"); return; }
      var val = box.querySelector("#b_val").value || "";
      if (!confirm("为所选 "+ids.length+" 个实例补字段「"+fn+" = "+val+"」并提交？")) return;
      var changes = ids.map(function(id){ return {operation:"update", id:id, properties: (function(){ var o={}; o[fn]=val; return o; })()}; });
      commit(changes, "ontology-hub 批量补字段 "+fn).then(function(res){
        var m = document.createElement("div");
        m.className = res && res.ok ? "ont-result" : "ont-result err";
        m.innerHTML = res && res.ok
          ? '<b>批量补字段已提交</b>：v'+esc(res.version)+' · TTL '+esc(res.ttl_info||"?")+' triples'
          : '<b>提交失败：</b>'+esc((res && (res.errors||[res.reason||"未知错误"]).join("；"))||"未知错误");
        bar.parentNode.insertBefore(m, bar.nextSibling);
        if (res && res.ok) loadList(docRoot(box.closest(".ont-main")));
      });
    });
    box.querySelector("#b_del").addEventListener("click", function(){
      var ids = selectedIds();
      if (!ids.length){ alert("请先勾选实例"); return; }
      if (!confirm("删除所选 "+ids.length+" 个实例及其全部关联边？\n（可回滚：将生成版本快照）")) return;
      var changes = ids.map(function(id){ return {operation:"delete_node", id:id}; });
      commit(changes, "ontology-hub 批量删除 "+ids.length+" 个实例").then(function(res){
        var m = document.createElement("div");
        m.className = res && res.ok ? "ont-result" : "ont-result err";
        m.innerHTML = res && res.ok
          ? '<b>批量删除已提交</b>：v'+esc(res.version)+' · TTL '+esc(res.ttl_info||"?")+' triples'
          : '<b>提交失败：</b>'+esc((res && (res.errors||[res.reason||"未知错误"]).join("；"))||"未知错误");
        bar.parentNode.insertBefore(m, bar.nextSibling);
        if (res && res.ok) loadList(docRoot(box.closest(".ont-main")));
      });
    });
  }

  /* ========================================================
   * 新增实例
   * ======================================================== */
  function openCreate(el){
    var classes = Object.keys(schema.classes||{});
    var def = curType || classes[0];
    var fields = fieldsFor(def).filter(function(f){ return f.req; });
    if (!fields.length) fields = fieldsFor(def).slice(0,2);
    var h = '<h3>新增实例</h3>';
    h += '<div class="fld"><label>类型</label><select id="c_type">';
    classes.forEach(function(c){
      h += '<option value="'+esc(c)+'"'+(c===def?" selected":"")+'>'+esc((schema.classes[c]&&schema.classes[c].label)||c)+'</option>';
    });
    h += '</select></div>';
    fields.forEach(function(f){
      h += '<div class="fld"><label class="'+(f.req?"req":"")+'">'+esc(f.label||f.name)+'</label>';
      h += '<input type="text" id="c_'+esc(f.name)+'" placeholder="'+esc(f.name)+'"></div>';
    });
    h += '<div style="display:flex;gap:8px;margin-top:10px">';
    h += '<button class="act" id="c_ok">创建</button>';
    h += '<button class="ghost" id="c_cancel">取消</button></div>';
    h += '<div class="ont-result" id="c_msg" style="display:none"></div>';
    var col = el.querySelector("#ont_edit_col");
    col.innerHTML = h;
    var typeSel = col.querySelector("#c_type");
    typeSel.addEventListener("change", function(){
      var t=this.value, fs=fieldsFor(t).filter(function(f){return f.req;});
      if(!fs.length) fs=fieldsFor(t).slice(0,2);
      var defV={};
      var fh='<div class="fld"><label>类型</label>'; // keep build simple: rebuild fields
      openCreate(el, t);
    });
    col.querySelector("#c_cancel").addEventListener("click", function(){ col.innerHTML = '<div class="hint">选择左侧实例进行编辑，或点击「新增实例」创建。</div>'; });
    col.querySelector("#c_ok").addEventListener("click", function(){
      var t = typeSel.value;
      var newProps = {};
      fields.forEach(function(f){
        var v = (col.querySelector("#c_"+f.name)||{}).value;
        if (v) newProps[f.name] = v;
      });
      var label = newProps.title || newProps.name || newProps.filePath || "instance";
      var id = label ? (t+":"+label.replace(/\s+/g,"_")) : "";
      var changes = [{operation:"add_node", type:t, id:id, properties:newProps, name:label}];
      commit(changes, "ontology-hub 新增实例").then(function(res){
        var m = col.querySelector("#c_msg"); m.style.display="block";
        if (res && res.ok){
          var vid = (res.instances && res.instances[0]) || "";
          m.className = "ont-result"; m.innerHTML = '<b>已创建并提交</b>（v'+esc(res.version||"?")+'，TTL '+esc(res.ttl_info||"?")+'）';
          loadList(el);
        } else {
          m.className = "ont-result err";
          m.innerHTML = '<b>校验未通过：</b><ul>'+(res.errors||[res.reason||"未知错误"]).map(function(e){return '<li>'+esc(e)+'</li>';}).join("")+'</ul>';
        }
      });
    });
  }

  /* ========================================================
   * 编辑会话
   * ======================================================== */
  function openEditor(el, id){
    var col = el.querySelector("#ont_edit_col");
    col.innerHTML = '<div class="loading">加载实例…</div>';
    api("/api/ontology/node/"+encodeURIComponent(id)).then(function(d){
      if (!d || !d.ok){ col.innerHTML = '<div class="error">加载失败: '+esc(d&&d.reason)+'</div>'; return; }
      S = {
        id: d.node.id, type: d.node.type,
        origProps: JSON.parse(JSON.stringify(d.node.properties||{})),
        added: [], removed: [], inputs: {}
      };
      col.innerHTML = editHTML(d);
      bindEdit(col, d);
    });
  }

  function editHTML(d){
    var n = d.node, cls = n.type, p = n.properties||{};
    var fields = fieldsFor(cls);
    var h = '<h3 style="margin-top:0">';
    h += '<span class="tag">'+esc(cls)+'</span> <span>'+esc(instLabel(p, n.id))+'</span>';
    h += '<span class="grey" style="margin-left:8px">'+esc(n.id)+'</span></h3>';

    /* 数据属性区 */
    h += '<div class="sec"><h4>数据属性</h4>';
    fields.forEach(function(f){
      var v = p[f.name]!=null ? String(p[f.name]) : "";
      h += '<div class="fld"><label class="'+(f.req?"req":"")+'">'+esc(f.label||f.name)+
           (f.hint ? ' <span class="grey">'+esc(f.hint)+'</span>' : '')+'</label>';
      h += '<input type="'+(f.range==="decimal"||f.range==="integer"||f.name==="year"?"number":"text")+'" data-f="'+esc(f.name)+'" value="'+esc(v)+'"></div>';
    });
    // 读保护：实例已有的其它键（元数据/溯源等）
    var extra = Object.keys(p).filter(function(k){ return !fields.some(function(f){return f.name===k;}); });
    if (extra.length){
      h += '<div class="fld"><label>其它元数据（只读）</label><div class="ont-diff" style="background:#f8f9fa;border-color:#dee2e6">';
      extra.forEach(function(k){
        var v = p[k]; if (v && typeof v==="object") v = JSON.stringify(v);
        h += '<div class="diff-line">'+esc(k)+' = '+esc(""+v)+'</div>';
      });
      h += '</div></div>';
    }
    h += '</div>';

    /* 关系区 */
    h += '<div class="sec"><h4>对象关系</h4>';
    h += '<div id="ont_edges"></div>';
    h += '<div class="ont-addbar">';
    h += '<select id="a_out"><option value="">+ 添加出边（本实例 → 目标）</option>';
    outPropsFor(cls).forEach(function(o){ h += '<option value="'+esc(o.name)+'" data-range="'+esc(o.range)+'">'+esc(o.label)+'</option>'; });
    h += '</select>';
    h += '<select id="a_out_tgt" style="display:none"><option>选择目标…</option></select>';
    h += '<button class="ghost" id="a_out_add" style="display:none">\+</button>';
    h += '</div>';
    h += '<div class="ont-addbar">';
    h += '<select id="a_in"><option value="">+ 添加入边（来源 → 本实例）</option>';
    inPropsFor(cls).forEach(function(o){ h += '<option value="'+esc(o.name)+'" data-domain="'+esc(o.domain)+'">'+esc(o.label)+'</option>'; });
    h += '</select>';
    h += '<select id="a_in_src" style="display:none"><option>选择来源…</option></select>';
    h += '<button class="ghost" id="a_in_add" style="display:none">\+</button>';
    h += '</div>';
    h += '</div>';

    /* diff 预览 */
    h += '<div id="ont_diff"></div>';

    /* 操作按钮 */
    h += '<div style="display:flex;gap:10px;align-items:center;margin-top:8px">';
    h += '<button class="act" id="ont_save">提交修改</button>';
    h += '<button class="ghost" id="ont_reload">放弃/刷新</button>';
    h += '<span style="flex:1"></span>';
    h += '<button class="btn-danger" id="ont_delete">删除此实例</button>';
    h += '</div>';
    h += '<div id="ont_result"></div>';
    return h;
  }

  function bindEdit(col, d){
    S.inputs = {};
    Array.prototype.forEach.call(col.querySelectorAll("input[data-f]"), function(inp){
      S.inputs[inp.getAttribute("data-f")] = inp;
      inp.addEventListener("input", updateDiff(col, d));
    });
    renderEdges(col, d);
    bindEdgeAdd(col, d);
    col.querySelector("#ont_reload").addEventListener("click", function(){ openEditor(docRoot(col), S.id); });
    col.querySelector("#ont_delete").addEventListener("click", function(){
      if (!confirm("删除实例 "+S.id+" 及其全部关联边？\n（可回滚：将生成版本快照）")) return;
      commit([{operation:"delete_node", id:S.id}], "ontology-hub 删除实例").then(function(res){
        var r = col.querySelector("#ont_result");
        if (res && res.ok){
          r.className="ont-result"; r.innerHTML='<b>已删除并提交</b>（v'+esc(res.version)+'，TTL '+esc(res.ttl_info||"?")+'）';
          loadList(docRoot(col));
          col.innerHTML='<div class="hint">实例已删除。</div>';
        } else {
          r.className="ont-result err"; r.innerHTML='<b>失败：</b>'+esc((res.errors||[res.reason||"未知"]).join("；"));
        }
      });
    });
    col.querySelector("#ont_save").addEventListener("click", function(){ save(col, d); });
    updateDiff(col, d)();
  }

  function docRoot(col){ return col.closest(".ont-main").parentElement; }

  function renderEdges(col, d){
    var box = col.querySelector("#ont_edges");
    var h = '';
    d.out_edges.concat(d.in_edges).forEach(function(e){
      if (S.removed.indexOf(e.edge_id) >= 0) return;
      var arrow = e.direction==="out" ? "→" : "←";
      h += '<div class="edgerow" data-eid="'+esc(e.edge_id)+'">';
      h += '<span class="tag" style="background:'+(e.direction==="out"?"#d0ebff":"#fff3bf")+'">'+esc(e.type)+'</span>';
      h += '<span class="grey">'+arrow+'</span>';
      h += '<b>'+esc(e.other.label)+'</b> <span class="grey">('+esc(e.other.type)+') '+esc(e.other.id)+'</span>';
      h += '<span style="flex:1"></span><button class="btn-danger e-del">移除</button>';
      h += '</div>';
    });
    S.added.forEach(function(a){
      h += '<div class="edgerow"><span class="tag plus" style="background:#d3f9d8">'+esc(a.type)+'</span>';
      h += '<span class="grey">'+(a.direction==="in"?"←":"→")+'</span><b>'+esc(a.targetLabel||a.sourceLabel||"新节点")+'</b>';
      h += '<span class="plus">（待添加）</span><span style="flex:1"></span>';
      h += '<button class="btn-danger a-del">撤销</button></div>';
    });
    box.innerHTML = h || '<div class="hint">暂无关联边</div>';
    Array.prototype.forEach.call(box.querySelectorAll(".e-del"), function(b){
      b.addEventListener("click", function(){
        S.removed.push(b.closest(".edgerow").getAttribute("data-eid"));
        renderEdges(col, d); updateDiff(col, d)();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll(".a-del"), function(b){
      b.addEventListener("click", function(){
        var idx = Array.prototype.indexOf.call(box.querySelectorAll(".a-del"), b);
        S.added.splice(idx,1);
        renderEdges(col, d); updateDiff(col, d)();
      });
    });
  }

  function bindEdgeAdd(col, d){
    var outSel = col.querySelector("#a_out");
    var outTgt = col.querySelector("#a_out_tgt");
    var outAdd = col.querySelector("#a_out_add");
    outSel.addEventListener("change", function(){
      if (!this.value){ outTgt.style.display="none"; outAdd.style.display="none"; return; }
      var range = this.options[this.selectedIndex].getAttribute("data-range");
      loadCandidates(range, "", function(list){
        outTgt.innerHTML = '<option value="">选择目标（'+range+'）…</option>';
        list.forEach(function(it){ outTgt.innerHTML += '<option value="'+esc(it.id)+'">'+esc(it.label)+'</option>'; });
        outTgt.style.display=""; outAdd.style.display="";
      });
    });
    outAdd.addEventListener("click", function(){
      var pn = outSel.value, tgt = outTgt.value;
      if (!tgt) return;
      S.added.push({type:pn, source_id:S.id, target_id:tgt, direction:"out", targetLabel: outTgt.options[outTgt.selectedIndex].text});
      outSel.value=""; outTgt.style.display="none"; outAdd.style.display="none";
      renderEdges(col, d); updateDiff(col, d)();
    });

    var inSel = col.querySelector("#a_in");
    var inSrc = col.querySelector("#a_in_src");
    var inAdd = col.querySelector("#a_in_add");
    inSel.addEventListener("change", function(){
      if (!this.value){ inSrc.style.display="none"; inAdd.style.display="none"; return; }
      var domain = this.options[this.selectedIndex].getAttribute("data-domain");
      loadCandidates(domain, "", function(list){
        inSrc.innerHTML = '<option value="">选择来源（'+domain+'）…</option>';
        list.forEach(function(it){ inSrc.innerHTML += '<option value="'+esc(it.id)+'">'+esc(it.label)+'</option>'; });
        inSrc.style.display=""; inAdd.style.display="";
      });
    });
    inAdd.addEventListener("click", function(){
      var pn = inSel.value, src = inSrc.value;
      if (!src) return;
      S.added.push({type:pn, source_id:src, target_id:S.id, direction:"in", sourceLabel: inSrc.options[inSrc.selectedIndex].text});
      inSel.value=""; inSrc.style.display="none"; inAdd.style.display="none";
      renderEdges(col, d); updateDiff(col, d)();
    });
  }

  /* 候选实例（按类） */
  function loadCandidates(type, q, cb){
    api("/api/ontology/instances?type="+encodeURIComponent(type)).then(function(d){
      var list = (d.instances||[]).map(function(it){ return {id:it.id, label:instLabel(it.props, it.id)}; });
      cb(list || []);
    });
  }

  /* diff 预览 */
  function updateDiff(col, d){
    return function(){
      var newProps = collectProps(col);
      // 只对比可编辑字段，排除只读元数据（prov:/venue/file/content/createdBy 等）
      var oldLimited = {};
      Object.keys(S.inputs).forEach(function(k){ if (S.origProps[k]!=null) oldLimited[k] = ""+S.origProps[k]; });
      var dp = diffProps(oldLimited, newProps);
      var box = col.querySelector("#ont_diff");
      var items = [];
      dp.plus.forEach(function(t){ items.push('<div class="diff-line plus">＋ '+esc(t)+'</div>'); });
      dp.mod.forEach(function(t){ items.push('<div class="diff-line mod">～ '+esc(t)+'</div>'); });
      dp.minus.forEach(function(t){ items.push('<div class="diff-line minus">－ '+esc(t)+'</div>'); });
      S.added.forEach(function(a){ items.push('<div class="diff-line plus">＋ 边 '+esc(a.type)+' ('+esc(a.source_id)+'→'+esc(a.target_id)+')</div>'); });
      S.removed.forEach(function(rid){ items.push('<div class="diff-line minus">－ 移除边 '+esc(rid)+'</div>'); });
      if (!items.length){
        box.innerHTML = '<div class="ont-diff">暂无可提交的修改。</div>';
      } else {
        box.innerHTML = '<div class="ont-diff"><b>待提交变更（'+items.length+' 项）</b><div style="margin-top:4px">'+items.join("")+'</div></div>';
      }
    };
  }

  function collectProps(col){
    var np = {};
    Object.keys(S.inputs).forEach(function(k){
      var v = S.inputs[k].value;
      if (v != null){ v = ""+v; if (v.trim()) np[k] = v.trim(); }
    });
    return np;
  }

  /* 提交 */
  function save(col, d){
    var newProps = collectProps(col);
    var oldLimited = {};
    Object.keys(S.inputs).forEach(function(k){ if (S.origProps[k]!=null) oldLimited[k] = ""+S.origProps[k]; });
    var dp = diffProps(oldLimited, newProps);
    var changes = [];
    if (dp.n > 0) changes.push({operation:"update", id:S.id, properties:newProps});
    S.removed.forEach(function(rid){ changes.push({operation:"delete_edge", id:rid}); });
    S.added.forEach(function(a){ changes.push({operation:"add_edge", type:a.type, source_id:a.source_id, target_id:a.target_id}); });
    if (!changes.length){
      var r = col.querySelector("#ont_result");
      r.className="ont-result"; r.innerHTML='没有可提交的修改。'; return;
    }
    var btn = col.querySelector("#ont_save");
    btn.disabled = true; btn.textContent = "提交中…";
    commit(changes, "ontology-hub 编辑实例 "+S.id).catch(function(err){
      btn.disabled=false; btn.textContent="提交修改";
      var r = col.querySelector("#ont_result");
      r.className = "ont-result err";
      r.innerHTML = '<b>网络/服务错误：</b>'+esc((err&&err.message)||"提交请求失败，请重试");
    }).then(function(res){
      btn.disabled=false; btn.textContent="提交修改";
      var r = col.querySelector("#ont_result");
      if (res && res.ok){
        r.className = "ont-result";
        r.innerHTML = '<b>已提交</b>：v'+esc(res.version)+' · 校验通过 · TTL '+esc(res.ttl_info||"?")+' triples · 节点 '+esc(res.n_nodes)+' / 边 '+esc(res.n_edges);
        loadList(docRoot(col));
        openEditor(col.closest(".ont-main").parentElement, S.id);
      } else if (res && res.status==="rejected"){
        r.className = "ont-result err";
        r.innerHTML = '<b>SHACL 校验未通过，已拒绝提交</b>：<ul>'+(res.errors||[]).map(function(e){return '<li>'+esc(e)+'</li>';}).join("")+'</ul>';
      } else {
        r.className = "ont-result err";
        r.innerHTML = '<b>提交失败：</b>'+esc(res&&res.reason||"未知错误");
      }
    });
  }

  function commit(changes, desc){
    return api("/api/commit", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({changes:changes, description:desc||"ontology-hub edit", author:"web"})
    });
  }

  /* 模块对外：render */
  Z.render = render;
  Z._debug = { openEditor: openEditor, render: render };
})();
