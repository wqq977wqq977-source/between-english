#!/bin/zsh
set -eu
cd "${0:A:h}"
# Respect a Node version selected by the caller; append common Finder paths.
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

fail() {
  print -u2 -- "$1"
  if [[ -t 0 ]]; then read -r '?按回车关闭…'; fi
  exit 1
}

[[ "$(uname -s)" == Darwin ]] || fail '一键启动器仅支持 macOS。请在项目目录运行 npm ci，然后运行 npm start。'

mkdir -p work
: >> work/launcher.lock
zmodload zsh/system || fail '启动锁不可用，请重新打开启动器。'
zsystem flock -t 60 -i 0.2 -f STUDY_LAUNCH_FD work/launcher.lock || fail '网站仍在准备中，请稍后重新打开。'

STUDY_NODE="$(command -v node || true)"
[[ -n "$STUDY_NODE" ]] || fail '需要安装 Node.js 22.13 或更新版本。'
"$STUDY_NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || major === 22 && minor >= 13 ? 0 : 1)' || fail '需要 Node.js 22.13 或更新版本。'

if ! "$STUDY_NODE" --input-type=module -e 'import.meta.resolve("@mozilla/readability"); import.meta.resolve("linkedom")' >/dev/null 2>&1; then
  print '首次启动，正在准备…'
  command -v npm >/dev/null 2>&1 || fail '未找到 npm，请重新安装 Node.js。'
  npm ci --no-audit --no-fund || fail '准备失败，请检查网络后重新打开。'
fi

STUDY_LAUNCH_LOCKED=1 "$STUDY_NODE" scripts/launch.mjs "$@" || fail '启动未完成。可查看项目 data/launcher.log，或重新打开启动器。'

zsystem flock -u "$STUDY_LAUNCH_FD"
