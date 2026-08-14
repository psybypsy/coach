// ── 極簡 Markdown → HTML（** 粗體、* 斜體、## 標題、- / • 條列、1. 數字條列、縮排巢狀條列）──
// 教練後台的客戶交付版與學員版報告共用，確保兩邊排版一致。

// 報告裡凡是「」『』“” 括起來的都是學員自己寫的原句，AI 只是引用。把整段（含括號）
// 標成 .cv-q（金色），讀者一眼就分得出哪些字是自己的、哪些是分析——面向標題那類
// ** 粗體 ** 是深藍，配色見 coachVizCss。
// 在跳脫與 **／* 之後才跑：此時字串裡只剩我們自己插入的 <strong>/<em>，不會誤傷標籤。
//
// 只標 6 個字以上的：AI 自己拿引號當強調時幾乎都是兩三個字（「流動」「卡住」），
// 那些不是學員說過的話，標了反而讓真正的原話變得不顯眼。門檻與後端信件的
// _member_quotes 一致，兩邊對「原話」的認定才是同一套。
const MIN_QUOTE_LEN = 6
function markQuotes(s: string): string {
  const wrap = (m: string, inner: string) =>
    inner.length >= MIN_QUOTE_LEN ? `<span class="cv-q">${m}</span>` : m
  return s
    .replace(/「([^」]*)」/g, wrap)
    .replace(/『([^』]*)』/g, wrap)
    .replace(/“([^”]*)”/g, wrap)
}

export function mdToHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    markQuotes(
      esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, '<em>$1</em>'),
    )
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
