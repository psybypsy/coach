// coachViz 產出的 HTML 片段用的樣式（cv-* 命名空間，避免與 Tailwind 衝突）。
// 教練後台與學員版報告共用，兩邊排版才會一致。
export const COACH_VIZ_CSS = `
.cv-slbl{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:11px;font-weight:800;color:#8993A1;letter-spacing:.09em;text-transform:uppercase;margin:22px 0 9px;padding-bottom:6px;border-bottom:1.5px solid #E2E5EA}
.cv-slbl>span{flex:1}
.cv-inc{font-size:11px;font-weight:700;color:#54606E;text-transform:none;letter-spacing:0;display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;white-space:nowrap}
.cv-inc input{width:14px;height:14px;accent-color:#1F3A5C;cursor:pointer;margin:0}
.cv-chart-wrap{overflow-x:auto;padding:4px 0}
.cv-chart-wrap svg{max-width:none;height:auto}
.cv-topic-wrap svg{display:block;max-width:100%;height:auto}
/* 雷達圖置中：Tailwind preflight 把所有 svg 設成 display:block（非預設的 inline），
   所以父層的 text-align:center 完全沒有作用——這才是一直沒置中的真正原因。
   block 元素本來就該用 margin:auto 置中，不需要 flex 或其他花招。 */
.cv-radar-wrap svg{margin:0 auto}
.cv-legend{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 2px;font-size:11.5px;font-weight:700;line-height:1.35}
.cv-legend-item-svg{display:block;flex:none;height:18px;overflow:visible}
.cv-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:6px 0}
@media(max-width:620px){.cv-stats{grid-template-columns:repeat(2,1fr)}}
.cv-stat{background:#fff;border:1.5px solid #E2E5EA;border-radius:9px;padding:14px 12px}
.cv-stat-n{font-size:21px;font-weight:800;color:#1C2530;font-variant-numeric:tabular-nums;line-height:1.1}
.cv-stat-n small{font-size:11px;color:#8993A1;font-weight:700}
.cv-stat-l{font-size:10.5px;color:#8993A1;margin-top:5px}
.cv-rdelta{border:1.5px solid #E2E5EA;border-radius:10px;margin-top:8px;overflow:hidden}
.cv-rdelta-row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #E2E5EA;font-size:12.5px}
.cv-rdelta-row:last-child{border-bottom:none}
.cv-rdelta-key{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;line-height:1;text-align:center;flex-shrink:0;font-family:Arial,-apple-system,'PingFang TC','Noto Sans TC',sans-serif}
.cv-rdelta-name{font-weight:700;flex:1}
.cv-rdelta-val{font-variant-numeric:tabular-nums;color:#54606E;font-weight:600;white-space:nowrap}
.cv-rdelta-tag-svg{width:82px;height:26px;display:block;flex:0 0 82px;overflow:visible}
.cv-wcloud{display:flex;flex-wrap:wrap;justify-content:center;align-items:baseline;gap:5px 18px;padding:28px 22px;line-height:1.35;background:#EEF0F3;border:1.5px solid #E2E5EA;border-radius:12px}
.cv-wcloud span{white-space:nowrap}
.cv-note{font-size:11.5px;color:#54606E;line-height:1.7;padding:12px 15px;background:#EEF0F3;border-radius:8px;margin-top:10px}
/* 圖表開頭的一句話說明：先講這張圖在看什麼，再呈現數據。刻意比 cv-note 低調（無底色），不搶圖表焦點 */
.cv-intro{font-size:12px;color:#54606E;line-height:1.7;margin:2px 0 12px}
.cv-vrow{border:1.5px solid #E2E5EA;border-radius:9px;margin-bottom:9px;overflow:hidden}
.cv-vrow-hd{display:flex;align-items:center;gap:10px;padding:11px 14px;background:#EEF0F3;cursor:pointer}
.cv-vrow-n{font-size:12px;font-weight:800;color:#1C2530}
.cv-vrow-date{font-size:11px;color:#8993A1}
.cv-vbadge{font-size:11.5px;font-weight:800;padding:3px 11px;border-radius:20px;margin-left:auto;font-variant-numeric:tabular-nums}
.cv-vrow-body{padding:14px;border-top:1.5px solid #E2E5EA}
.cv-caret{font-size:11px;color:#8993A1;transition:transform .2s}
.cv-vrow.open .cv-caret{transform:rotate(90deg)}
.cv-vreason{font-size:12.5px;line-height:1.75;color:#2B3440;margin-bottom:12px;padding:10px 13px;background:#EEF0F3;border-radius:7px;border-left:3px solid #1F3A5C}
.cv-vdim{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #E2E5EA}
.cv-vdim:last-child{border-bottom:none}
.cv-vdim-key{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:800;display:inline-block;line-height:20px;text-align:center;flex-shrink:0;font-family:-apple-system,'PingFang TC','Noto Sans TC',sans-serif}
.cv-vdim-name{font-size:12px;font-weight:700;width:150px;flex-shrink:0}
.cv-vdim-v{font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;width:42px;flex-shrink:0}
.cv-vdim-reason{font-size:11.5px;color:#54606E;line-height:1.5;flex:1}
.cv-emos{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.cv-emo{font-size:12px;font-weight:700;padding:5px 12px;border-radius:6px;border:1.5px solid}
.cv-emo.positive{background:#D9E7E0;border-color:#BCD3C8;color:#2E7057}
.cv-emo.negative{background:#F0E0D6;border-color:#E1C3B1;color:#B0542C}
.cv-emo.neutral{background:#EAECF0;border-color:#CBD1DA;color:#54606E}
.cv-block{border:1.5px solid #E2E5EA;border-radius:10px;margin-bottom:12px;overflow:hidden;background:#fff}
.cv-block-hd{display:flex;align-items:center;gap:10px;padding:12px 15px;background:#EEF0F3;border-bottom:1.5px solid #E2E5EA}
.cv-block-title{font-size:13.5px;font-weight:800;color:#1C2530;flex:1}
.cv-block-tag{font-size:10px;font-weight:800;letter-spacing:.04em;padding:3px 9px;border-radius:5px;text-transform:uppercase}
.cv-block-tag.inc{background:#D9E7E0;color:#2E7057;border:1.5px solid #BCD3C8}
.cv-block-tag.preview{background:#E7ECF5;color:#1F3A5C;border:1.5px solid #B9C6DE}
.cv-block-tags{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.cv-block-body{padding:14px 16px}
.cv-preview-note{font-size:11.5px;color:#54606E;line-height:1.6;padding:9px 12px;background:#EEF0F3;border-left:3px solid #8993A1;margin:8px 0 10px}
.cv-md{font-size:13px;line-height:1.8;color:#2B3440}
.cv-md p{margin:0 0 9px}
.cv-md h2,.cv-md h3{font-size:14px;font-weight:800;margin:13px 0 6px;color:#1C2530}
.cv-md strong{font-weight:800;color:#1F3A5C}
.cv-md em{color:#54606E}
/* 報告內文只有兩種強調，顏色對應語意而不是輕重：
   strong（面向標題、優勢名稱）＝深藍，系統寫的結構標籤；
   .cv-q（mdToHtml 的 markQuotes）＝金色，學員自己說的話，全篇唯一的暖色。
   兩者都用 800，靠色相區分；同色不同粗在中文字級下分不出來。 */
.cv-q{color:#8A6A26;font-weight:800}
.cv-block-actions{display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid #E2E5EA;justify-content:space-between}
.cv-block-edit{font-size:11.5px;font-weight:700;color:#1F3A5C;cursor:pointer}
.cv-block-edit:hover{text-decoration:underline}
.cv-textarea{width:100%;min-height:140px;border:1.5px solid #CBD1DA;border-radius:7px;padding:11px 13px;font-size:13px;font-family:inherit;line-height:1.7;color:#2B3440;resize:vertical}
.cv-doc{background:#fff;border:1.5px solid #E2E5EA;border-radius:10px;padding:34px 38px;line-height:1.95;color:#1C2530;font-family:'Songti TC','Noto Serif TC',Georgia,serif}
@media(max-width:560px){.cv-doc{padding:24px 22px}}
/* PDF 一律用同一個可量測的桌面版面；不可用 visibility:hidden/display:none，否則 SVG 尺寸會變成 0。 */
.cv-pdf-export{position:relative!important;width:720px!important;box-sizing:border-box!important;margin:0!important;border:0!important;border-radius:0!important;padding:34px 38px!important;background:#fff!important}
.cv-pdf-export .cv-stats{grid-template-columns:repeat(4,1fr)!important}
.cv-doc-head{text-align:center;padding-bottom:20px;margin-bottom:22px;border-bottom:2px solid #1C2530}
.cv-doc-title{font-size:22px;font-weight:800;margin:0 0 4px;letter-spacing:.02em}
.cv-doc-meta{font-size:12px;color:#54606E}
.cv-doc h2,.cv-doc h3{color:#1C2530}
.cv-doc h2{font-size:16px;font-weight:800;margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid #E2E5EA}
.cv-doc h3{font-size:14px;font-weight:800;margin:16px 0 6px}
.cv-doc p{margin:0 0 12px;font-size:14px}
.cv-doc strong{font-weight:800;color:#1F3A5C}
.cv-doc-sign{margin-top:26px;padding-top:16px;border-top:1px solid #E2E5EA;font-size:13px;color:#54606E}
.cv-doc-charts{margin-top:8px;font-family:-apple-system,'PingFang TC','Noto Sans TC',sans-serif}
/* 客戶文件內的圖表要縮進頁寬，避免 PDF／Word 右側被裁切、比例跑掉。
   SVG 有 viewBox，設 max-width:100%+height:auto 即等比縮放至容器寬；窄圖（雷達）維持原寸。 */
.cv-doc-charts .cv-chart-wrap{overflow:visible;text-align:center}
.cv-doc-charts .cv-chart-wrap svg{max-width:100% !important;height:auto !important}
/* 雷達圖固定尺寸，PDF/Word 匯出時不要被上面那條縮放規則影響——懷疑 html2canvas 對
   「縮到 100% 寬度」這個縮放算不準，導致內容被裁切而非等比縮小，先讓它維持原寸排除這個變因。 */
.cv-doc-charts .cv-radar-wrap svg{max-width:none !important;width:280px !important;height:294px !important}
/* 圖表接續正文流動排版；單一圖表本身不可從中間被切
   （避免雷達與 A/P/M/R/E 清單分到不同頁），也避免正文很短時留下大面積空白頁。 */
.cv-doc-chart{break-inside:avoid;page-break-inside:avoid;margin-bottom:30px}
.cv-doc-chart-h{margin-top:0 !important}
.cv-rdelta,.cv-stats,.cv-wcloud,.cv-rdelta-row{break-inside:avoid;page-break-inside:avoid}
.cv-pdf-export h2,.cv-pdf-export h3{break-after:avoid;page-break-after:avoid}
.cv-pdf-export p,.cv-pdf-export li,.cv-pdf-export .cv-doc-head,.cv-pdf-export .cv-doc-sign{break-inside:avoid;page-break-inside:avoid}
/* PDF 中的雷達明細採緊湊行高；避免 PDF viewer 放大後每列看起來像獨佔一個大區塊。 */
.cv-pdf-export .cv-rdelta-row{padding:7px 12px;font-size:11.5px;gap:8px}
.cv-pdf-export .cv-rdelta-key{width:18px;height:18px;box-sizing:border-box}
.cv-pdf-export .cv-rdelta-tag-svg{width:82px;height:26px;flex-basis:82px}
.cv-word-export{position:relative!important;width:644px!important;box-sizing:border-box!important;margin:0!important;padding:0 2px 10px!important;background:#fff!important}
.cv-word-export .cv-chart-wrap{overflow:visible!important}
.cv-word-export .cv-chart-wrap svg{max-width:100%!important;height:auto!important}
.cv-md{font-size:13.5px;line-height:1.85}
.cv-md h2,.cv-md h3{margin:16px 0 7px}
/* 真正的列點：實心圓點／數字，而非單純換行 —— cv-md（教練簡報）與 cv-doc（客戶文件）共用 */
.cv-md ul,.cv-doc ul{list-style:none;margin:8px 0 14px;padding:0}
.cv-md ul li,.cv-doc ul li{position:relative;padding-left:20px;margin-bottom:7px;line-height:1.7}
.cv-md ul li::before,.cv-doc ul li::before{content:'';position:absolute;left:3px;top:.68em;width:5px;height:5px;border-radius:50%;background:#8993A1}
.cv-md ol,.cv-doc ol{list-style:none;counter-reset:cvol;margin:8px 0 14px;padding:0}
.cv-md ol li,.cv-doc ol li{position:relative;counter-increment:cvol;padding-left:24px;margin-bottom:7px;line-height:1.7}
.cv-md ol li::before,.cv-doc ol li::before{content:counter(cvol) '.';position:absolute;left:0;top:0;font-weight:800;color:#1F3A5C;font-variant-numeric:tabular-nums}
/* 巢狀子條列：縮排一層、標記縮小變淺，清楚區分「維度標籤」與其下的證據 */
.cv-md li>ul,.cv-doc li>ul,.cv-md li>ol,.cv-doc li>ol{margin:6px 0 2px}
.cv-md li>ul>li,.cv-doc li>ul>li{padding-left:17px}
.cv-md li>ul>li::before,.cv-doc li>ul>li::before{width:4px;height:4px;background:#B9C0CB}
.cv-md li>ol>li,.cv-doc li>ol>li{padding-left:20px;font-size:.96em}
/* 章節導覽側欄（sticky，隨捲動高亮目前章節） */
[id^="sec-"]{scroll-margin-top:20px}
.cv-toc{position:sticky;top:24px;display:flex;flex-direction:column;gap:2px;width:172px;flex-shrink:0;max-height:calc(100vh - 48px);overflow-y:auto}
.cv-toc-link{font-size:12.5px;font-weight:700;color:#8993A1;padding:7px 10px;border-radius:7px;text-decoration:none;border-left:2px solid transparent;transition:color .15s,background-color .15s}
.cv-toc-link:hover{color:#1C2530;background:#EEF0F3}
.cv-toc-link.active{color:#1F3A5C;font-weight:800;background:#EEF0F3;border-left-color:#1F3A5C}
.cv-toc-sub{padding-left:20px;font-size:11.5px;font-weight:600}
@media(max-width:1024px){.cv-toc{display:none}}
/* 自訂分析框架編輯器 */
.cv-block-tag.ai{background:#E7ECF5;color:#1F3A5C;border:1.5px solid #B9C6DE}
.cv-block-del{font-size:11.5px;font-weight:700;color:#B0542C;cursor:pointer}
.cv-block-del:hover{text-decoration:underline}
.cv-fw-intro{border:1.5px solid #E2E5EA;background:#FAFAF8;border-radius:10px;padding:15px 16px;margin-bottom:14px}
.cv-fw{border:1.5px solid #B5843A;background:#FBF7EE;border-radius:10px;padding:15px 16px;margin-bottom:14px}
.cv-fw-hd{font-size:12.5px;font-weight:800;color:#1C2530;margin-bottom:11px}
.cv-fw-lab{display:block;font-size:11.5px;font-weight:700;color:#54606E;margin:8px 0 4px}
.cv-fw-in{width:100%;border:1.5px solid #CBD1DA;border-radius:7px;padding:8px 11px;font-size:12.5px;font-family:inherit;line-height:1.5;color:#2B3440;background:#fff;margin-bottom:6px}
.cv-fw-in:focus{outline:none;border-color:#B5843A}
.cv-fw-dim{position:relative;border:1px dashed #CBD1DA;border-radius:8px;padding:10px 34px 4px 11px;margin-bottom:8px;background:#fff}
.cv-fw-del{position:absolute;top:8px;right:9px;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:#8993A1;cursor:pointer;font-size:16px;line-height:1}
.cv-fw-del:hover{background:#F0E0D6;color:#B0542C}
.cv-fw-add{font-size:12px;font-weight:700;color:#1F3A5C;cursor:pointer;background:none;border:none;padding:2px 0}
.cv-fw-add:hover{text-decoration:underline}
.cv-fw-refs{margin-top:10px;font-size:11.5px;color:#54606E}
.cv-fw-refs ul{margin:4px 0 0 18px}
.cv-fw-refs li{margin-bottom:3px;line-height:1.5}
.cv-fw-note{margin-top:10px;font-size:11.5px;color:#8A6A26;background:#F6EEDC;border-radius:6px;padding:8px 11px}
/* #3 列印：只輸出客戶報告（Personal Well-being Review），不印整頁 */
@media print{
  body *{visibility:hidden !important}
  #cv-print-area,#cv-print-area *{visibility:visible !important}
  #cv-print-area{position:absolute;left:0;top:0;width:100%;margin:0;border:none;box-shadow:none;padding:0 8mm}
}
`
