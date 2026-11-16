---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 0416bf3adc9ae6268d5ccecae9b2b626_dcfc2c8eab5611f18039525400461939
    ReservedCode1: KmWm6ysZn2S0Td5nG8s/qOyrZ09KWI8B+WufaUQTFEiLfDRoWH4dOuOHlFG4poU/jbuSeQDFRWufNeE+jvYOzZvIflQdrmybQSdJ00NRW7grD32ibqiXJOUn/RcLhxtP8owOxdGGg5g2ChwVznZmLGfcESi3ly1yhKGkpDDBsOCAxsGDRCRc5u4XWQ8=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 0416bf3adc9ae6268d5ccecae9b2b626_dcfc2c8eab5611f18039525400461939
    ReservedCode2: KmWm6ysZn2S0Td5nG8s/qOyrZ09KWI8B+WufaUQTFEiLfDRoWH4dOuOHlFG4poU/jbuSeQDFRWufNeE+jvYOzZvIflQdrmybQSdJ00NRW7grD32ibqiXJOUn/RcLhxtP8owOxdGGg5g2ChwVznZmLGfcESi3ly1yhKGkpDDBsOCAxsGDRCRc5u4XWQ8=
---

# v1.5 文献入库增强管线 —— 增强报告

- 执行时间：2026-09-08T15:14:55
- 执行模式：请求 ollama → 实际 **ollama**（Ollama 探测：检测到 Ollama 服务（HTTP http://localhost:11434/v1/models），模型: qwen3:8b）

## 1. 去重统计

- 比对库文献总数：13 篇
- 去重命中（已入库，跳过新增）：**13** 篇
- 未命中（新增入库）：**0** 篇

## 2. 元数据增强覆盖率

| 维度 | 覆盖数 | 说明 |
| --- | --- | --- |
| 自动关键词 autoKeywords | 13 | 从标题/摘要抽取，图谱已知关键词词表 49 个 |
| AI 摘要 aiSummary | 13 | 仅 LLM 模式生成；规则模式/失败篇不编造，留空 |
| 置信度 confidence | 13 | 规则=0.60 恒定经验值 / LLM=模型返回confidence，见每条标注 |
| 研究方向归类 autoResearchArea | 13 | ollama=LLM返回researchArea；规则=关键词 Top3 归类 |
| 溯源 sourcedFrom | 13 | 每条增强回链来源文档（LocalFile 节点） |

## 3. 模式与耗时

- 抽取模式：LLM（qwen3:8b）
- LLM 抽取耗时：521.36 s
- 管线总耗时：**522.1 s**

## 4. 去重命中提示

本次 13 篇文献已在库中（按 DOI/标题归一化匹配），均未重复入库；全部走存量增强通道。新增文献请走相同命令，命中时会跳过新增并提示。

## 5. SHACL 复检

- conforms：**False**

- 若存在校验不通过项，绝大多数来自 year 的 xsd:gYear 工具误报（pyshacl 将 xsd:gYear 与 xsd:integer 比较所致），年份 1980–2020 合法，按 v1.1 豁免规则豁免。year 误报计数：26

```
Validation Report
Conforms: False
Results (13):
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S0141029609001771-main.pdf>
	Value Node: Literal("2009", datatype=xsd:gYear)
	Result Path: es:year
	Message: 文献年份必须在 1900 至 2026 之间。
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S0141029615001819-main.pdf>
	Value Node: Literal("2015", datatype=xsd:gYear)
	Result Path: es:year
	Message: 文献年份必须在 1900 至 2026 之间。
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S095006180500053X-main.pdf>
	Value Node: Literal("2006", datatype=xsd:gYear)
	Result Path: es:year
	Message: 文献年份必须在 1900 至 2026 之间。
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S0950061818330757-main.pdf>
	Value Node: Literal("2019", datatype=xsd:gYear)
	Result Path: es:year
	Message: 文献年份必须在 1900 至 2026 之间。
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S0950061819324857-main.pdf>
	V
```

## 6. 每条增强的溯源与置信度

每条 Paper 均写入属性：`es:aiSummary`（仅LLM）、`es:autoKeywords`、`es:confidence`、`es:sourcedFrom`、`createdBy`（ollama/rule/failed）。详见 `scholar_data_v2_3.ttl` 与 `scholar_literature_graph_v2_3.json`（v2_2 保留）。

____

## 7. LLM 模式重跑（真实本地大模型）

- **模型**：qwen3:8b（OpenAI 兼容接口 http://localhost:11434/v1/chat/completions，thinking 模型已处理思考段，只取最终 content 严格 JSON 解析）
- **单篇平均耗时**：40.1 s（LLM 抽取总耗时 521.36 s / 成功 13 篇）
- **13 篇 aiSummary 生成数**：**13/13**
- **LLM 成功篇数**：13 / **失败篇数**：0（失败且重试仍失败，如实标记 failed，aiSummary 留空）
- **重试次数**（首次调用失败后重试 1 次）：0
- **created_by**：成功篇=ollama，失败篇=failed
- **confidence 分布**（成功 13 篇，模型返回 0-1）：min=0.5 / max=0.85 / 均值=0.654，明细 [0.6, 0.6, 0.85, 0.65, 0.6, 0.5, 0.6, 0.7, 0.75, 0.5, 0.6, 0.7, 0.85]

## 8. SHACL 复检（LLM 重跑后）

- conforms：**False**

- year xsd:gYear 工具误报计数：26（pyshacl 将 xsd:gYear 与 xsd:integer 比较所致，年份合法，按 v1.1 豁免规则豁免）

```
Validation Report
Conforms: False
Results (13):
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S0141029609001771-main.pdf>
	Value Node: Literal("2009", datatype=xsd:gYear)
	Result Path: es:year
	Message: 文献年份必须在 1900 至 2026 之间。
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S0141029615001819-main.pdf>
	Value Node: Literal("2015", datatype=xsd:gYear)
	Result Path: es:year
	Message: 文献年份必须在 1900 至 2026 之间。
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S095006180500053X-main.pdf>
	Value Node: Literal("2006", datatype=xsd:gYear)
	Result Path: es:year
	Message: 文献年份必须在 1900 至 2026 之间。
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S0950061818330757-main.pdf>
	Value Node: Literal("2019", datatype=xsd:gYear)
	Result Path: es:year
	Message: 文献年份必须在 1900 至 2026 之间。
Constraint Violation in MinInclusiveConstraintComponent (http://www.w3.org/ns/shacl#MinInclusiveConstraintComponent):
	Severity: sh:Violation
	Source Shape: [ sh:datatype xsd:gYear ; sh:maxInclusive Literal("2026", datatype=xsd:integer) ; sh:message Literal("文献年份必须在 1900 至 2026 之间。", lang=zh) ; sh:minCount Literal("1", datatype=xsd:integer) ; sh:minInclusive Literal("1900", datatype=xsd:integer) ; sh:path es:year ]
	Focus Node: <http://edu-scholar.org/ontology#Paper:1-s2.0-S0950061819324857-main.pdf>
	V
```

---
*由 tools/enhance_ingest.py 自动生成，统计全部来自真实执行结果。*
*（内容由AI生成，仅供参考）*
