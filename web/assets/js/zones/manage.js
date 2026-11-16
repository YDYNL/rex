/* zone: manage — KG 概览仪表盘（真实数据 /api/manage/stats） */
(function(){
  window.MarvisZone["manage"] = {
    title: "总览",
    render: function(el){
      el.innerHTML = '<div class="loading">拉取统计…</div>';
      fetch("/api/manage/stats").then(function(r){ return r.json(); }).then(function(d){
        var kg = d.kg || {};
        var types = kg.types || {};
        var src = d.sources || [];
        var html = '<div class="cards">';
        html += card(kg.nodes||0, "节点", "#4c6ef5");
        html += card(kg.edges||0, "关系边", "#12b886");
        html += card(Object.keys(types).length, "实体类型", "#f59f00");
        html += card(d.versions||0, "版本快照", "#e8590c");
        html += '</div>';
        html += '<div class="panel"><h3>类型分布</h3><div class="bars">';
        Object.keys(types).forEach(function(k){
          var v = types[k], w = Math.max(2, Math.round(v/(kg.nodes||1)*100));
          html += '<div class="bar"><span>'+k+'</span><i style="width:'+w+'%"></i><b>'+v+'</b></div>';
        });
        html += '</div></div>';
        html += '<div class="grid2">';
        html += '<div class="panel"><h3>数据来源</h3><table class="tbl"><tr><th>来源</th><th>实体数</th></tr>';
        (src||[]).forEach(function(s){
          var k=s[0], n=s[1];
          html += '<tr><td>'+(k||"(未标注)")+'</td><td>'+n+'</td></tr>';
        });
        html += '</table></div>';
        html += '<div class="panel"><h3>工作台状态</h3><div class="kv">';
        html += '<dt>命名空间</dt><dd><code>'+d.namespace+'</code></dd>';
        html += '<dt>最近更新</dt><dd>'+(d.updated||"—")+'</dd>';
        html += '<dt>图谱版本</dt><dd>v2.4</dd>';
        html += '<dt>编辑入口</dt><dd>「本体」区进行实例编辑与提交（M3 全量）</dd>';
        html += '</div></div>';
        html += '</div>';
        el.innerHTML = html;
      }).catch(function(e){ el.innerHTML = '<div class="error">请求失败: '+e+'</div>'; });
    }
  };
  function card(n,t,c){ return '<div class="card" style="border-top:3px solid '+c+'"><b>'+n+'</b><span>'+t+'</span></div>'; }
})();
