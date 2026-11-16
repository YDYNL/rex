# 本体可视化编辑与治理工作台 —— 优化方案（v1，待确认）

> 目标：把当前「只读知识图谱可视化页」升级为「本体驱动的可治理数据工作台」——
> 用户可在页面上查看整体 Ontology（对象/属性/关系/逻辑/整个图谱），并按需求编辑纠正；
> 编辑结果落盘生效、反哺文献管理。

---

## 一、需求理解

用户的核心诉求分为三层，由浅入深：

| 诉求 | 含义 | 现状 |
|---|---|---|
| ① 查看整体 Ontology | 不仅看图谱节点，还要看本体定义：对象（7 类）、属性（数据/对象属性）、关系（对象属性）、逻辑（SHACL 约束）、以及全图谱 | 页面仅展示数据实例，本体定义与约束不展示、不可查 |
| ② 编辑纠正 Ontology | 针对业务需求修正：改节点属性、增删对象、改关系边、补逻辑约束、修本体定义 | 页面纯只读，任何修正都需改 JSON 后手跑脚本重建 |
| ③ 更新后生效 | 编辑结果持久化（写回图谱 JSON + TTL），并重建页面/生效到文献管理 | 目前是"离线重建"式，无"编辑-保存-生效"闭环 |

本质：从 `read-only 图谱看板` 升级为 `palantir 式 Ontology Workbench`（对象/属性/关系/逻辑/执行五要素闭环）。

---

## 二、现状盘点（基于实际文件核对）

### 2.1 文件与管线

- **数据源（唯一事实源）**：`scholar_literature_graph_v2_4.json`
  - `nodes` 187 个（含 19 Paper / 54 Author / 8 Venue / 77 Keyword / 9 Organization 等）
  - `edges` 493 条、`links` 449 条（含血缘 familyId / weight / properties）
  - `meta` 版本 2.4、governance_log 留痕
- **本体定义**：`edu_scholar_ontology.ttl`
  - 7 个类：Paper / Author / Organization / Venue / Keyword / LocalFile / DomainCategory（两两 disjoint）
  - 10 个对象属性：hasAuthor / cites / publishedIn / hasKeyword / belongsTo / hasAffiliation / hasResearchTopic / hasPart / related_to / sourcedFrom
  - 13 个数据属性：researchArea / aiSummary / autoKeywords / confidence / title / year / doi / filePath / name / paperType / keywordName / organizationName / venueName
- **逻辑约束**：`edu_scholar_shapes.ttl` —— PaperShape 等 SHACL 形状（title 必填单值、year 必填 gYear、hasAuthor minCount 1、cites/publishedIn/hasKeyword/belongsTo 的类型约束、confidence maxCount 1 等）
- **可视化页**：`scholar_literature_manager.html`（221KB，单文件自包含、数据内嵌 `const DATA`，8 个 Tab：总览/文献/作者/期刊/关键词/机构/关联图谱/上传入库）
- **服务**：`tools/serve.py`（localhost 上 GET / 出页面、POST /upload 上传 PDF 触发 ingest_pdf.py）
- **重建管线**：`tools/rebuild_page.py` —— 从图谱 JSON 全量聚合 → 重写页面 DATA → 重建 HTML

### 2.2 关键架构约束（重要）

1. **file:// 下无法 fetch 本地 JSON**（CORS 拦截）——因此"编辑后写回 + 生效"**必须走后端 HTTP 服务**（serve.py），不能只靠单文件 HTML。
2. 页面数据全部内嵌在 `const DATA` 中，二进制大、重建慢；编辑若只改页面不写回图谱 JSON，会被下一次 rebuild 冲掉。
3. 图谱 JSON 是唯一事实源，TTL（scholar_data_vX.ttl）由 JSON 推导导出，编辑生效的落盘主目标是 **图谱 JSON + 本体/约束 TTL**。

---

## 三、目标架构（对齐 Palantir Ontology 五要素）

```
┌─────────────────────────  浏览器  ─────────────────────────┐
│  查看层：对象清单 / 属性面板 / 关系图谱 / 逻辑(约束)面板      │
│  编辑层：就地编辑 · 侧栏表单 · 拖拽连线 · 约束校验提示        │
└────────────────────────────┬───────────────────────────────┘
                             │  fetch / PUT / POST / DELETE
┌────────────────────────────▼───────────────────────────────┐
│  服务层 tools/serve.py（扩展 REST API）                      │
│  GET  /api/ontology  本体定义(类/属性/约束)                  │
│  GET  /api/graph     图谱数据                                │
│  PUT/POST/DELETE /api/node /api/edge /api/property /api/constraint │
│  POST /api/commit   提交一批编辑 → 校验 → 备份 → 写回 → 重建  │
└────────────────────────────┬───────────────────────────────┘
                             │
┌────────────────────────────▼───────────────────────────────┐
│  数据层                                                      │
│  事实源：scholar_literature_graph_v*.json                    │
│  本体：edu_scholar_ontology.ttl + edu_scholar_shapes.ttl    │
│  落盘：提交时自动 备份(.bak) → 增量写回 JSON → 重建页面       │
└─────────────────────────────────────────────────────────────┘
```

**五要素在本次落地中的映射：**

| Palantir 要素 | 本系统实体 | 当前能力 | 本方案新增 |
|---|---|---|---|
| Objects 对象 | nodes（Paper/Author/Venue/Keyword/Org…） | 只读展示 | 增/删/改名、类型调整 |
| Properties 属性 | 数据属性（title/year/doi/aiSummary…） | 只读 | 编辑属性值、新增/删除属性 |
| Links 关系 | objects 属性边（cites/hasAuthor/publishedIn…） | 只读图谱 | 增/删/改关系、连线编辑 |
| Logic 逻辑 | SHACL 约束 / 必填·类型·基数 | 不展示 | 查看约束并可视化校验反馈 |
| Actions 执行 | upload 自动入库 | 已有 | 新增"提交编辑"回合：校验→备份→写回→重建 |

---

## 四、实施路线（分阶段，每阶段可独立交付验证）

### 阶段 A：服务层扩展 + 数据读接口（地基）
- serve.py 增加 REST：
  - `GET /api/ontology`：解析 TTL 返回 类/属性(数据|对象)/SHACL 约束 结构化 JSON
  - `GET /api/graph`：返回图谱 JSON 全量
  - `GET /api/history`：编辑/治理留痕
- 新增 `tools/ontology_editor.py`：统一封装「读 OWL/SHACL → 结构化」「校验编辑」「备份」「写回 JSON」「diff→导出 TTL」「触发 rebuild_page」。
- 保留现有 GET / 与 POST /upload 不动，向后兼容。

### 阶段 B：页面新增「本体视图」Tab（查看层闭环）
- 新增 Tab「本体」，含四个面板：
  1. **类/对象树**：7 个类及其实例数、类间继承/disjoint 关系
  2. **属性面板**：数据属性 + 对象属性列表（domain/range/基数/必填）
  3. **约束面板**：SHACL 规则可读化渲染（哪类必填 title、hasAuthor 至少 1 等）
  4. **图谱画布**：复用现有 graph view，支持按类型/属性筛选
- 进入该 Tab 时通过 `GET /api/ontology` 拉取，不再依赖页面内嵌 DATA（第一次解决"本体定义在页面不可见"问题）。

### 阶段 C：编辑能力（编辑层闭环，最核心）
- 编辑入口：详细信息卡片上加「编辑」按钮 → 侧栏表单，支持：
  - 节点：改属性值、改名、改类型、删除
  - 关系：新增（选类型+两端）、删除、改 weight/properties
  - 本体：新增/修改 SHACL 约束（如"Author 也必填 researchArea"）、新增数据属性
- 提交前**前端即时校验**：类型不匹配、必填缺失、引用悬空（target 不存在）、重复节点等给出红黄提示。
- 每次提交 = 一组 patch，可**批量提交**，提交前展示 diff 预览。

### 阶段 D：提交生效（执行层闭环）
- `POST /api/commit` 服务端处理：
  1. 校验（复用 SHACL 语义，失败则返回明细不改动）
  2. 备份当前 JSON/TTL → `*.bak.<ts>`
  3. 增量写回 `scholar_literature_graph_vX.json`
  4. 由 JSON 差分导出最新 `scholar_data_vX.ttl`
  5. 调用 rebuild_page.py 重建页面（下一次打开即新数据）
- 记录 governance_log：`{time, actor, op, before, after, summary}`，页面可查看编辑历史。

### 阶段 E（可选增强，按需）
- 编辑历史/回滚入口
- 本地 Ollama 辅助：批量修正（如识别错别作者名、补 researchArea）给出建议 diff

> 风险控制：所有写操作走「备份 → 校验 → 提交」三步，破坏性操作（删除节点/关系）需勾选确认；批量操作遵循"少量试点 → 确认 → 全量"。

---

## 五、待确认的决策点

1. **实施范围**：先做哪一档？
   - A. 最小闭环：只做"实例编辑"（改对象属性、增删关系），本体/SHACL 只读展示 —— 最快落地
   - B. 完整闭环：实例编辑 + 本体定义编辑（类/属性/约束增改） —— 工作量更大
   - 推荐 **A 起步、B 作为增强**，保证先打通"编辑-保存-生效"链路。
2. **Schema/约束编辑的重度**：是否需要支持新增数据属性、修改 SHACL 规则并重建语义（涉及 TTL 深改写，建议分步试点）？还是本期仅实例编辑 + 约束可视化提示？
3. **回滚机制**：是否需要"单步撤销/历史快照回滚"？还是"提交前备份 + 保留 .bak"即可够用（低成本）？
4. **是否需要 Ollama 辅助建议**（编辑时给出自动修正提议），还是纯手动编辑？

确认以上决策后，我再进入实施（阶段 A/B 优先，然后 C/D）。
