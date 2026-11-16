---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 0416bf3adc9ae6268d5ccecae9b2b626_061564d4b18e11f18304525400aeaaa3
    ReservedCode1: 7rzd5A8ZaoPNrVVEkl+7tl3Nm+n78Wv7YdLP/GfZzNY53KCq/M7TtQ0clIl6eSoR2g3RF7WHR/28zueXqJXKiyqCOkF3Vql3EPc/oirD/YallcRI3Z3EKIXd3SrhGAs0yXmCItxZYOlUCkUbbHf9GB+7OS0JE9YEtCRZvN1iKbOlK0gBrB8zIMRF3U8=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 0416bf3adc9ae6268d5ccecae9b2b626_061564d4b18e11f18304525400aeaaa3
    ReservedCode2: 7rzd5A8ZaoPNrVVEkl+7tl3Nm+n78Wv7YdLP/GfZzNY53KCq/M7TtQ0clIl6eSoR2g3RF7WHR/28zueXqJXKiyqCOkF3Vql3EPc/oirD/YallcRI3Z3EKIXd3SrhGAs0yXmCItxZYOlUCkUbbHf9GB+7OS0JE9YEtCRZvN1iKbOlK0gBrB8zIMRF3U8=
---



# 科研学术本体工作台 · 桌面端（Electron）

v0.2.0：在 v0.1 外壳基础上补齐三件事——**可打包分发（.dmg）**、**原生 PDF 拖拽入库**、**前端入口切到六大区并接真实 API**。
原有 `web/` 与 `tools/serve_workbench.py` 源码未改动，桌面层只做编排。

## 架构

```
Electron 主进程 (main.js)
  ├─ Node 内嵌静态服务  http://127.0.0.1:5199/      → 托管 web/ 六大区前端（index.html）
  ├─ 反向代理           http://127.0.0.1:5199/api/*  → 转发 Python 后端
  └─ 子进程             python3.11 tools/serve_workbench.py 9173
                                                    （图谱 / 本体 / 洞察 / 增强 / 治理 API）
```

启动顺序：**先亮窗口（启动封面）→ 等 Python 就绪 → 再进工作台**，避免首屏在
后端未就绪时发出 `/api` 请求拿到 502 占位数据（v0.2.0 修复）。

打包版首次运行会把 `Resources/seed/` 复制到
`~/Library/Application Support/科研学术本体工作台/workspace/`，
此后所有读写都发生在该目录，应用包本身只读。

## 使用

```bash
# 开发态
cd desktop
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm start
```

打包版：安装 `dist/科研学术本体工作台-0.2.0-arm64.dmg`，或先解压 `dist/mac-arm64/` 里的 `.app` 试用。

### 原生 PDF 入库

两种入口，均走「复制到 `.ingest_inbox` → 后端解析 → 去重比对 → 写入图谱」链路：

- **拖拽**：把 PDF 拖到窗口任意位置，出现蓝色投放区后松手，支持多选批量；
- **菜单 / 快捷键**：`文件 → 导入 PDF 文献…`（⌘O）走原生文件选择器。

结果以浮层提示（已入库 / 去重命中 / 失败），失败原因同时写入「治理审计」区日志。

## 打包

```bash
npm run pack   # 只出未压缩的 .app（dist/mac-arm64/）
npm run dist   # 出 .dmg（Apple Silicon）
```

`build.extraResources` 会把 `web/ tools/ 图谱与本体 ttl/ versions/` 打进 `Resources/seed/`；
`build/icon.icns` 由 `build/icon.html` 经 Chrome 渲染生成。

## 环境依赖（Python 侧）

后端由 `python3.11` 运行，以下包为**用户级安装**（`~/Library/Python/3.11`），需存在于本机：

| 包 | 用途 | 缺失后果 |
|---|---|---|
| `rdflib` | 图谱 RDF/TTL 读写、SPARQL（洞察区） | SPARQL 面板不可用 |
| `pypdf` / `pdfplumber` | 上传 PDF 文本解析 | 入库必然失败（元数据解析异常） |
| `pyshacl` | 提交前 SHACL 校验 | 校验降级为豁免处理 |
| `fontTools` | CFF/Type1 字体编码解析 | 解析变慢并刷大量警告 |

安装：`/opt/homebrew/bin/python3.11 -m pip install --user rdflib pypdf pdfplumber pyshacl fonttools`

## 目录

```
desktop/
├─ main.js            主进程：静态服务 + 反代 + Python 子进程 + 原生菜单/拖拽
├─ preload.js         受控桥（拖拽投放区、上传进度浮层、只读环境信息）
├─ build/icon.html    图标源（Chrome 渲染 → icon.icns）
├─ start.command      一键启动脚本
├─ package.json       打包配置（0.2.0）
└─ dist/              打包产物
```

## 已完成 / 待接

- [x] 打包分发：electron-builder → .dmg（arm64）
- [x] 原生 PDF 拖拽入库 + 文件选择器（⌘O）
- [x] 前端入口切到 `web/index.html`，六大区全部接真实 API
- [x] 启动封面 + 后端就绪再进主界面（消除首屏 502）
- [ ] 自动更新（electron-updater）
- [ ] 提交前 SHACL 校验的界面化展示（当前仅在日志中提示）

*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
