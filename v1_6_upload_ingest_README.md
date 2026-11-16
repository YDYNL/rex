---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 0416bf3adc9ae6268d5ccecae9b2b626_d2a696afab6511f18874525400287e28
    ReservedCode1: +ATikk4dZ+0naveFQzlCl1uytFPaCSwGooTFYOTdWna9+vDpjpGiIWX9XE6DP62R7jqikixTDvqmMJ7YuCQE8m8Rm8hQGiYISvHWcee1RkkEf0HjC2X8DfjhXAgb5XYumcD6JyFWeN8tZGWAh0rxcuOOHEhvG/MiQugH8eabMlEUVHC523Y6UEAIof8=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 0416bf3adc9ae6268d5ccecae9b2b626_d2a696afab6511f18874525400287e28
    ReservedCode2: +ATikk4dZ+0naveFQzlCl1uytFPaCSwGooTFYOTdWna9+vDpjpGiIWX9XE6DP62R7jqikixTDvqmMJ7YuCQE8m8Rm8hQGiYISvHWcee1RkkEf0HjC2X8DfjhXAgb5XYumcD6JyFWeN8tZGWAh0rxcuOOHEhvG/MiQugH8eabMlEUVHC523Y6UEAIof8=
---

# 科研文献本地化管理系统 v1.6 —— 上传 PDF 自动入库闭环

> 版本：v1.6 ｜ 日期：2026-09-08 ｜ 目录：`/Users/lolilosorb/AI_APP/marvis/output/Ontology/`

## 一、这是什么

用户把本地 PDF 文献交给系统后，自动完成：**解析元数据 → 去重 → 本地 LLM 增强 → 本体实例化 → 增量写入图谱 → 可视化页面即时可见** 的完整闭环。

产出文件（在 `Ontology/` 根目录，均在本次真实执行中生成）：

| 文件 | 说明 |
| --- | --- |
| `tools/ingest_pdf.py` | 入库管线（单 PDF / 目录 / 监控三种模式） |
| `tools/serve.py` | 本地 HTTP 服务（localhost:9000，零第三方依赖） |
| `tools/rebuild_page.py` | 幂等页面重建（含 v1.6 上传面板自动补齐） |
| `scholar_literature_graph_v2_4.json` | v2.4 图谱（v2.3 保留不动，新增增量） |
| `scholar_data_v2_4.ttl` | v2.4 本体数据（SHACL 复检，year 工具缺陷豁免） |
| `scholar_literature_manager.html` | 可视化页面（含「上传入库」标签页） |
| `v1_6_upload_ingest_README.md` | 本文档 |

## 二、使用方式

### 2.1 启动本地服务（推荐）

```bash
cd /Users/lolilosorb/AI_APP/marvis/output/Ontology
python3 tools/serve.py                    # 默认端口 9000
python3 tools/serve.py 9000              # 或指定端口
```

启动后浏览器打开 `http://localhost:9000/` 进入系统页面。

### 2.2 页面操作步骤

1. 打开 `http://localhost:9000/`，进入页面。
2. 点击顶栏 **「上传入库」** 标签页。
3. 两种上传方式可选：
   - **点击选择文件**按钮，选中本地 PDF；
   - **拖拽** PDF 到拖拽上传区。
4. 上传后页面自动调用 `/upload` 接口，等待处理（新增文献含本地 LLM 增强，单篇约 20–80 秒），完成后展示处理结果：
   - `新增入库`：解析成功、通过去重、已完成 LLM 增强并写入图谱；
   - `去重命中`：该 PDF 已在库中（DOI / 标题归一化 / 文件名任一命中），跳过新增；
   - `入库失败`：解析异常或其它原因（原因附在提示中）。
5. 处理完成页面已自动重建，**刷新页面即可看到新文献**（统计卡文献数 +1，图谱聚焦新增 Paper）。

> 若直接以 `file://` 方式打开 HTML：页面正常显示但上传不可用，会显示命令指引「请先运行 `python3 tools/serve.py` 启动本地服务」，不会报错。

### 2.3 命令行直接入库

```bash
python3 tools/ingest_pdf.py --file /path/to/paper.pdf   # 单文件
python3 tools/ingest_pdf.py --dir  /path/to/dir/        # 扫描目录下所有 .pdf
python3 tools/ingest_pdf.py --dir  /path/to/dir/ --watch # 监控模式，每 3s 轮询新 PDF 自动入库（Ctrl+C 退出）
```

可选参数：`--no-llm`（跳过本地大模型增强，走规则降级）、`--no-rebuild`（入库后不重建页面）。

## 三、管线流程

```
本地 PDF
  │ 1) 元数据提取  pypdf + pdfplumber（双后端，优先本地元数据）
  │    标题 / 作者 / 年份 / DOI / 摘要 / 期刊；DOI 正则 10.xxxx/xxx 识别
  │    可选 Crossref 校验 DOI（联网失败自动降级，不阻断；本次 <2026-09-08> 实际为离线直连探测，未依赖外网）
  ▼
 2) 去重比对（比对库 = 最新 v2_4；无则 v2_3 基线）
    ① DOI 归一化比对 → ② 标题归一化比对 → ③ 文件名比对
    命中 → 跳过并提示「去重命中」，清理暂存副本
  ▼
 3) 本地 LLM 增强（Ollama qwen3:8b，OpenAI 兼容接口）
    http://localhost:11434/v1/chat/completions
    输出严格 JSON：aiSummary / 关键词 / 研究方向 / confidence
    失败本地重试一次，仍失败标 failed 且不编造摘要（关键词规则降级）
  ▼
 4) 本体实例化（edu_scholar_ontology v1.5 全部类）
    Paper / Author / Venue / Keyword / LocalFile / Organization
    + 全部对象属性（hasAuthor / publishedIn / hasKeyword / cites / hasAffiliation / hasLocalFile 等）
    作者按 姓名+机构 与已有实体消歧合并；created_by=ollama；
    es:sourcedFrom 回链 PDF LocalFile；es:confidence 记录置信度
  ▼
 5) 增量写入  scholar_literature_graph_v2_4.json + scholar_data_v2_4.ttl
    （v2_3 保留不动；v2_4 已存在则继续叠加，跨运行累积）
  ▼
 6) SHACL 复检（year xsd:gYear 工具缺陷按 v1.1 豁免）
  ▼
 7) rebuild_page.py 幂等重建 HTML → 页面即时可见
```

## 四、支持的输入与解析能力

- **文件类型**：`.pdf`；单文件 / 目录批量 / 目录监控三种模式。
- **解析后端**：`pypdf`（元数据 + 文本）与 `pdfplumber`（文本抽取），失败自动切换/降级。
- **可提取字段**：标题、作者（含机构）、发表年份、DOI、摘要、期刊/出处、正文文本（用于摘要兜底与关键词抽取）。
- **元数据来源优先级**：PDF 内嵌元数据 > 文本首段启发式 > 文件名兜底；DOI 命中可走 Crossref 校验（联网失败降级不阻断）。
- **去重维度**：DOI 归一化 / 标题归一化 / 文件名，三路命中任一即跳过。
- **LLM 增强**：本地 Ollama `qwen3:8b`（亦可切换其它 OpenAI 兼容模型），生成中文 `es:aiSummary`、`es:autoKeywords`、`es:autoResearchArea`，并给 `es:confidence`（Ollama 增强样本均值 ~0.65–0.85）。

## 五、限制与已知缺口（如实标注）

1. **扫描版 PDF 未支持 OCR**：纯扫描件无可抽取文本时，标题/年份/摘要可能为空，需 OCR 后再处理（当前版本未内置 OCR）。
2. **元数据不全的文献**：年份/DOI 缺失时如实留空，**绝不编造**。例如测试文献《中 华 人 民 共 和 国 国 家 标 准》（GBT_upload_test.pdf，正式入库样本）无出版年份与 DOI，其 SHACL `year` minCount 违规即为缺项而非工具缺陷，已在 SHACL 结论中注明。
3. **SHACL year 误报**：`xsd:gYear` 与 `xsd:integer` 字面量比较的工具缺陷（合法年份如 2009/2015/2006/2019 被误报），按 v1.1 豁免规则处理，人工核对无误。
4. **LLM 依赖本地 Ollama**：若 `localhost:11434` 未运行 `qwen3:8b`，则 `--no-llm`/自动降级到规则抽取（`created_by=rule`，不生成编造摘要）。
5. **监控模式** `--watch` 未做长时间实跑压力验证（代码路径就绪），短时轮询逻辑与普通模式共用同一条入库处理链。

## 六、本次验证结果（真实执行，非编造）

| 验证项 | 命令/操作 | 结果 |
| --- | --- | --- |
| 接口新增闭环 | `curl -F file=@GBT_upload_test.pdf /upload` | HTTP 200，`ingested=1`（新增 Paper:GBT_upload_test.pdf，含真实中文 aiSummary，confidence 0.85，created_by=ollama） |
| 接口去重 | 再次上传同一 PDF | `duplicate=1`，提示「标题归一化命中已入库」 |
| 命令行 `--file` | `ingest_pdf.py --file polymers_test_copy.pdf` | `duplicate=1`（DOI 命中已入库） |
| 命令行 `--dir` | `ingest_pdf.py --dir polydir/` | `duplicate=1`（DOI 命中已入库） |
| 页面即时可见 | 重建后解析内联 DATA | `stats.paper=14`（13 存量 + 1 新增），14/14 带 aiSummary，footer 指向 v2_4 |
| SHACL | `run_shacl(scholar_data_v2_4.ttl)` | 违规全部为 year 工具缺陷 + 1 处 GBT 缺年份（如实标注），其余归零 |

图谱规模（v2.4）：**14 Paper / 54 Keyword / 15 LocalFile / 50 Author / 9 Organization / 7 Venue，456 边**。
*（内容由AI生成，仅供参考）*
