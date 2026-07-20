import { useLanguage } from '../lib/i18n/context'
import { LANGUAGE_OPTIONS, type Language } from '../lib/i18n/language'

// 精簡版切換：角落的語言下拉選單。
export function LanguageSwitcherCompact({ className = '' }: { className?: string }) {
  const { language, setLanguage, t } = useLanguage()

  return (
    <select
      aria-label={t('語言')}
      value={language}
      onChange={(e) => setLanguage(e.target.value as Language)}
      className={`rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold text-foreground ${className}`}
    >
      {LANGUAGE_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}
