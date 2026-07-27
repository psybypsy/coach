// ── 極簡 Markdown → HTML（** 粗體、* 斜體、## 標題、- / • 條列、1. 數字條列、縮排巢狀條列）──
// 教練後台的客戶交付版與學員版報告共用，確保兩邊排版一致。
export function mdToHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, '<em>$1</em>')
  const rawLines = String(md || '').split('\n')
  let h = ''
  // 依縮排深度堆疊巢狀 <ul>/<ol>：同層同類型接續為 <li> 手足，縮排加深則在目前 <li> 內開新子清單
  const stack: { type: 'ul' | 'ol'; indent: number }[] = []
  const closeAllLists = () => {
    while (stack.length) {
      h += '</li>'
      const f = stack.pop()!
      h += f.type === 'ul' ? '</ul>' : '</ol>'
    }
  }
  for (const raw of rawLines) {
    const l = raw.trim()
    const indent = (/^\s*/.exec(raw)?.[0] ?? '').replace(/\t/g, '  ').length
    const bullet = /^[-*•‣]\s+(.*)$/.exec(l)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(l)
    if (bullet || numbered) {
      const type: 'ul' | 'ol' = bullet ? 'ul' : 'ol'
      const content = inline((bullet ?? numbered)![1])
      while (
        stack.length &&
        (stack[stack.length - 1].indent > indent ||
          (stack[stack.length - 1].indent === indent && stack[stack.length - 1].type !== type))
      ) {
        h += '</li>'
        const f = stack.pop()!
        h += f.type === 'ul' ? '</ul>' : '</ol>'
      }
      if (stack.length && stack[stack.length - 1].indent === indent) {
        h += '</li><li>' + content
      } else {
        h += type === 'ul' ? '<ul>' : '<ol>'
        stack.push({ type, indent })
        h += '<li>' + content
      }
      continue
    }
    closeAllLists()
    const hm = l.match(/^#{1,3} /)
    if (hm) {
      const lvl = hm[0].trim().length
      h += `<h${lvl}>` + inline(l.replace(/^#+ /, '')) + `</h${lvl}>`
    } else if (l) {
      h += '<p>' + inline(l) + '</p>'
    }
  }
  closeAllLists()
  return h
}
