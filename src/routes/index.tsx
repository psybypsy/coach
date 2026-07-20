import { createFileRoute } from '@tanstack/react-router'
import { DIMENSION_ORDER, DIMENSION_CONFIGS } from '../lib/perma'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <div className="bg-page min-h-screen flex flex-col items-center px-6 py-12">
      <h1 className="font-heading text-3xl text-foreground mb-2">PERMA 書寫</h1>
      <p className="text-foreground-soft mb-8">腳手架已就緒，接下來從這裡開始接上登入與書寫頁。</p>
      <div className="grid gap-4 w-full max-w-md">
        {DIMENSION_ORDER.map((key) => {
          const dim = DIMENSION_CONFIGS[key]
          return (
            <div
              key={key}
              className={`rounded-3xl border ${dim.borderLight} ${dim.bgLight} p-5 shadow-soft`}
            >
              <div className={`font-heading text-sm ${dim.textColor} mb-1`}>
                {dim.label} · {dim.sublabel}
              </div>
              <div className="text-foreground text-sm">{dim.question}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
