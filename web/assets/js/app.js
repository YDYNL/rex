/* app.js — 工作台引导：左侧六区导航 + zone 模块懒加载 */
window.MarvisZone = window.MarvisZone || {};

var META = {
  manage:   { title: "总览 · Manage" },
  graph:    { title: "知识图谱 · Knowledge Explorer" },
  ontology: { title: "本体工作台 · Ontology Hub" },
  analyze:  { title: "洞察 · Analyze" },
  enrich:   { title: "增强 · Enrich" },
  decisions:{ title: "治理审计 · Decisions" }
};

var viewTitle = document.getElementById("view-title");
var viewBody = document.getElementById("view-body");
var active = null;

function setTitle(t){ viewTitle.textContent = t; }

function showLoading(){ viewBody.innerHTML = '<div class="loading">加载中…</div>'; }

function loadScript(src, cb){
  var s = document.createElement("script");
  s.src = src;
  s.onload = function(){ cb && cb(); };
  s.onerror = function(){
    viewBody.innerHTML = '<div class="error">模块加载失败: ' + src + '</div>';
  };
  document.head.appendChild(s);
}

function renderZone(name){
  setTitle(META[name].title);
  var z = window.MarvisZone[name];
  if(!z){ viewBody.innerHTML = '<div class="error">zone 未定义: ' + name + '</div>'; return; }
  viewBody.innerHTML = "";
  z.render(viewBody);
}

function activate(name){
  if(active === name) return;
  active = name;
  var btns = document.querySelectorAll(".zone-btn");
  for(var i=0;i<btns.length;i++){
    btns[i].classList.toggle("active", btns[i].getAttribute("data-zone") === name);
  }
  showLoading();
  if(window.MarvisZone[name]){ renderZone(name); }
  else { loadScript("/assets/js/zones/" + name + ".js", function(){ renderZone(name); }); }
}

(function(){
  var btns = document.querySelectorAll(".zone-btn");
  for(var i=0;i<btns.length;i++){
    btns[i].addEventListener("click", function(){ activate(this.getAttribute("data-zone")); });
  }
  activate("manage");
})();
