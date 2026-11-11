#!/usr/bin/env bash
# NewbimAI CADViewer Skill installer (macOS / Linux)
#
# Symlinks Skill/NewbimAI-CADViewer-Skill into the skills folder(s) your agent reads.
# After installing, no CADVIEWER_ROOT is needed: the CLI finds the project root
# by walking up from its own script path.
#
# Lightweight bundle: it only carries the Skill + the server modules the CLI imports
# (small enough for agents with a 3MB upload limit). The rest of the product - built
# interface (web/dist), server entry points (server/*.js), export pipeline - is fetched
# here from the release archive, so a fresh install ends up with the full feature set.
#
# The closed-source custom-object parser (bin/udo-cli) is NOT downloaded here:
# it ships only in the full package. Missing it degrades only `udo --coverage`.
#
# Version: bundled skill.json (injected from server/package.json at build time);
# source tree falls back to server/package.json. Skill and App share one version.
#
# Usage:
#   bash Skill/install.sh
#   bash Skill/install.sh --force
#   bash Skill/install.sh --skills-dir "$HOME/.config/opencode/skills"
#   bash Skill/install.sh --skip-components
#   COMPONENTS_URL=<zip> bash Skill/install.sh

set -euo pipefail

SKILL_NAME="NewbimAI-CADViewer-Skill"

FORCE=0
SKIP_COMPONENTS=0
SKILLS_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force|-f) FORCE=1; shift ;;
    --skip-components) SKIP_COMPONENTS=1; shift ;;
    --skills-dir) SKILLS_DIR="${2:?--skills-dir needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$SCRIPT_DIR/$SKILL_NAME"
ROOT="$(dirname "$SCRIPT_DIR")"

SKILL_JSON="$SOURCE/skill.json"
if [ ! -f "$SOURCE/SKILL.md" ]; then
  echo "[FAIL] cannot find Skill source: $SOURCE" >&2
  exit 1
fi
if [ ! -f "$ROOT/server/scanner.js" ]; then
  echo "[FAIL] missing $ROOT/server/scanner.js" >&2
  echo "       the Skill only works next to a 'server' folder (repo or lightweight bundle)" >&2
  exit 1
fi

# 权威模块清单来自 skill.json（requires.serverModules）；没有 jq/node 时用内置兜底。
OWN_MODULES=""
if [ -f "$SKILL_JSON" ] && command -v node >/dev/null 2>&1; then
  OWN_MODULES="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write((j.requires&&j.requires.serverModules||[]).join(" "))}catch(e){}' "$SKILL_JSON" 2>/dev/null || true)"
fi
if [ -z "$OWN_MODULES" ]; then
  OWN_MODULES="cadcraft.js scanner.js udo-detect.js svg-pdf.js udo-convert.js"
fi

if [ -n "$SKILLS_DIR" ]; then
  TARGETS=("$SKILLS_DIR")
else
  TARGETS=("$HOME/.config/opencode/skills")
  [ -d "$HOME/.claude" ] && TARGETS+=("$HOME/.claude/skills")
  [ -d "$HOME/.cursor" ] && TARGETS+=("$HOME/.cursor/skills")
fi

echo ""
echo "  source : $SOURCE"
echo "  root   : $ROOT"
echo ""

ok=0
skip=0
for dir in "${TARGETS[@]}"; do
  target="$dir/$SKILL_NAME"
  echo "  -> $target"
  mkdir -p "$dir"

  if [ -L "$target" ]; then
    current="$(readlink "$target")"
    if [ "$current" = "$SOURCE" ]; then
      echo "     [OK] already linked here"; ok=$((ok+1)); continue
    fi
    if [ "$FORCE" -eq 1 ]; then
      rm -f "$target"; ln -s "$SOURCE" "$target"
      echo "     [OK] repointed (was $current)"; ok=$((ok+1)); continue
    fi
    echo "     [SKIP] linked elsewhere: $current"; skip=$((skip+1)); continue
  fi

  if [ -e "$target" ]; then
    if [ "$FORCE" -eq 1 ]; then
      rm -rf "$target"; ln -s "$SOURCE" "$target"
      echo "     [OK] replaced an old copy with a link"; ok=$((ok+1)); continue
    fi
    echo "     [SKIP] exists and is not a link (old copy?) — re-run with --force"; skip=$((skip+1)); continue
  fi

  ln -s "$SOURCE" "$target"
  if [ -L "$target" ]; then
    echo "     [OK] linked"
  else
    echo "     [WARN] created a copy (symlinks blocked on this filesystem)"
  fi
  ok=$((ok+1))
done

# 有的环境（Windows 上的 Git Bash、某些无符号链接权限的文件系统）会把 ln -s 变成复制。
# 复制出来的 Skill 无法通过“向上找 server/”定位项目根，必须提醒，否则 CLI 会报找不到根。
copies=0
for dir in "${TARGETS[@]}"; do
  if [ ! -L "$dir/$SKILL_NAME" ]; then copies=$((copies+1)); fi
done
if [ "$copies" -gt 0 ]; then
  echo "  [WARN] $copies target(s) are copies, not symlinks (this filesystem/policy blocks symlinks)."
  echo "         A copy cannot find server/ by walking up. On Windows use instead:"
  echo "         powershell -ExecutionPolicy Bypass -File Skill\\install.ps1"
fi

# ---- cadcraft（DWG 转换器）：一次性装好；装好后只有打开 DWG 时才会被调用 ----
CADCRAFT_VER="0.8.0"
# ⚠️ set -euo pipefail 下，find 一个不存在的目录会返回 1 并直接终止脚本，
#    所以先判目录、再兜底 true（这是之前 install.sh 在全新目录上必崩的原因）。
cli=""
if [ -d "$ROOT/bin/cadcraft" ]; then
  cli="$(find "$ROOT/bin/cadcraft" -name 'cadcraft-cli*' 2>/dev/null | head -1 || true)"
fi
if [ -n "$cli" ]; then
  echo "  cadcraft: already installed"
  # 顺手清掉旧的 GUI 主程序（见下方解压后的说明）
  find "$ROOT/bin/cadcraft" -name 'cadcraft.exe' -type f -delete 2>/dev/null || true
elif [ -n "${SKIP_CADCRAFT:-}" ]; then
  echo "  cadcraft: skipped (SKIP_CADCRAFT=1)"
else
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) asset="cadcraft-$CADCRAFT_VER-windows-x64-portable.zip" ;;
    Darwin)               asset="cadcraft-cli-$CADCRAFT_VER-macos-universal.zip" ;;
    *)                    asset="" ;;
  esac
  if [ -z "$asset" ]; then
    echo "  cadcraft: no official Linux build - install manually (see Skill/README.md)"
  else
    url="https://github.com/storytold/cadcraft/releases/download/v$CADCRAFT_VER/$asset"
    tmp="${TMPDIR:-/tmp}/$asset"
    echo "  cadcraft: downloading $asset (~57MB)..."
    if curl -fL --retry 2 -o "$tmp" "$url"; then
      mkdir -p "$ROOT/bin/cadcraft"
      if command -v unzip >/dev/null 2>&1; then
        unzip -qo "$tmp" -d "$ROOT/bin/cadcraft"
      else
        tar -xf "$tmp" -C "$ROOT/bin/cadcraft"
      fi
      rm -f "$tmp"
      # 便携包里的 cadcraft.exe 是 EGUI 桌面主程序（约 75MB），CLI 链路从不调用它。
      # 只留 cadcraft-cli：安装体积从 ~128MB 降到 ~53MB。
      find "$ROOT/bin/cadcraft" -name 'cadcraft.exe' -type f -delete 2>/dev/null || true
      if [ -n "$(find "$ROOT/bin/cadcraft" -name 'cadcraft-cli*' 2>/dev/null | head -1)" ]; then
        echo "  cadcraft: installed"
      else
        echo "  cadcraft: [WARN] extracted but cli not found"
      fi
    else
      echo "  cadcraft: [WARN] download failed - install manually: $url"
    fi
  fi
fi

if [ -x "$ROOT/bin/udo-cli/udo-cli" ] || [ -f "$ROOT/bin/udo-cli/udo-cli.exe" ]; then
  echo "  udo-cli: present (custom objects: walls / openings / text / dimensions)"
else
  echo "  udo-cli: not found - custom-object parsing disabled (ships with the full package)"
  echo "           everything else (stats / compare / export) still works"
fi

echo ""
echo "  $ok linked, $skip skipped"

# ---- components（界面 + 服务端入口 + 导出链路）----
# 小包里只有 CLI 真正 import 的模块；这里把 web/dist 与 server/*.js 补回来，
# 补完就是完整功能。下载失败只告警（统计 / JSON / DXF 导出不依赖它们）。
need_components=0
[ -f "$ROOT/server/index.js" ] || need_components=1
[ -f "$ROOT/web/dist/index.html" ] || need_components=1

if [ "$need_components" -eq 0 ]; then
  echo "  components: already present (interface + server)"
elif [ "$SKIP_COMPONENTS" -eq 1 ]; then
  echo "  components: skipped - open/serve/compare will not work"
else
  # 版本：优先包内 skill.json（构建时从 server/package.json 注入），源码树回退 package.json
  REF="main"
  V=""
  if [ -f "$SKILL_JSON" ] && command -v node >/dev/null 2>&1; then
    V="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write(j.version||"")}catch(e){}' "$SKILL_JSON" 2>/dev/null || true)"
  fi
  if [ -z "$V" ] && [ -f "$ROOT/server/package.json" ]; then
    V="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/server/package.json" | head -1)"
  fi
  if [ -n "$V" ]; then REF="v$V"; fi
  if [ "$REF" = "main" ]; then
    echo "  components: [WARN] no skill.json/server package version - falling back to 'main'"
    echo "              the downloaded server may not match this bundle's CLI"
  fi

  if [ -n "${COMPONENTS_URL:-}" ]; then
    URLS=("$COMPONENTS_URL")
  else
    URLS=()
    if [ "$REF" != "main" ]; then
      URLS+=("https://github.com/NewbimAI/NewbimAI-CADViewer/archive/refs/tags/$REF.zip")
      URLS+=("https://codeload.github.com/NewbimAI/NewbimAI-CADViewer/zip/refs/tags/$REF")
    fi
    URLS+=("https://github.com/NewbimAI/NewbimAI-CADViewer/archive/refs/heads/main.zip")
    URLS+=("https://codeload.github.com/NewbimAI/NewbimAI-CADViewer/zip/refs/heads/main")
  fi

  TMP_BASE="${TMPDIR:-/tmp}"
  TMP_ZIP="$TMP_BASE/NewbimAI-CADViewer-components-$REF.zip"
  TMP_DIR="$TMP_BASE/NewbimAI-CADViewer-components-$$"
  SRC_DIR=""

  for url in "${URLS[@]}"; do
    echo "  components: downloading interface + server (~18MB)..."
    echo "              $url"
    rm -f "$TMP_ZIP"
    if ! curl -fL --retry 2 --max-time 900 -s -o "$TMP_ZIP" "$url"; then
      echo "              failed: download error"
      continue
    fi
    if [ ! -s "$TMP_ZIP" ]; then
      echo "              failed: empty download"
      continue
    fi
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"
    if command -v unzip >/dev/null 2>&1; then
      unzip -qo "$TMP_ZIP" -d "$TMP_DIR" || { echo "              failed: unzip"; continue; }
    else
      tar -xf "$TMP_ZIP" -C "$TMP_DIR" || { echo "              failed: tar"; continue; }
    fi
    candidate=""
    for d in "$TMP_DIR"/*/; do
      if [ -d "$d" ]; then candidate="${d%/}"; break; fi
    done
    if [ -z "$candidate" ] || [ ! -f "$candidate/server/index.js" ]; then
      echo "              failed: archive layout unexpected"
      continue
    fi
    SRC_DIR="$candidate"
    break
  done

  if [ -z "$SRC_DIR" ]; then
    echo "  components: [WARN] download failed - open/serve/compare unavailable for now"
    echo "              statistics, JSON and DXF export still work."
    echo "              retry later, or pass COMPONENTS_URL=<zip>"
  else
    mkdir -p "$ROOT/server"
    # 包里自带的模块是本包版本的权威副本，不被归档覆盖；其余 *.js 补齐。
    # 权威副本清单来自 skill.json 的 requires.serverModules（OWN_MODULES）。
    for f in "$SRC_DIR"/server/*.js; do
      [ -f "$f" ] || continue
      name="$(basename "$f")"
      skip_file=0
      for own in $OWN_MODULES; do
        if [ "$name" = "$own" ]; then skip_file=1; break; fi
      done
      if [ "$skip_file" -eq 1 ]; then continue; fi
      cp -f "$f" "$ROOT/server/$name"
    done
    for name in package.json package-lock.json start.bat; do
      if [ -f "$SRC_DIR/server/$name" ] && [ ! -f "$ROOT/server/$name" ]; then
        cp -f "$SRC_DIR/server/$name" "$ROOT/server/$name"
      fi
    done
    if [ -f "$SRC_DIR/web/dist/index.html" ]; then
      mkdir -p "$ROOT/web/dist"
      cp -Rf "$SRC_DIR/web/dist/." "$ROOT/web/dist/"
    fi
    if [ -f "$ROOT/web/dist/index.html" ] && [ -f "$ROOT/server/index.js" ]; then
      echo "  components: installed (interface + server)"
    else
      echo "  components: [WARN] incomplete after copy"
    fi
  fi

  rm -f "$TMP_ZIP"
  rm -rf "$TMP_DIR"
fi

# 装完直接自检（只读本地文件，不碰任何图纸）
# ⚠️ 不要用 `... | grep -o ... | head -1` 取字段：pipefail 下 head 提前退出会让
#    grep 拿到 SIGPIPE，整条命令返回非 0，set -e 直接把脚本杀掉（表现为“装完了但没输出”）。
CLI="$SOURCE/scripts/cad.mjs"
if [ -f "$CLI" ] && command -v node >/dev/null 2>&1; then
  doctor_out="${TMPDIR:-/tmp}/cadviewer-doctor-$$.json"
  if node "$CLI" doctor >"$doctor_out" 2>/dev/null; then
    # doctor 输出是多行 pretty JSON，用 node 取字段（别用 sed/grep 跨行匹配）
    info="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=j.versions||{};process.stdout.write((v.skillVersion||"?")+" / "+(v.appVersion||"?")+"|"+(j.degraded||[]).join(", "))}catch(e){}})' <"$doctor_out" 2>/dev/null || true)"
    ver="${info%%|*}"
    deg="${info#*|}"
    echo "  versions: skill ${ver} (same source as app; server/package.json)"
    if grep -q '"ok": true' "$doctor_out"; then
      echo "  doctor: ok${deg:+ (degraded: $deg)}"
    else
      echo "  doctor: NOT ok - run manually: node \"$CLI\" doctor"
    fi
  else
    echo "  doctor: NOT ok - run manually: node \"$CLI\" doctor"
  fi
  rm -f "$doctor_out"
fi

echo ""
echo "Nothing else to do. Do NOT verify with a drawing; do NOT run npm install / vite build."
echo "The local service starts on demand only (open / serve / compare)."
echo "Custom-object parsing (udo --coverage) needs bin/udo-cli, which ships in the full package."
echo ""

if [ "$skip" -gt 0 ] && [ "$ok" -eq 0 ]; then exit 2; fi
exit 0
