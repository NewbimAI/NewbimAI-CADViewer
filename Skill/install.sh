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

echo ""
echo "  $ok linked, $skip skipped"
echo ""
echo "Try it (no env vars needed):"
echo "  node \"$SOURCE/scripts/cad.mjs\" doctor"
echo "  node \"$SOURCE/scripts/cad.mjs\" summary \"<path-to-drawing>.dxf\""
echo ""
echo "DWG needs the converter (optional): https://github.com/storytold/cadcraft/releases"
echo "  unzip cadcraft-<ver>-*-portable.zip into $ROOT/bin/cadcraft/"
echo ""

if [ "$skip" -gt 0 ] && [ "$ok" -eq 0 ]; then exit 2; fi
exit 0
