import type { ReactElement, SVGProps } from 'react'

// 一律自绘 SVG，禁止 emoji 当功能图标（项目铁律）。
const P: Record<string, ReactElement> = {
  today: <><circle cx="9" cy="9" r="7" fill="none" /><path d="M9 5.5V9l2.6 1.6" fill="none" /></>,
  classroom: <><path d="M3 5l6 4 6-4" fill="none" /><rect x="3" y="4" width="12" height="11" rx="2" fill="none" /></>,
  courses: <><rect x="3" y="3" width="5.5" height="5.5" rx="1.4" fill="none" /><rect x="9.5" y="3" width="5.5" height="5.5" rx="1.4" fill="none" /><rect x="3" y="9.5" width="5.5" height="5.5" rx="1.4" fill="none" /><rect x="9.5" y="9.5" width="5.5" height="5.5" rx="1.4" fill="none" /></>,
  schedule: <><rect x="3" y="4" width="12" height="11" rx="2" fill="none" /><path d="M3 7.5h12M6.5 2.5v3M11.5 2.5v3" fill="none" /></>,
  vocab: <><path d="M4 3h8.5L16 6.5V15a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 3 15V4.5A1.5 1.5 0 0 1 4.5 3z" fill="none" /><path d="M6.5 8h5M6.5 11h3.5" fill="none" /></>,
  practice: <><circle cx="9" cy="9" r="7" fill="none" /><path d="M6.5 9.5l1.8 1.8 3.4-4" fill="none" /></>,
  exam: <><path d="M4.5 3h9v13l-4.5-2.4L4.5 16V3z" fill="none" /><path d="M7 7h4M7 10h3" fill="none" /></>,
  stats: <><path d="M3.5 15.5V9M8 15.5V4.5M12.5 15.5v-8M17 15.5v-4" fill="none" /></>,
  writing: <><path d="M3 15.5l1-4L13 3l2.6 2.6L6.5 14.5z" fill="none" /><path d="M11.5 4.5l2.6 2.6" fill="none" /></>,
  agent: <><circle cx="9" cy="9" r="2.6" fill="none" /><path d="M9 2.5v2M9 13.5v2M2.5 9h2M13.5 9h2M4.7 4.7l1.4 1.4M11.9 11.9l1.4 1.4M13.3 4.7l-1.4 1.4M6.1 11.9l-1.4 1.4" fill="none" /></>,
  canvas: <><circle cx="4.5" cy="9" r="2.2" fill="none" /><circle cx="13.5" cy="4.5" r="2.2" fill="none" /><circle cx="13.5" cy="13.5" r="2.2" fill="none" /><path d="M6.5 8.2l4.8-2.9M6.5 9.8l4.8 2.9" fill="none" /></>,
  play: <path d="M5.5 3.5l9 5.5-9 5.5z" />,
  // 停止：实心方块。跟 play 一对 —— 发送中它替换发送键。
  stop: <rect x="5.2" y="5.2" width="7.6" height="7.6" rx="1.5" />,
  // 重新拉取：开口环 + 箭头
  refresh: <><path d="M14.5 9a5.5 5.5 0 1 1-1.6-3.9" fill="none" /><path d="M14.8 3.4v3.4h-3.4" fill="none" /></>,
  // 底部状态条：计时圈 / 用量堆叠
  clock: <><circle cx="9" cy="9" r="6.4" fill="none" /><path d="M9 5.4V9l2.7 1.6" fill="none" /></>,
  stack: <><ellipse cx="9" cy="5.2" rx="5.4" ry="2.1" fill="none" /><path d="M3.6 5.2v7.6c0 1.2 2.4 2.1 5.4 2.1s5.4-.9 5.4-2.1V5.2" fill="none" /><path d="M3.6 9c0 1.2 2.4 2.1 5.4 2.1s5.4-.9 5.4-2.1" fill="none" /></>,
  chev: <path d="M6 4l5 5-5 5" fill="none" />,
  plus: <path d="M9 4v10M4 9h10" fill="none" />,
  minus: <path d="M4 9h10" fill="none" />,
  check: <path d="M4 9.5l3.5 3.5L15 5.5" fill="none" />,
  x: <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" fill="none" />,
  search: <><circle cx="8" cy="8" r="5" fill="none" /><path d="M11.8 11.8l3.4 3.4" fill="none" /></>,
  cam: <><path d="M2.5 6.5h3l1-1.5h5l1 1.5h3v9h-13z" fill="none" /><circle cx="9" cy="10.5" r="2.6" fill="none" /></>,
  gal: <><rect x="2.5" y="4" width="13" height="10" rx="1.6" fill="none" /><path d="M2.5 11l3.4-3 3 2.6 2.4-2 3.7 3" fill="none" /></>,
  img: <><rect x="2.5" y="3.5" width="13" height="11" rx="1.6" fill="none" /><circle cx="6.5" cy="7" r="1.4" fill="none" /><path d="M2.5 12l3.6-3.4 3 2.6 2.2-1.9 4 3.2" fill="none" /></>,
  undo: <path d="M6 5.5L3 9l3 3.5M3 9h7.5a4.5 4.5 0 1 1 0 9H7" fill="none" />,
  redo: <path d="M12 5.5L15 9l-3 3.5M15 9H7.5a4.5 4.5 0 1 0 0 9H11" fill="none" />,
  fit: <path d="M3 6V3h3M15 6V3h-3M3 12v3h3M15 12v3h-3" fill="none" />,
  // 「铺满」：四角朝外。fit 是四角朝里（收紧），两个方向得分得清，
  // 否则影院模式开着的时候看不出点下去是打开还是收起。
  full: <path d="M6.5 3H3v3.5M11.5 3H15v3.5M6.5 15H3v-3.5M11.5 15H15v-3.5" fill="none" />,
  sound: <><path d="M4 7.5h2.5L10 4.5v9L6.5 10.5H4z" fill="none" /><path d="M12.2 6.8a3.6 3.6 0 0 1 0 4.4M14 5.2a6 6 0 0 1 0 7.6" fill="none" /></>,
  // 麦克风：胶囊 + 托弧 + 立杆。录音时按钮会换成实心红底，图形本身不改 ——
  // 「再点一下停」比「图标从麦克风变成方块」好认。
  mic: <><rect x="7" y="2.2" width="4" height="8" rx="2" fill="none" /><path d="M4.6 8.4a4.4 4.4 0 0 0 8.8 0" fill="none" /><path d="M9 12.8v2.9" fill="none" /></>,
  star: <path d="M9 2.8l1.9 4 4.4.6-3.2 3 .8 4.3L9 12.7l-3.9 2 .8-4.3-3.2-3 4.4-.6z" />,
  down: <path d="M4 7l5 5 5-5" fill="none" />,
  cloud: <><path d="M5.6 13.5h7.2a3.2 3.2 0 0 0 .3-6.4A4.6 4.6 0 0 0 4.4 8a3 3 0 0 0 1.2 5.5z" fill="none" /><path d="M9 15.5v-5M7 12.6l2 2 2-2" fill="none" /></>,
  trash: <><path d="M3.5 5.5h11M7.5 5.5V4h3v1.5" fill="none" /><path d="M5.2 5.5l.7 9.5h6.2l.7-9.5" fill="none" /></>,
  tag: <><path d="M3 8.5V4h4.5l7 7-4.5 4.5z" fill="none" /><circle cx="6.2" cy="6.6" r="1" fill="none" /></>,
  // Canvas 里用到但一直缺的三个（缺了会 fallback 成「今日」图标，等于画错）。
  node: <><rect x="2.5" y="7" width="5" height="4" rx="1.2" fill="none" /><rect x="10.5" y="2.5" width="5" height="4" rx="1.2" fill="none" /><rect x="10.5" y="11.5" width="5" height="4" rx="1.2" fill="none" /><path d="M7.5 9h1.4V4.5h1.6M8.9 9v4.5h1.6" fill="none" /></>,
  md: <><rect x="3" y="2.5" width="12" height="13" rx="1.6" fill="none" /><path d="M5.5 12V6.5l2 2.6 2-2.6V12M12.5 6.5V12" fill="none" /></>,
  dl: <><path d="M9 2.5v8M6 7.8l3 3 3-3" fill="none" /><path d="M3.5 12.5v2h11v-2" fill="none" /></>,
  // 课堂页的两栏开关：左边一条竖栏 + 箭头，暗示「这一栏在/不在」。
  'panel-left': <><rect x="2.5" y="3.5" width="13" height="11" rx="2" fill="none" /><path d="M7 3.5v11" fill="none" strokeWidth="1.5" /></>,
  'panel-right': <><rect x="2.5" y="3.5" width="13" height="11" rx="2" fill="none" /><path d="M11 3.5v11" fill="none" strokeWidth="1.5" /></>,
}

export type IconName = keyof typeof P

export function Icon({ n, size = 18, ...rest }: { n: IconName | string; size?: number } & SVGProps<SVGSVGElement>) {
  const body = P[n] ?? P.today
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 18 18" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" aria-hidden {...rest}>
      {body}
    </svg>
  )
}
