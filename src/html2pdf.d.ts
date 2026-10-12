// html2pdf.js 沒有官方 TypeScript 型別，最小宣告讓 tsc 通過。
declare module 'html2pdf.js' {
  const html2pdf: () => {
    set: (opt: Record<string, unknown>) => {
      from: (el: HTMLElement) => { save: () => Promise<void>; outputPdf: (type: 'blob') => Promise<Blob> }
    }
  }
  export default html2pdf
}
