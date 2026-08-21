// 把 docs/ 底下的 Markdown 轉成 Word，方便寄給不看 GitHub 的人。
// 支援這些文件實際用到的語法：H1–H3、表格、程式碼區塊、條列、引用、
// 水平線、**粗體**、`行內碼`、[連結](url)、![圖說](相對路徑.png)
//
// 用法：node scripts/md2docx.cjs docs/foo.md docs/foo.docx
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  ExternalHyperlink, LevelFormat, ImageRun,
} = require('docx');

const SRC = process.argv[2];
const OUT = process.argv[3];
if (!SRC || !OUT) { console.error('用法: node scripts/md2docx.cjs <來源.md> <輸出.docx>'); process.exit(1); }

const BODY = { name: 'Calibri', eastAsia: 'Microsoft JhengHei' };
const MONO = { name: 'Consolas', eastAsia: 'Microsoft JhengHei' };
const CONTENT_W = 9020; // A4 扣掉左右邊界的可用寬度（DXA）

function inline(text, base = {}) {
  const runs = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ ...base, text: text.slice(last, m.index) }));
    if (m[1] !== undefined) {
      runs.push(new ExternalHyperlink({ link: m[2], children: [new TextRun({ ...base, text: m[1], style: 'Hyperlink' })] }));
    } else if (m[3] !== undefined) {
      runs.push(new TextRun({ ...base, text: m[3], bold: true }));
    } else {
      runs.push(new TextRun({ ...base, text: m[4], font: MONO, shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' } }));
    }
    last = re.lastIndex;
  }
  if (last < text.length) runs.push(new TextRun({ ...base, text: text.slice(last) }));
  return runs.length ? runs : [new TextRun({ ...base, text: '' })];
}

const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function buildTable(rows) {
  const header = splitRow(rows[0]);
  const bodyRows = rows.slice(2).map(splitRow); // rows[1] 是 |---|---| 分隔列
  const n = header.length;
  const first = Math.round(CONTENT_W * (n <= 2 ? 0.42 : 0.3));
  const rest = Math.round((CONTENT_W - first) / (n - 1));
  const widths = [first, ...Array(n - 1).fill(rest)];
  widths[n - 1] = CONTENT_W - widths.slice(0, n - 1).reduce((a, b) => a + b, 0);
  const cell = (txt, i, isHeader) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    shading: isHeader ? { type: ShadingType.CLEAR, fill: 'E9EEF4' } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: inline(txt, { font: BODY, size: 19, bold: isHeader || undefined }) })],
  });
  return new Table({
    columnWidths: widths,
    width: { size: CONTENT_W, type: WidthType.DXA },
    rows: [
      new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, i, true)) }),
      ...bodyRows.map((r) => new TableRow({ children: Array.from({ length: n }, (_, i) => cell(r[i] ?? '', i, false)) })),
    ],
  });
}

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const children = [];
let i = 0;

while (i < lines.length) {
  const line = lines[i];

  if (/^```/.test(line)) { // 程式碼區塊：等寬字型 + 淺底，逐行成段（Word 沒有 \n）
    i++;
    const buf = [];
    while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
    i++;
    buf.forEach((l, idx) => children.push(new Paragraph({
      spacing: { before: idx === 0 ? 120 : 0, after: idx === buf.length - 1 ? 160 : 0, line: 240 },
      shading: { type: ShadingType.CLEAR, fill: 'F7F7F5' },
      children: [new TextRun({ text: l || ' ', font: MONO, size: 16 })],
    })));
    continue;
  }

  if (/^\|/.test(line)) {
    const buf = [];
    while (i < lines.length && /^\|/.test(lines[i])) buf.push(lines[i++]);
    if (buf.length >= 2) {
      children.push(buildTable(buf));
      children.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun('')] }));
    }
    continue;
  }

  const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
  if (img) {
    const file = path.resolve(path.dirname(SRC), img[2]);
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      const w0 = buf.readUInt32BE(16), h0 = buf.readUInt32BE(20); // PNG IHDR
      const W = 600, H = Math.round((h0 / w0) * W);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 160, after: 60 },
        children: [new ImageRun({ type: 'png', data: buf, transformation: { width: W, height: H } })],
      }));
      if (img[1]) children.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 200 },
        children: [new TextRun({ font: BODY, size: 17, color: '6A7685', text: img[1] })],
      }));
    } else {
      console.warn('  ! 找不到圖片:', file);
    }
    i++;
    continue;
  }

  const h = line.match(/^(#{1,3})\s+(.*)$/);
  if (h) {
    const lvl = h[1].length;
    children.push(new Paragraph({
      heading: lvl === 1 ? HeadingLevel.HEADING_1 : lvl === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
      spacing: { before: lvl === 1 ? 0 : lvl === 2 ? 360 : 240, after: lvl === 1 ? 200 : 120 },
      children: inline(h[2], { font: BODY, size: lvl === 1 ? 36 : lvl === 2 ? 28 : 23, bold: true, color: '1F3A5C' }),
    }));
    i++;
    continue;
  }

  if (/^---+$/.test(line)) {
    children.push(new Paragraph({
      spacing: { before: 120, after: 120 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D5DC' } },
      children: [new TextRun('')],
    }));
    i++;
    continue;
  }

  if (/^[-*]\s+/.test(line)) {
    children.push(new Paragraph({
      numbering: { reference: 'bullets', level: 0 },
      spacing: { after: 60 },
      children: inline(line.replace(/^[-*]\s+/, ''), { font: BODY, size: 21 }),
    }));
    i++;
    continue;
  }

  if (/^>\s?/.test(line)) {
    children.push(new Paragraph({
      spacing: { before: 80, after: 80 },
      indent: { left: 360 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'B5843A', space: 8 } },
      children: inline(line.replace(/^>\s?/, ''), { font: BODY, size: 20, color: '54606E' }),
    }));
    i++;
    continue;
  }

  if (!line.trim()) { i++; continue; }

  children.push(new Paragraph({ spacing: { after: 140, line: 300 }, children: inline(line, { font: BODY, size: 21 }) }));
  i++;
}

const doc = new Document({
  numbering: { config: [{ reference: 'bullets', levels: [{
    level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 460, hanging: 260 } } },
  }] }] },
  styles: { default: { document: { run: { font: BODY, size: 21 } } } },
  sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log(`已產生: ${OUT}  (${(buf.length / 1024).toFixed(1)} KB, ${children.length} 個元素)`);
});
