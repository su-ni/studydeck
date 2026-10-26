/* 画布自动布局：思维导图（左右平衡）/ 竖树 / 放射。
 *
 * 抽成独立文件的原因：Canvas.tsx 已经一千八百行，布局只会越加越多
 * （以后还有「鱼骨」「组织架构」），塞回组件里就是第二个一千行。
 *
 * 四条铁律：
 * 1) **不改入参**。折叠表 fold、拖动位置 pos 都只读。
 * 2) **pos 覆盖优先**。用户拖过的节点在哪就在哪 —— 换布局、改折叠都不许把它拽回去。
 *    想让它归位，只有「整理」按钮（它把 pos 清空）。
 * 3) 折叠分支的子孙不进结果集（否则会浮在半空，连线也画不出来）。
 * 4) **节点尺寸只有一个来源**。boxOf() 算出来的 w/h 必须和 CSS 画出来的一致，
 *    否则 ReactFlow 量到的和画出来的对不上，连线全歪。
 *    —— 这也是为什么字号、内边距、行高都在这里定义，别在 CSS 里另写一份。
 */

import type { TNode } from './treelib'
import { metricsOf, typeOf } from './blocks'

export type LayoutMode = 'mind' | 'treeV' | 'radial'
export type Pt = { x: number; y: number }
export type LaidNode = {
  id: string; x: number; y: number; depth: number; w: number; h: number
  /** 这一支朝哪边展开：1 向右、-1 向左（只有 mind 布局用得上；连线据此选 Handle）。 */
  side: 1 | -1
}

/* ── 层级造型 ────────────────────────────────────────────────────────────
   XMind 这类软件好看，靠的不是颜色，是「每一层长得不一样」：
   中心主题最大最重、一级分支粗一号、二级是普通条目、三级往下变小变淡。
   下面这张表就是全部规则，改字号改行高只改这里 —— 少了这一份，
   CSS 和布局各写一套，第三个改的人一定改漏。 */
export type DepthStyle = {
  fs: number        // 字号
  lh: number        // 行高倍数
  padX: number      // 左右内边距
  padY: number      // 上下内边距
  maxW: number      // 单行最宽（超了换行，不是省略号）
}

export const DEPTH_STYLE: DepthStyle[] = [
  { fs: 20, lh: 1.4, padX: 22, padY: 14, maxW: 250 },   // 中心主题：最大最重
  { fs: 14, lh: 1.5, padX: 16, padY: 10, maxW: 250 },   // 一级分支
  { fs: 13, lh: 1.55, padX: 13, padY: 8, maxW: 250 },   // 二级
  { fs: 12, lh: 1.55, padX: 12, padY: 7, maxW: 240 },   // 三级往下
]
export const styleOf = (depth: number): DepthStyle => DEPTH_STYLE[Math.min(DEPTH_STYLE.length - 1, Math.max(0, depth))]

/** 一行大概能塞几个全角字符：CJK 按 1 个字号宽，其余按 0.56。 */
export function textWidth(text: string, fs: number): number {
  let px = 0
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0) || 0
    px += c > 0x2e80 ? fs : fs * 0.56
  }
  return px
}

/* 按内容宽度折行。返回折出来的行数与最宽那一行的宽度。
   不做真正的排版（那种要拿 canvas 量），估算误差最多差一个字 —— 但节点是
   **自适应宽度**的，差一个字只是盒子宽一点窄一点，不会像省略号那样把内容藏掉。
   「把字藏起来」在思维导图里是不可接受的：导图就是用来看文字的。 */
export function wrapOf(text: string, depth: number): { lines: string[]; w: number } {
  const st = styleOf(depth)
  const raw = String(text ?? '').replace(/\r/g, '')
  const paras = raw.split('\n')
  const out: string[] = []
  for (const para of paras) {
    if (!para) { out.push(''); continue }
    let cur = ''
    let curW = 0
    for (const ch of para) {
      const cw = (ch.codePointAt(0) || 0) > 0x2e80 ? st.fs : st.fs * 0.56
      if (curW + cw > st.maxW && cur) { out.push(cur); cur = ch; curW = cw }
      else { cur += ch; curW += cw }
    }
    out.push(cur)
  }
  let w = 0
  for (const l of out) w = Math.max(w, textWidth(l, st.fs))
  return { lines: out, w }
}

/** 节点的渲染盒：宽高都按折行结果算。
 *  带 type 的节点不由这里逐字量 —— 代码块/表格/公式有自己的排法，
 *  交给 blocks.metricsOf()。两处必须共用同一份数，否则量到的和画出来的对不上。 */
export type Box = { w: number; h: number }
export function boxOf(n: TNode, depth = 1): Box {
  const st = styleOf(depth)
  const ty = typeOf(n)
  // 根节点给个下限，免得两个字的主干缩成一小坨
  const minW = depth === 0 ? 96 : 40
  if (ty !== 'text') {
    const m = metricsOf(n.text || '', ty, st)
    return { w: Math.max(minW, m.w), h: Math.max(Math.round(st.fs * st.lh + st.padY * 2), m.h) }
  }
  const { lines, w } = wrapOf(n.text || '', depth)
  const rows = Math.max(1, lines.length)
  return {
    w: Math.round(Math.max(minW, Math.min(st.maxW, w)) + st.padX * 2),
    h: Math.round(rows * st.fs * st.lh + st.padY * 2),
  }
}

/** 这一支被折叠了吗（根节点永远不折叠：折叠了自己这一支全没了，就剩一张空画布）。 */
function isHidden(n: TNode, depth: number, fold: Record<string, 1>): boolean {
  return depth > 0 && !!fold[n.id]
}

/* ── 间距 ─────────────────────────────────────────────────────────────── */
export const GAP_X = 62   // 相邻两层之间的横向空隙（连线就画在这上面；太窄会像贴在一起）
export const GAP_Y = 18   // 兄弟节点之间的纵向空隙（太小会糊成一片，看不出层次）
export const V_STEP = 90  // 竖树每层纵向步长
export const R_STEP = 250 // 放射每环半径增量

/** 兼容旧调用（导出 SVG / 快捷键提示里还提到过这些名字）。 */
export const H = 46

/* 树里递归收集「某个节点下所有后代」的 id。拖动父节点时要带着整支走，
   不收集的话拖了父节点、子孙留在原地，线从父节点拉到天边。 */
export function subtreeIds(n: TNode, out: string[] = []): string[] {
  ;(n.children || []).forEach((c) => { out.push(c.id); subtreeIds(c, out) })
  return out
}

/* ---------------------------------------------------------------------------
   思维导图（默认）：中心主题居中，一级分支一半向左一半向右，两边分开长。
   这是 XMind「逻辑图 / 思维导图」看起来像导图的关键 —— 以前所有分支都朝右，
   就变成了一棵躺倒的树，越深越往右挤，看着像列表。

   纵向排法是经典的「后序累加」：先量每棵子树要占多高，再把兄弟一个个摞起来，
   父节点落在自己这堆孩子的垂直中点上。这样分支之间永远不会叠。
   --------------------------------------------------------------------------- */
export function mind(root: TNode, fold: Record<string, 1> = {}, pos: Record<string, Pt> = {}): LaidNode[] {
  const out: LaidNode[] = []
  const rb = boxOf(root, 0)

  // 量高度：返回这一支的盒子总高
  const heightOf = (n: TNode, depth: number): number => {
    const b = boxOf(n, depth)
    const kids = isHidden(n, depth, fold) ? [] : n.children || []
    if (!kids.length) return b.h
    let sum = 0
    kids.forEach((k, i) => { sum += heightOf(k, depth + 1) + (i ? GAP_Y : 0) })
    return Math.max(b.h, sum)
  }

  /* 摆一支：给定「这一支的纵向中轴」与「根节点的纵向中轴」，
     从 x 开始往外排。返回这一支实际占的高度（父节点若有多个孩子要用来摞）。 */
  const place = (n: TNode, depth: number, centerY: number, startX: number, side: 1 | -1) => {
    const b = boxOf(n, depth)
    const p = pos[n.id]
    const x0 = side === 1 ? startX : startX - b.w
    // 真实落点：被拖过的节点以 pos 为准。下面的孩子必须**从这个落点**往外排，
    // 不能再用布局算出来的 x —— 否则父节点被拖走了，孩子还挂在原来的位置，
    // 一支整体错位，看着像「拖了没用」。
    const x = p ? p.x : x0
    const y = p ? p.y : centerY - b.h / 2
    out.push({ id: n.id, x, y, depth, w: b.w, h: b.h, side })

    const kids = isHidden(n, depth, fold) ? [] : n.children || []
    if (!kids.length) return

    const heights = kids.map((k) => heightOf(k, depth + 1))
    const total = heights.reduce((s, h) => s + h, 0) + GAP_Y * (kids.length - 1)
    let at = y + b.h / 2 - total / 2
    const kidX = side === 1 ? x + b.w + GAP_X : x - GAP_X
    kids.forEach((k, i) => {
      const c = at + heights[i] / 2
      place(k, depth + 1, c, kidX, side)
      at += heights[i] + GAP_Y
    })
  }

  // 根节点在原点，纵向中轴 0
  const rp = pos[root.id]
  out.push({ id: root.id, x: rp ? rp.x : 0, y: rp ? rp.y : -rb.h / 2, depth: 0, w: rb.w, h: rb.h, side: 1 })

  const kids = isHidden(root, 0, fold) ? [] : root.children || []
  if (!kids.length) return out
  const rootY = rp ? rp.y + rb.h / 2 : 0   // 跟 place 一样：被拖过就按落点算中轴

  /* 左右怎么分：奇数个时右边多一个（人的视线从左上进来，右边多一点更自然）。
     分成两组后各自独立摞高度 —— 两边互不影响，这一支长得再长也不会把对面顶歪。 */
  const half = Math.ceil(kids.length / 2)
  const groups: { side: 1 | -1; list: TNode[] }[] = [
    { side: 1, list: kids.slice(0, half) },
    { side: -1, list: kids.slice(half) },
  ]
  for (const g of groups) {
    if (!g.list.length) continue
    const heights = g.list.map((k) => heightOf(k, 1))
    const total = heights.reduce((s, h) => s + h, 0) + GAP_Y * (g.list.length - 1)
    let at = rootY - total / 2
    /* 起点必须从**盒边**算，不是从中心：
       根节点自身占 [0, rb.w] —— 用 rb.w/2 当量出来的起点会让右支压在主题块上，
       左支反倒离得远远的，两边不对称，一眼就看得出歪。
       左右各自从自己那条边外推 GAP_X，才是对称的一左一右。 */
    const startX = g.side === 1 ? rb.w + GAP_X : -GAP_X
    g.list.forEach((k, i) => {
      const c = at + heights[i] / 2
      place(k, 1, c, startX, g.side)
      at += heights[i] + GAP_Y
    })
  }
  return out
}

/* ---------------------------------------------------------------------------
   竖树：父在上、子在下，父节点横向落在这堆孩子的中点。像组织架构图。
   --------------------------------------------------------------------------- */
export function treeV(root: TNode, fold: Record<string, 1> = {}, pos: Record<string, Pt> = {}): LaidNode[] {
  const out: LaidNode[] = []
  let cursor = 0
  const walk = (n: TNode, depth: number): { left: number; right: number } => {
    const b = boxOf(n, depth)
    const kids = n.children || []
    const hidden = isHidden(n, depth, fold)
    let left: number
    let right: number
    if (!kids.length || hidden) {
      left = cursor
      right = cursor + b.w
      cursor = right + 26
    } else {
      const spans = kids.map((k) => walk(k, depth + 1))
      left = spans[0].left
      right = spans[spans.length - 1].right
    }
    const p = pos[n.id]
    out.push({
      id: n.id,
      x: p ? p.x : (left + right) / 2 - b.w / 2,
      y: p ? p.y : 40 + depth * V_STEP,
      depth, w: b.w, h: b.h, side: 1,
    })
    return { left, right }
  }
  walk(root, 0)
  return out
}

/* ---------------------------------------------------------------------------
   放射：根在原点，按层分环，每层的角度按该层「需要的弧长」占比分配，
   子节点落进父节点分到的那段扇区里。分支多的方向角度就大，扇叶不会互相压住。
   --------------------------------------------------------------------------- */
export function radial(root: TNode, fold: Record<string, 1> = {}, pos: Record<string, Pt> = {}): LaidNode[] {
  const out: LaidNode[] = []
  const weight = new Map<string, number>()
  const measure = (n: TNode, depth: number): number => {
    const b = boxOf(n, depth)
    const kids = isHidden(n, depth, fold) ? [] : n.children || []
    if (!kids.length) {
      const w = b.w + 26
      weight.set(n.id, w)
      return w
    }
    const w = kids.reduce((s, k) => s + measure(k, depth + 1), 0)
    weight.set(n.id, w)
    return w
  }
  measure(root, 0)

  const place = (n: TNode, depth: number, from: number, to: number) => {
    const r = depth * R_STEP
    const mid = (from + to) / 2
    const b = boxOf(n, depth)
    const px = Math.cos(mid) * r - b.w / 2
    const py = Math.sin(mid) * r - b.h / 2
    const p = pos[n.id]
    out.push({ id: n.id, x: p ? p.x : px, y: p ? p.y : py, depth, w: b.w, h: b.h, side: Math.cos(mid) >= 0 ? 1 : -1 })

    const kids = isHidden(n, depth, fold) ? [] : n.children || []
    if (!kids.length) return
    const total = kids.reduce((s, k) => s + (weight.get(k.id) || 1), 0) || 1
    let at = from
    kids.forEach((k) => {
      const span = ((weight.get(k.id) || 1) / total) * (to - from)
      place(k, depth + 1, at, at + span)
      at += span
    })
  }
  const kidCount = (isHidden(root, 0, fold) ? [] : root.children || []).length
  const sweep = kidCount >= 3 ? Math.PI * 2 : kidCount === 2 ? Math.PI : Math.PI * 0.9
  const start = -Math.PI / 2 - sweep / 2
  place(root, 0, start, start + sweep)
  return out
}

export function autoLayout(
  mode: LayoutMode,
  root: TNode,
  fold: Record<string, 1> = {},
  pos: Record<string, Pt> = {},
): LaidNode[] {
  if (mode === 'treeV') return treeV(root, fold, pos)
  if (mode === 'radial') return radial(root, fold, pos)
  return mind(root, fold, pos)
}

/* 连线形态跟着布局走：
   - 思维导图：默认贝塞尔曲线（一端水平出、一端水平进，像导图的粗枝）
   - 竖树：折线（父下沿接子上沿，拐直角才像组织架构）
   - 放射：直线（环与环之间走直线最干净，曲线会绕成麻花） */
export function edgeTypeOf(mode: LayoutMode): 'smoothstep' | 'default' | 'straight' {
  if (mode === 'treeV') return 'smoothstep'
  if (mode === 'radial') return 'straight'
  return 'default'
}

/** 三种布局的中文名，顶栏按钮与键盘提示共用一份，别两边各写一遍。 */
export const LAYOUT_CN: Record<LayoutMode, string> = {
  mind: '导图',
  treeV: '纵向',
  radial: '放射',
}

/* ---------------------------------------------------------------------------
   本机偏好：读一个只可能是几个固定值的开关。
   localStorage 里的东西不可信（手改过、旧版本留下的），白名单以外一律回默认。
   --------------------------------------------------------------------------- */
export function lsPick<T extends string>(key: string, allowed: readonly T[], dft: T): T {
  try {
    const v = localStorage.getItem(key)
    // 旧版本存的是 'treeH'（横树），现在叫 'mind' —— 认识的留着，不认识的回默认，
    // 不要把老值当新值用（'treeH' 早就不在布局表里了）。
    return (allowed as readonly string[]).includes(String(v)) ? (v as T) : dft
  } catch { return dft }
}

export function lsFlag(key: string, dft: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return dft
    return v === '1' || v === 'true'
  } catch { return dft }
}

/** 存布尔开关。隐私模式下写不进去，吞掉 —— 不影响这一页能用。 */
export function lsSetFlag(key: string, on: boolean) {
  try { localStorage.setItem(key, on ? '1' : '0') } catch { /* noop */ }
}

/** 迷你地图那一个开关的键。写错字就谁也不认谁，所以只在这里出现一次。 */
export const LS_MINIMAP = 'sd.cv.minimap'
export const LS_LAYOUT = 'sd.cv.layout'
export const LAYOUTS: readonly LayoutMode[] = ['mind', 'treeV', 'radial'] as const
