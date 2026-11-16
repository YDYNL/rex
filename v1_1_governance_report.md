---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 0416bf3adc9ae6268d5ccecae9b2b626_4923ac5ea8dd11f190de525400461939
    ReservedCode1: e6nZIkbMgpi9PNzLgxBidIZw14Vuq9Q5Cp/4qk0Foiwhl1gl3xmJbumN/omyHAs8tYPB5sBS3r4Dt14Kmw4GeRzwRu5qLDIcGUXiq0v1AlAet5G5uo9fLFpDOc/ZuQerquQIrDWnfF0H3UqQRCMFuU3UJ4mWdcUs2movO/UCHWFiy1x5zNe8AQltRhI=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 0416bf3adc9ae6268d5ccecae9b2b626_4923ac5ea8dd11f190de525400461939
    ReservedCode2: e6nZIkbMgpi9PNzLgxBidIZw14Vuq9Q5Cp/4qk0Foiwhl1gl3xmJbumN/omyHAs8tYPB5sBS3r4Dt14Kmw4GeRzwRu5qLDIcGUXiq0v1AlAet5G5uo9fLFpDOc/ZuQerquQIrDWnfF0H3UqQRCMFuU3UJ4mWdcUs2movO/UCHWFiy1x5zNe8AQltRhI=
---

# 科研学术本体 v1.1 数据治理与研究通道扩展报告

- 项目：科研学术本地文献管理系统
- 版本：v1.0 → v1.1（数据治理 + 作者研究方向通道扩展）
- 日期：2026-09-05
- 产出目录：`/Users/lolilosorb/AI_APP/marvis/output/Ontology/`
- 数据基线：`scholar_literature_graph_v2.json`（治理前）→ `scholar_literature_graph_v2_1.json` / `scholar_data_v2_1.ttl`（治理后）

> 全部统计来源为治理前后真实图谱数据（v2.pre-governance.bak 与 v2_1 文件），未作任何编造。治理前文件以 `.bak` / `v2.pre-governance.*` 形式保留。

---

## 1. 本体扩展（edu_scholar_ontology.ttl → v1.1）

| 项目 | 变更 |
| --- | --- |
| 数据属性 | `es:researchArea`（xsd:string，作者研究方向文本，非强制） |
| 对象属性 | `es:hasResearchTopic`（domain `es:Author`，range `es:Keyword`） |
| AuthorShape 约束 | 新增 `researchArea` 非强制（无 minCount）；`hasResearchTopic` 校验 `sh:class es:Keyword` 且 `sh:maxCount 5`（关键词 Top5 上限） |
| 兼容备份 | `edu_scholar_ontology.v1.0.bak.ttl`、`edu_scholar_shapes.v1.0.bak.ttl` |

原 v1.0 本体与 shapes 已备份保留，v1.0 数据文件 `scholar_data_v2.ttl` 与 `scholar_literature_graph_v2.json` 未删除。

---

## 2. 治理前后维度对比

### 2.1 节点维度

| 类型 | v2（治理前） | v2.1（治理后） | 变化说明 |
| --- | --- | --- | --- |
| Paper | 13 | 13 | 1 个无 rdf:type 脏节点剔除（记录见 §5） |
| Author | 49 | 49 | 12 个混入机构名的 Author IRI 清洗（见 §4） |
| Organization | 7 | 9 | 泛化"University"拆分 + Ontario Hydro 补全 |
| Venue | 8 | 7 | 近似重复合并（见 §3） |
| Keyword | 49 | 49 | 不变 |
| LocalFile | 14 | 14 | 不变（含重复 PDF 归属主 Paper） |
| 合计 | 140 | 141 | — |

### 2.2 边维度

| 边类型 | v2 | v2.1 | 变化 |
| --- | --- | --- | --- |
| hasAuthor | 53 | 53 | 不变 |
| publishedIn | 13 | 13 | 不变 |
| hasKeyword | 89 | 89 | 不变 |
| cites | 26 | 26 | 不变 |
| related_to | 14 | 14 | 悬空边 0（修复前导下划线 id 缺失问题） |
| hasAffiliation | 14 | 15 | 作者 Shakim A. Sheikh 补全机构（Ontario Hydro） |
| hasResearchTopic | 0 | 239 | 新增研究方向关联（每作者 Top 4~5 关键词，上限 5） |
| 合计 | 209 | 449 | — |

### 2.3 关键指标对比

| 指标 | v2 | v2.1 |
| --- | --- | --- |
| 作者有机构 | 14 / 49（28.6%） | 15 / 49（30.6%） |
| 作者标"待补全" | 35 / 49 | 34 / 49 |
| 机构名规范 | 7 个含截断/泛化 | 9 个全规范全称 |
| Venue 近似重复 | 2 组变体 | 0 |
| 作者有研究方向 | 0 | 49 / 49（100%） |

---

## 3. Venue 重复归一化

| 治理前（3 个近似名） | 治理后 |
| --- | --- |
| `Composites: Part B` | → `Composites Part B: Engineering` |
| `Composites Part B`（2 篇） | → `Composites Part B: Engineering` |
| `Composites Part B: Engineering` | 保留 |

合并后 Venue 7 个：Construction and Building Materials / Composites Part B: Engineering / Engineering Structures / Journal of Composites for Construction / Journal of the Structural Division / Polymer Composites / Polymers。原 Venue 节点（变体 id）已统一指向合并后规范节点，相关 `publishedIn` 边全部改挂。

---

## 4. 机构名规范化与 Author IRI 清洗

### 4.1 机构名回填（依据 Crossref 机构资料与论文元数据中机构信息；本地无据者标注"待补全"，不编造）

| 作者 | 治理前机构 | 治理后机构 |
| --- | --- | --- |
| Débora R. Ferreira | Univ. of Mi | University of Minho |
| Joaquim A. Barros | Univ. of Mi | University of Minho |
| Jim Youssef | Univ. of Wo | University of Wollongong |
| Muhammad N. S. Hadi | Univ. of Wo | University of Wollongong |
| Suzru M. Uzumeri | Univ. of To | University of Toronto |
| Libo Yan | University of Br | Technical University of Braunschweig |
| Thong M. Pham | Curtin Univ. | Curtin University |
| Ying Wang | Research Institute | China Machinery International Engineering Design & Research Institute Co., Ltd |
| Deju Zhu / Hang Li / Haozhi Tan / Liang Huang / Xiaoxun Sun | University（泛化） | Hunan University（5 人） |
| Jia‐yi Chen | University（泛化） | Tianjin University |
| Shamim A. Sheikh | 无 | Ontario Hydro（新增，来自 v2 无机构专项回填） |

- 泛化 `University` 占位按论文语境拆分为 Hunan / Tianjin 两所规范机构。
- 无本地依据的 34 位作者机构保持 `None`，页面标注"待补全机构"，未编造全称。

### 4.2 Author IRI 清洗（混入机构名后缀 → 规范姓名 IRI，共 12 条）

示例：

| 治理前 id | 治理后 id |
| --- | --- |
| `Author:D_bora_R._Ferreira_univ.ofmi` | `Author:D_bora_R._Ferreira` |
| `Author:Hang_Li_university` | `Author:Hang_Li` |
| `Author:Joaquim_A._Barros_univ.ofmi` | `Author:Joaquim_A._Barros` |
| `Author:Muhammad_N._S._Hadi_univ.ofwo` | `Author:Muhammad_N._S._Hadi` |
| `Author:Suzru_M._Uzumeri_univ.ofto` | `Author:Suzru_M._Uzumeri` |
| `Author:Libo_Yan_universityofbr` | `Author:Libo_Yan` |
| `Author:Thong_M._Pham_curtinuniv.` | `Author:Thong_M._Pham` |
| `Author:Ying_Wang_researchinstitute` | `Author:Ying_Wang` |
| `Author:Deju_Zhu_university` 等（共 12 条） | 去除机构后缀 |

清洗后机构信息写入 `hasAffiliation`，不再混入姓名 IRI。全部 49 个 Author id 已通过"不含机构关键字后缀"校验。

---

## 5. 无 rdf:type 脏节点处理

- 脏节点：`Paper:Assessing_the_Efficiency_of_CFRP_Discrete_Confinement_Systems_for_Concrete_Cylinders.pdf`（仅 1 条 `related_to` 边指向重复 PDF，无任何 rdf:type 声明）。
- 处置：该 PDF（`Assessing_the_Efficiency_of_CFRP_...pdf`）与主 PDF `(ASCE)1090-0268(2008)12_2(134).pdf` 属同一文献（同标题、同 DOI），其 LocalFile 归属主 Paper，脏节点从图谱移除，其 `related_to` 边删除并改挂主 Paper。**源 JSON 未删除**，仅治理输出中剔除。
- 校验：v2.1 图谱 141 节点内不含该脏节点，悬空边 0，13 篇 Paper → 14 个 LocalFile 映射完整（含 1 个重复 PDF）。

---

## 6. 作者研究方向填充（hasResearchTopic / researchArea）

- 方法：聚合每位作者全部文献的 Keyword 词频集合，取 Top5 作为研究方向主题，建立 `hasResearchTopic` 边（Author → Keyword）；`researchArea` 用该集合关键词以逗号连接为文本并注明"由关键词聚合生成"。
- 结果：
  - 覆盖率：**49 / 49（100%）**，全部作者有 `hasResearchTopic`（239 条边，每作者 4~5 条 ≤ maxCount 5）且有 `researchArea`。
  - 无因 Keyword 缺失而留空的作者（49 篇文献关键词全部可用）。
- 示例：`Joaquim A. Barros` → researchArea = "assessing, efficiency, cfrp, discrete, confinement, systems, concrete, cylinders（由关键词聚合生成）"。

---

## 7. SHACL 质检结果（pyshacl，对 scholar_data_v2_1.ttl）

- RDF 三元组：817 | 对象属性边：449 | 悬空边：0
- `conforms = False`，Violations 共 **13** 条，**全部**为 `MinInclusiveConstraintComponent`（`es:year` 以 xsd:gYear 存储，pyshacl 用 xsd:integer 字面量做比较导致的工具缺陷误报），涉及 13 篇文献、年份值为 1980~2020 均在 1900–2026 合法范围内。
- **按已知豁免条款处理**：该 13 条为本工具对 gYear 的比较缺陷，予以豁免。
- **其余所有约束（含新增 researchArea / hasResearchTopic 校验）违规数 0**，已归零。

豁免明细（仅列便于核验，均为同一缺陷类型）：
`2009/2015/2006/2019/2020/2014/2015/2019/2008/2008/1980/2017/2015`，全部来自 Path `es:year`。

---

## 8. 页面重建结果（scholar_literature_manager.html）

- 复用 v1 构建脚本逻辑（Python 预处理聚合 → 内联 JSON → 原生 SVG 力导向渲染，无 CDN / fetch，`file://` 直接打开无 CORS）。
- 数据源切换为 `scholar_literature_graph_v2_1.json`，输出覆盖 `scholar_literature_manager.html`（168 KB，内联 JSON 139 KB）。
- 内嵌数据自测通过：`json.loads` 校验 OK；`DATA.authors` 49 人中 49 人有 `researchArea`，与统计一致。
- 渲染数据：节点 141（Paper 13 / Author 49 / Keyword 49 / LocalFile 14 / Venue 7 / Organization 9），边 449，悬空边 0。
- 页面维度展示：
  - 直观展示：作者研究方向（关键词聚合）字段；作者机构按规范全称显示，"待补全机构"独立标记。
  - 期刊视图为合并后 7 个规范期刊（无 `Composites: Part B` / `Composites Part B` 变体残留）。
  - 机构视图展示 9 个规范机构及成员，说明文本更新为 v1.1 治理后状态。
  - 总览页"待补全提示"更新为"v1.1 治理后状态"：机构回填（15/49）、期刊合并、研究方向通道（49/49）、悬空边清零。
- 已知如实保留：34 位作者无机构（标注"待补全"）、文献类型仅"期刊论文"实例、`citesCover 8/13`。

---

## 9. 产出文件清单（Ontology 目录）

| 文件 | 说明 |
| --- | --- |
| `edu_scholar_ontology.ttl` | 本体 v1.1（含 researchArea / hasResearchTopic） |
| `edu_scholar_shapes.ttl` | SHACL 约束 v1.1（AuthorShape 新增 researchArea / hasResearchTopic 校验） |
| `scholar_data_v2_1.ttl` | 治理后数据（817 三元组） |
| `scholar_literature_graph_v2_1.json` | 治理后图谱（141 节点 / 449 边） |
| `scholar_literature_manager.html` | 重建的可视化管理系统（v2.1 治理版） |
| `v1_1_governance_report.md` | 本报告 |
| `*.bak / v2.pre-governance.*` | 治理前原文件备份（保留，可回退） |
*（内容由AI生成，仅供参考）*
