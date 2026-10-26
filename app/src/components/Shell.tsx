import { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { callTool, type Base } from '../lib/api'

export type PageKey =
  | 'today' | 'classroom' | 'courses' | 'schedule' | 'vocab'
  | 'practice' | 'exam' | 'stats' | 'writing' | 'agent' | 'canvas'

export type NavItem = { k: PageKey; t: string; n: IconName; cnt?: (b: Base) => number }

/* 十一个入口平铺在一列，等于没有分组 —— 用户每次都要从头扫到尾。
   按「今天做什么 / 学什么 / 记下什么 / 配置」四层收拢，数字只留在真能数的入口上。
   设置永远在最后：换模型、导题库、备份同步都在那一页，藏起来等于没有。 */
export const NAVGRP: { g?: string; items: NavItem[] }[] = [
  { items: [{ k: 'today', t: '今日', n: 'today' }] },
  {
    g: '学',
    items: [
      // 课堂是「正在学的那一讲」，不是全库总数 —— 挂 889 会和课程库撞成两个一样的数。
      { k: 'classroom', t: '课堂', n: 'classroom' },
      { k: 'courses', t: '课程库', n: 'courses', cnt: (b) => b.kpi?.lesson_total ?? 0 },
      { k: 'schedule', t: '课表', n: 'schedule' },
      { k: 'vocab', t: '背单词', n: 'vocab', cnt: (b) => b.kpi?.vocab_total ?? 0 },
      { k: 'practice', t: '练习', n: 'practice', cnt: (b) => b.exercise_bank?.total ?? 0 },
      { k: 'exam', t: '考场', n: 'exam', cnt: (b) => b.kpi?.exam_papers ?? 0 },
    ],
  },
  {
    g: '记',
    items: [
      { k: 'stats', t: '统计', n: 'stats' },
      { k: 'writing', t: '作文', n: 'writing' },
      { k: 'canvas', t: '画布', n: 'canvas' },
    ],
  },
  { g: '设', items: [{ k: 'agent', t: '设置', n: 'agent' }] },
]

export const NAV: NavItem[] = NAVGRP.reduce<NavItem[]>((a, x) => a.concat(x.items), [])

export const TITLES: Record<PageKey, { kick: string; h1: string; sub: string }> = {
  today: { kick: '今日', h1: '今天怎么排', sub: '按「断点续学 > 到期复习 > 最大错因 > 未开科目」现场算' },
  classroom: { kick: '课堂', h1: '一屏学完一讲', sub: '视频 + 讲义 + 本讲词群 + 当堂测' },
  courses: { kick: '课程库', h1: '课程 + 本地资料', sub: '进度直接读本机数据' },
  schedule: { kick: '课表', h1: '这七天怎么排', sub: '计划由规则生成，完成情况来自真实记录' },
  vocab: { kick: '背单词', h1: '今天背这一组', sub: 'SM-2 记忆状态存在本机数据库，评分即落库' },
  practice: { kick: '练习', h1: '按考点刷', sub: '所有题源共用一张表 · 判分在服务端，不提前泄答案' },
  exam: { kick: '考场', h1: '真题卷', sub: '答案来自 exam_papers.json' },
  stats: { kick: '统计', h1: '家底与进度', sub: '只展示能核对到源头的数字' },
  writing: { kick: '作文', h1: '写一篇', sub: '本机先数能数的（词数 / 要点 / 格式），语言与文采要模型判 —— 模型没接就写「没判」，不给分' },
  agent: { kick: '设置', h1: '能力与数据', sub: '模型、题源、备份、同步 —— 所有能力都是可调用工具，点一行就真调一次' },
  canvas: { kick: '画布', h1: '笔记画布', sub: '导图存在本机，可拉 XMind / Obsidian 等来源' },
}

export function Shell({
  page, onGo, base, children, topRight,
}: {
  page: PageKey
  onGo: (p: PageKey) => void
  base: Base | null
  children: React.ReactNode
  topRight?: React.ReactNode
}) {
  const t = TITLES[page]
  return (
    // 画布页把侧栏收成 56px 图标条（开发文档 3.1）：画布是「一屏都在画」，一条 236px 的
    // 常驻导航在那儿会一直抢走一条地。其它页照常展开 —— 不留给用户手动收，切页就恢复。
    <div className={'app app-mn' + (page === 'canvas' ? ' focus' : '')}>
      <aside className="rail">
        {/* 品牌与「接着学」卡都在滚动条外面：
            品牌是路标，不该跟着导航一起滚走；底卡是常驻入口，滚到下面才看见等于没有。
            只有中间那串分组会滚 —— 以后再加页面，也是这一串变长。 */}
        <div className="brand">
          <div className="lg">研</div>
          <div><b>研学台</b><span>StudyDeck · 2027 专升本</span></div>
        </div>
        <div className="rail-in">
          <nav className="nav">
            {NAVGRP.map((grp, gi) => (
              <div className="navgrp" key={grp.g || gi}>
                {/* 分组标题只做路标，不占点击面积：一排小字比十一个同级入口好扫。 */}
                {grp.g ? <div className="gh">{grp.g}</div> : null}
                {grp.items.map((it) => (
                  <button key={it.k} className={'nv' + (page === it.k ? ' on' : '')}
                    /* title 平时看不见，收起成图标条时它就是 tooltip —— 图标条上只剩图标，
                       没有名字的图标等于猜。计数跟着名字一起收，不单独留一个孤零零的数。 */
                    title={it.t + (it.cnt && base ? ' · ' + it.cnt(base) : '')}
                    aria-label={it.t}
                    onPointerDown={(e) => { e.currentTarget.classList.add('press'); setTimeout(() => e.currentTarget.classList.remove('press'), 130) }}
                    onClick={() => onGo(it.k)}>
                    <Icon n={it.n} className="ic" size={15} />
                    {it.t}
                    {it.cnt && base ? <span className="cn">{it.cnt(base)}</span> : null}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </div>
        <RailFoot onGo={onGo} base={base} />
      </aside>
      <div className="main">
        <header className="top">
          {/* key 一换，标题就重新进场：切页时字从下方 4px 浮上来，
              不是整条顶栏闪一下。只动标题，不动右边那排 pill —— 那些是常驻的。 */}
          <h2 key={page}>{t.h1}</h2>
          <span className="nt" key={page + '-sub'}>{t.sub}</span>
          <div className="sp">
            {topRight}
          </div>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  )
}

function RailFoot({ onGo, base }: { onGo: (p: PageKey) => void; base: Base | null }) {
  // 断点位置要真查，不能写死一句「还没取到」。
  const cur = useToolCur(base)
  const has = !!cur?.lesson?.title
  const t = cur?.lesson?.title || '还没有断点'
  const sub = has
    ? (cur?.lesson?.chapter || '')
    : '本机还没有课程数据 —— 去「设置」导一份，或者直接跟助手说你要学什么'
  return (
    // 外层 .railbt 是 v6 的行内边距容器，内层 .railfoot 是老样式里的卡片 ——
    // 两层都得在：v6 的 focus 收起规则挂在 .railbt 上，老样式挂在 .railfoot 上。
    <div className="railbt">
    <div className="railfoot">
      <div className="k">接着学</div>
      <div className="t" title={t}>{t}</div>
      <div className="m" title={sub}>{sub}</div>
      {/* 有一讲真能接着学，才给这颗按钮。
          空库里挂着「继续这一讲」= 点进去一片空白，比没有按钮更糟。 */}
      {has
        ? <button className="go" title="继续这一讲" onClick={() => onGo('classroom')}>
            {/* 侧栏收起时按钮只剩 40px，字被 font-size:0 收掉了 —— 留一枚图标兜底，
                免得收起来之后那里是个空白方块。 */}
            <Icon n="play" size={15} />
            <span className="go-t">继续这一讲</span>
          </button>
        : <button className="go ghost" title="去导课程" onClick={() => onGo('agent')}>
            <Icon n="plus" size={15} />
            <span className="go-t">去导课程</span>
          </button>}
    </div>
    </div>
  )
}

// 侧栏底部只要断点那一讲，单独拉一次，不跟页面抢 useTool 的生命周期。
function useToolCur(_base: Base | null) {
  const [d, setD] = useState<{ lesson?: { title?: string; chapter?: string } } | null>(null)
  const [tick, setTick] = useState(0)
  // base 换了（15 秒轮询）就重查 —— 入库刚发生，别让侧栏一直挂「还没有断点」。
  useEffect(() => { setTick(t => t + 1) }, [_base])
  useEffect(() => {
    let alive = true
    // 写死 subject:'english' 是通用性的漏网之鱼：空库 / 别的考试根本没有英语。
    // 不传 subject，让后端按「最近动过」挑断点。
    callTool('get_current_lesson', {}).then((r) => {
      if (alive) setD((r.data as any) || null)
    }).catch(() => {})
    return () => { alive = false }
  }, [tick])
  return d
}

// 通用小件，各页直接用，别再各写一份。
// v6：这些还留在 Shell 里是因为画布页在用；页面自己的容器已经从 V6.tsx 取。
export function Sec({ title, note, children, style }: { title: string; note?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="blkcard-mn" style={style}>
      <div className="hd"><b>{title}</b>{note ? <span>{note}</span> : null}</div>
      {children}
    </div>
  )
}

export function Kpi({ k, v, unit, pctv, green }: { k: string; v: string | number; unit?: string | number; pctv?: number; green?: boolean }) {
  return (
    <div className="kpi">
      <div className="k">{k}</div>
      <div className="v">{v}{unit ? <small>/ {unit}</small> : null}</div>
      {pctv != null ? <div className={'bar' + (green ? ' g' : '')}><i style={{ width: Math.max(0, Math.min(100, pctv)) + '%' }} /></div> : null}
    </div>
  )
}

export function Row({ nm, v, pctv }: { nm: string; v: string | number; pctv?: number }) {
  return (
    <div className="statrow">
      <span className="nm">{nm}</span>
      <div className="bar"><i style={{ width: Math.max(0, Math.min(100, pctv ?? 0)) + '%' }} /></div>
      <span className="v">{v}</span>
    </div>
  )
}

export function Tag({ children, c }: { children: React.ReactNode; c?: 'a' | 'g' | 'r' }) {
  return <span className={'tagg' + (c ? ' ' + c : '')}>{children}</span>
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="galempty" style={{ padding: '26px 18px', textAlign: 'center' }}>{children}</div>
}

export function Err({ children }: { children: React.ReactNode }) {
  return (
    <div className="blkcard-mn" style={{ borderColor: 'rgba(255,107,74,.4)' }}>
      <div className="hd"><b style={{ color: 'var(--bad)' }}>没取到</b></div>
      <div className="note-mn">{children}</div>
    </div>
  )
}
