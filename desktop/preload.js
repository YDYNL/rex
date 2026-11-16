/**
 * preload.js — 桌面端受控桥（v0.2）
 * ==================================
 * 1. 暴露只读环境信息与原生入库 API（contextIsolation 下唯一通道）
 * 2. 注入「拖拽 PDF 即入库」能力 —— 不改动 web/ 下任何页面代码，桌面端自动生效
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function pathOf(file) {
  try {
    if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
  } catch (_) {}
  return (file && file.path) || '';
}

contextBridge.exposeInMainWorld('workbenchDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  uploadPdfs: (paths) => ipcRenderer.invoke('pdf:upload', paths),
  submitPdfs: (paths) => ipcRenderer.invoke('pdf:submit', paths),
  pickAndUpload: () => ipcRenderer.invoke('pdf:pick'),
  pickAndUploadProgress: () => ipcRenderer.invoke('pdf:pickSubmit'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  revealInFinder: (p) => ipcRenderer.invoke('app:openPath', p),
  onMenuPickPdf: (cb) => ipcRenderer.on('menu:pick-pdf', () => cb()),
});

// ------------------------------------------------------------------ 拖拽入库 UI
const STYLE_ID = 'wb-desktop-style';
const OVERLAY_ID = 'wb-drop-overlay';
const TOAST_ID = 'wb-drop-toast';

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
#${OVERLAY_ID}{
  position:fixed;inset:0;z-index:2147483000;display:none;
  align-items:center;justify-content:center;
  background:rgba(15,18,25,.82);backdrop-filter:blur(3px);
  font:500 17px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#e6edf7;
}
#${OVERLAY_ID}.on{display:flex}
#${OVERLAY_ID} .box{
  border:2px dashed rgba(125,211,252,.75);border-radius:18px;
  padding:44px 64px;text-align:center;background:rgba(30,39,67,.55);
}
#${OVERLAY_ID} .big{font-size:22px;font-weight:700;color:#7dd3fc;margin-bottom:8px}
#${OVERLAY_ID} .sub{font-size:14px;color:#9fb0c9}
#${TOAST_ID}{
  position:fixed;right:22px;bottom:22px;z-index:2147483001;width:360px;max-height:60vh;overflow:auto;
  background:#161c2c;border:1px solid #2b3550;border-radius:12px;
  box-shadow:0 18px 48px rgba(0,0,0,.5);
  font:400 13px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#dbe4f3;
  padding:14px 16px;display:none;
}
#${TOAST_ID}.on{display:block}
#${TOAST_ID} .t{font-weight:700;font-size:14px;margin-bottom:8px;color:#e6edf7}
#${TOAST_ID} .row{padding:5px 0;border-top:1px solid #232b41}
#${TOAST_ID} .row:first-of-type{border-top:0}
#${TOAST_ID} .nm{font-weight:600;color:#c7d3e8;word-break:break-all}
#${TOAST_ID} .st{font-size:12px;margin-top:1px}
#${TOAST_ID} .ok{color:#4ade80}#${TOAST_ID} .dup{color:#facc15}
#${TOAST_ID} .err{color:#f87171}#${TOAST_ID} .info{color:#7dd3fc}
#${TOAST_ID} .bar{display:flex;gap:8px;margin-top:11px}
#${TOAST_ID} button{
  flex:1;padding:7px 10px;border-radius:8px;cursor:pointer;
  border:1px solid #33405f;background:#1f2740;color:#cfe0f7;font-size:12px;
}
#${TOAST_ID} button:hover{background:#26304d}
`;
  document.head.appendChild(s);
}

function ensureOverlay() {
  let el = document.getElementById(OVERLAY_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = OVERLAY_ID;
  el.innerHTML = '<div class="box"><div class="big">松手即入库</div>'
    + '<div class="sub">支持 PDF 文献（可多选），将自动解析并写入知识图谱</div></div>';
  document.body.appendChild(el);
  return el;
}

let hideTimer = null;
function flashOverlay() {
  const el = ensureOverlay();
  el.classList.add('on');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el.classList.remove('on'), 900);
}

function toast(title, rows) {
  let el = document.getElementById(TOAST_ID);
  if (!el) { el = document.createElement('div'); el.id = TOAST_ID; document.body.appendChild(el); }
  const body = rows.map(r => {
    const cls = r.level || 'info';
    return `<div class="row"><div class="nm">${escapeHtml(r.name)}</div>`
      + `<div class="st ${cls}">${escapeHtml(r.text)}</div></div>`;
  }).join('');
  el.innerHTML = `<div class="t">${escapeHtml(title)}</div>${body}`
    + '<div class="bar"><button id="wb-toast-reload">重新加载页面</button>'
    + '<button id="wb-toast-close">关闭</button></div>';
  el.classList.add('on');
  const closeBtn = el.querySelector('#wb-toast-close');
  if (closeBtn) closeBtn.onclick = () => el.classList.remove('on');
  const reloadBtn = el.querySelector('#wb-toast-reload');
  if (reloadBtn) reloadBtn.onclick = () => location.reload();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_TEXT = {
  ingested: { level: 'ok', text: '已入库（新增）' },
  duplicate: { level: 'dup', text: '已入库（去重命中，跳过新增）' },
  updated: { level: 'ok', text: '已入库（修正噪声旧记录）' },
  failed: { level: 'err', text: '入库失败' },
  error: { level: 'err', text: '处理异常' },
};

async function fetchProgress(ids) {
  try {
    const r = await fetch('/api/upload/progress?file_id=' + encodeURIComponent(ids.join(',')));
    const j = await r.json();
    return (j && j.items) ? j.items : [];
  } catch (_) { return []; }
}

/** 逐文件解析进度 toast：items 为后端受理结果 [{file, file_id, reason, sync_done, status, statusText, title}] */
async function trackUploads(items) {
  const t0 = Date.now();
  const list = items || [];
  const n = list.length;
  if (!n) return 0;
  const state = list.map(x => {
    const accepted = !!(x && x.file_id) || !!(x && x.sync_done);
    return {
      file: (x && x.file) || '?',
      file_id: (x && x.file_id) || '',
      status: accepted ? (x.sync_done ? 'done' : 'queued') : 'failed',
      text: accepted ? (x.sync_done ? (x.statusText || '已完成') : '排队中…')
                     : ('提交失败：' + ((x && x.reason) || '未知原因')),
      level: accepted ? (x.sync_done ? ((STATUS_TEXT[x.status] || {}).level || 'ok') : 'info') : 'err',
      title: (x && x.title) || '',
    };
  });
  const rows = () => state.map(s => ({ name: s.file, text: s.text + (s.title ? '｜' + s.title : ''), level: s.level }));
  const finished = () => state.filter(s => s.status === 'done' || s.status === 'failed').length;
  if (!state.some(s => s.file_id)) { toast(`提交结束：成功 0 / 共 ${n}`, rows()); return 0; }
  toast(`正在解析…（完成 0/${n}）`, rows());
  let guard = 0;
  while (guard++ < 3000) {
    const pend = state.filter(s => s.file_id && s.status !== 'done' && s.status !== 'failed');
    if (!pend.length) break;
    await wait(1500);
    const its = await fetchProgress(pend.map(s => s.file_id));
    its.forEach(it => {
      const s = state.find(v => v.file_id === it.file_id);
      if (!s || s.status === 'done' || s.status === 'failed') return;
      if (it.title) s.title = it.title;
      if (it.status === 'done') {
        s.status = 'done';
        s.text = it.status_text || '解析完成';
        s.level = (STATUS_TEXT[it.result_status] || {}).level || 'ok';
      } else if (it.status === 'failed') {
        s.status = 'failed';
        s.text = (it.status_text || '入库失败') + (it.reason ? '：' + it.reason : '');
        s.level = 'err';
      } else if (it.status === 'parsing') {
        s.text = (it.stage_name || '解析中') + ' ' + (it.percent || 0) + '%（已用 '
               + Math.round((Date.now() - t0) / 1000) + 's）';
        s.level = 'info';
      } else {
        s.text = '排队中…' + (it.queue_position > 1 ? '（前方 ' + (it.queue_position - 1) + ' 篇）' : '');
        s.level = 'info';
      }
    });
    toast(`正在解析…（完成 ${finished()}/${n}）`, rows());
  }
  const okN = state.filter(s => s.status === 'done').length;
  toast(`入库完成：成功 ${okN} / 共 ${n}`, rows());
  return okN;
}

async function handleFiles(files) {
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name || ''));
  if (!pdfs.length) {
    toast('未发现 PDF 文件', [{ name: files.map(f => f.name).join('、') || '（空）', text: '仅支持 PDF 文献', level: 'err' }]);
    return;
  }
  const paths = pdfs.map(pathOf).filter(Boolean);
  const skipped = pdfs.length - paths.length;
  if (skipped > 0) {
    toast(`有 ${skipped} 个文件无法获取本地路径，已跳过`,
          [{ name: '（已跳过）', text: '请改用「上传文献」按钮选择文件', level: 'err' }]);
    await wait(1200);
  }
  if (!paths.length) return;
  const sub = await ipcRenderer.invoke('pdf:submit', paths);
  const items = (sub && sub.items) || [];
  const okN = await trackUploads(items);
  if (okN > 0) {
    // 让页面数据区感知数据已变化
    window.dispatchEvent(new CustomEvent('workbench-data-changed', { detail: { items } }));
  }
}

function installDropSupport() {
  injectStyle();
  ensureOverlay();

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return;
    stop(e); ensureOverlay().classList.add('on');
  }, true);

  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    stop(e);
    e.dataTransfer.dropEffect = 'copy';
  }, true);

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {   // 真正离开窗口
      const el = document.getElementById(OVERLAY_ID);
      if (el) el.classList.remove('on');
    }
  }, true);

  window.addEventListener('drop', (e) => {
    stop(e);
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.classList.remove('on');
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) handleFiles(files);
  }, true);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', installDropSupport);
} else {
  installDropSupport();
}

ipcRenderer.on('menu:pick-pdf', async () => {
  const r = await ipcRenderer.invoke('pdf:pickSubmit');
  if (!r || r.canceled) return;
  const okN = await trackUploads(r.items || []);
  if (okN > 0) {
    window.dispatchEvent(new CustomEvent('workbench-data-changed', { detail: { items: r.items } }));
  }
});

// ------------------------------------------------------------------ 六区探针（仅 WORKBENCH_PROBE=1 时由主进程触发）
const PROBE_ZONES = ['manage', 'graph', 'ontology', 'analyze', 'enrich', 'decisions'];
const wait = (ms) => new Promise(r => setTimeout(r, ms));

ipcRenderer.on('probe:run', async () => {
  const out = {};
  for (const z of PROBE_ZONES) {
    const btn = document.querySelector('.zone-btn[data-zone="' + z + '"]');
    if (!btn) { out[z] = '(未找到导航按钮)'; continue; }
    btn.click();
    await wait(2600);
    const body = document.getElementById('view-body');
    const txt = (body && body.innerText) ? body.innerText : '(无 view-body)';
    out[z] = txt.replace(/\s+/g, ' ').slice(0, 240);
  }
  const back = document.querySelector('.zone-btn[data-zone="manage"]');
  if (back) back.click();
  ipcRenderer.send('probe:report', out);
});
