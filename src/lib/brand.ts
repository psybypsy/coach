// ── 品牌設定（集中管理，避免各頁面各自寫死不一致）──
// 主品牌為 Ipsen Taiwan；Tan Yee Ming Coach 為輔（教練署名）。
// 網頁上不再出現任何 PSYbyPSY 字樣。
export const BRAND = {
  name: 'Ipsen Taiwan',
  tagline: '職場幸福感書寫', // 英文由 i18n dict 對應
  coachEn: 'Tan Yee Ming Coach',
  coachZh: '陳郁敏 教練',
} as const

// 依語言回傳教練署名。
export function coachName(language: 'zh-TW' | 'en'): string {
  return language === 'en' ? BRAND.coachEn : BRAND.coachZh
}
