/* zone: search — P1-3 顶栏全局检索
 * 加载后向顶栏注入搜索框与结果浮层；结果按类型分组，点击跳转图谱区查看。
 * 零依赖纯 JS。 */
(function(){
  var Z = window.MarvisZone["search"] = { title: "全局检索" };
  var timer = null;
  var lastQ = "";

  /* ---------- 顶栏注入 ---------- */
  Z.injectGlobal = function(){
    if (document.getElementById("gs_wrap")) return;
    var host = document.getElementById("global-search") || document.getElementById("view-title");
    if (!host) return;
    var wrap = document.createElement("div");
    wrap.id = "gs_wrap";
    wrap.className = "gs-wrap";
    wrap.innerHTML =
      '<input id="gs_input" type="search" placeholder="全局检索：标题 / 作者 / DOI / 关键词 / 摘要…" autocomplete="off">' +
      '<div id="gs_results" class="gs-results" style="display:none"></div>';
    host.parentNode.insertBefore(wrap, host.nextSibling);

    var inp = wrap.querySelector("#gs_input");
    var res = wrap.querySelector("#gs_results");

    function hide(){ res.style.display = "none"; }
    function show(){ res.style.display = ""; }

    function run(q){
      if (!q || q === lastQ){ return; }
      lastQ = q;
      show();
      res.innerHTML = '<div class="gs-hint">检索中…</div>';
      fetch("/api/search?q=" + encodeURIComponent(q)).then(function(r){ return r.json(); }).then(function(d){
        if (inp.value.trim() !== q) return;
        if (!d || !d.ok || !d.total){
          res.innerHTML = '<div class="gs-empty">无匹配结果</div>';
          return;
        }
        var h = '<div class="gs-head">共 ' + d.total + ' 条结果</div>';
        (d.groups || []).forEach(function(grp){
          h += '<div class="gs-group"><div class="gs-group-title">' + esc(grp.type) + '（' + grp.count + '）</div>';
          grp.items.slice(0, 30).forEach(function(it){
            var p = it.props || {};
            var sub = [p.title || p.name || "", p.author || "", p.year || p.yearText || "", p.venue || "", p.doi || ""].filter(Boolean).join(" · ");
            h += '<div class="gs-item" data-id="' + esc(it.id) + '" data-label="' + esc(it.label || it.id) + '">';
            h += '<div class="gs-item-name">' + esc(it.label || it.id) + '</div>';
            h += '<div class="gs-item-sub">' + esc(sub) + '</div>';
            h += '</div>';
          });
          h += '</div>';
        });
        res.innerHTML = h;
        Array.prototype.forEach.call(res.querySelectorAll(".gs-item"), function(item){
          item.addEventListener("click", function(){
            window._graphInitialSearch = item.getAttribute("data-label") || item.getAttribute("data-id");
            hide();
            inp.value = "";
            lastQ = "";
            if (window.activate) activate("graph");
          });
        });
      }).catch(function(){ res.innerHTML = '<div class="gs-empty">检索失败</div>'; });
    }

    inp.addEventListener("input", function(){
      var q = this.value.trim();
      if (!q){ hide(); lastQ = ""; return; }
      clearTimeout(timer);
      timer = setTimeout(function(){ run(q); }, 300);
    });
    inp.addEventListener("keydown", function(e){
      if (e.key === "Enter" && this.value.trim()){ clearTimeout(timer); run(this.value.trim()); }
      if (e.key === "Escape"){ hide(); this.blur(); }
    });
    document.addEventListener("click", function(e){
      if (!wrap.contains(e.target)) hide();
    });
  };

  /* ---------- 独立面板（保留 zone 语义，供未来入口使用） ---------- */
  Z.render = function(el){
    el.innerHTML =
      '<div class="panel"><p class="hint">全局检索已集成在顶栏搜索框（输入关键词后回车 / 自动检索）。</p>' +
      '<p class="hint">支持匹配：标题、名称、作者、DOI、关键词、摘要、类型、ID 等字段。</p></div>';
  };

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }

  /* 自启动：脚本加载后立即注入顶栏 */
  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", Z.injectGlobal);
  } else {
    setTimeout(Z.injectGlobal, 0);
  }
})();
