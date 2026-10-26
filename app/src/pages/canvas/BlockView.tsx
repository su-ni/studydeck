/* 节点的六种「块」怎么画。
 *
 * 规矩：
 * 1) **不引第三方库**（没有 marked / katex / react-syntax-highlighter）。理由跟
 *    md.tsx 那份一致：备注用的 MD 子集够用了，引一个 200KB 的解析器只为
 *    高亮代码不值当；真要专业 KaTeX 再来一轮单独评估。
 * 2) **不许 dangerouslySetInnerHTML**。备注是用户自己写的，但也有从 XMind /
 *    Markdown 文件同步过来的内容 —— 一律 React 元素，'<script>' 只是一串字符。
 * 3) **不许省略号**。代码、表格、公式都一样：看不全就让它宽一点、让画布滚，
 *    把内容藏起来等于删掉内容。
 */

import type { NodeType, Parsed, Style } from './blocks'
import { imgSrcOf, parse, typeOf } from './blocks'

export type BlockProps = {
  text: string
  ty: NodeType
  depth: number
  st: Style
}
export type MRow = { done?: boolean; text?: string }

/** 代码块在编号行头上用的一点点亮度区分 —— 纯 CSS 变量，浅色画布也成立。 */
export function CodeBlock({ p, st }: { p: Extract<Parsed, { kind: 'code' }>; st: Style }) {
  const fs = Math.max(10, st.fs - 1)
  return (
    <span className="cvblk cvblk-code" style={{ padding: '0 2px' }}>
      {p.lang ? <span className="cvblk-lang">{p.lang}</span> : null}
      <code className="cvblk-pre" style={{ fontSize: fs, lineHeight: st.lh }}>
        {p.lines.map((l, i) => (
          <span className="cvblk-ln" key={i}>
            <i className="cvblk-no">{i + 1}</i>
            <span className="cvblk-cd">{l || ' '}</span>
          </span>
        ))}
      </code>
    </span>
  )
}

export function TableBlock({ p, st }: { p: Extract<Parsed, { kind: 'table' }>; st: Style }) {
  const cols = Math.max(1, p.head.cells.length)
  const grid = `${cols}`
  return (
    <span className="cvblk cvblk-table" style={{ ['--cvcols' as any]: grid }}>
      <span className="cvblk-tr head">
        {p.head.cells.map((c, i) => <b key={i}>{c}</b>)}
      </span>
      {p.rows.map((r, ri) => (
        <span className="cvblk-tr" key={ri}>
          {new Array(cols).fill(0).map((_, i) => <span key={i}>{r.cells[i] ?? ''}</span>)}
        </span>
      ))}
    </span>
  )
}

export function TodoBlock({ p, st }: { p: Extract<Parsed, { kind: 'todo' }>; st: Style }) {
  return (
    <span className="cvblk cvblk-todo" style={{ fontSize: st.fs, lineHeight: st.lh }}>
      {p.items.map((it, i) => (
        <span className={'cvblk-li' + (it.done ? ' done' : '')} key={i}>
          <i className="cvblk-box">{it.done ? '✓' : ''}</i>
          <span>{it.text}</span>
        </span>
      ))}
    </span>
  )
}

export function CalloutBlock({ p, st }: { p: Extract<Parsed, { kind: 'callout' }>; st: Style }) {
  return (
    <span className={'cvblk cvblk-callout ' + p.tone} style={{ fontSize: st.fs, lineHeight: st.lh }}>
      {p.lines.map((l, i) => <span className="ln" key={i}>{l || '\u00A0'}</span>)}
    </span>
  )
}

export function FormulaBlock({ p, st }: { p: Extract<Parsed, { kind: 'formula' }>; st: Style }) {
  const fs = Math.round(st.fs * 1.15)
  return (
    <span className="cvblk cvblk-formula" style={{ fontSize: fs, lineHeight: st.lh }}>
      {p.lines.map((l, i) => (
        <span className="ln" key={i}>{pretty(l)}</span>
      ))}
    </span>
  )
}

/* 图片块。引用式（开发文档 6.1）：相对路径借 imgBase（/noteimg/<来源>?p=…）读原文件，
   本机路径（/shots /assets）和 http 直链原样走。图挂了显示 alt 文案，不显示破图标 ——
   外部文件被删是引用式说清楚的代价，alt 至少告诉人这张图本来是什么。 */
export function ImageBlock({ p, st, imgBase }: { p: Extract<Parsed, { kind: 'image' }>; st: Style; imgBase?: string }) {
  const url = imgSrcOf(p.src, imgBase)
  return (
    <span className="cvblk cvblk-img" style={{ width: Math.min(240, st.maxW) }}>
      <img src={url} alt={p.alt || '图片'} loading="lazy" draggable={false}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
      <em className="cvblk-img-alt">{p.alt || p.src}</em>
    </span>
  )
}

/* 把最常见的几个 ASCII / LaTeX 记号换成排印字符：$x^2$ → x²，sqrt → √，
   != → ≠，<= → ≤。只是替换显示字符，**不做公式排版** —— 真正的公式渲染要
   KaTeX，那是一整套依赖。这里说的清清楚楚：做不到就不假装做到了。 */
export function pretty(s: string): string {
  let t = String(s ?? '')
  const map: [RegExp, string][] = [
    [/\^\{?2\}?/g, '²'], [/\^\{?3\}?/g, '³'], [/\^\{?([0-9])\}?/g, '^$1'],
    [/\\?sqrt/g, '√'], [/\\?times/g, '×'], [/\\?div/g, '÷'], [/\\?pm/g, '±'],
    [/\balpha\b|\\alpha/g, 'α'], [/\bbeta\b|\\beta/g, 'β'], [/\btheta\b|\\theta/g, 'θ'],
    [/\bpi\b|\\pi/g, 'π'], [/\\?sum/g, '∑'], [/\\?int/g, '∫'], [/\\?infty/g, '∞'],
    [/!=/g, '≠'], [/<=/g, '≤'], [/>=/g, '≥'], [/->/g, '→'], [/\*/g, '·'],
  ]
  for (const [re, to] of map) t = t.replace(re, to)
  return t
}

/* ── 分派 ──────────────────────────────────────────────────────────────
   节点内容统一从这里出去：调用方只管把 text / type / style 递进来。 */
export function NodeBlock({ text, ty, st, imgBase }: { text: string; ty: NodeType; st: Style; imgBase?: string }) {
  const p = parse(text, ty)
  switch (p.kind) {
    case 'code': return <CodeBlock p={p} st={st} />
    case 'table': return <TableBlock p={p} st={st} />
    case 'todo': return <TodoBlock p={p} st={st} />
    case 'callout': return <CalloutBlock p={p} st={st} />
    case 'formula': return <FormulaBlock p={p} st={st} />
    case 'image': return <ImageBlock p={p} st={st} imgBase={imgBase} />
    default: return (
      <span className="cvblk cvblk-text" style={{ fontSize: st.fs, lineHeight: st.lh }}>
        {p.lines.map((l, i) => <span className="ln" key={i}>{l || '\u00A0'}</span>)}
      </span>
    )
  }
}

export const blockType = typeOf
