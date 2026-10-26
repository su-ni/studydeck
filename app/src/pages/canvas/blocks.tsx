/* 画布节点的「类型」：文字之外还能装什么。
 *
 * 为什么加这个：以前节点只能装一句话，再有内容就只能塞备注里藏起来 ——
 * 用户那句「节点只显示几个文字有什么用」就是这么来的。参考 brainstorming-vue
 * 的做法是给节点一个 type 字段，正文统一走 node.text，由 <NodeRenderer> 分派
 * 到不同的 Block。这里同一套思路，但三处我们做得不一样：
 *   1) 它用 v-html 灌 marked 的结果（没 sanitize），我们一律 React 元素，
 *      不碰 dangerouslySetInnerHTML —— 备注里出现 `<script>` 也不过是一串字符。
 *   2) 它的新块要靠改 pickup 面板类型菜单；这里**自动识别**：粘进来是代码 fences
 *      就是代码块，是 `| a | b |` 就是表格，人不用先选类型再写。
 *   3) 它每个块带独立的 Alt+滚轮缩放；我们先不抄 —— 画布本身的缩放已经能用，
 *      再加一层内容缩放会让「滚动到底是在滚谁」说不清。
 *
 * 存储口径：**正文永远在 node.text**，类型可以由内容推出来。
 * 好处是导出 md/opml/json、大纲视图、老数据全都不用改 —— 它们读的都是 text；
 * type 只是一个「这块该怎么画」的提示，随时能从内容重新判断。
 */

export type NodeType = 'text' | 'code' | 'table' | 'todo' | 'callout' | 'formula' | 'image'

export const NODE_TYPES: { v: NodeType; name: string; hint: string; icon: string }[] = [
  { v: 'text', name: '文字', hint: '默认', icon: 'writing' },
  { v: 'code', name: '代码', hint: '``` 包起来', icon: 'node' },
  { v: 'table', name: '表格', hint: '| 分隔', icon: 'gal' },
  { v: 'todo', name: '待办', hint: '- [ ]', icon: 'check' },
  { v: 'callout', name: '提示', hint: '> 开头', icon: 'star' },
  { v: 'formula', name: '公式', hint: '$…$', icon: 'md' },
  { v: 'image', name: '图片', hint: '![说明](路径)', icon: 'img' },
]

/** 中文/全角按一个字号宽，西文按 0.56 —— 与 autolayout.textWidth 同一套算法。 */
function dispW(s: string, fs: number): number {
  let px = 0
  for (const ch of String(s || '')) {
    px += (ch.codePointAt(0) || 0) > 0x2e80 ? fs : fs * 0.56
  }
  return px
}

/* ── 识别 ──────────────────────────────────────────────────────────────
   纯函数、只看文本：这样任何一条旧笔记拉进来都能自动分派，不用人先选类型。
   顺序要紧 —— 表格里也可能有 `- [ ]`，所以表格判在待办前面。 */
export function detectType(text: string): NodeType {
  const t = String(text ?? '').replace(/\r/g, '')
  if (!t.trim()) return 'text'
  if (t.trim().startsWith('```')) return 'code'
  if (/^\s*\|.*\|\s*$/m.test(t) && /\|[\s:|-]+\|/.test(t)) return 'table'
  if (/^\s*> ?/m.test(t)) return 'callout'
  if (/^\s*[-*+]\s+\[[ xX]\]/m.test(t)) return 'todo'
  /* 公式：整段被 $ 包起来，或者整段没有中文、看着就像式子。
     拉丁字母得收进来（`a^2 + b^2 = c^2` 这类），但触发条件收紧为
     ^ _ = 或数学符号 —— 只用 / 判断的话 "and/or" 会被误判成公式。
     宁可判断不出来当文字，也别把一句普通的话渲染成公式体。 */
  const one = t.trim()
  /* 图片节点：整段就是一张 Markdown 图（![说明](路径)）。
     开发文档 6.1 的引用式规矩 —— 路径是内容，不是格式，剥了就回不去了。 */
  if (/^!\[[^\]]*\]\([^)\s]+\)$/.test(one)) return 'image'
  if (/^\$\$?[\s\S]+\$\$?$/.test(one)) return 'formula'
  if (/^[A-Za-z0-9+\-*/^_=(){}[\]\\ \t\n.,∫∑√≤≥≠±×÷α-ωΑ-Ω]+$/.test(one) && /[\^_=∫∑√≤≥≠±×÷]/.test(one)) return 'formula'
  return 'text'
}

export function typeOf(node: { type?: NodeType; text?: string }): NodeType {
  const t = node?.type
  if (t && NODE_TYPES.some((x) => x.v === t)) return t
  return detectType(node?.text || '')
}

/* ── 解析：把 text 拆成每块自己要的结构 ──────────────────────────────
   全部在这里做完，渲染组件只管画。这样量尺寸（给布局算盒子）和画画面
   用的是同一次解析结果 —— 两边各算一套的话，盒子一定会对不上文字。 */

export type Row = { cells: string[] }

export type Parsed =
  | { kind: 'text'; lines: string[] }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'table'; head: Row; rows: Row[] }
  | { kind: 'todo'; items: { done: boolean; text: string }[] }
  | { kind: 'callout'; tone: 'note' | 'warn'; lines: string[] }
  | { kind: 'formula'; lines: string[] }
  | { kind: 'image'; alt: string; src: string }

/** 把节点正文里的图片引用解析出来（图片块 / 缩略图都要用）。
    返回 null 表示这段文字不是「整段一张图」。 */
export function parseImg(text: string): { alt: string; src: string } | null {
  const m = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(String(text ?? ''))
  return m ? { alt: m[1], src: m[2] } : null
}

/** 图片地址 → 浏览器能直接要的 URL。
    绝对地址（/shots/..、/assets/..、http、data:）原样走；
    相对路径是外部笔记里的引用式图片，借 imgBase（/noteimg/<来源>）读原文件。 */
export function imgSrcOf(src: string, imgBase?: string): string {
  const s = String(src || '')
  if (!s || /^(https?:|data:|\/|blob:)/.test(s)) return s
  return imgBase ? imgBase + '?p=' + encodeURIComponent(s) : s
}

export function parse(text: string, ty: NodeType): Parsed {
  const raw = String(text ?? '').replace(/\r/g, '')
  switch (ty) {
    case 'code': {
      const lines = raw.split('\n')
      const head = lines[0] || ''
      const lang = head.replace(/^\s*```/, '').trim()
      const body = lines.slice(1)
      // 收尾那行 fence 自己删掉：它是格式标记不是内容
      const tail = body.length && /^\s*```\s*$/.test(body[body.length - 1]) ? body.slice(0, -1) : body
      return { kind: 'code', lang, lines: tail.length ? tail : [''] }
    }
    case 'table': {
      const rows: Row[] = []
      for (const line of raw.split('\n')) {
        const s = line.trim()
        if (!s.startsWith('|')) continue
        // 分隔行（| --- | --- |）是语法，不是一行数据
        if (/^\|[\s:|-]+\|$/.test(s.replace(/\|/g, '|'))) {
          if (/^[\s|:-]+$/.test(s)) continue
        }
        rows.push({ cells: s.slice(1, -1).split('|').map((c) => c.trim()) })
      }
      const head = rows.shift() || { cells: [] }
      return { kind: 'table', head, rows }
    }
    case 'todo': {
      const items: { done: boolean; text: string }[] = []
      for (const line of raw.split('\n')) {
        const m = /^\s*[-*+]?\s*\[([ xX])\]\s*(.*)$/.exec(line)
        if (m) items.push({ done: m[1].toLowerCase() === 'x', text: m[2] })
        else if (line.trim()) items.push({ done: false, text: line.trim() })
      }
      return { kind: 'todo', items }
    }
    case 'callout': {
      // 「! 」起头的是警示（琥珀），「> 」是普通提示（中性）
      const warn = /^\s*(!|>!)\s?/m.test(raw)
      const lines = raw.split('\n').map((l) => l.replace(/^\s*(!|>!|>)\s?/, '')).filter((l, i, a) => l.trim() || a.slice(0, i).some((x) => x.trim()))
      return { kind: 'callout', tone: warn ? 'warn' : 'note', lines }
    }
    case 'formula': {
      const one = raw.trim().replace(/^\$\$?/, '').replace(/\$\$?$/, '')
      return { kind: 'formula', lines: one.split('\n').map((s) => s.trim()).filter((s) => s || true) }
    }
    case 'image': {
      const p = parseImg(raw) || { alt: '', src: raw.trim() }
      return { kind: 'image', alt: p.alt, src: p.src }
    }
    default:
      return { kind: 'text', lines: raw.split('\n') }
  }
}

/* ── 量尺寸 ────────────────────────────────────────────────────────────
   布局要提前知道盒子多大。这里必须和 CSS 画出来的保持同一套数字，
   否则 ReactFlow 量到的和画出来的对不上，连线全歪（autolayout.ts 第 4 条铁律）。
   st = {fs,lh,padX,padY,maxW}（来自 autolayout.styleOf），不 import 是为了
   避免模块互相依赖 —— 那边反过来要用这里的 metricsOf。 */
export type Style = { fs: number; lh: number; padX: number; padY: number; maxW: number }

export function metricsOf(text: string, ty: NodeType, st: Style): { w: number; h: number; rows: number } {
  const p = parse(text, ty)
  const lhPx = (fs: number) => Math.round(fs * st.lh)
  let rows = 1
  let w = 0

  if (p.kind === 'code') {
    // 等宽字体每字符按 0.6em；不折行（代码折行就没法读了），超宽留出横向滚动
    const fs7 = Math.max(10, st.fs - 1)
    rows = Math.max(1, Math.min(16, p.lines.length)) + (p.lang ? 1 : 0)
    for (const l of p.lines) w = Math.max(w, Math.round(l.length * fs7 * 0.6))
    w = Math.min(st.maxW + 40, Math.max(120, w))
    return { w: Math.round(w + st.padX * 2 + 8), h: Math.round(rows * lhPx(fs7) + st.padY * 2 + (p.lang ? 14 : 0)), rows }
  }
  if (p.kind === 'table') {
    const cols = Math.max(1, p.head.cells.length)
    // 每列宽度取该列最长那一格；格子再长也折行（藏字是禁的）
    const colW: number[] = new Array(cols).fill(0)
    const scan = (r: Row) => r.cells.forEach((c, i) => { colW[i] = Math.max(colW[i] || 0, Math.min(150, dispW(c, st.fs - 1))) })
    scan(p.head)
    p.rows.forEach(scan)
    w = colW.reduce((a, b) => a + b, 0) + (cols + 1) * 14
    rows = p.rows.length + 1
    return { w: Math.round(Math.min(st.maxW + 60, Math.max(110, w)) + st.padX * 2), h: Math.round(rows * lhPx(st.fs - 1) + st.padY * 2 + 6), rows }
  }
  if (p.kind === 'todo') {
    const fs7 = st.fs
    for (const it of p.items) w = Math.max(w, Math.min(st.maxW, dispW(it.text, fs7)) + 20)
    rows = p.items.length
    return { w: Math.round(Math.max(90, w) + st.padX * 2), h: Math.round(rows * lhPx(fs7) + st.padY * 2), rows }
  }
  if (p.kind === 'formula') {
    // 公式整体放大一号、用衬线体；宽高还是得跟 CSS 对上
    const fsf = Math.round(st.fs * 1.15)
    for (const l of p.lines) w = Math.max(w, Math.round(dispW(l, fsf) * 0.92))
    rows = p.lines.length
    return { w: Math.round(Math.min(st.maxW, Math.max(70, w)) + st.padX * 2), h: Math.round(rows * lhPx(fsf) + st.padY * 2), rows }
  }
  if (p.kind === 'image') {
    /* 图片块给一个固定预览框（跟 app.css 的 .cvblk-img img 同一个数：
       高 148 + 说明行 ~19 + 描边 2）。真实比例要等图加载完才知道，
       但布局不能等 —— 所有图统一框尺寸，换来的是连线永不歪（铁律 4）。 */
    const w = Math.round(Math.min(st.maxW, 240))
    return { w: w + st.padX * 2, h: 148 + 19 + st.padY * 2 + 2, rows: 1 }
  }
  // callout 与 text 都按普通折行处理（callout 多一条左侧竖条的 12px）
  const lines: string[] = p.kind === 'callout' ? p.lines : (p.kind === 'text' ? p.lines : [])
  const extra = p.kind === 'callout' ? 14 : 0
  const wrapped: string[] = []
  for (const para of lines) {
    if (!para.trim()) { wrapped.push(''); continue }
    let cur = ''
    let curW = 0
    for (const ch of para) {
      const cw = (ch.codePointAt(0) || 0) > 0x2e80 ? st.fs : st.fs * 0.56
      if (curW + cw > st.maxW - extra && cur) { wrapped.push(cur); cur = ch; curW = cw }
      else { cur += ch; curW += cw }
    }
    wrapped.push(cur)
  }
  rows = Math.max(1, wrapped.length)
  for (const l of wrapped) w = Math.max(w, dispW(l, st.fs))
  return { w: Math.round(Math.max(depth0Guard(ty), Math.min(st.maxW, w)) + st.padX * 2 + extra), h: Math.round(rows * lhPx(st.fs) + st.padY * 2), rows }
}

function depth0Guard(_ty: NodeType): number {
  return 40
}
