// 全站語言設定（只有繁中／英文兩種，跟 MindGym 不同不需要簡中）。
export type Language = 'zh-TW' | 'en'

const KEY = 'coach_language'

export const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
]

const HTML_LANG: Record<Language, string> = {
  'zh-TW': 'zh-Hant-TW',
  en: 'en',
}

export function getLanguage(): Language {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'zh-TW' || v === 'en') return v
  } catch {
    // localStorage 不可用時退回預設
  }
  // 預設英文；使用者可切換成繁中，切換後會記在 localStorage。
  return 'en'
}

export function persistLanguage(lang: Language): void {
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    // 忽略寫入失敗（隱私模式等）
  }
  applyHtmlLang(lang)
}

export function applyHtmlLang(lang: Language): void {
  document.documentElement.lang = HTML_LANG[lang]
}
