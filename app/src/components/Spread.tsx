import { type ReactNode } from 'react'

/* 把一串题按「一张纸装得下多少」切成几段，再并排成几张纸。
 *
 * 分段的规矩（用户定的，别自己发明）：
 *   · 一「题」= 题干 + 它自己的选项。题干和选项永远在一起，不跨纸。
 *   · 屏幕够宽就摆两张纸（甚至更多），够高就一张纸装更多题。
 *   · 装不下才换下一张 —— 不是固定每张 N 题。
 *
 * 尺寸是估的：视口内高减去外壳占的，按一道题约 110px 去算。
 * 估偏了也只会多出一张纸或一张纸短一点，不会漏题。
 */
export function paginate<T>(items: T[], per: number): T[][] {
  const n = Math.max(1, per)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out.length ? out : [[]]
}

/* 视口内可用高度 → 一张纸能装几道题。
 * reserve 是这张纸外面还占着的高度（外壳、chip 行、纸头）。 */
export function perLeaf(reserve = 300, rowH = 110, min = 2, max = 12): number {
  const h = (typeof window === 'undefined' ? 900 : window.innerHeight) - reserve
  return Math.max(min, Math.min(max, Math.floor(h / rowH)))
}

export function Leaf({ children }: { children: ReactNode }) {
  return <div className="leaf-mn">{children}</div>
}

/* 折起来的一摞纸。叶子怎么排、几张，由调用方决定 ——
   这里只管「横着排、中间不留空白」这一层。 */
export function Spread({ cols, children }: { cols: number; children: ReactNode }) {
  return (
    <div className="qspread-mn" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))` }}>
      {children}
    </div>
  )
}
