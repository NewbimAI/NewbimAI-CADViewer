#!/usr/bin/env python3
"""
把字体整理成 dxf-viewer 能正确渲染的形态。

为什么需要（见 THIRD-PARTY.md「字体」一节）：
  1. opentype.js 不支持可变轴，变体字体只会渲染默认实例（Noto 默认是 ExtraLight，太细）
     → 必须先用 fonttools 在目标字重处实例化。
  2. dxf-viewer 用 earcut 三角化字形，靠 nonzero 规则的字形一旦有自交/重叠笔画，
     会被填成**实心块**（实测 Noto Serif SC 的 `7` 就是这样）
     → 必须用 skia-pathops 做并集，把重叠轮廓消掉。

用法：
  python scripts/normalize-font.py in.ttf out.ttf
  python scripts/normalize-font.py in.ttf out.ttf --weight 400
  python scripts/normalize-font.py in.ttf out.ttf --sample 200     # 只处理前 200 个字形（试跑）
  python scripts/normalize-font.py in.ttf out.ttf --skip-pathops    # 只做实例化

依赖：fonttools、skia-pathops（pip install fonttools skia-pathops）
"""
import argparse
import sys
import time

from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen


def instantiate(font, weight):
    from fontTools.varLib.instancer import instantiateVariableFont

    if "fvar" not in font:
        return False
    axes = {a.axisTag for a in font["fvar"].axes}
    if "wght" not in axes:
        raise SystemExit("字体是可变字体，但没有 wght 轴，请手动指定要保留的轴")
    instantiateVariableFont(font, {"wght": weight}, inplace=True)
    return True


def dedupe_overlaps(font, sample=None):
    """对每个字形做 self-union，消除自交/重叠轮廓。返回 (处理数, 跳过数)。"""
    from pathops import Path, PathOp, op

    glyph_set = font.getGlyphSet()
    glyf = font["glyf"]
    hmtx = font["hmtx"]
    names = list(font.getGlyphOrder())
    if sample:
        names = names[:sample]

    done = 0
    skipped = 0
    for name in names:
        try:
            glyph = glyph_set[name]
            rec = DecomposingRecordingPen(glyph_set)
            glyph.draw(rec)
            if not rec.value:
                skipped += 1
                continue

            path = Path()
            rec.replay(path.getPen())
            # 自并集：把重叠/自交轮廓合并成不重叠的外轮廓（nonzero → 单一轮廓）
            merged = op(path, path, PathOp.UNION)

            pen = TTGlyphPen(glyph_set)
            merged.draw(pen)
            new_glyph = pen.glyph()
            glyf[name] = new_glyph
            done += 1
        except Exception as e:  # 单个字形失败不影响整体
            skipped += 1
            print(f"  [WARN] {name}: {e}", file=sys.stderr)

    # 统一重算包围盒；hmtx 的 lsb 跟着 xMin 走（advance 不动）
    for name in names:
        try:
            g = glyf[name]
            g.recalcBounds(glyf)
            advance, _lsb = hmtx[name]
            x_min = getattr(g, "xMin", 0) if getattr(g, "numberOfContours", 0) else 0
            hmtx[name] = (advance, x_min)
        except Exception:
            pass
    return done, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--weight", type=int, default=400)
    ap.add_argument("--sample", type=int, default=None)
    ap.add_argument("--skip-pathops", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    font = TTFont(args.src, recalcBBoxes=False, recalcTimestamp=False)

    if instantiate(font, args.weight):
        print(f"实例化 wght={args.weight} 完成")
    else:
        print("静态字体，跳过实例化")

    if args.skip_pathops:
        print("按参数跳过去重叠")
    else:
        done, skipped = dedupe_overlaps(font, args.sample)
        print(f"去重叠：处理 {done} 个字形，跳过 {skipped} 个")

    font.save(args.dst)
    print(f"已写出 {args.dst}（{time.time() - t0:.1f}s）")


if __name__ == "__main__":
    main()
