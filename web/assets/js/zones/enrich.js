/* zone: enrich — 增强：PDF 导入 / 导出 / 版本 diff（真实 API） */
(function(){
  window.MarvisZone["enrich"] = {
    title: "增强",
    render: function(el){
      var self = this;
      var html = '<div class="panel"><h3>上传 PDF 自动入库</h3>';
      html += '<input type="file" id="up_pdf" accept=".pdf" style="margin-bottom:10px;display:block">';
      html += '<button class="act" id="up_btn">上传并解析</button> <span id="up_status"></span></div>';
      html += '<div class="grid2">';
      html += '<div class="panel"><h3>导出</h3>';
      html += '<a class="ghost" style="text-decoration:none;display:inline-block" href="/api/enrich/export?fmt=json">导出 JSON</a> ';
      html += '<a class="ghost" style="text-decoration:none;display:inline-block" href="/api/enrich/export?fmt=ttl">导出 TTL</a>';
      html += '</div>';
      html += '<div class="panel"><h3>版本 diff</h3>';
      html += '<select id="diff_v1"></select> → <select id="diff_v2"></select> ';
      html += '<button class="act" id="diff_btn">对比</button><div id="diff_out" style="margin-top:10px"></div></div>';
      html += '</div>';
      el.innerHTML = html;
      self.renderVersions();
      document.getElementById("up_btn").addEventListener("click", function(){
        var f = document.getElementById("up_pdf").files[0];
        if(!f){ alert("请先选择 PDF"); return; }
        var st = document.getElementById("up_status");
        st.textContent = "上传解析中（LLM 增强可能需要较长时间）…";
        var fd = new FormData(); fd.append("file", f);
        fetch("/upload", { method:"POST", body:fd }).then(function(r){return r.json();}).then(function(d){
          st.textContent = d.statusText + (d.title ? " · " + d.title : "");
          self.renderVersions();
        }).catch(function(e){ st.textContent = "失败:"+e; });
      });
      document.getElementById("diff_btn").addEventListener("click", function(){
        var v1 = document.getElementById("diff_v1").value;
        var v2 = document.getElementById("diff_v2").value;
        if(!v1||!v2){ alert("请选择两个版本"); return; }
        fetch("/api/enrich/diff?v1="+encodeURIComponent(v1)+"&v2="+encodeURIComponent(v2))
          .then(function(r){return r.json();}).then(function(d){
            var df = d.diff||{};
            var h = '<table class="tbl"><tr><th>变化</th><th>数量</th></tr>';
            h += '<tr><td>新增节点</td><td>'+df.nodes_added_n+'</td></tr>';
            h += '<tr><td>删除节点</td><td>'+df.nodes_removed_n+'</td></tr>';
            h += '<tr><td>修改节点</td><td>'+df.nodes_modified_n+'</td></tr>';
            h += '<tr><td>新增关系</td><td>'+df.edges_added_n+'</td></tr>';
            h += '<tr><td>删除关系</td><td>'+df.edges_removed_n+'</td></tr>';
            h += '</table>';
            document.getElementById("diff_out").innerHTML = h;
          }).catch(function(e){ document.getElementById("diff_out").innerHTML='<div class="error">'+e+'</div>'; });
      });
    },
    renderVersions: function(){
      var self = this;
      fetch("/api/commit/versions").then(function(r){return r.json();}).then(function(d){
        var s1 = document.getElementById("diff_v1"), s2 = document.getElementById("diff_v2");
        if(!s1) return;
        s1.innerHTML = ""; s2.innerHTML = "";
        (d.versions||[]).forEach(function(v){
          var o = document.createElement("option"); o.value = v.file; o.textContent = (v.taken_at||"")+" · "+v.n_nodes+"节点/"+v.n_edges+"边";
          var o2 = o.cloneNode();
          s1.appendChild(o); s2.appendChild(o2);
        });
        if(s2.options.length>0) s2.selectedIndex = 0;
        if(s2.options.length>1) s1.selectedIndex = 1;
      });
    }
  };
})();
