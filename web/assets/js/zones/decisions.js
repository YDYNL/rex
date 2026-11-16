/* zone: decisions — 治理审计流：操作日志时间线 + 实体血缘（真实 /api/decisions） */
(function(){
  window.MarvisZone["decisions"] = {
    title: "治理审计",
    render: function(el){
      el.innerHTML = '<div class="loading">读取治理日志…</div>';
      fetch("/api/decisions").then(function(r){ return r.json(); }).then(function(d){
        var logs = d.log || [];
        var html = '<div class="cards"><div class="card" style="border-top:3px solid #1098ad"><b>'+d.total+'</b><span>治理操作记录</span></div></div>';
        if(!logs.length){
          html += '<div class="panel"><div class="hint">暂无治理记录。上传 PDF、提交编辑、回滚等操作会在此留痕。</div></div>';
        } else {
          html += '<div class="panel"><h3>操作时间线（最新在前）</h3><ul class="flow">';
          logs.forEach(function(r){
            var act = r.action||"?";
            var desc = typeof r.payload==="object" ? JSON.stringify(r.payload) : (r.payload||"");
            if(desc.length>160) desc = desc.slice(0,160)+"…";
            html += '<li><span class="time">'+esc(r.t||"")+'</span> · <b>'+esc(act)+'</b>';
            if(r.version) html += ' · <span class="tag">'+r.version+'</span>';
            if(desc){ html += '<div class="sub">'+esc(desc)+'</div>'; }
            html += '</li>';
          });
          html += '</ul></div>';
        }
        el.innerHTML = html;
      }).catch(function(e){ el.innerHTML = '<div class="error">请求失败: '+e+'</div>'; });
    }
  };
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
})();
