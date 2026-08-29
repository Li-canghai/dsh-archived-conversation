#!/bin/sh
#
# sync-from-dev.sh — 把 dsh-archived-conversation 的开发目录(源码)
# 单向同步到本公开发布仓库的工作区(只更新文件,不 git commit / 不 push)。
#
# 设计原则:
#   - 显式白名单:只同步插件源码该有的文件,绝不碰 .git / .github / .gitignore。
#   - 目录镜像:lib/ 和 tests/ 采用"复制源有而目标无的文件 + 删除目标有而源无的文件",
#     因此开发侧删除文件也会在发布侧删除(保持奇偶一致)。
#   - 幂等:重复运行结果一致;源与目标内容已一致时不会产生改动。
#   - POSIX sh 兼容(可经 /bin/sh=dash 运行,无需 bash)。
#
# 用法:
#   ./sync-from-dev.sh            # 用默认开发目录同步
#   SRC=/path/to/dev ./sync-from-dev.sh   # 覆盖源目录

set -eu

# 目标 = 本脚本所在目录(即公开发布仓库根)
DST=$(cd "$(dirname "$0")" && pwd)

# 源 = 开发目录(可被环境变量覆盖)
SRC="${SRC:-/home/canghai/Project/DSH/Plugins/dsh-archived-conversation}"

# 显式白名单:只同步这些文件/目录(空格分隔)
ALLOWLIST="lib tests package.json README.md README.zh-CN.md LICENSE cordis.patch.yml"

# 受保护、绝不触碰的条目(仅作安全断言)
PROTECTED=".git .github .gitignore"

if [ ! -d "$SRC" ]; then
  echo "[sync] ERROR: 源目录不存在: $SRC" >&2
  exit 1
fi

echo "[sync] 源(dev):  $SRC"
echo "[sync] 目标(发布): $DST"

sync_tree() {
  name="$1"
  s="$SRC/$name"
  d="$DST/$name"

  if [ -d "$s" ]; then
    # 1) 复制源树中所有文件到目标(覆盖);find 输出相对路径 ./xxx
    ( cd "$s" && find . -type f ) | while read -r f; do
      mkdir -p "$d/$(dirname "$f")"
      cp -f "$s/$f" "$d/$f"
    done
    # 2) 删除目标中存在、但源中已不存在的文件(镜像删除)
    if [ -d "$d" ]; then
      ( cd "$d" && find . -type f ) | while read -r f; do
        if [ ! -f "$s/$f" ]; then
          rm -f "$d/$f"
          echo "  - 删除目标多余文件: $name/$f"
        fi
      done
    fi
  elif [ -f "$s" ]; then
    cp -f "$s" "$d"
  else
    echo "  ! 跳过:源中缺失 $name" >&2
  fi
}

for entry in $ALLOWLIST; do
  # 安全断言:白名单不得命中受保护条目
  for p in $PROTECTED; do
    if [ "$entry" = "$p" ]; then
      echo "[sync] ERROR: 白名单误包含受保护条目 $p,已中止" >&2
      exit 1
    fi
  done
  sync_tree "$entry"
done

echo "[sync] 完成。"
echo "[sync] 未触碰 .git / .github / .gitignore(发布仓库自身配置)。"
