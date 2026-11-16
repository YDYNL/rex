---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 0416bf3adc9ae6268d5ccecae9b2b626_16c2e9fca2bb11f192a2525400287e28
    ReservedCode1: pbXortmmkb3siNvf1+kuxj0EkLtEGOaDHnoTrItbCiWXc8Eqf55yoCBuTHcUT33Eynz/IijIdL6o/GQilug+Oo0q1VJTTbATpBwIvBsFYD0B2MzRwsjbl47dRx8dX8NW9X1e8Gs5s7S4xOPb8EV6+3A9Z3rmvmHltR23sP2PXfnEK9XHDOLQDcLRUIY=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 0416bf3adc9ae6268d5ccecae9b2b626_16c2e9fca2bb11f192a2525400287e28
    ReservedCode2: pbXortmmkb3siNvf1+kuxj0EkLtEGOaDHnoTrItbCiWXc8Eqf55yoCBuTHcUT33Eynz/IijIdL6o/GQilug+Oo0q1VJTTbATpBwIvBsFYD0B2MzRwsjbl47dRx8dX8NW9X1e8Gs5s7S4xOPb8EV6+3A9Z3rmvmHltR23sP2PXfnEK9XHDOLQDcLRUIY=
---

# Palantir 平台全站知识总结报告

> 本报告由两次全量页面提取合并而成：
> 1. **Ontology 主题域专项提取**（389 个文档页），已整理为《palantir_ontology_knowledge.md》12 章知识库；
> 2. **Palantir 官网全站提取**（3451 个文档页，约 19MB），覆盖 Foundry / Apollo / Gotham 三大板块。
>
> 报告以"数据 → 语义 → 智能 → 应用 → 交付 → 治理"为主线，汇总两大知识资产的精华。

---

## 第 1 章 平台总览：一套操作系统，三大支柱

Palantir 将平台定位为组织的"操作系统"，由三个产品协同构成：

| 产品                                        | 定位                                        |
| ----------------------------------------- | ----------------------------------------- |
| **Foundry**                               | 数据运营平台：连接、整合、建模数据，构建分析与运营应用               |
| **AIP**（Artificial Intelligence Platform） | 人工智能平台：将 AI 与数据、运营流程结合，构建生产级 AI 工作流       |
| **Apollo**                                | 自主软件交付平台：面向 Kubernetes 环境的软件部署、变更管理与合规    |
| **Gotham**（补充）                            | 面向国防与情报领域的安全分析平台，与 Foundry 共享安全模型与跨应用交互能力 |

**AIP 的核心能力主张**：

- **无缝集成**：直接基于 Foundry 已有数据构建 LLM 驱动的 Agent 与工作流，支持广泛数据源与格式。
- **安全与治理**：继承 Palantir 全部高级安全措施（访问控制、加密、审计），内置治理工具维护 AI 运营的问责与血缘。
- **模型管理**：构建、训练、部署 LLM 的完整工具链，支持多模型选型、版本控制与协作。
- **规模与性能**：分布式架构支撑大规模数据操作与实时分析，提供资源使用的精细控制。
- **可解释与透明**：生成详细审计轨迹、解释与评测，帮助组织安全部署 AI。

**三种交付形态**：LLM 驱动的 Web 应用、使用视觉-语言模型的移动应用、内嵌本地化 AI 的边缘应用。

**注意**：AIP 功能可用性随版本与客户而异，部分能力处于 Beta 阶段（如 Autopilot、AIP Evolve）。

---

## 第 2 章 数据层：集成与管道

### 2.1 数据集成（Data Integration）

Foundry 提供统一的数据连接框架，将各类外部数据源接入平台：

- **Data Connection**：连接外部数据库与文件系统（含 SAP 连接器、Iceberg 表等），支持表/文件导入与虚拟表。
- **连接对象**：Connections（连接）、Virtual Tables（虚拟表）、File/Table Imports（文件与表导入）。
- **分析连通性**：提供 Power BI、Tableau 开箱即用连接器；REST API、ODBC/JDBC 驱动、Python/R SDK 用于通用与数据科学工具连通；Excel、Microsoft Report Builder 引导式集成。

### 2.2 管道构建（Pipeline Builder）

- **Pipeline Builder**：可视化/低代码构建数据管道（ETL），支持 Python / Java / R / SQL transforms，底层为 Spark 基础设施。
- **Code Repositories**：基于 Git 的 Web IDE，面向生产级代码（Transforms 支持 Python/Java/SQL；Functions 支持 TypeScript/Python），内置 PR 评审、IntelliSense、lint 与调试。
- **Code Workspaces**：将 JupyterLab、RStudio Workbench、VS Code 第三方 IDE 带入 Foundry，适用于机器学习建模与交互式分析（单节点运行，大规模转换仍建议 Pipeline Builder / Code Repositories）。
- **Streaming**：Foundry Streaming 处理流式数据场景。

---

## 第 3 章 本体论（Ontology）：组织语义与动力的核心

> 本章融合第一次专项提取（389 个 ontology 子页整理成的 12 章知识库）的精华。

### 3.1 定位：组织的"数字孪生"运营层

Ontology 是叠加在数字资产（数据集、虚拟表、模型）之上的**运营层**，将数据连接到现实世界实体（物理资产如工厂、设备、产品，或概念如客户订单、金融交易）。它包含：

- **语义要素（Semantic）**：对象（Objects）、属性（Properties）、链接（Links）
- **动力要素（Kinetic）**：动作（Actions）、函数（Functions）、动态安全

### 3.2 核心概念分层

| 概念              | 说明                                                        |
| --------------- | --------------------------------------------------------- |
| **Object Type** | 对象类型，数据映射为可操作对象的形态定义                                      |
| **Link Type**   | 链接类型，定义对象间关系（含语义链接）                                       |
| **Property**    | 属性，对象的字段与元数据                                              |
| **Interface**   | 接口：描述对象类型的形状与能力，提供对象类型多态（polymorphism），支持对共享形状的对象类型做一致性建模 |
| **Action Type** | 动作类型：一次事务内对对象/属性/链接的一组变更 + 副作用逻辑                          |
| **Function**    | 函数：可编排任意复杂度、低延迟执行的业务逻辑                                    |
| **Object Set**  | 对象集合：可被保存、共享、跨平台复用的对象子集                                   |

### 3.3 动作与函数（动力要素）

- **Action Type**：定义用户可一次执行的变更集，含参数定义、规则、提交准则（submission criteria）、副作用（如通知）。提交后写入 writeback 数据集，所有用户应用实时一致。例：`Assign Employee` 动作可同时改角色属性并自动创建与 Manager 的链接、通知新旧经理、校验 HR 权限。
- **Function**：在 Code Repositories 中编写（TypeScript / Python），支持基于 Ontology 数据类型的自动补全与预览；也可在 AIP Logic 中无代码构建 LLM 函数。

### 3.4 管理工具

- **Ontology Manager（OMA）**：构建与维护 Ontology 的入口——创建对象类型、动作类型、连接数据、排查更新。三种入口：侧边栏图标、Data Lineage 右键、`/workspace/ontology` URL。

### 3.5 语义搜索与数据安全（知识库章节要点）

- 支持语义搜索：在对象/属性/链接上做基于语义的检索与发现。
- 权限与安全：对象级安全策略（object security policies）、属性级安全（property security markings）、受限视图（restricted views）等行列级细粒度控制。
- 后端架构：Ontology 查询系统（高扩展对象/链接查询）、时间序列存储、writeback 机制、血缘追踪。
- 语义网标准对照：知识库中提供了 Object type / Link type / Interface 等术语与 OWL / RDF 语义网体系的对照，便于从本体论视角理解。
- 应用生态：Object Views、Object Explorer、Quiver、Workshop 等均深度集成 Ontology，实现"一次建模、处处复用"。

---

## 第 4 章 AIP 与 AI 能力全景

### 4.1 AIP 构建工具族

| 工具 | 定位 |
|------|------|
| **AIP Logic** | 无代码环境构建 LLM 驱动的函数：可视化编排 prompt、接入 Ontology 数据、测试、评估、监控、自动化 |
| **AIP Chatbot Studio**（原 AIP Agent Studio） | 构建交互式 AIP Chatbot（原 AIP Agent）：LLM + Ontology + 文档 + 自定义工具，可内部部署或经 OSDK/平台 API 对外部署 |
| **AIP Evals** | 函数与 Agent 的评测：结果分析器按根因归类失败用例，建议针对性 prompt 修改 |
| **AIP Evolve**（Beta） | 协调 AI FDE Agent 群体改进 AI 系统：定义目标/校验策略/限制，Agent 自动探索并给出提案（如换模型降成本 65%、加 guardrail） |
| **Pro-code Agents** | 在 Code Repositories 中用 Claude Agent SDK / OpenAI Agents SDK / Google ADK 模板构建自定义 Agent，发布为 Foundry function，自动获得 OSDK / OMCP / Palantir MCP 作用域权限 |
| **AI FDE** | AI 驱动的"驻场工程师"：自然语言转 Foundry 操作（数据变换、代码仓库、本体构建与编辑），闭环运行（执行→观察→再决策），支持分支提案供审查 |
| **AIP Assist** | LLM 支撑的平台内支持助手：多语言、上下文感知、提供模式（默认/平台文档/开发者文档/AIP Chatbot）、可注册自定义内容源（Notepad 文档或自定义文档仓库） |

### 4.2 分析与智能体应用

- **AIP Analyst**：面向本体数据的 Agent 化临时分析接口——用自然语言提问，Agent 自动搜索 Ontology、创建对象集、变换数据、生成摘要与可视化。
- **AIP Document Intelligence**：文档提取工作流入口：在媒体集上执行多种 SOTA 文档提取策略，评估质量/速度/Token 成本，一键部署为批量管道的 Python transform。
- **Autopilot**（Beta）：Ontology 自动化工作流的控制中心：Kanban 看板 + 依赖图可视化、对象级事件失败追踪、编辑历史溯源、实时 liveness、手动重试、直接修改自动化条件。
- **HyperAuto（SDDI）**：软件定义数据集成：在 SAP / Salesforce / Oracle NetSuite 等关键系统上开箱即用地自动同步、集成、结构化数据（V2 支持实时流式，当前支持 SAP）。
- **Threads / Realtime Audio / Compass / Flow Capture / Preparation**：AIP 域下的交互线程、实时音频、路径规划（Compass）、流程捕获与数据准备能力。

### 4.3 AIP 与 Ontology 可观测性

- **AIP Observability**：监控与优化 Agent/应用的性能：日志搜索（log search）、成本、延迟、成功率等指标。
- 可观测性贯穿函数评测、模型切换、工作流健康监测。

---

## 第 5 章 分析与可视化

Foundry 提供面向不同角色的分析应用，全部与 Ontology 集成，支持将分析结论**写回 Ontology**：

| 应用 | 特点 | 适用场景 |
|------|------|----------|
| **Contour** | 表格点选分析：可视化过滤/变换、参数化、交互式 Dashboard、可存为数据集 | 未映射 Ontology 的大表分析、超大规模 join/聚合 |
| **Quiver** | 多模态图表应用：对象驱动分析、时间序列分析、点选 ML、Dashboard 构建，公式语言与 transform tables | Ontology 已建模数据、时间序列、嵌入 Workshop |
| **Code Workbook**（Legacy） | 代码式分析：Python/R/SQL 变换、可视化、模板、分支协作 | 快速迭代分析逻辑 |
| **Notepad** | 对象感知的协同富文本编辑器：嵌入各应用图表/对象，模板化报告、冻结时点、导出打印 | 临时笔记、平台内文档、周期性报告 |
| **Fusion** | 电子表格驱动应用：表格计算 + Ontology 对象查询系统 | 熟悉表格的数据处理者 |
| **Insight** | 点选式 Ontology 数据探索：分步构建对象集过滤、遍历链接、聚合、可视化 | 对象集的发现与构建 |
| **Reports**（Sunset） | 报告工具，已进入停止维护阶段，推荐迁移到 Contour/Quiver Dashboards 与 Notepad | 存量报告仍只读可用 |

---

## 第 6 章 应用构建

### 6.1 构建方式对比

| 方式 | 定位 |
|------|------|
| **Workshop** | 无代码、对象导向的操作型应用构建器：三大原则（对象数据、一致设计、交互与复杂度），支持 Inbox 任务管理、公共作战图（COP）；拖拽与 App Pairing 跨应用交互 |
| **OSDK React 应用** | React 自定义 UI，由 Ontology SDK 驱动，Developer Console 创建，可经 Pilot AI 生成 |
| **Custom Widgets** | 在 Workshop 中以自定义前端代码扩展（如 K 线图、行业专属对象视图、签名组件） |
| **Slate** | 低代码拖拽构建器：操作应用、交互式 Dashboard、落地页，可 CSS 深度定制，可发布公开互联网应用（无需自建服务器/DNS/认证） |
| **Code Workspaces 应用** | Streamlit / Dash（Python）与 Shiny（R）交互式 Web 应用，第三方 IDE 发布 |
| **Pilot** | AI 驱动的应用生成器：从自然语言 prompt 生成 OSDK 应用（本体实体、设计、前端）并引导部署 |

### 6.2 跨应用交互（Cross-application Interactivity）

- **拖拽（Drag & Drop）**：在应用间移动对象/对象集（如从 Gotham 的 Gaia 拖入 Workshop）。
- **App Pairing 与 Commands**：实时共享选择状态，跨应用执行工作流，为 AIP 提供当前视口/选择上下文。
- **AIP Chatbot 可作为工具读写**支持命令互操作的应用（如 Gaia）。
- 每个交互点都是潜在连接，形成应用生态系统。

### 6.3 Ontology SDK（OSDK）

- 支持 npm（TypeScript）、pip/Conda（Python）、Maven（Java）、OpenAPI（任意语言）。
- 访问对象类型、应用动作写回、调用函数、运行 AIP Logic 函数；OAuth 作为公开/机密客户端访问数据。

---

## 第 7 章 开发者平台与 API

### 7.1 开发者工具链

- **Core APIs & SDKs**：OSDK（Ontology SDK）+ 平台级 API。
- **Palantir MCP**：Model Context Protocol 实现，让 AI IDE 与 AI Agent 自主构建端到端应用（数据集成→本体配置→应用开发），并查询文档/元数据/数据、执行平台高层任务。
- **Ontology MCP（OMCP）**：Developer Console 功能，将应用的本体资源暴露为 MCP 工具，供外部 AI Agent 安全读写生产本体数据（面向"本体消费者"）。
- **Compute Modules**：容器化代码并扩展部署。

### 7.2 主要 API 族

| API | 能力 |
|-----|------|
| Datasets | 读写管理数据集（分支、事务、文件、视图） |
| Filesystem | 管理空间、项目、文件夹与资源角色 |
| Administration | 管理用户、组、组织、主机与标记 |
| Orchestration | 触发构建、检查作业、配置调度 |
| Connectivity | 管理连接、虚拟表、外部导入 |
| SQL Queries | 对数据集执行 SQL |
| Media Sets（Beta） | 上传、检索、管理媒体集 |

> 另有 REST API v2 的 426 个端点页为前端动态渲染，已单独存为 api_v2_urls.json 清单（未抓正文）。

### 7.3 开发环境

- **Code Repositories**：Git Web IDE（见 2.2）。
- **Code Workspaces**：VS Code / JupyterLab / RStudio Workbench 集成，含 AIP 辅助编码 Agent、Git 工作流、模型集成、Sources 外部系统交互。
- **Developer Console**：构建与管理自定义应用（OAuth 授权客户端、SDK 生成、SDK 文档、权限、指标、Web 托管、Code Repository 关联、Marketplace 分发、MCP server）。
- **SuperRepo**：Pro-code monorepo，代码定义本体/函数/前端，本地生成 SDK，作为 Marketplace 产品部署到多环境。
- **VS Code workspaces + Palantir 扩展**：在熟悉 IDE 中编辑管理代码。
- **Global Branching**：跨端到端工作流的安全开发环境。

---

## 第 8 章 规则、逻辑与自动化

- **Foundry Rules**（原 Taurus）：低代码业务规则管理——条件组合构成规则，应用于数据集/对象/时间序列，典型用例包括反洗钱（AML）告警、设备监控、客户分群（Cohorting）。
- **AIP Logic**：见 4.1；LLM 函数可被 Automate 自动化，使 Ontology 编辑自动应用或暂存人工审查；支持 Foundry Branching 隔离开发与健康指标监控。
- **Workflow Lineage**（原 Workflow Builder）：工作流理解与管理工作台——探索对象/动作/函数/接口/自定义组件/应用/模型等资源的 API 名称、输入、Ontology 编辑、提交准则；模型生命周期查看、批量替换模型、下游使用分析、每周用量指标、全局分支审查、服务日志搜索、跨本体关系可视化。
- **Automate**：触发工作流/函数的自动化（事件驱动），是 pro-code agent 的推荐触发点。
- **Autopilot**：见 4.2，自动化工作流运行时的控制中心。

---

## 第 9 章 安全与治理

### 9.1 平台安全模型

四大设计原则：**严格强制**（只给已授权数据）、**细粒度控制**、**透明**（知道谁因何访问什么）、**可用性**（信心地管理访问控制）。

- **认证（Authentication）**：验证身份；支持 SAML 2.0 与 OpenID Connect 1.0（OIDC）身份提供方集成。
- **授权（Authorization）**：基于用户属性与权限。
- **强制控制（Mandatory）**：Markings（标记）、基于分类的访问控制（CBAC）、Organizations（组织），随数据通过血缘/谱系传播。
- **自主控制（Discretionary）**：资源级角色授予（Owner/Editor/Viewer/Discoverer），行列过滤（restricted views、object security policies、property security markings）。行列控制只过滤用户可读内容，不向下游输出/导出传播。
- **组织隔离**：一个 Organization 的用户无法访问另一 Organization 的资源，除非显式配置共享协议。

### 9.2 企业级安全（不设付费墙）

标准产品即含：全量数据静态/传输加密、SSO 与 MFA（SaaS 强制 MFA 多年）、强制+自主访问控制、安全审计日志、可扩展信息治理与隐私控制。合规框架对齐 HIPAA、GDPR、ITAR 等。基础设施安全遵循零信任、最小权限、纵深防御。

### 9.3 专项工具

- **Sensitive Data Scanner（SDS，原 Foundry Inference）**：发现并保护敏感数据——指定敏感模式与自动处置动作，支持单次或定期扫描，辅助 GDPR/CCPA/LGPD 合规。
- **Cipher**：加密服务（加密/解密/哈希），通过 Channels（算法与密钥管理）与 Licenses（权限与应用）管理，面向非技术用户提供隐私增强工具。
- **Private Link**：AWS PrivateLink / Azure Private Link / GCP Private Service Connect，为 VPC 到 Foundry VPC 提供私有内网连接（Ingress/Egress 双向）。

---

## 第 10 章 Apollo：自主软件部署与交付

### 10.1 架构：Hub 与 Spoke

- **Hub**：接收 Spoke 遥测，通过**编排引擎（Orchestration Engine）** 下发 **Plan**；可管理多个 Spoke，也可自管。
- **Spoke**：每个环境运行 **Spoke Control Plane**，Agent 回报观测状态（Reported State、Probes、Telemetry & Logs），轮询并执行 Hub 的 Plan。
- 编排引擎输入：Product Catalog 的产品发布（Release）、发布渠道、环境设置、中央可观测性反馈；无单一目标版本，而是"产品 + Release Channel"约束规则。

### 10.2 变更管理与合规

- **Change Management**：所有环境设置变更走审批流，仅高质量的、经审计的合规变更进入生产。
- **CEL Policies**：用 Common Expression Language（CEL，Kubernetes/Google Cloud 同源标准）定义审批策略；按**单个 Entity 变更**粒度评估，多策略结果 AND 合并；表达式返回 `approve()/reject()/no_op()/require_role()` 等；输入字段含 type/author/onBehalfOf/editors/metadata/request/diff/referencedResources/createdAt/now。
- **RBAC**：基于角色的授权贯穿变更、产品、发布渠道。

### 10.3 其他能力

- **Secrets 管理**：键值对式 secrets，支持增删改查与引用。
- **Notifications**：多渠道（Email/Slack/平台内），用户级与团队级，支持变更审批提醒、产品召回、RBAC 变更、发布提升失败、Plan 失败等通知类型。
- **Release Channels & Promotion Pipeline**：发布渠道管理、发布提升流水线、产品召回处理。

---

## 第 11 章 Gotham

- **定位**：面向国家安全与国防领域的安全分析平台（文档公开部分以 Security 板块为主），与 Foundry 共享同一套安全哲学与安全模型（严格强制、细粒度、透明、可用；强制+自主控制；markings；企业级加密/认证/审计/治理）。
- **跨应用交互**：Gotham 的 Gaia、Graph 等应用可与 Foundry 应用通过拖拽、App Pairing、Commands 联动，形成跨平台工作流生态系统。
- **文档规模**：本次抓取 Gotham 板块 9 页，主题集中在安全与跨应用交互。

---

## 第 12 章 附录：文档资产与索引

### 12.1 抓取规模总览

| 板块 | 落盘页数 |
|------|----------|
| Foundry | 3181 |
| Apollo | 261 |
| Gotham | 9 |
| **合计（核心文档）** | **3451 页（约 19MB）** |
| 动态列表页（跳过） | 16（release-notes 年度归档、filters 筛选视图） |
| REST API v2 端点页（动态渲染，清单化） | 426（存 api_v2_urls.json） |

> 早期另有 ontology 主题域 389 个子页专项提取（2.2MB），整理为 12 章知识库。

### 12.2 主要文件位置

| 文件 | 内容 | 位置 |
|------|------|------|
| site_docs/ | 全站文档正文（按板块分子目录，每页为干净 Markdown） | temp/site_docs/ |
| _full_index.md | 全量索引（标题 + URL + 首段，3451 条） | temp/site_docs/_full_index.md |
| site_index.json | 全站元数据索引 | temp/site_index.json |
| all_core_urls.json | 全站核心文档 URL 清单（3467 条） | temp/all_core_urls.json |
| api_v2_urls.json | REST API v2 动态端点清单（426 条） | temp/api_v2_urls.json |
| palantir_ontology_knowledge.md | Ontology 主题域 12 章知识库 | output/palantir_ontology_knowledge.md |
| 本报告 | 全量知识总结 | output/Palantir全站知识总结报告.md |

### 12.3 索引使用指引

- 需要检索具体主题时，优先使用 `_full_index.md` 的标题 + 首段快速定位，再打开对应 `site_docs/` 正文页深读。
- Ontology 语义概念（对象/链接/接口/动作/函数/OWL 对照）请直接查阅《palantir_ontology_knowledge.md》。
- REST API 端点细节尚未落盘正文，可按 `api_v2_urls.json` 中的 URL 在线查阅。

---

*报告生成时间：2026-08-28 · 数据源：Palantir 官网 docs 板块全量页面提取*
*（内容由AI生成，仅供参考）*
