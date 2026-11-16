#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
another_license.py — Another 授权签发工具（主控侧，含私钥，切勿分发）
=====================================================================
用法（用内置 runtime 的 python 执行）：

  # 1) 看本机指纹（让对方在他们机器上跑同一句，把指纹发给你）
  python3 tools/another_license.py machine-id

  # 2) 给对方签发授权（绑定其机器指纹，默认 365 天）
  python3 tools/another_license.py issue --machine <对方指纹> --days 365 \
      --note "内测-张三" --out ~/Desktop/license.json

  # 3) 校验某份授权
  python3 tools/another_license.py verify --file ~/Desktop/license.json

私钥默认位置：<项目根>/.license_keys/private.pem（权限 600，不进安装包）
"""

import argparse
import base64
import json
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import license_guard as LG

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_KEY = os.path.join(ROOT, ".license_keys", "private.pem")


def cmd_machine_id(_args):
    print(LG.machine_id())


def cmd_issue(args):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key_path = args.key or DEFAULT_KEY
    if not os.path.exists(key_path):
        sys.exit(f"找不到私钥：{key_path}")
    priv = serialization.load_pem_private_key(open(key_path, "rb").read(), password=None)
    if not isinstance(priv, Ed25519PrivateKey):
        sys.exit("私钥不是 Ed25519 类型")

    exp = date.today() + timedelta(days=args.days)
    payload = {
        "v": 1,
        "product": LG.PRODUCT,
        "machine_id": (args.machine or "").strip().lower() or LG.machine_id(),
        "issued_at": date.today().isoformat(),
        "expires_at": exp.isoformat(),
        "edition": args.edition,
        "note": args.note or "",
    }
    sig = priv.sign(LG.canonical(payload))
    payload["sig"] = base64.b64encode(sig).decode()

    out = os.path.expanduser(args.out or os.path.join(os.getcwd(), "license.json"))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"已签发：{out}")
    print(f"  机器指纹：{payload['machine_id']}")
    print(f"  有效期至：{payload['expires_at']}")


def cmd_verify(args):
    ok, reason, info = LG.verify_license(os.path.expanduser(args.file) if args.file else None, verbose=True)
    print("通过" if ok else f"不通过：{reason}")
    if ok:
        print(f"  机器指纹：{info.get('machine_id')}")
        print(f"  有效期至：{info.get('expires_at')}")
        print(f"  备注：{info.get('note') or '-'}")
    sys.exit(0 if ok else 3)


def main():
    ap = argparse.ArgumentParser(description="Another 授权签发/校验")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("machine-id", help="打印本机指纹")

    p = sub.add_parser("issue", help="签发授权文件")
    p.add_argument("--machine", default="", help="目标机器指纹（留空=本机）")
    p.add_argument("--days", type=int, default=365, help="有效天数，默认 365")
    p.add_argument("--edition", default="internal", help="版本标识，默认 internal")
    p.add_argument("--note", default="", help="备注，如使用人")
    p.add_argument("--out", default="license.json", help="输出路径")
    p.add_argument("--key", default="", help="私钥路径")
    p.set_defaults(func=cmd_issue)

    v = sub.add_parser("verify", help="校验授权文件")
    v.add_argument("--file", default="", help="授权文件路径（留空=自动查找）")
    v.set_defaults(func=cmd_verify)

    args = ap.parse_args()
    if args.cmd == "machine-id":
        cmd_machine_id(args)
    else:
        args.func(args)


if __name__ == "__main__":
    main()
