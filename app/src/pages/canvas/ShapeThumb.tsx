/* 一张图在哪儿都长一个样。
   这个文件是从 Canvas.tsx 里搬出来的 —— 课堂右栏的笔记卡以前自己画了一套
   「一列带点的字」，跟图库里那张导图缩略图完全不像同一个东西。 */
/* 导图缩略图。图库卡片、课堂右栏的笔记卡、画布左栏的画布列表都用这一个 ——
   三处以前各写一套，形状还不一样（左栏和课堂右栏还是「一列带点的字」），
   同一样东西在三个地方长三种样子，认不出是同一张图。
   W/H 是画布坐标的宽高，vw/vh 是它在页面上实际占的尺寸，两者可以不相等（会等比缩放）。 */
export function ShapeThumb({ shape, W = 300, H = 118, cls = 'sthumb mind' }: {
  shape?: any; W?: number; H?: number; cls?: string
}) {
  if (!shape) return <span className="sthumb empty">空画布</span>

  type N = { t: string; col?: string; kids: N[] }
  /* 图片节点：缩略图上画不了图，也不该露出一串 ![alt](path) 的原始记号 ——
     显示 alt 文案；连 alt 都没有就写「图片」，至少认得出这是个节点。 */
  const thumbText = (raw: string) => {
    const m = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(String(raw || ''))
    if (!m) return String(raw || '').trim()
    return m[1].trim() || '图片'
  }
  const toN = (n: any): N | null => {
    if (!n) return null
    const kids: N[] = []
    for (const c of n.c || []) {
      const k = toN(c)
      if (k) kids.push(k)
    }
    return { t: thumbText(n.t), col: n.col, kids }
  }
  const root = toN(shape)
  if (!root) return <span className="sthumb empty">空画布</span>
  const branches = root.kids.filter((k) => k.t)
  if (!branches.length) return <span className="sthumb empty">空画布</span>

  /* 缩略图只画「主题 + 一层分支」。
     早先试过画到二级：300px 宽里要塞下主题、两侧分支、再加两侧的孙子，
     结果是字号得压到 7.5px、盒子互相叠 —— 看着像一串标点，不像导图。
     缩略图的职责是「一眼认出这是一张什么形状的图」，不是把字读全。 */
  const cx = W / 2, cy = H / 2
  /* 字号下限不能只是「看着不糊」，还得跟**分支数**配合 ——
     196×54 这种小卡里，3 个分支只用 H*0.22 的行距摞起来，
     盒子只有 H*0.178 高（约 9.6px）、字 6px，实际渲染出来是一坨深色块，
     用户看到的就是「课堂右栏那张画布是个黑方块」。
     这里做两件事：
       ① 字号按「盒子高度」而不是整张图的高度算，盒子高才是字真正的容身处；
       ② 分支太多时不再硬塞，只画前 N 个并在末尾用「+n」示意 —— 缩略图的职责是
          「一眼认出这是什么形状」，塞满只会糊成一片。 */
  const maxRows = H < 80 ? 3 : 6
  const showBranches = branches.length > maxRows ? branches.slice(0, maxRows - 1) : branches
  const moreCount = branches.length - showBranches.length
  const rowH = H * 0.178
  const FS = Math.max(7, Math.min(H * 0.19, Math.round(rowH * 0.62 * 10) / 10))
  const chw = (c: string) => (c.charCodeAt(0) > 0x2e80 ? FS * 0.75 : FS * 0.43)
  const tw = (t: string) => {
    let w = 0
    for (const c of t) w += chw(c)
    return w
  }
  const clip = (t: string, max: number) => {
    let out = '', w = 0
    for (const c of t) {
      const cw = chw(c)
      if (w + cw > max - FS * 1.4) break
      out += c; w += cw
    }
    return out
  }

  /* 盒子宽必须按「还剩多少地方」算，不能写死。
     实测过的翻车：主题一宽（「函数的单调性」被撑到 132），右侧那支的盒子右边缘就到了 328，
     viewBox 只有 300 —— 文字直接被切掉一半，看着像画错了。 */
  const PAD = 5, GAP = Math.max(8, Math.round(W * 0.047))
  const ROOT_MAX = Math.round(W * 0.35)
  const rootW = Math.min(ROOT_MAX, Math.round(tw(root.t || '') + 20))
  const rootH = Math.round(H * 0.195)
  /* 每侧能用多宽：半张图 - 主题一半 - 间距 - 边距 */
  const avail = Math.floor(W / 2 - rootW / 2 - GAP - PAD)

  const half = Math.ceil(showBranches.length / 2)
  const right = showBranches.slice(0, half)
  const left = showBranches.slice(half)
  /* 行距按「这一侧有几支」算。固定值在三支时挤成一条，在七支时又漏出画布。 */
  const rowOf = (n: number) => (n <= 1 ? 0 : Math.min(H * 0.22, (H * 0.81) / (n - 1)))
  const BOX_MAX = Math.max(30, Math.min(Math.round(W * 0.32), avail))

  type P = { x: number; y: number; n: N; side: 1 | -1; w: number }
  const pts: P[] = []
  const place = (list: N[], side: 1 | -1) => {
    const row = rowOf(list.length)
    const startY = cy - ((list.length - 1) * row) / 2
    list.forEach((n, i) => {
      const y = startY + i * row
      const w = Math.min(BOX_MAX, Math.round(tw(n.t) + FS * 1.6))
      const x = cx + side * (rootW / 2 + GAP + w / 2)
      pts.push({ x, y, n, side, w })
    })
  }
  place(right, 1)
  place(left, -1)

  const curve = (p: P) => {
    const sx = cx + p.side * (rootW / 2 + 1)
    const ex = p.x - p.side * (p.w / 2 + 1)
    const mx = sx + p.side * Math.max(12, Math.abs(ex - sx) * 0.55)
    return `M${sx},${cy} C${mx},${cy} ${mx},${p.y} ${ex},${p.y}`
  }

  return (
    <span className={cls}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {pts.map((p, i) => (
          <path key={'e' + i} d={curve(p)} fill="none"
            stroke={p.n.col || 'var(--cvedge)'} strokeWidth={Math.max(1.1, H * 0.016)} opacity=".9" />
        ))}
        {pts.map((p, i) => (
          <g key={'b' + i}>
            <rect x={p.x - p.w / 2} y={p.y - H * 0.089} width={p.w} height={H * 0.178} rx={Math.max(3, H * 0.05)}
              fill="var(--cvnode)" stroke={p.n.col || 'var(--cvline)'} strokeWidth="1.1" />
            <text x={p.x} y={p.y + FS * 0.36} fontSize={FS} textAnchor="middle" fill="var(--cvtx)">
              {clip(p.n.t, p.w)}
            </text>
          </g>
        ))}
        {/* 主题：中间那块实心琥珀。它必须写得出标题 —— 一枚空胶囊没人认得出这是导图。 */}
        <rect x={cx - rootW / 2} y={cy - rootH / 2} width={rootW} height={rootH} rx={Math.max(4, H * 0.068)}
          fill="var(--cvroot)" />
        <rect x={cx - rootW / 2 - 2} y={cy - rootH / 2 - 2} width={rootW + 4} height={rootH + 4} rx={Math.max(5, H * 0.085)}
          fill="none" stroke="var(--cvroot)" strokeWidth="1" opacity=".22" />
        <text x={cx} y={cy + rootH * 0.18} fontSize={FS * 1.05} fontWeight="750" textAnchor="middle" fill="var(--cvroottx)">
          {clip(root.t || '', rootW)}
        </text>
        {/* 分支太多时，右下角标一个「+n」—— 缩略图只画得下几条，
            但「还有更多」这件事必须说出来，否则人会以为这张图就这么点内容。 */}
        {moreCount > 0 ? (
          <text x={W - 4} y={H - 4} fontSize={Math.max(8, FS * 0.95)} textAnchor="end"
            fill="var(--cvtx2)" opacity=".9">{'+' + moreCount}</text>
        ) : null}
      </svg>
    </span>
  )
}

