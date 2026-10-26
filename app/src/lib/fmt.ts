/* 几个页面都要用的取值兜底，集中一处，别再各写一份。 */

// UP 主名：正式库里是字符串，B 站落库的课里带回来的是 {mid,name,face} 对象。
// 直接把对象塞进 JSX 会触发 React #31（对象不能当子节点），整页白屏 —— 实测过一次。
export function upName(v: unknown): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return String((v as any).name ?? (v as any).uname ?? (v as any).owner ?? '') || ''
  return String(v)
}

// 分钟 → 「3 小时 12 分」；不到一小时只写分钟。
export function hm(min: number | null | undefined): string {
  const m = Math.max(0, Math.round(min ?? 0))
  if (m < 60) return m + ' 分钟'
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`
}

// 只留日期里的 MM-DD，用来做时间轴表头。
export function md(date: string): string {
  return (date || '').slice(5).replace('-', '/')
}

export const WD = ['一', '二', '三', '四', '五', '六', '日']
