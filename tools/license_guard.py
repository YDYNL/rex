#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
license_guard.py — Another 离线授权校验（后端侧）
=================================================
授权文件 = license.json，由主控私钥（Ed25519）签发，内容绑定机器指纹与有效期。
本模块用内置公钥验签，任何篡改（改机器码 / 改有效期 / 改产品名）都会导致验签失败。

授权文件查找顺序：
  1. 环境变量 ANOTHER_LICENSE_PATH 指定的路径
  2. ~/Library/Application Support/Another/license.json（macOS）
  3. 应用资源目录下的 license.json（随包分发时可放这里）

绕过开关（仅开发/自动化测试用，打包版主进程永不设置）：
  ANOTHER_LICENSE_OK=1      —— 主进程已验签通过，后端直接放行
  ANOTHER_SKIP_LICENSE=1    —— 开发态跳过校验
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import subprocess
import sys
from datetime import date, datetime

PRODUCT = "Another"
PUB_KEY_HEX = "2c3193891a20b6323bbe0a7453b844cdb5be28fdb0813e6ed32f65b04084b490"


# ---------------------------------------------------------------- 机器指纹
def _raw_machine_id() -> str:
    """取稳定的硬件标识（macOS 用 IOPlatformUUID，Windows 用 MachineGuid，Linux 用 machine-id）。"""
    system = platform.system()
    try:
        if system == "Darwin":
            out = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True, text=True, timeout=8).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    return line.split('"')[3].strip()
        elif system == "Windows":
            # 首选注册表 MachineGuid（与主进程 main.js 的 rawMachineId 完全一致）
            try:
                import winreg  # noqa: WPS433 (Windows 专属)
                with winreg.OpenKey(
                        winreg.HKEY_LOCAL_MACHINE,
                        r"SOFTWARE\Microsoft\Cryptography", 0,
                        winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                    val = winreg.QueryValueEx(k, "MachineGuid")[0]
                if val:
                    return str(val).strip()
            except Exception:
                pass
            # 次选：主板 UUID（MachineGuid 被清理时的备份路径）
            try:
                out = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                     "(Get-CimInstance Win32_ComputerSystemProduct).UUID"],
                    capture_output=True, text=True, timeout=15).stdout.strip()
                if out:
                    return out
            except Exception:
                pass
        else:
            for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                if os.path.exists(p):
                    return open(p).read().strip()
    except Exception:
        pass
    # 兜底：主机名 + 用户名（稳定性略差，仅用于非 mac / 非 win 环境）
    return f"{platform.node()}-{os.getenv('USER') or os.getenv('USERNAME', 'user')}"


def machine_id() -> str:
    """对硬件标识做 sha256，外发时不泄露原始 UUID。"""
    return hashlib.sha256(_raw_machine_id().upper().encode()).hexdigest()


# ---------------------------------------------------------------- 授权文件
def candidate_paths() -> list:
    paths = []
    env = os.getenv("ANOTHER_LICENSE_PATH")
    if env:
        paths.append(env)
    home = os.path.expanduser("~")
    paths.append(os.path.join(home, "Library", "Application Support", "Another", "license.json"))
    appdata = os.getenv("APPDATA")  # Windows：%APPDATA%\Another\license.json（= Electron userData）
    if appdata:
        paths.append(os.path.join(appdata, "Another", "license.json"))
    paths.append(os.path.join(home, "Application Support", "Another", "license.json"))  # 非 mac 兜底
    here = os.path.dirname(os.path.abspath(__file__))
    paths.append(os.path.join(here, "license.json"))
    return paths


def find_license():
    for p in candidate_paths():
        if p and os.path.exists(p):
            return p
    return None


def canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def verify_license(path: str | None = None, verbose: bool = False) -> tuple:
    """返回 (ok: bool, reason: str, info: dict)。"""
    path = path or find_license()
    if not path:
        return False, "未找到授权文件 license.json", {}
    try:
        data = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        return False, f"授权文件无法解析：{e}", {}

    sig_b64 = data.pop("sig", "")
    if not sig_b64:
        return False, "授权文件缺少签名", {}
    if data.get("product") != PRODUCT:
        return False, "授权文件产品名不匹配", {}

    # 验签
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(PUB_KEY_HEX))
        pub.verify(base64.b64decode(sig_b64), canonical(data))
    except ImportError:
        if verbose:
            print("[license] 缺少 cryptography，仅做字段校验")
    except Exception:
        return False, "签名校验失败（授权文件被篡改或非官方签发）", {}

    # 机器绑定
    mid = machine_id()
    if data.get("machine_id") and data["machine_id"] != mid:
        return False, f"授权与当前机器不匹配（本机指纹 {mid[:16]}…）", {"machine_id": mid}

    # 有效期
    exp = data.get("expires_at") or ""
    try:
        exp_d = datetime.strptime(exp, "%Y-%m-%d").date()
    except Exception:
        return False, "授权有效期格式错误", {}
    if exp_d < date.today():
        return False, f"授权已于 {exp} 过期", {"expires_at": exp}

    return True, "ok", data


def require_license(role: str = "backend") -> dict:
    """校验不通过则直接退出进程；通过则返回授权信息。"""
    if os.getenv("ANOTHER_LICENSE_OK") == "1" or os.getenv("ANOTHER_SKIP_LICENSE") == "1":
        return {"mode": "trusted", "role": role}
    ok, reason, info = verify_license(verbose=True)
    if not ok:
        print("\n" + "=" * 62)
        print(f"Another · 授权校验未通过（{role}）")
        print(f"原因：{reason}")
        print(f"本机指纹：{machine_id()}")
        print("请把本机指纹发给授权方换取 license.json，放到：")
        print("  ~/Library/Application Support/Another/license.json")
        print("=" * 62 + "\n", flush=True)
        sys.exit(3)
    return info


if __name__ == "__main__":
    ok, reason, info = verify_license(verbose=True)
    print(json.dumps({
        "ok": ok,
        "reason": reason,
        "machine_id": machine_id(),
        "license_path": find_license(),
        "info": {k: v for k, v in info.items() if k in ("product", "machine_id", "expires_at", "edition", "note")},
    }, ensure_ascii=False, indent=2))
    sys.exit(0 if ok else 3)
