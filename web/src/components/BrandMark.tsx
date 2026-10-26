/**
 * NewbimAI 品牌标记（像素「N」）。
 *
 * 由设计师的 256px 导出（E:\NewbimAI\icons-xin\newbimai-mark-on-light-256.png）
 * 按**连通域**逐个方块还原成矢量矩形：位置/尺寸与原图一一对应，
 * 明暗层次用 currentColor + opacity 表达，因此在浅底/深底都能跟随文字色。
 *
 * ⚠️ 几何数据是自动追踪出来的，改形状请改源 PNG 后重跑 scripts/make-icon.mjs 的追踪逻辑。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 151 160"
      className={className}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="NewbimAI"
    >
      <rect x="33" y="0" width="29" height="28" />
      <rect x="66" y="0" width="29" height="28" />
      <rect x="99" y="0" width="29" height="28" opacity="0.9" />
      <rect x="0" y="33" width="28" height="28" />
      <rect x="33" y="33" width="29" height="28" />
      <rect x="99" y="33" width="29" height="28" opacity="0.9" />
      <rect x="143" y="61" width="7" height="6" opacity="0.8" />
      <rect x="0" y="66" width="28" height="28" />
      <rect x="99" y="66" width="29" height="28" opacity="0.9" />
      <rect x="135" y="80" width="9" height="9" opacity="0.9" />
      <rect x="147" y="91" width="4" height="3" opacity="0.7" />
      <rect x="0" y="99" width="28" height="28" opacity="0.9" />
      <rect x="99" y="99" width="13" height="12" opacity="0.8" />
      <rect x="115" y="99" width="13" height="12" opacity="0.8" />
      <rect x="137" y="101" width="6" height="6" opacity="0.8" />
      <rect x="99" y="115" width="13" height="12" opacity="0.8" />
      <rect x="115" y="115" width="13" height="12" opacity="0.7" />
      <rect x="0" y="132" width="28" height="28" opacity="0.9" />
      <rect x="99" y="132" width="8" height="8" opacity="0.7" />
      <rect x="109" y="132" width="8" height="8" opacity="0.7" />
      <rect x="119" y="132" width="8" height="8" opacity="0.7" />
      <rect x="99" y="142" width="8" height="8" opacity="0.7" />
      <rect x="109" y="142" width="8" height="8" opacity="0.7" />
      <rect x="119" y="142" width="8" height="8" opacity="0.6" />
      <rect x="99" y="151" width="8" height="8" opacity="0.6" />
      <rect x="109" y="151" width="8" height="8" opacity="0.6" />
      <rect x="119" y="151" width="8" height="8" opacity="0.6" />
    </svg>
  );
}

export default BrandMark;
