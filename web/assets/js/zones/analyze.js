/* zone: analyze — 洞察（M4：SPARQL 查询面板 + 预置模板 + 轻量推理） */
(function(){
  window.MarvisZone["analyze"] = {
    title: "洞察",
    render: function(el){
      var html = '';
      html += '<div class="panel"><h3>SPARQL 查询面板</h3>';
      html += '<p class="hint">直接对图谱 TTL（rdflib）执行 SPARQL 查询。命名空间：<code>es</code> = <code>http://edu-scholar.org/ontology#</code>，另有 <code>rdf/rdfs/xsd/owl/prov</code>。</p>';
      html += '<div class="row"><select id="az_tpl" style="flex:1"><option value="">— 选择预置模板 —</option></select>';
      html += '<button id="az_run" class="btn primary">运行查询</button></div>';
      html += '<textarea id="az_q" rows="7" spellcheck="false" placeholder="SELECT ?p ?title WHERE { ?p a es:Paper . ?p es:title ?title } LIMIT 10"></textarea>';
      html += '<div class="row"><span class="hint" id="az_hint"></span><span style="flex:1"></span>';
      html += '<button id="az_clear" class="btn">清空</button></div>';
      html += '<div id="az_result"></div></div>';
      html += '<div class="panel"><h3>轻量推理 · 数据质检</h3>';
      html += '<p class="hint">基于图谱执行规则推理：缺作者论文、引用不对称、低置信度、孤立关键词等，辅助发现数据问题。</p>';
      html += '<button id="az_reason" class="btn primary">运行推理</button>';
      html += '<div id="az_reason_result"></div></div>';

      el.innerHTML = html;
      var q = el.querySelector("#az_q"), tpl = el.querySelector("#az_tpl"), hint = el.querySelector("#az_hint");
      var result = el.querySelector("#az_result"), rr = el.querySelector("#az_reason_result");

      // 加载预置模板
      fetch("/api/analyze/templates").then(function(r){ return r.json(); }).then(function(d){
        (d.templates||[]).forEach(function(t){
          var o = document.createElement("option");
          o.value = t.id; o.textContent = t.name; o.title = t.desc || "";
          tpl.appendChild(o);
        });
        if((d.templates||[]).length){ q.value = d.templates[1].sparql; hint.textContent = d.templates[1].desc; }
      }).catch(function(){ hint.textContent = "模板加载失败"; });

      tpl.addEventListener("change", function(){
        if(!tpl.value) return;
        fetch("/api/analyze/templates").then(function(r){ return r.json(); }).then(function(d){
          var t = (d.templates||[]).find(function(x){ return x.id === tpl.value; });
          if(t){ q.value = t.sparql; hint.textContent = t.desc; }
        }).catch(function(){});
      });

      el.querySelector("#az_run").addEventListener("click", function(){
        var query = q.value.trim();
        if(!query){ result.innerHTML = '<div class="error">请输入 SPARQL 查询</div>'; return; }
        result.innerHTML = '<div class="loading">查询中…</div>';
        fetch("/api/analyze", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({sub: "sparql", query: query})
        }).then(function(r){ return r.json(); }).then(function(d){
          if(!d.ok){ result.innerHTML = '<div class="error">'+esc(d.reason||"查询失败")+'</div>'; return; }
          if(!d.rows || !d.rows.length){ result.innerHTML = '<div class="hint">查询成功，0 行结果（共 '+d.triples+' triples）。</div>'; return; }
          var html = '<div class="hint">返回 '+d.row_count+' 行 · 图谱共 '+d.triples+' triples</div>';
          html += '<table class="tbl"><thead><tr>';
          (d.columns||[]).forEach(function(c){ html += '<th>'+esc(c)+'</th>'; });
          html += '</tr></thead><tbody>';
          d.rows.forEach(function(row){
            html += '<tr>';
            row.forEach(function(v){
              var s = v == null ? "" : String(v);
              html += '<td>'+(s.length > 160 ? esc(s.slice(0,160))+"…" : esc(s))+'</td>';
            });
            html += '</tr>';
          });
          html += '</tbody></table>';
          result.innerHTML = html;
        }).catch(function(e){ result.innerHTML = '<div class="error">请求失败: '+esc(e)+'</div>'; });
      });

      el.querySelector("#az_clear").addEventListener("click", function(){ q.value = ""; hint.textContent = ""; result.innerHTML = ""; });

      el.querySelector("#az_reason").addEventListener("click", function(){
        rr.innerHTML = '<div class="loading">推理中…</div>';
        fetch("/api/analyze", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({sub: "reason"})
        }).then(function(r){ return r.json(); }).then(function(d){
          if(!d.ok){ rr.innerHTML = '<div class="error">'+esc(d.reason||"推理失败")+'</div>'; return; }
          var html = '<div class="hint">推理完成 · 图谱共 '+d.triples+' triples</div>';
          if(!d.findings || !d.findings.length){ html += '<div class="hint">未发现数据问题。</div>'; }
          (d.findings||[]).forEach(function(f){
            var color = f.severity === "high" ? "#e03131" : f.severity === "medium" ? "#f59f00" : "#868e96";
            html += '<div class="panel" style="border-left:4px solid '+color+'"><h4>'+esc(f.rule)+' <span class="hint">('+f.count+')</span></h4>';
            (f.samples||[]).forEach(function(s){
              if(typeof s === "string"){ html += '<div class="mono">'+esc(s)+'</div>'; }
              else { html += '<div class="mono">'+(s.id?esc(s.id):"")+(s.title?" — "+esc(s.title):"")+(s.confidence!=null?" · conf="+s.confidence:"")+(s.from?" ("+esc(s.from)+" → "+esc(s.to)+")":"")+'</div>'; }
            });
            html += '</div>';
          });
          rr.innerHTML = html;
        }).catch(function(e){ rr.innerHTML = '<div class="error">请求失败: '+esc(e)+'</div>'; });
      });
    }
  };
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
})();
