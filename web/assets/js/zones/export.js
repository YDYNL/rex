/* zone: export — P0-2 Excel 导出触发逻辑
 * 由 ontology 区「导出当前类型」按钮调用；fetch blob 下载 xlsx（实例/关系/规则三 Sheet）。
 * 零依赖纯 JS。 */
(function(){
  window.MarvisZone["export"] = {
    title: "数据导出",
    triggerExport: function(type){
      var url = "/api/data/export" + (type ? "?type=" + encodeURIComponent(type) : "");
      var fname = "Another_数据导出_" + (type || "全部") + ".xlsx";
      fetch(url).then(function(r){
        if (!r.ok) return r.json().catch(function(){ return null; }).then(function(j){
          var e = new Error("HTTP " + r.status + (j && j.reason ? "：" + j.reason : ""));
          throw e;
        });
        return r.blob();
      }).then(function(blob){
        var u = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = u;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function(){ URL.revokeObjectURL(u); }, 4000);
        if (window.MarvisZone && MarvisZone.notify) MarvisZone.notify("已导出 Excel：" + fname);
      }).catch(function(err){
        alert("导出失败：" + err.message);
      });
    }
  };
})();
