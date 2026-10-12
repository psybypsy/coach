// ── 報告 PDF 匯出（教練客戶交付版 ↔ 學員版報告共用）──
// 從 app.coach.member.$id.tsx 抽出，兩邊產出的 PDF 才會一致。
import html2pdf from 'html2pdf.js'

// 先把 SVG 轉成 PNG 再交給 html2canvas。
// html2canvas 對 SVG 的支援在各瀏覽器差異很大，直接交給它常會畫出空白圖表。
export async function rasterizeExportSvgs(root: HTMLElement) {
  const svgs = [...root.querySelectorAll('svg')] as SVGSVGElement[]
  await Promise.all(
    svgs.map(
      (svg) =>
        new Promise<void>((resolve) => {
          const rect = svg.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) {
            resolve()
            return
          }
          const source = new XMLSerializer().serializeToString(svg)
          const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }))
          const image = new Image()
          image.onload = () => {
            const scale = 2
            const canvas = document.createElement('canvas')
            canvas.width = Math.ceil(rect.width * scale)
            canvas.height = Math.ceil(rect.height * scale)
            const ctx = canvas.getContext('2d')
            if (ctx) {
              ctx.scale(scale, scale)
              ctx.drawImage(image, 0, 0, rect.width, rect.height)
              const replacement = document.createElement('img')
              replacement.src = canvas.toDataURL('image/png')
              replacement.alt = ''
              replacement.style.display = 'block'
              replacement.style.width = `${rect.width}px`
              replacement.style.height = `${rect.height}px`
              replacement.style.maxWidth = '100%'
              replacement.style.margin = getComputedStyle(svg).margin
              svg.replaceWith(replacement)
            }
            URL.revokeObjectURL(url)
            resolve()
          }
          image.onerror = () => {
            URL.revokeObjectURL(url)
            resolve() // 保留原 SVG，讓 html2canvas 作為後備處理
          }
          image.src = url
        }),
    ),
  )
}

// 用固定桌面版寬度的離屏副本輸出，不改動使用者正在看的畫面。
// filename 請用純 ASCII，避免檔名特殊字元讓下載失效。
export async function downloadReportPdf(source: HTMLElement, filename: string) {
  await renderReportPdf(source, filename, 'save')
}

// 同一份排版，但不下載、回傳 PDF 內容——給「寄給學員」當附件用。
// 圖片改用 JPEG：PNG 版動輒十幾 MB，超過信件附件能安全寄送的大小。
export async function reportPdfBlob(source: HTMLElement): Promise<Blob> {
  return renderReportPdf(source, 'report.pdf', 'blob')
}

async function renderReportPdf(source: HTMLElement, filename: string, output: 'save'): Promise<void>
async function renderReportPdf(source: HTMLElement, filename: string, output: 'blob'): Promise<Blob>
async function renderReportPdf(
  source: HTMLElement,
  filename: string,
  output: 'save' | 'blob',
): Promise<void | Blob> {
  const exportRoot = source.cloneNode(true) as HTMLElement
  exportRoot.removeAttribute('id')
  exportRoot.classList.add('cv-pdf-export')
  // 定位放在外層 host，而不是 exportRoot 本身；html2pdf 再複製 exportRoot 時才不會
  // 把 left:-100000px 一起複製進 PDF 畫布。
  const exportHost = document.createElement('div')
  exportHost.style.cssText = 'position:fixed;left:-100000px;top:0;width:720px;z-index:-1'
  exportHost.appendChild(exportRoot)
  document.body.appendChild(exportHost)

  try {
    // 等字型完成後再量尺寸，避免中文字型替換造成換行點在匯出途中改變。
    await document.fonts?.ready
    await rasterizeExportSvgs(exportRoot)

    const worker = html2pdf()
      .set({
        margin: [12, 12, 14, 12],
        filename,
        image: output === 'blob' ? { type: 'jpeg', quality: 0.92 } : { type: 'png', quality: 1 },
        // width/windowWidth 同時固定 html2pdf 容器與 media query 的計算，手機與桌面輸出一致。
        width: 720,
        windowWidth: 720,
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          logging: false,
          foreignObjectRendering: false,
          windowWidth: 720,
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: [
            '.cv-doc-head',
            '.cv-doc h2',
            '.cv-doc h3',
            '.cv-doc p',
            '.cv-doc li',
            '.cv-doc-sign',
            '.cv-doc-chart',
            '.cv-rdelta',
            '.cv-stats',
            '.cv-wcloud',
          ],
        },
      })
      .from(exportRoot)
    if (output === 'blob') return await worker.outputPdf('blob')
    await worker.save()
  } finally {
    exportHost.remove()
  }
}
