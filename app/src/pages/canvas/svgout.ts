/* 把当前布局画成一张能存盘的 SVG（截图库要的是矢量，再栅格化）。
 *
 * 从 Canvas.tsx 拆出来的理由：这段原来埋在 buildSvg() 里，跟着 Canvas 一起改，
 * 布局一换就得同步改三处（屏幕 / 导出 / 概览），总漏。现在它只读 LaidNode，
 * 布局怎么变这里都不用动。
 *
 * 要求：**导出的样子必须与屏幕上一致**。所以颜色、字号、圆角、连线形态
 * 全部从 autolayout 的 DEPTH_STYLE 与 CSS 变量的同源取值拿。
 */

import { DEPTH_STYLE, wrapOf, type LaidNode, type LayoutMode } from './autolayout'
import type { TNode } from './treelib'

const esc = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/* 屏幕上是 CSS 变量（--bg/--card/--tx），SVG 里没有变量可继承，
   所以这里得有一份字面值。只放这一处，改配色时同步改这里。 */
const K = {
  bg: '#0F0D0A',
  node: '#1B1812',
  nodeLine: '#2A251D',
  root: '#FFB020',
  rootTx: '#1A1000',
  tx: '#FBF7EF',
  tx2: '#C2B8A4',
  edge: '#3D372C',
  edgeRoot: '#FFB020',
}

type Box = { x0: number; y0: number; x1: number; y1: number }

export function boundsOf(laid: LaidNode[], pad = 40): Box {
  if (!laid.length) return { x0: 0, y0: 0, x1: 400, y1: 300 }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of laid) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h)
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
}

/* 折线/贝塞尔的锚点按「这一支朝哪边长」选边，跟节点上的 Handle 一致。
   左右接错的话导出图里线会横穿整棵子树。 */
function pathOf(a: LaidNode, b: LaidNode, mode: LayoutMode): string {
  if (mode === 'treeV') {
    const cx1 = a.x + a.w / 2, cy1 = a.y + a.h
    const cx2 = b.x + b.w / 2, cy2 = b.y
    const my = cy1 + Math.max(14, (cy2 - cy1) / 2)
    return `M${cx1},${cy1} C${cx1},${my} ${cx2},${my} ${cx2},${cy2}`
  }
  if (b.side === -1) {
    // 左支：从父的左腰，接到子的右腰
    const x1 = a.x, y1 = a.y + a.h / 2
    const x2 = b.x + b.w, y2 = b.y + b.h / 2
    const mx = x1 - Math.max(16, (x1 - x2) / 2)
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
  }
  const x1 = a.x + a.w, y1 = a.y + a.h / 2
  const x2 = b.x, y2 = b.y + b.h / 2
  if (mode === 'radial') return `M${x1},${y1} L${x2},${y2}`
  const mx = x1 + Math.max(16, (x2 - x1) / 2)
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
}

export function buildSvg(
  laid: LaidNode[],
  tree: TNode,
  mode: LayoutMode,
  fold: Record<string, 1>,
  title = '',
): string {
  const byId: Record<string, TNode> = {}
  const walk = (n: TNode | null) => {
    if (!n) return
    byId[n.id] = n
    ;(n.children || []).forEach(walk)
  }
  walk(tree)

  const box = boundsOf(laid)
  const W = box.x1 - box.x0
  const Hh = box.y1 - box.y0
  const vis = new Set(laid.map((l) => l.id))
  const P = (id: string) => laid.find((l) => l.id === id)

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh}" viewBox="${box.x0} ${box.y0} ${W} ${Hh}">`
  s += `<rect x="${box.x0}" y="${box.y0}" width="${W}" height="${Hh}" fill="${K.bg}"/>`

  // 连线先画，节点盖在上面（否则线头会压住文字）
  let edges = ''
  let rootEdges = ''
  for (const p of laid) {
    const n = byId[p.id]
    if (!n || fold[n.id]) continue
    for (const c of n.children || []) {
      if (!vis.has(c.id)) continue
      const a = P(p.id), b = P(c.id)
      if (!a || !b) continue
      // 第二层往下用细线，一级支干用琥珀色的粗线 —— 这是导图「有骨架」的来源
      const d = pathOf(a, b, mode)
      if (p.depth === 0) rootEdges += `<path d="${d}" fill="none" stroke="${K.edgeRoot}" stroke-width="2.6" stroke-opacity=".55" stroke-linecap="round"/>`
      else edges += `<path d="${d}" fill="none" stroke="${b.side === -1 ? '#2F2A22' : K.edge}" stroke-width="${p.depth === 1 ? 1.8 : 1.3}" stroke-linecap="round"/>`
    }
  }
  s += rootEdges + edges

  for (const p of laid) {
    const n = byId[p.id]
    if (!n) continue
    const st = DEPTH_STYLE[Math.min(DEPTH_STYLE.length - 1, p.depth)]
    const isRoot = p.depth === 0
    const stroke = n.col || K.nodeLine
    const bg = isRoot ? K.root : K.node
    const r = isRoot ? 16 : Math.max(7, 12 - p.depth * 2)
    s += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${r}" fill="${bg}" stroke="${stroke}" stroke-width="${isRoot ? 0 : 1.2}"/>`
    if (p.depth === 1 && n.col) {
      s += `<rect x="${p.x}" y="${p.y}" width="3" height="${p.h}" fill="${n.col}"/>`
    }
    const { lines } = wrapOf(n.text || '', p.depth)
    const tx = isRoot ? K.rootTx : (n.col && p.depth > 0 ? n.col : K.tx)
    const weight = isRoot ? 800 : p.depth === 1 ? 700 : 500
    lines.forEach((ln, i) => {
      const y = p.y + st.padY + st.fs * st.lh * (i + 0.78)
      s += `<text x="${p.x + st.padX}" y="${y}" fill="${tx}" font-family="system-ui,-apple-system,'Noto Sans CJK SC',sans-serif" font-size="${st.fs}" font-weight="${weight}">${esc(ln)}</text>`
    })
    if (fold[n.id] && p.depth > 0) {
      s += `<text x="${p.x + p.w - 4}" y="${p.y + p.h / 2 + 4}" fill="${K.tx2}" font-size="10" text-anchor="end">+</text>`
    }
  }

  // 角上留个署名：截图库里的图不止一张，得认得出是哪张
  if (title) {
    s += `<text x="${box.x1 - 8}" y="${box.y1 - 8}" fill="${K.tx2}" font-size="10" text-anchor="end" opacity=".5">${esc(title)}</text>`
  }
  return s + '</svg>'
}
