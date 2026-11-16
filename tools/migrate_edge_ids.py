#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
migrate_edge_ids.py — R2（P2 顺带修复）运行态无 id 边 id 回填迁移
=================================================================
背景
    P1 交付后运行态图谱 scholar_literature_graph_v2_4.json 中 138 条历史边
    全部没有 `id` 字段（v1.6 上传闭环写入的旧形态），而「拖拽连线」新增边带
    uuid 形态 id，两种形态并存导致：
      - delete_edge 按 id 定位时旧边不可达（R1 修复前的“无 id 全量删边”正是由此放大）
      - 版本快照 / 审计无法精确引用某条边
    见《科研学术本体工作台_管理模块评估报告》R2。

策略（安全第一）
    1. 迁移前**强制备份**图谱 JSON（默认落到 versions/p2_backup/，带时间戳），失败可从备份整文件回滚。
    2. id 生成**确定性**：sha1(source_id|target_id|type|第几次出现)[:16]，重复执行结果一致，幂等。
    3. 只**新增** id / familyId 字段，不改动删任何既有字段与边，不重排顺序。
    4. 原子写：写 .tmp 再 os.replace，避免写坏事实源。
    5. --dry-run 预演；--restore <backup> 一键回滚。

用法
    python3 migrate_edge_ids.py --dry-run
    python3 migrate_edge_ids.py                # 备份 + 迁移 + 校验
    python3 migrate_edge_ids.py --restore versions/p2_backup/xxx.baseline.json
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime

DEFAULT_GRAPH = os.path.join(
    os.path.expanduser("~"),
    "Library/Application Support", "ReX", "workspace",
    "scholar_literature_graph_v2_4.json")


def now_stamp():
    return datetime.now().strftime("%Y%m%d%H%M%S")


def now_iso():
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def det_id(src, dst, typ, nth):
    key = "%s|%s|%s|%d" % (src, dst, typ, nth)
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def backup_graph(graph_path, backup_dir=None):
    backup_dir = backup_dir or os.path.join(os.path.dirname(graph_path), "versions", "p2_backup")
    os.makedirs(backup_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(graph_path))[0]
    dst = os.path.join(backup_dir, "%s.%s.baseline.json" % (base, now_stamp()))
    shutil.copy2(graph_path, dst)
    return dst


def migrate(graph_path, apply=True, backup_dir=None):
    with open(graph_path, encoding="utf-8") as f:
        g = json.load(f)
    edges = g.get("edges") or []
    links = g.get("links") or []
    seen = {e.get("id") for e in edges if e.get("id")}
    counter, assigned, skipped = {}, [], 0
    for e in edges:
        if e.get("id"):
            skipped += 1
            continue
        src, dst, typ = e.get("source_id"), e.get("target_id"), e.get("type")
        key = (src, dst, typ)
        counter[key] = counter.get(key, 0) + 1
        eid = det_id(src, dst, typ, counter[key])
        while eid in seen:                      # 极低概率碰撞，退避重算
            eid = det_id(src, dst, typ, counter[key] + 1000)
        seen.add(eid)
        e["id"] = eid
        e.setdefault("familyId", eid)
        assigned.append({"edge": eid, "source_id": src, "target_id": dst, "type": typ})
    # links 与 edges 同构（本工作区 links 为空，仍做兜底同步）
    for i, l in enumerate(links):
        if not l.get("id") and i < len(assigned):
            l["id"] = assigned[i]["edge"]
            l.setdefault("familyId", l["id"])

    report = {"graph": graph_path, "at": now_iso(), "apply": bool(apply),
              "edges_total": len(edges), "already_had_id": skipped,
              "backfilled": len(assigned), "links_total": len(links)}
    if not apply:
        report["dry_run_sample"] = assigned[:5]
        return report, g, None

    backup = backup_graph(graph_path, backup_dir)
    report["backup"] = backup
    tmp = graph_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(g, f, ensure_ascii=False, indent=2)
    os.replace(tmp, graph_path)
    # 迁移清单留痕（审计 / 精确回滚定位）
    sidecar = os.path.join(os.path.dirname(backup),
                           "edge_id_migration_%s.json" % now_stamp())
    with open(sidecar, "w", encoding="utf-8") as f:
        json.dump({"report": report, "assigned": assigned}, f, ensure_ascii=False, indent=2)
    report["sidecar"] = sidecar

    # 复核：迁移后仍无 id 的边数应为 0
    with open(graph_path, encoding="utf-8") as f:
        g2 = json.load(f)
    still = sum(1 for e in (g2.get("edges") or []) if not e.get("id"))
    report["verify_no_id_after"] = still
    report["verify_ok"] = (still == 0 and len(g2.get("edges") or []) == len(edges))
    report["md5_after"] = hashlib.md5(open(graph_path, "rb").read()).hexdigest()
    return report, g2, backup


def restore(graph_path, backup_file):
    if not os.path.isfile(backup_file):
        return {"ok": False, "reason": "备份文件不存在: " + backup_file}
    shutil.copy2(backup_file, graph_path)
    return {"ok": True, "restored_from": backup_file,
            "md5": hashlib.md5(open(graph_path, "rb").read()).hexdigest()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--graph", default=DEFAULT_GRAPH)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--restore", default="")
    ap.add_argument("--backup-dir", default="")
    a = ap.parse_args()
    if a.restore:
        out = restore(a.graph, a.restore)
    else:
        out, _g, _b = migrate(a.graph, apply=not a.dry_run, backup_dir=a.backup_dir or None)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if not out.get("verify_ok") is False else 1


if __name__ == "__main__":
    sys.exit(main())
