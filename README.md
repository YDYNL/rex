# ReX · 科研学术本体工作台

ReX 是一个面向科研学术场景的本地知识工作台：把论文、笔记、项目材料整理成可查询、可推理的本体图谱，并在本地模型上完成文献理解、关系抽取与洞察生成。全部推理与数据都在本机运行，离线可用。

> 历史名称：本项目曾用名 **Another**、"科研学术本体工作台"。改名后旧版本的用户数据目录（`Another`、`科研学术本体工作台`）会在首次启动时自动迁移工作区与配置，旧授权文件同样可继续读取。

## 架构

```
desktop/   Electron 主进程（窗口、菜单、本地后端与 llama.cpp 的拉起、授权校验、检查更新）
web/       前端（单页工作台 + 六区视图：总览 / 图谱 / 本体 / 洞察 / 增强 / 治理）
tools/     Python 后端与离线工具（服务工作进程、PDF 入库、本体抽取、授权签发/校验）
data_test/ 示例数据（本地测试用，不入库）
```

- 界面：`web/index.html` 与 `web/prototype_ai_workbench_v6.html`
- 本地推理：内置 Qwen3-4B（GGUF）通过 `llama-server` 提供 OpenAI 兼容 `/v1` 接口
- 默认端口：UI `5199`、Python 后端 `9173`、llama `8199`（均可用环境变量覆盖）

## 运行

```bash
cd desktop
npm install
npm start          # 开发态：拉起 Python 后端 + 本地模型，再打开工作台
```

常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `WORKBENCH_UI_PORT` / `WORKBENCH_PY_PORT` / `WORKBENCH_LLM_PORT` | 覆盖默认端口 |
| `WORKBENCH_WORK_ROOT` | 指定工作根目录（干净机器验收 / 多实例隔离） |
| `ES_LLM_BASE` / `ES_LLM_MODEL` / `ES_LLM_FORCE_V1` | 指定后端使用的模型地址与模型名 |
| `REX_LICENSE_PATH` | 指定授权文件路径 |
| `REX_SKIP_LICENSE=1` | 开发态跳过授权校验 |
| `REX_UPDATE_URL` | 覆盖「检查更新」使用的清单地址 |

## 离线授权

- Ed25519 授权文件 `license.json`，绑定本机指纹（macOS `IOPlatformUUID` / Windows `MachineGuid` 的 sha256）与有效期
- 校验双层：Electron 主进程启动时验签 → 比对指纹 → 查有效期；Python 后端启动时再验一次
- 签发工具在 `tools/rex_license.py`，私钥 `tools/.license_keys/private.pem` **只在主控机保存，不入库、不进安装包**
- 公钥硬编码在主进程（`desktop/main.js`）与后端（`tools/license_guard.py`）

```bash
# 查看本机指纹
python3 tools/rex_license.py machine-id
# 为某台机器签发 365 天授权
python3 tools/rex_license.py issue --machine <指纹> --days 365 --edition standard
```

## 打包

```bash
cd desktop
npm run dist        # → dist/ReX-<version>-arm64.pkg
npm run dist:win    # → dist/ReX-<version>-win-x64.zip（含运行时与本地模型）
```

Windows 采用 ZIP + 脚本（`install.bat` / `run-portable.bat` / `uninstall.bat`）分发，避免 NSIS 的 2GB 单文件上限。

## 检查更新

主进程读取 `package.json` 的 `rex.updateFeed`（或 `REX_UPDATE_URL`）指向的静态 `update.json`，比较版本号后下载全量包、做 SHA256 校验，再交给系统安装器（macOS pkg）/ 引导解压覆盖（Windows zip）。

## 版本

当前版本 `0.2.0`。
