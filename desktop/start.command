#!/bin/bash
# 双击启动科研学术本体工作台（桌面端）
# 首次使用如提示"无法打开"，右键 → 打开 即可
cd "$(dirname "$0")" || exit 1
# 定位 Node（优先 node@22，其次 PATH 中的 node）
if [ -x "/opt/homebrew/opt/node@22/bin/node" ]; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
elif ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node，请先安装 Node.js 22 或以上版本。"
  read -n 1 -s -r -p "按任意键关闭..."
  exit 1
fi
if [ ! -d node_modules/electron ]; then
  echo "首次运行，正在安装 Electron（约 300MB，需数分钟）..."
  npm install --registry=https://registry.npmmirror.com --no-audit --no-fund || {
    echo "依赖安装失败，请检查网络后重试。"
    read -n 1 -s -r -p "按任意键关闭..."
    exit 1
  }
fi
exec ./node_modules/.bin/electron .
