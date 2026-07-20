// 翻譯字典彙總。每個命名空間檔案（./dict/*.ts）各自維護一批「原文（繁中）→ 英文」，
// 這裡合併成單一查表供 t() 使用。key 一律是畫面上實際出現過的繁中原文字串。
import { common } from './dict/common'
import { login } from './dict/login'
import { perma } from './dict/perma'

export type Translation = { en: string }
export type Dictionary = Record<string, Translation>

export const DICTIONARY: Dictionary = {
  ...common,
  ...login,
  ...perma,
}
