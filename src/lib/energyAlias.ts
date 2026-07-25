// 匿名發布用的「能量代號」：用自然環境形容詞 + 名詞隨機組合，
// 例如「寧靜的森林」「Golden Breeze」，讓其他成員看不到真實姓名。

const ADJECTIVES_ZH = [
  '寧靜的', '溫柔的', '沉穩的', '清澈的', '自由的', '溫暖的',
  '堅定的', '悠然的', '明亮的', '深邃的', '輕盈的', '踏實的',
]
const NOUNS_ZH = [
  '森林', '海浪', '山谷', '溪流', '清風', '晨光',
  '月光', '星野', '雲海', '沙丘', '花田', '潮汐',
]

const ADJECTIVES_EN = [
  'Quiet', 'Gentle', 'Steady', 'Clear', 'Free', 'Warm',
  'Bright', 'Calm', 'Deep', 'Wild', 'Soft', 'Golden',
]
const NOUNS_EN = [
  'Forest', 'Wave', 'Valley', 'Stream', 'Breeze', 'Dawn',
  'Moonlight', 'Starfield', 'Cloudsea', 'Dune', 'Meadow', 'Tide',
]

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

export function generateEnergyAlias(language: string): string {
  if (language === 'en') {
    return `${pick(ADJECTIVES_EN)} ${pick(NOUNS_EN)}`
  }
  return `${pick(ADJECTIVES_ZH)}${pick(NOUNS_ZH)}`
}
