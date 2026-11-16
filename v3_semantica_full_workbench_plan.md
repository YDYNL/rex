---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 0416bf3adc9ae6268d5ccecae9b2b626_cecf5008ad0b11f18039525400461939
    ReservedCode1: sB9iJGyHjx/qictWensaa9+g4PQSI/cEq9VdPNudKwS17KGiDZhmk18IB8oY/NRA8hLb+daE4v6wwj3fWcMX+NCLluaoyH0sAGOuuBqncmssC+ONRDfIqXcCRmoi8sA/jylvAc8iE7kApzV5bnUZpSa6OsmWAryT7HJzDuwO6YDTrkLLAnGjmEUo1KU=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 0416bf3adc9ae6268d5ccecae9b2b626_cecf5008ad0b11f18039525400461939
    ReservedCode2: sB9iJGyHjx/qictWensaa9+g4PQSI/cEq9VdPNudKwS17KGiDZhmk18IB8oY/NRA8hLb+daE4v6wwj3fWcMX+NCLluaoyH0sAGOuuBqncmssC+ONRDfIqXcCRmoi8sA/jylvAc8iE7kApzV5bnUZpSa6OsmWAryT7HJzDuwO6YDTrkLLAnGjmEUo1KU=
---

# v3 规划：semantica 六大工作区全量移植设计

> 目标：把 semantica 可视化工作台的**六大工作区能力**整体复制到现有科研文献本体平台，
> 保持"图谱 JSON 单一事实源 + serve.py 零依赖后端 + 浏览器工作区"的轻量架构。
> 本设计核心：**搬架构范式，不搬 React 源码**。
> 状态：方案已确认（2026-09-10），进入实施。
> 落地进度：
> - ✅ **M1 服务层地基（2026-09-10 完成）**：新建 `tools/serve_workbench.py`（v2.0），
>   实现路由分发 + graph/ontology/commit/manage/decisions/enrich 六区 API 骨架 +
>   `/api/commit` 统一提交闸门（校验→快照→写回JSON→派生TTL→变更日志）+
>   `/api/commit/versions|rollback|log` 版本管理 + `/assets/*` 静态托管 + 保留 `/upload`。
>   经隔离副本冒烟：非法提交 422 拦截、引用不存在节点拒绝、TTL 派生 1045 triples、
>   HTTP 各 API 全部 200、回滚快照可用。原 serve.py 保留未动，可随时切换回退。
> - ✅ **M2 前端框架（2026-09-10 完成）**：新建 `web/index.html` 骨架 + `web/assets/`
>   全局样式与引导脚本 + 六区独立 JS 模块（总览/图谱/本体/洞察/增强/治理），serve 静态托管、
>   模块懒加载；修复 serve_workbench 静态路径 bug（/assets 前缀）。修复后经浏览器子 Agent
>   真机验收：五区均渲染正常无白屏，截图存档 output/m2_*.png。原单文件页面仍可回退。
> - ✅ **M3 本体工作台实例编辑（2026-09-14 完成）**：重写 `web/assets/js/zones/ontology.js`
>   为完整实例编辑器（类筛选→实例搜索→数据属性表单→对象关系增删→diff 预览→提交），
>   修复 `serve_workbench.py` 快照文件名消毒 + 前端 .catch 兜底 + diff 只读字段误报 3 个 Bug，
>   经浏览器二次复验通过（v2.23/v2.24 提交回滚正常）。Schema 拖拽编辑（M3b）待后续。
> - ✅ **M4 Analyze（2026-09-15 完成）**：`serve_workbench.py` 实现 `/api/analyze/templates`
>   （10 个预置模板）+ `/api/analyze/stats`（rdflib TTL 统计）+ POST `/api/analyze`
>   （sub=sparql 执行查询 / sub=reason 轻量推理：缺作者、引用不对称、低置信度、孤立关键词）；
>   前端 `analyze.js` 重写为查询面板（模板下拉+textarea+结果表格）+ 推理质检卡片。
>   修复：POST body bytes 解析、rdflib 7.6 无 timeout 参数、Decimal 序列化、g.value 三参 Bug。
> - ⏳ M5 Enrich + Explorer / M6 Manage + Decisions / M3b Schema 拖拽待实施。
> 决策记录（用户逐项拍板）：
> 1. 前端形态 → 确认 serve 托管 + 模块拆分（不再单文件）
> 2. Analyze 区 → 接受唯一第三方依赖 rdflib
> 3. Decisions 区 → 映射为"数据治理审计流"
> 4. Schema 级拖拽编辑 → **一起实现**（纳入本期，不放远期）
> 前置基础仍有效：小闭环步进 / 实例编辑优先 / 支持回滚 / 先手动后 Ollama。

---

## 0. 一句话架构

```
事实源(图谱JSON + 本体/约束TTL)
   │
   ▼
服务面 serve.py 按 semantica 六区划分 API（+统一提交闸门 /api/commit）
   │
   ▼
前端工作区式界面（左侧竖排图标导航，六大区 Tab，数据全走 http API）
```

semantica 本身的架构就是"单一事实源 ContextGraph + 分类 REST API + 多工作区 React 前端"。
我们要做的是把它的**第一层换成本地 JSON+TTL、第二层用标准库重建、第三层用无依赖页面重建**。

---

## 1. 数据层（复用 + 极小扩展）

| 事实 | 文件 | 用途 |
|---|---|---|
| 图谱实例 | `scholar_literature_graph_v2_x.json` | knowledge explorer / 编辑 / 可视化 的唯一事实源 |
| 本体 Schema | `edu_scholar_ontology.ttl` | Ontology Hub 的类/属性层级展示 |
| 约束 | `edu_scholar_shapes.ttl` | 提交时的 SHACL 校验 |
| 实例化本体 | `scholar_data_v2_x.ttl` | Analyze 区 SPARQL 的 rdflib 内存数据源（可选依赖） |
| 版本快照 | 新增 `versions/` 目录（.bak + checksum + 变更日志） | 提交留痕与回滚（对标 semantica `version_storage.py` + `change_log.py`） |
| 治理痕迹 | `governance_log`（已内嵌 JSON meta） | Manage 血缘 + Decisions 决策记录 |

唯一新增物：`versions/` 快照目录。其余全部复用现有文件。

---

## 2. 服务层：serve.py 按六区扩展 API（标准库，零依赖为主）

### 2.1 统一提交闸门 `/api/commit`（全站写的唯一入口）

所有编辑最终都走这一个闸门，流程对齐 semantica commit + 版本存储：

```
请求变更 → ① 快照备份(versions/xx-{ts}.bak.json + checksum)
        → ② SHACL 校验(读 shapes.ttl)
        → ③ 写回 图谱JSON
        → ④ 派生：重建 TTL + 重建页面
        → ⑤ 写变更日志(change_log: 谁/何时/改了什么/校验结果/快照id)
        → 返回 commit_id
```

回滚：`/api/commit/rollback/{version}` → 校验目标快照 checksum → 恢复 JSON → 重新派生 → 记录回滚日志。

### 2.2 六区 API 设计（对标 semantica routes/）

| 区 | 端点 | 能力 | 对标 semantica |
|---|---|---|---|
| 🗺️ Knowledge Explorer | `/api/graph/nodes` `/edges` `/search` `/stats` `/node/{id}` `/path` | 图谱读取、检索、最短路径（只读为主） | `explorer/routes/graph.py` |
| 🧬 Ontology Hub | `/api/ontology/classes` `/properties` `/instances` + `/instances`(POST/PATCH/DELETE) + `/shacl/validate` + `/versions` `/rollback` | 本体浏览 + **实例表单编辑** + SHACL 报告 + 版本回滚 | `routes/ontology.py` + `change_management/` |
| 🔍 Analyze | `/api/analyze/sparql` `/reason` `/stats` | SPARQL 查询（rdflib on TTL）+ 轻量推理 | `routes/sparql.py` + `reasoning/` |
| 🧾 Enrich | `/api/enrich/ingest/pdf`(已有) `/ingest/url` `/export?fmt=` `/diff` `/resolve` | 导入(联网可选)、导出、diff、实体消歧 | `routes/enrich.py` `export_import.py` |
| 🗄️ Manage | `/api/manage/stats` `/lineage/{id}` `/ontology-summary` | KG 概览仪表盘 + PROV-O 血缘 + 本体摘要 | `routes/provenance.py` `analytics.py` |
| 🧠 Decisions | `/api/decisions` `/record` | 治理操作记录 + 因果链视图 | `routes/decisions.py` |

> Analyze 区是**唯一会引入第三方依赖**（rdflib）的区，其余全部标准库即可实现。

---

## 3. 前端层：工作区式界面（关键架构决策）

### 3.1 形态选择

| 方案 | 说明 | 判定 |
|---|---|---|
| A 继续单文件膨胀 | 六大区全塞进一个 HTML | ❌ 会涨到数百 KB，维护爆炸 |
| B 拆分模块，serve 托管 | 骨架 HTML + 每区一个 JS 模块，Tab 惰性加载 | ✅ 推荐 |
| C 引前端框架 | Vue/React CDN | ❌ 违背"零外部依赖"既定约束 |

**推荐 B**：`serve.py` 既当 API 又当静态托管；左侧竖排图标导航对齐 semantica 六图标；每区点击才加载。数据天然走 http（编辑也必须 http，正好同构）。

### 3.2 六区前端视图

1. **Knowledge Explorer**：收编现有 8 Tab（总览/文献/作者/期刊/关键词/机构/图谱/上传）+ 词汇层级树 + 全图画布
2. **Analyze**：SPARQL 输入面板 + 结果表格/图渲染 + 预置查询模板（如"某作者的论文"）+ 推理结果
3. **Decisions**：操作日志流 + 单实体因果链（"这篇文献：解析→增强→中文作者修正→编辑…"）
4. **Enrich**：PDF 拖拽导入 / URL 导入 / 导出(JSON/TTL/CSV) / 两版本 diff / 疑似重名作者待合并列表
5. **Manage**：KG 统计仪表盘（节点/边/类分布/来源占比）+ 实体血缘全链路 + 本体摘要卡
6. **Ontology Hub**（本期核心）：本体层级查看 + 实例表单编辑 + SHACL 校验报告 + 版本历史回滚

---

## 4. 落地分期（贴合小步快跑，每期可验收）

> 分期更新（决策4确认后）：Schema 级拖拽编辑纳入本期一并实现。
> 全量实施照以下里程碑推动，每期交付可看效果，不做不可验收的"大爆炸"。

| 期 | 内容 | 涉及依赖 | 对齐现状 |
|---|---|---|---|
| **M1 服务层地基** | serve.py 重构：路由分发 + 六区 API 骨架 + `/api/commit` 统一提交闸门 + versions/ 版本快照与回滚 | 无（标准库） | 9000 端口升级 |
| **M2 前端框架** | 页面拆分：骨架 HTML + 左侧六大区导航 + 每区 JS 模块 lazy 加载（serve 静态托管） | 无 | 替代单文件 |
| **M3 Ontology Hub** | 本体层级查看 + **实例表单编辑** + **Schema 拖拽编辑(类/属性/关系)** + SHACL 校验报告 + diff 预览 | 无 | 本期核心交付 |
| **M4 Analyze** | SPARQL 面板（rdflib on TTL）+ 预置模板 + 轻量推理 | **rdflib（唯一外部依赖）** | 引入查询能力 |
| **M5 Enrich + Explorer** | 导出(JSON/TTL/CSV) / 两版本 diff / 实体消歧列表 / 全图画布与词汇树 | 无 | 治理与导入导出 |
| **M6 Manage + Decisions** | KG 概览仪表盘 + PROV-O 血缘 + 治理审计流（把 ingest/enhance/repair 的 trace 落库） | 标准库 | 全量闭环 |

> 约束：M3 是用户最关心的交付（本体可视化工作台），一旦 M1/M2 立起来即在 M3 上聚焦打磨；
> 每期结束跑 smoke 冒烟 + 截图验收。

---

## 5. 关于"编辑维护能力"的边界澄清

- **实例编辑（本期）**：改属性值 / 改名 / 增删关系 / 新增删除实例 —— 表单式编辑。
- **Schema 级深编辑（本期，已确认一起实现）**：对应 semantica OntologyEditor 的 @xyflow/react 拖拽画布，
  支持类/对象属性/数据属性/restriction/axiom 的添加、删除、修改 + SHACL Studio + SKOS 词汇管理。
  前端用 SVG/canvas 自绘实现轻量拖拽画布（不引 xyflow），提交仍走 `/api/commit` 闸门（备份→校验→写回→派生）。
- **决策区定位**：落地为**数据治理决策记录**（谁在何时为何做了哪个编辑/入库/回滚），不照搬 Palantir 商业决策链。

---

## 6. 待拍板决策点（2026-09-10 已全部确认）

| # | 决策点 | 决定 |
|---|---|---|
| 1 | 前端形态 | ✅ serve 托管 + 模块拆分（弃单文件） |
| 2 | Analyze 依赖 | ✅ 接受 rdflib |
| 3 | Decisions 定位 | ✅ 数据治理审计流 |
| 4 | Schema 拖拽 | ✅ 一起实现（本期） |

---

## 7. 产出物与验收标准（全量完成态）

- 浏览器一个入口（serve.py:9000）承载六大工作区；
- 任意实例可选中 → 编辑 → diff 预览 → 提交 → 自动备份可回滚；
- SPARQL/推理/导出/消歧/血缘/治理记录六类能力在对应区可用；
- 图谱 JSON 始终是唯一事实源，TTL/页面全由它派生；
- versions/ 保留完整历史，随时一键回滚。
*（内容由AI生成，仅供参考）*
