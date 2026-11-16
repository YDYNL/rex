/**
 * main.js — ReX 桌面端主进程（v0.2）
 * =================================================
 * 架构：
 *   Electron 窗口  →  http://127.0.0.1:<UI_PORT>/            （Node 内嵌静态服务，托管 web/）
 *                   →  http://127.0.0.1:<UI_PORT>/api/*      （反向代理到 Python 后端）
 *                   →  http://127.0.0.1:<UI_PORT>/upload
 *   Python 后端     →  tools/serve_workbench.py  <PY_PORT>   （图谱 API / 提交闸门 / 上传闭环）
 *
 * 页面入口（窗口菜单 Cmd+1 / Cmd+2 切换）：
 *   index.html                        六大区工作台（真实 /api/*，默认入口）
 *   prototype_ai_workbench_v5.html    v5 单文件原型（数据内嵌，作为兜底/对照）
 *
 * v0.2 新增：
 *   1. 打包适配：工作根目录开发态=仓库上一层，打包态=用户数据目录（首次从 resources/seed 播种）
 *   2. Python 解释器探测（跳过缺 cgi 模块的 3.13+）
 *   3. 原生拖拽入库：渲染层拖入 PDF → 主进程 multipart 直传后端 /upload
 *   4. 原生菜单 + 入口切换
 */
'use strict';

const { app, BrowserWindow, shell, ipcMain, Menu, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

// ---------------------------------------------------------------- 基础配置
const DESKTOP_DIR = __dirname;
// 应用名统一为 ReX；用户数据目录同名。
// 历史目录（按新→旧优先级）：Another（本产品改名前的名字）、科研学术本体工作台（更早的名字）
// 迁移策略：仅当新目录里没有 workspace 而某个历史目录里有，把 workspace / llm_config 迁过来
// （不整体 rename 旧目录，避免动到 Electron 缓存目录，也避免新目录被提前创建导致迁移永不触发）
app.setName('ReX');
const APP_DATA_DIR = app.getPath('appData');
const LEGACY_DATA_DIRS = [
  path.join(APP_DATA_DIR, 'Another'),
  path.join(APP_DATA_DIR, '科研学术本体工作台'),
];
const NEW_DATA_DIR = path.join(APP_DATA_DIR, 'ReX');
try {
  const newWs = path.join(NEW_DATA_DIR, 'workspace');
  if (!fs.existsSync(newWs)) {
    for (const legacyDir of LEGACY_DATA_DIRS) {
      const legacyWs = path.join(legacyDir, 'workspace');
      if (!fs.existsSync(legacyWs)) continue;
      fs.mkdirSync(NEW_DATA_DIR, { recursive: true });
      fs.renameSync(legacyWs, newWs);
      const legacyCfg = path.join(legacyDir, 'llm_config.json');
      const newCfg = path.join(NEW_DATA_DIR, 'llm_config.json');
      if (fs.existsSync(legacyCfg) && !fs.existsSync(newCfg)) fs.renameSync(legacyCfg, newCfg);
      console.log('[workbench] 已从旧目录迁移工作区：' + legacyWs + ' → ' + newWs);
      break;
    }
  }
} catch (e) {
  console.warn('[workbench] 旧目录工作区迁移失败（将使用新目录）：' + e.message);
}
app.setPath('userData', NEW_DATA_DIR);
const IS_PACKAGED = app.isPackaged;

/** 工作根目录：开发态 = <Ontology>；打包态 = 用户数据目录（可写，不污染 .app）
 *  WORKBENCH_WORK_ROOT 可覆盖（用于干净机器验收 / 多实例隔离测试） */
const WORK_ROOT = process.env.WORKBENCH_WORK_ROOT
  ? path.resolve(process.env.WORKBENCH_WORK_ROOT)
  : (IS_PACKAGED
    ? path.join(app.getPath('userData'), 'workspace')
    : path.resolve(DESKTOP_DIR, '..'));

const WEB_DIR = path.join(WORK_ROOT, 'web');
const SERVE_PY = path.join(WORK_ROOT, 'tools', 'serve_workbench.py');

const UI_PORT = intEnv('WORKBENCH_UI_PORT', 5199);   // Node 静态服务 + 反代
const PY_PORT = intEnv('WORKBENCH_API_PORT', 9173);  // Python 后端
const LLM_PORT = intEnv('WORKBENCH_LLM_PORT', 8199); // 内置 llama-server

/** 随包运行时目录：打包态 = resources/runtime，开发态 = desktop/vendor/runtime */
const RUNTIME_DIR = IS_PACKAGED
  ? path.join(process.resourcesPath, 'runtime')
  : path.join(DESKTOP_DIR, 'vendor', 'runtime');
/** 随包模型目录：打包态 = resources/models，开发态 = desktop/vendor/models */
const MODELS_DIR = IS_PACKAGED
  ? path.join(process.resourcesPath, 'models')
  : path.join(DESKTOP_DIR, 'vendor', 'models');

const IS_WIN = process.platform === 'win32';

/** 随包运行时布局：mac = py311/bin/python3 + llama/llama-server；win = py311-win/python.exe + llama-win/llama-server.exe */
const PY_SUBDIR = IS_WIN ? 'py311-win' : 'py311';
const LLAMA_SUBDIR = IS_WIN ? 'llama-win' : 'llama';
const BUNDLED_PY = path.join(RUNTIME_DIR, PY_SUBDIR, IS_WIN ? 'python.exe' : path.join('bin', 'python3'));
const BUNDLED_LLAMA = path.join(RUNTIME_DIR, LLAMA_SUBDIR, IS_WIN ? 'llama-server.exe' : 'llama-server');
const LLM_MODEL_ID = 'qwen3-4b';

const PAGES = {
  v6: { file: 'prototype_ai_workbench_v6.html', label: '工作台（v5 交互 · 真实数据）' },
  workbench: { file: 'index.html', label: '六大区工作台（诊断视图）' },
  prototype: { file: 'prototype_ai_workbench_v5.html', label: 'v5 原型（内嵌数据）' },
};
const DEFAULT_PAGE = 'v6';

function intEnv(key, def) {
  const v = parseInt(process.env[key] || '', 10);
  return Number.isFinite(v) ? v : def;
}

let mainWindow = null;
let staticServer = null;
let pyProc = null;
let pyOwned = false;
let pyPython = null;
let pyReady = false;
let llmProc = null;
let llmOwned = false;
let llmReady = false;
let llmModelPath = null;

function log(...a) { console.log('[workbench]', ...a); }

/** 终止子进程：Windows 需 taskkill /T 才能连带其子进程，POSIX 直接 SIGTERM */
function killTree(proc) {
  if (!proc || proc.killed || !proc.pid) return;
  if (IS_WIN) {
    try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    catch (_) { try { proc.kill(); } catch (__) {} }
  } else {
    try { proc.kill('SIGTERM'); } catch (_) {}
  }
}

// ---------------------------------------------------------------- 打包态播种
/** 首次启动把随包资源复制到用户数据目录，使数据可写、后端 BASE_DIR 自洽 */
const SEED_ITEMS = [
  ['web', 'web', 'always'],
  ['tools', 'tools', 'always'],
  ['scholar_literature_graph_v2_4.json', 'scholar_literature_graph_v2_4.json', 'once'],
  ['scholar_data_v2_4.ttl', 'scholar_data_v2_4.ttl', 'once'],
  // 本体 / SHACL：仅首次播种。工作台「结构编辑」会在这两个文件的扩展区写入用户改动，
  // 若设为 always 会在每次启动时把用户结构改动冲掉。
  ['edu_scholar_ontology.ttl', 'edu_scholar_ontology.ttl', 'once'],
  ['edu_scholar_shapes.ttl', 'edu_scholar_shapes.ttl', 'once'],
  ['versions', 'versions', 'once'],
];

function bootstrapWorkspace() {
  if (!IS_PACKAGED) return;
  const seed = path.join(process.resourcesPath, 'seed');
  if (!fs.existsSync(seed)) { log('未找到 seed 资源目录：' + seed); return; }
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  for (const [from, to, mode] of SEED_ITEMS) {
    const src = path.join(seed, from);
    const dst = path.join(WORK_ROOT, to);
    if (!fs.existsSync(src)) continue;
    if (mode === 'once' && fs.existsSync(dst)) continue;
    try {
      fs.cpSync(src, dst, { recursive: true, force: true });
    } catch (e) {
      log(`播种失败 ${from} → ${to}: ${e.message}`);
    }
  }
  log('工作目录已就绪：' + WORK_ROOT);
}

// ---------------------------------------------------------------- Python 后端
const PY_CANDIDATES = [
  process.env.WORKBENCH_PYTHON,
  BUNDLED_PY,                                   // 随包 Python（3.11，含 cgi 与 pypdf/pdfplumber）
  ...(IS_WIN ? [
    'python.exe', 'python3.exe', 'python', 'python3',
  ] : [
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.10',
    '/usr/local/bin/python3.11',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
  ]),
].filter(Boolean);

/** serve_workbench.py 依赖 cgi 模块（3.13 起被移除），据此筛选解释器 */
function pickPython() {
  for (const p of PY_CANDIDATES) {
    try {
      execFileSync(p, ['-c', 'import cgi'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
      return p;
    } catch (_) { /* 试下一个 */ }
  }
  return null;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

async function waitPort(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portInUse(port)) return true;
    await new Promise(r => setTimeout(r, 350));
  }
  return false;
}

async function startPythonBackend() {
  if (await portInUse(PY_PORT)) {
    pyReady = true;
    log(`Python 后端已在 :${PY_PORT} 运行，复用现有实例`);
    return true;
  }
  if (!fs.existsSync(SERVE_PY)) {
    log(`未找到 ${SERVE_PY}，跳过后端启动`);
    return false;
  }
  pyPython = pickPython();
  if (!pyPython) {
    log('未找到可用 Python 解释器（需含 cgi 模块，即 3.9~3.12）');
    return false;
  }
  try {
    const pyEnv = Object.assign({}, process.env, {
      // 统一模型入口：内置 llama-server（OpenAI 兼容）；Python 侧 llm_bridge / enhance_ingest 均读这两个变量
      WORKBENCH_LLM_PORT: String(LLM_PORT),
      ES_LLM_BASE: `http://127.0.0.1:${LLM_PORT}/v1`,
      ES_LLM_MODEL: LLM_MODEL_ID,
      ES_LLM_FORCE_V1: '1',        // llama-server 无 Ollama 原生 /api/chat，直接走 OpenAI 兼容路径
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
    });
    pyProc = spawn(pyPython, [SERVE_PY, String(PY_PORT)], {
      cwd: WORK_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pyEnv,
      windowsHide: true,
    });
    pyOwned = true;
    pyProc.stdout.on('data', d => process.stdout.write('[py] ' + d));
    pyProc.stderr.on('data', d => process.stderr.write('[py] ' + d));
    pyProc.on('exit', (code, sig) => {
      log(`Python 后端退出 code=${code} sig=${sig}`);
      pyProc = null; pyOwned = false; pyReady = false;
    });
    pyProc.on('error', (e) => log('Python 启动失败：' + e.message));
    pyReady = await waitPort(PY_PORT, 12000);
    log(pyReady ? `Python 后端就绪 :${PY_PORT}（${pyPython}）` : 'Python 后端启动超时（页面照常打开）');
    return pyReady;
  } catch (e) {
    log('Python 后端异常：' + e.message);
  }
  return false;
}

function stopPythonBackend() {
  if (pyProc && pyOwned && !pyProc.killed) {
    killTree(pyProc);
    log('已请求停止 Python 后端');
  }
}

// ---------------------------------------------------------------- 内置本地模型（llama.cpp）
/** 在 MODELS_DIR 里挑一个 .gguf 权重（优先 Qwen3-4B Q4_K_M） */
function pickModelFile() {
  try {
    const files = fs.readdirSync(MODELS_DIR).filter(f => f.toLowerCase().endsWith('.gguf'));
    if (!files.length) return null;
    const preferred = files.find(f => /Q4_K_M/i.test(f)) || files.find(f => /Q4/i.test(f)) || files[0];
    return path.join(MODELS_DIR, preferred);
  } catch (_) { return null; }
}

function llmHealthy() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: LLM_PORT, path: '/health', method: 'GET', timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** 启动随包 llama-server（OpenAI 兼容 /v1），失败不阻塞主流程 */
async function startLocalModel() {
  if (await portInUse(LLM_PORT)) {
    llmReady = true;
    llmOwned = false;
    log(`本地模型服务已在 :${LLM_PORT} 运行，复用现有实例`);
    return true;
  }
  if (!fs.existsSync(BUNDLED_LLAMA)) { log('未找到内置 llama-server：' + BUNDLED_LLAMA); return false; }
  llmModelPath = pickModelFile();
  if (!llmModelPath) { log('未找到内置模型权重（' + MODELS_DIR + '）'); return false; }

  const args = [
    '-m', llmModelPath,
    '--host', '127.0.0.1', '--port', String(LLM_PORT),
    '-c', '8192', '--jinja', '--no-webui',
    '-t', String(Math.max(4, Math.min(8, require('os').cpus().length - 2))),
  ];
  try {
    llmProc = spawn(BUNDLED_LLAMA, args, {
      cwd: path.join(RUNTIME_DIR, LLAMA_SUBDIR),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        // mac 用 DYLD_LIBRARY_PATH；Windows 用 PATH 定位随包 DLL（exe 同目录本就是首选）
        DYLD_LIBRARY_PATH: path.join(RUNTIME_DIR, LLAMA_SUBDIR),
        PATH: path.join(RUNTIME_DIR, LLAMA_SUBDIR) + path.delimiter + (process.env.PATH || ''),
      }),
      windowsHide: true,
    });
    llmOwned = true;
    llmProc.stdout.on('data', d => { if (process.env.WORKBENCH_LLM_DEBUG === '1') process.stdout.write('[llm] ' + d); });
    llmProc.stderr.on('data', d => { if (process.env.WORKBENCH_LLM_DEBUG === '1') process.stderr.write('[llm] ' + d); });
    llmProc.on('exit', (code, sig) => { log(`本地模型退出 code=${code} sig=${sig}`); llmProc = null; llmOwned = false; llmReady = false; });
    llmProc.on('error', e => log('本地模型启动失败：' + e.message));
  } catch (e) {
    log('本地模型异常：' + e.message);
    return false;
  }

  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {          // 4B 模型冷加载约 15~40s
    if (await llmHealthy()) {
      llmReady = true;
      log(`本地模型就绪 :${LLM_PORT}（${path.basename(llmModelPath)}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      return true;
    }
    await new Promise(r => setTimeout(r, 700));
  }
  log('本地模型启动超时（页面照常打开，AI 能力暂不可用）');
  return false;
}

function stopLocalModel() {
  if (llmProc && llmOwned && !llmProc.killed) {
    killTree(llmProc);
    log('已请求停止本地模型');
  }
}

// ---------------------------------------------------------------- 静态服务 + 反代
function proxyToPython(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port: PY_PORT,
    path: req.url,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: `127.0.0.1:${PY_PORT}` }),
  };
  const p = http.request(options, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  p.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, reason: '后端未就绪：' + e.message }, null, 2));
  });
  p.setTimeout(600000, () => { p.destroy(new Error('后端超时')); });
  req.pipe(p);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/' + PAGES[DEFAULT_PAGE].file;
  if (!fs.existsSync(WEB_DIR)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端目录不存在：' + WEB_DIR);
    return;
  }
  const rootReal = fs.realpathSync(WEB_DIR);
  let targetReal;
  try { targetReal = fs.realpathSync(path.join(WEB_DIR, rel.replace(/^\/+/, ''))); }
  catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + rel);
    return;
  }
  if (!targetReal.startsWith(rootReal)) {   // 路径穿越防护
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(targetReal, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(targetReal).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
}

function startUiServer() {
  return new Promise((resolve) => {
    staticServer = http.createServer((req, res) => {
      const url = req.url || '/';
      if (url.startsWith('/api/') || url === '/upload') { proxyToPython(req, res); return; }
      serveStatic(req, res);
    });
    staticServer.on('error', (e) => { log('静态服务错误：' + e.message); resolve(false); });
    staticServer.listen(UI_PORT, '127.0.0.1', () => {
      log(`UI 服务就绪 http://127.0.0.1:${UI_PORT}`);
      resolve(true);
    });
  });
}

// ---------------------------------------------------------------- 原生 PDF 入库
/** multipart/form-data 直传后端 /upload（对应 serve_workbench.py 的兼容入口） */
function uploadOne(filePath) {
  return new Promise((resolve) => {
    const name = path.basename(filePath);
    let buf;
    try { buf = fs.readFileSync(filePath); }
    catch (e) { return resolve({ ok: false, file: name, path: filePath, reason: '读取失败：' + e.message }); }

    const boundary = '----workbench' + Date.now() + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`, 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buf, tail]);

    const req = http.request({
      hostname: '127.0.0.1', port: PY_PORT, path: '/upload', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch (_) { data = { ok: false, reason: text.slice(0, 500) }; }
        resolve(Object.assign({ file: name, path: filePath }, data));
      });
    });
    req.on('error', e => resolve({ ok: false, file: name, path: filePath, reason: '后端未就绪：' + e.message }));
    req.setTimeout(30 * 60 * 1000, () => { req.destroy(new Error('处理超时（>30 分钟）')); });
    req.end(body);
  });
}

async function uploadMany(paths) {
  const out = [];
  for (const p of paths || []) out.push(await uploadOne(p));
  return out;
}

function registerIpc() {
  ipcMain.handle('pdf:upload', async (_e, paths) => uploadMany(paths));

  ipcMain.handle('pdf:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择要入库的 PDF',
      filters: [{ name: 'PDF 文献', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true, results: [] };
    return { canceled: false, results: await uploadMany(r.filePaths) };
  });

  ipcMain.handle('app:info', async () => ({
    packaged: IS_PACKAGED,
    workRoot: WORK_ROOT,
    uiPort: UI_PORT,
    apiPort: PY_PORT,
    pyReady,
    pyPython,
    entry: PAGES[DEFAULT_PAGE].file,
    page: currentPage,
  }));

  ipcMain.handle('app:openPath', async (_e, p) => { shell.showItemInFolder(p); });

  ipcMain.on('probe:report', (_e, r) => {
    if (!r || typeof r !== 'object') { log('探针：回报格式异常'); return; }
    for (const k of Object.keys(r)) log(`[探针·${k}] ${r[k]}`);
    log('【六区探针结束】');
  });
}

// ---------------------------------------------------------------- 六区探针（诊断用）
/** WORKBENCH_PROBE=1 时，由 preload 在页面内依次点击六个导航按钮并回报各区渲染文本 */
function probeZones() {
  if (!mainWindow) return;
  log('探针：已下发（逐区点击探测）');
  setTimeout(() => mainWindow && mainWindow.webContents.send('probe:run'), 3000);
}

// ---------------------------------------------------------------- 启动封面
/** 后端拉起期间显示的过渡页：窗口秒开，数据就绪后再进入工作台 */
const BOOT_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>ReX</title><style>
html,body{height:100%;margin:0;background:#0f1219;color:#dbe4f3;
font:400 14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
display:flex;align-items:center;justify-content:center}
.box{text-align:center}
.logo{width:74px;height:74px;margin:0 auto 18px;border-radius:50%;
background:radial-gradient(circle at 34% 30%,#7dd3fc,#2563eb);box-shadow:0 0 48px rgba(56,189,248,.45)}
h1{font-size:19px;font-weight:600;margin:0 0 6px;letter-spacing:.5px}
p{color:#8ea2bd;font-size:13px;margin:0}
.bar{width:230px;height:3px;border-radius:2px;background:#1e2743;margin:22px auto 0;overflow:hidden}
.bar i{display:block;width:36%;height:100%;background:linear-gradient(90deg,#38bdf8,#5eead4);
animation:run 1.15s ease-in-out infinite}
@keyframes run{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
.hint{margin-top:16px;font-size:12px;color:#5f7391}
</style></head><body><div class="box"><div class="logo"></div>
<h1>ReX</h1><p>正在启动本地服务…</p>
<div class="bar"><i></i></div>
<div class="hint">首次启动会释放数据文件，请稍候</div></div></body></html>`;

// ---------------------------------------------------------------- 上传自测（诊断用）
/** WORKBENCH_UPLOAD_TEST=<pdf 绝对路径> 时，进入工作台后自动走一次原生上传链路 */
async function runUploadSelfTest() {
  const p = process.env.WORKBENCH_UPLOAD_TEST;
  if (!p || !fs.existsSync(p)) { log('上传自测：文件不存在 ' + p); return; }
  log('上传自测：开始 ' + p);
  const r = await uploadMany([p]);
  log('上传自测：结果 ' + JSON.stringify(r));
}

// ---------------------------------------------------------------- 窗口
let currentPage = DEFAULT_PAGE;

function pageUrl(key) { return `http://127.0.0.1:${UI_PORT}/${PAGES[key].file}`; }

function loadPage(key) {
  if (!PAGES[key]) return;
  currentPage = key;
  if (mainWindow) mainWindow.loadURL(pageUrl(key));
  buildMenu();
}

function createWindow(initialUrl) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    title: 'ReX',
    backgroundColor: '#f6f7fb',
    show: false,
    webPreferences: {
      preload: path.join(DESKTOP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 渲染层自检：确认 preload 桥与拖拽入库 UI 均已注入
  mainWindow.webContents.on('did-finish-load', async () => {
    const url = mainWindow ? mainWindow.webContents.getURL() : '';
    if (!/^http:\/\/127\.0\.0\.1:/.test(url)) return;   // 启动封面不参与自检
    try {
      const r = await mainWindow.webContents.executeJavaScript(
        '({bridge: !!window.workbenchDesktop, entry: location.pathname,'
        + ' dropOverlay: !!document.getElementById("wb-drop-overlay"),'
        + ' zones: document.querySelectorAll("[data-zone]").length,'
        + ' v6: (window.WB_V6 ? window.WB_V6.status() : null)})');
      log('渲染层自检：' + JSON.stringify(r));
    } catch (e) {
      log('渲染层自检失败：' + e.message);
    }
    if (process.env.WORKBENCH_PROBE === '1') probeZones();
    if (process.env.WORKBENCH_UPLOAD_TEST) runUploadSelfTest();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(initialUrl || pageUrl(DEFAULT_PAGE));
  currentPage = DEFAULT_PAGE;
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------- 菜单
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 ReX' },
        { type: 'separator' },
        { label: '打开工作目录', click: () => shell.openPath(WORK_ROOT) },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '全部显示' },
        { type: 'separator' }, { role: 'quit', label: '退出' },
      ],
    }] : []),
    {
      label: '视图',
      submenu: [
        {
          label: `切换到 ${PAGES.v6.label}`,
          accelerator: 'CmdOrCtrl+1',
          type: 'radio', checked: currentPage === 'v6',
          click: () => loadPage('v6'),
        },
        {
          label: `切换到 ${PAGES.workbench.label}`,
          accelerator: 'CmdOrCtrl+2',
          type: 'radio', checked: currentPage === 'workbench',
          click: () => loadPage('workbench'),
        },
        {
          label: `切换到 ${PAGES.prototype.label}`,
          accelerator: 'CmdOrCtrl+3',
          type: 'radio', checked: currentPage === 'prototype',
          click: () => loadPage('prototype'),
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '文件',
      submenu: [
        { label: '导入 PDF 文献…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow && mainWindow.webContents.send('menu:pick-pdf') },
        { type: 'separator' },
        ...(isMac ? [] : [{ role: 'quit', label: '退出' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '后端状态', click: showBackendStatus },
        { label: '打开数据目录', click: () => shell.openPath(WORK_ROOT) },
        { type: 'separator' },
        { label: '检查更新…', click: () => checkForUpdates(true) },
        { label: '授权信息…', click: showLicenseInfo },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showBackendStatus() {
  const info = {
    '运行模式': IS_PACKAGED ? '打包版' : '开发版',
    '工作目录': WORK_ROOT,
    'UI 端口': UI_PORT,
    'API 端口': PY_PORT,
    'Python 后端': pyReady ? `已就绪（${pyPython}）` : '未就绪',
    '本地模型': llmReady
      ? `已就绪（${LLM_MODEL_ID} · :${LLM_PORT}）`
      : (fs.existsSync(BUNDLED_LLAMA) ? '未就绪' : '未随包提供'),
    '当前页面': PAGES[currentPage].file,
    'Electron': process.versions.electron,
  };
  await dialog.showMessageBox(mainWindow, {
    type: pyReady ? 'info' : 'warning',
    title: '后端状态',
    message: pyReady ? '后端连接正常' : '后端未就绪（页面可浏览，写回/入库暂不可用）',
    detail: Object.entries(info).map(([k, v]) => `${k}：${v}`).join('\n'),
    buttons: ['好'],
  });
}

async function showLicenseInfo() {
  const r = verifyLicense();
  const detail = r.ok
    ? ['状态：已授权', '机器指纹：' + machineId(), '有效期至：' + (r.info.expires_at || '开发态'),
       '版本标识：' + (r.info.edition || '-'), '备注：' + (r.info.note || '-'),
       '授权文件：' + (licensePaths().find(x => fs.existsSync(x)) || '（开发态未使用）')].join('\n')
    : ['状态：未授权', '原因：' + r.reason, '机器指纹：' + machineId(), '',
       '把上面的机器指纹发给授权方换取 license.json，放到：',
       path.join(app.getPath('userData'), 'license.json')].join('\n');
  const res = await dialog.showMessageBox(mainWindow, {
    type: r.ok ? 'info' : 'warning',
    title: '授权信息', message: r.ok ? 'ReX 已激活' : 'ReX 未激活',
    detail, buttons: ['复制机器指纹', '好'], defaultId: 0, cancelId: 1,
  });
  if (res.response === 0) { try { require('electron').clipboard.writeText(machineId()); } catch (_) {} }
}

// ---------------------------------------------------------------- 授权（离线 license.json）
// 公钥内置；私钥在主控手里（<项目根>/.license_keys/private.pem，绝不进安装包）
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const PRODUCT_NAME = 'ReX';
const LICENSE_PUB_HEX = '2c3193891a20b6323bbe0a7453b844cdb5be28fdb0813e6ed32f65b04084b490';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawMachineId() {
  if (IS_WIN) {
    // 首选注册表 MachineGuid（与 tools/license_guard.py 的 Windows 分支一致）
    try {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,})/);
      if (m) return m[1].trim().toUpperCase();
    } catch (_) {}
    // 次选：主板 UUID
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_ComputerSystemProduct).UUID'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (out && out.trim()) return out.trim().toUpperCase();
    } catch (_) {}
    return `${os.hostname()}-${process.env.USERNAME || 'user'}`.toUpperCase();
  }
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (m) return m[1].trim().toUpperCase();
  } catch (_) {}
  return `${os.hostname()}-${process.env.USER || 'user'}`.toUpperCase();
}
function machineId() {
  return crypto.createHash('sha256').update(rawMachineId()).digest('hex');
}
function canonicalJson(o) {
  if (Array.isArray(o)) return '[' + o.map(canonicalJson).join(',') + ']';
  if (o && typeof o === 'object') {
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(o);
}
function licensePaths() {
  const ps = [];
  if (process.env.REX_LICENSE_PATH) ps.push(process.env.REX_LICENSE_PATH);
  ps.push(path.join(app.getPath('userData'), 'license.json'));
  // 兼容改名前的历史授权目录（Another）：老授权文件无需搬迁也能被读取
  for (const legacyDir of LEGACY_DATA_DIRS) {
    const legacyLicense = path.join(legacyDir, 'license.json');
    if (fs.existsSync(legacyLicense)) ps.push(legacyLicense);
  }
  if (IS_PACKAGED) ps.push(path.join(process.resourcesPath, 'license.json'));
  return ps;
}

/** 校验授权：签名 → 机器绑定 → 有效期。返回 { ok, reason, info } */
function verifyLicense() {
  if (!IS_PACKAGED || process.env.REX_SKIP_LICENSE === '1') return { ok: true, info: { mode: 'dev' } };
  const p = licensePaths().find(x => x && fs.existsSync(x));
  if (!p) return { ok: false, reason: '未找到授权文件 license.json' };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, reason: '授权文件无法解析：' + e.message };
  }
  const sig = data.sig;
  delete data.sig;
  if (!sig) return { ok: false, reason: '授权文件缺少签名' };
  // 兼容改名前的历史授权（product 字段为旧品牌名），其余校验项不变
  const LEGACY_PRODUCT_NAMES = ['Another'];
  if (data.product !== PRODUCT_NAME && !LEGACY_PRODUCT_NAMES.includes(data.product)) return { ok: false, reason: '授权文件产品名不匹配' };
  try {
    const pub = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(LICENSE_PUB_HEX, 'hex')]),
      format: 'der', type: 'spki',
    });
    const okSig = crypto.verify(null, Buffer.from(canonicalJson(data), 'utf8'), pub, Buffer.from(sig, 'base64'));
    if (!okSig) return { ok: false, reason: '签名校验失败（授权文件被篡改或非官方签发）' };
  } catch (e) {
    return { ok: false, reason: '签名校验异常：' + e.message };
  }
  const mid = machineId();
  if (data.machine_id && data.machine_id !== mid) {
    return { ok: false, reason: `授权与当前机器不匹配（本机指纹 ${mid.slice(0, 16)}…）`, info: { machine_id: mid } };
  }
  const exp = String(data.expires_at || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp) || new Date(exp + 'T23:59:59') < new Date()) {
    return { ok: false, reason: `授权已过期（${exp || '未填写'}）`, info: data };
  }
  return { ok: true, info: data };
}

async function requireLicenseOrQuit() {
  const r = verifyLicense();
  if (r.ok) return true;
  const mid = machineId();
  log('授权校验未通过：' + r.reason);
  // 自动化验收用：REX_LICENSE_TEST=1 时不弹窗，直接打印并退出（码 3）
  if (process.env.REX_LICENSE_TEST === '1') {
    console.log('[license] machine_id=' + mid);
    console.log('[license] license_paths=' + licensePaths().join(','));
    app.exit(3);
    return false;
  }
  await dialog.showMessageBox({
    type: 'error',
    title: 'ReX 未获授权',
    message: '本机尚未通过授权校验，程序无法启动。',
    detail: `原因：${r.reason}\n\n本机指纹（发给授权方换取 license.json）：\n${mid}\n\n授权文件放置位置：\n${path.join(app.getPath('userData'), 'license.json')}`,
    buttons: ['复制指纹并退出', '退出'],
    defaultId: 0, cancelId: 1,
  }).then(res => { if (res.response === 0) { try { require('electron').clipboard.writeText(mid); } catch (_) {} } });
  app.quit();
  return false;
}

// ---------------------------------------------------------------- 远程更新（静态清单 + 全量 pkg）
const DEFAULT_FEED = (() => {
  try { return (require('./package.json').rex || {}).updateFeed || ''; } catch (_) { return ''; }
})();
const UPDATE_FEED = process.env.REX_UPDATE_URL || DEFAULT_FEED;

function httpGetText(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : require('http');
    const req = mod.get(url, { timeout }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve(buf));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : require('http');
    const req = mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0, last = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', c => {
        got += c.length;
        const now = Date.now();
        if (onProgress && now - last > 800) { last = now; onProgress(got, total); }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function checkForUpdates(interactive = true) {
  if (!UPDATE_FEED) {
    if (interactive) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info', title: '检查更新', message: '尚未配置更新源',
        detail: '在 package.json 的 rex.updateFeed（或环境变量 REX_UPDATE_URL）里填入 update.json 的公网地址即可启用远程更新。',
        buttons: ['好'],
      });
    }
    return;
  }
  let info;
  try {
    info = JSON.parse(await httpGetText(UPDATE_FEED));
  } catch (e) {
    if (interactive) await dialog.showMessageBox(mainWindow, { type: 'warning', title: '检查更新', message: '无法获取更新信息', detail: e.message, buttons: ['好'] });
    return;
  }
  const cur = app.getVersion();
  if (cmpVersion(info.version, cur) <= 0) {
    if (interactive) await dialog.showMessageBox(mainWindow, { type: 'info', title: '检查更新', message: `已是最新版本 v${cur}`, buttons: ['好'] });
    return;
  }
  const notes = info.notes ? `\n\n更新说明：\n${info.notes}` : '';
  const ask = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: '发现新版本',
    message: `发现新版本 v${info.version}（当前 v${cur}）`,
    detail: `安装包约 ${info.size_mb ? info.size_mb + ' MB' : '未知大小'}，${IS_WIN ? '下载完成后关闭 ReX、解压该压缩包并运行其中的 install.bat 覆盖安装即可。' : '下载完成后需输入管理员密码安装。'}${notes}`,
    buttons: ['下载并安装', '稍后'], defaultId: 0, cancelId: 1,
  });
  if (ask.response !== 0) return;

  const ext = IS_WIN ? 'zip' : 'pkg';
  const dest = IS_WIN
    ? path.join(app.getPath('downloads'), `ReX-${info.version}-win-x64.${ext}`)
    : path.join(app.getPath('temp'), `ReX-${info.version}.${ext}`);
  let progWin = null;
  try {
    progWin = new BrowserWindow({
      width: 420, height: 130, resizable: false, minimizable: false, maximizable: false,
      title: '正在下载更新', alwaysOnTop: true, webPreferences: { nodeIntegration: false },
    });
    const render = (got, total) => {
      const pct = total ? Math.floor(got * 100 / total) : 0;
      const mb = (got / 1048576).toFixed(0), tb = total ? (total / 1048576).toFixed(0) : '?';
      const html = `<body style="font:13px -apple-system;padding:18px;margin:0">
        <div style="margin-bottom:10px">正在下载 ReX v${info.version} …</div>
        <div style="background:#eee;border-radius:6px;height:10px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:#3b82f6"></div></div>
        <div style="margin-top:8px;color:#666">${mb} / ${tb} MB（${pct}%）</div></body>`;
      progWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    };
    render(0, 0);
    await downloadFile(IS_WIN ? (info.win_url || info.pkg_url) : info.pkg_url, dest, render);
    const got = await sha256File(dest);
    if (info.sha256 && got.toLowerCase() !== String(info.sha256).toLowerCase()) {
      fs.unlinkSync(dest);
      throw new Error('安装包校验失败（sha256 不匹配），已删除下载文件');
    }
    try { progWin.destroy(); } catch (_) {}
    const go = await dialog.showMessageBox(mainWindow, {
      type: 'info', title: '下载完成',
      message: `ReX v${info.version} 已下载并通过校验`,
      detail: IS_WIN
        ? '更新包已保存到「下载」文件夹。请先退出 ReX，解压该压缩包，运行其中的 install.bat 覆盖安装（文献库与授权文件会保留）。'
        : '点击「立即安装」将打开系统安装器，安装过程需要输入管理员密码，安装完成后请手动重新打开 ReX。',
      buttons: IS_WIN ? ['打开所在文件夹', '稍后'] : ['立即安装', '稍后'], defaultId: 0, cancelId: 1,
    });
    if (go.response === 0) {
      if (IS_WIN) {
        shell.showItemInFolder(dest);
      } else {
        await shell.openPath(dest);
        setTimeout(() => app.quit(), 1500);
      }
    }
  } catch (e) {
    try { progWin && progWin.destroy(); } catch (_) {}
    await dialog.showMessageBox(mainWindow, { type: 'error', title: '更新失败', message: '下载或校验更新包失败', detail: e.message, buttons: ['好'] });
  }
}

// ---------------------------------------------------------------- 生命周期
app.whenReady().then(async () => {
  if (!(await requireLicenseOrQuit())) return;
  process.env.REX_LICENSE_OK = '1';
  // Dock 图标统一为科技熊（打包态由 icon.icns 提供，开发态兜底设置，确保任何运行方式外观一致）
  try {
    if (process.platform === 'darwin' && app.dock) {
      const candidates = [
        path.join(process.resourcesPath || '', 'icon.icns'),
        path.join(DESKTOP_DIR, 'build', 'icon.icns')
      ];
      const bear = candidates.find(fs.existsSync);
      if (bear) app.dock.setIcon(nativeImage.createFromPath(bear));
    }
  } catch (_) { /* 图标设置失败不影响启动 */ }
  bootstrapWorkspace();
  registerIpc();
  const ok = await startUiServer();
  if (!ok) log(`UI 端口 ${UI_PORT} 不可用，请检查是否被占用`);

  // 先亮窗口（启动封面），避免首屏在 Python 就绪前发出 /api 请求而拿到 502 占位数据
  createWindow('data:text/html;charset=utf-8,' + encodeURIComponent(BOOT_HTML));

  const [ready] = await Promise.all([startPythonBackend(), startLocalModel()]);
  log(ready ? '后端就绪 → 进入工作台' : '后端未就绪 → 仍进入工作台（仅浏览）');
  loadPage(DEFAULT_PAGE);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopPythonBackend();
  stopLocalModel();
  if (staticServer) { try { staticServer.close(); } catch (_) {} }
});
