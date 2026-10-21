#!/usr/bin/env bash
# CADViewer Skill installer (macOS / Linux)
#
# Symlinks Skill/cadviewer into the skills folder(s) your agent reads.
# After installing, no CADVIEWER_ROOT is needed: the CLI finds the project root
# by walking up from its own script path.
#
# Usage:
#   bash Skill/install.sh
#   bash Skill/install.sh --force
#   bash Skill/install.sh --skills-dir "$HOME/.config/opencode/skills"

set -euo pipefail

FORCE=0
SKILLS_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force|-f) FORCE=1; shift ;;
    --skills-dir) SKILLS_DIR="${2:?--skills-dir needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$SCRIPT_DIR/cadviewer"
ROOT="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$SOURCE/SKILL.md" ]; then
  echo "[FAIL] cannot find Skill source: $SOURCE" >&2
  exit 1
fi
if [ ! -f "$ROOT/server/scanner.js" ]; then
  echo "[FAIL] missing $ROOT/server/scanner.js" >&2
  echo "       the Skill only works next to a 'server' folder (repo or lightweight bundle)" >&2
  exit 1
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
  target="$dir/cadviewer"
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
  echo "     [OK] linked"; ok=$((ok+1))
done

# ---- cadcraft（DWG 转换器）：一次性装好；装好后只有打开 DWG 时才会被调用 ----
CADCRAFT_VER="0.8.0"
cli="$(find "$ROOT/bin/cadcraft" -name 'cadcraft-cli*' 2>/dev/null | head -1)"
if [ -n "$cli" ]; then
  echo "  cadcraft: already installed"
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

echo ""
echo "  $ok linked, $skip skipped"

# 装完直接自检（只读本地文件，不碰任何图纸）
CLI="$SOURCE/scripts/cad.mjs"
if [ -f "$CLI" ] && command -v node >/dev/null 2>&1; then
  out="$(node "$CLI" doctor 2>/dev/null || true)"
  if printf '%s' "$out" | grep -q '"ok": true'; then
    deg="$(printf '%s' "$out" | grep -o '"degraded": \[[^]]*\]' | head -1)"
    echo "  doctor: ok ${deg:+($deg)}"
  else
    echo "  doctor: NOT ok - run manually: node \"$CLI\" doctor"
  fi
fi

echo ""
echo "Nothing else to do. Do NOT verify with a drawing; do NOT run npm install / vite build."
echo "The local service starts on demand only (open / serve)."
echo ""

if [ "$skip" -gt 0 ] && [ "$ok" -eq 0 ]; then exit 2; fi
exit 0
