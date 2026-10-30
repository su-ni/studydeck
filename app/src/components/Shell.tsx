import { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { clsColor } from './V6'
import { Sel } from './Sel'
import { type Base } from '../lib/api'
import { useTool } from '../lib/useTool'

export type PageKey =
  | 'home' | 'today' | 'classroom' | 'courses' | 'schedule' | 'vocab'
  | 'practice' | 'notes' | 'notesAll' | 'exam' | 'stats' | 'writing' | 'agent' | 'canvas' | 'shots'
  | 'search'

export type NavItem = { k: PageKey; t: string; n: IconName; cnt?: (b: Base) => number }

/* 左栏定稿（docs/style-C-cover.html）：极窄图标条 56px。
   横向空间全部让给内容 —— 236px 的文字导航在 1440 屏上要吃掉十六分之一，
   而它每天只被点几次。图标 + hover 提示够用，选中项用左侧 2px 琥珀竖条标位。
   科目不在这里：它属于「当前课程」，放顶栏那条上下文里。 */
const ICON_NAV: { k: PageKey; t: string; n: IconName }[] = [
  { k: 'today', t: '今日', n: 'today' },
  { k: 'home', t: '课程主页', n: 'courses' },
  { k: 'classroom', t: '课堂', n: 'classroom' },
  { k: 'schedule', t: '课表', n: 'schedule' },
  { k: 'practice', t: '练习', n: 'practice' },
  /* 左栏这个「笔记」是全部课的笔记，不跟课程走 —— 顶栏那个「笔记」才是这一门课的。
     两个入口同时存在是有意的：一个是学到这一讲顺手记（跟课），一个是翻旧账（全局）。 */
  { k: 'notesAll', t: '笔记（全部课）', n: 'writing' },
  { k: 'vocab', t: '背单词', n: 'vocab' },
]

const ICON_NAV_TAIL: { k: PageKey; t: string; n: IconName }[] = [
  { k: 'exam', t: '考场', n: 'exam' },
  { k: 'stats', t: '统计', n: 'stats' },
  { k: 'courses', t: '课程库', n: 'courses' },
  { k: 'canvas', t: '画布', n: 'canvas' },
  /* 截图库：课堂上按 S 存下来的帧、画布导出的图、上传的图，全在这儿翻。
     以前只有课堂右栏（本讲 24 张）和画布抽屉能看到 —— 截了 200 张没处找。 */
  { k: 'shots', t: '截图库', n: 'img' },
  { k: 'agent', t: '设置', n: 'agent' },
]

/* 顶栏那组「这门课的视图」胶囊（C 稿的 .vt）：
   同属一门课的几个面，切换不离开这门课 —— 不用每次都回左栏找。

   固定五项是每门课都有的；「背单词」不是 —— 英语要背 3790 个词，高数不用背单词，
   所以它按科目出没（subject.has_vocab 由后端按词表归属算，不是前端写死名单）。 */
const COURSE_TABS_FIXED: { k: PageKey; t: string }[] = [
  { k: 'home', t: '课程主页' },
  { k: 'classroom', t: '课堂' },
  { k: 'schedule', t: '课表' },
  { k: 'practice', t: '练习' },
  { k: 'notes', t: '笔记' },
]

/* 这些页不属于「某一门课」，顶栏就不该出现那一排视图胶囊：
   今日是五门课混排，课程库/考场/统计是全局，画布和设置是工具，笔记总览是全部课。 */
const NO_COURSE_TABS: PageKey[] = ['today', 'courses', 'exam', 'stats', 'canvas', 'agent', 'notesAll', 'shots']

export const NAV: NavItem[] = ICON_NAV.concat(ICON_NAV_TAIL).map((x) => ({ k: x.k, t: x.t, n: x.n }))

export const TITLES: Record<PageKey, { kick: string; h1: string; sub: string }> = {
  home: { kick: '课程', h1: '这门课', sub: '' },
  today: { kick: '今日', h1: '今天怎么排', sub: '按「断点续学 > 到期复习 > 最大错因 > 未开科目」现场算' },
  /* 课堂页只要一个名字。以前那句「一屏学完一讲 / 视频+讲义+词群+当堂测」是宣传语，
     用户明确要删 —— 这一页干什么，用户比谁都清楚，不用自我介绍。 */
  classroom: { kick: '课堂', h1: '课堂', sub: '' },
  courses: { kick: '课程库', h1: '课程 + 本地资料', sub: '进度直接读本机数据' },
  schedule: { kick: '课表', h1: '这七天怎么排', sub: '计划由规则生成，完成情况来自真实记录' },
  vocab: { kick: '背单词', h1: '今天背这一组', sub: 'SM-2 记忆状态存在本机数据库，评分即落库' },
  practice: { kick: '练习', h1: '按考点刷', sub: '所有题源共用一张表 · 判分在服务端，不提前泄答案' },
  notes: { kick: '笔记', h1: '这门课的笔记', sub: '按讲次归位：哪一讲记的，就回到哪一讲' },
  notesAll: { kick: '笔记', h1: '全部笔记', sub: '五门课都在这里，按时间倒序' },
  exam: { kick: '考场', h1: '真题卷', sub: '答案来自 exam_papers.json' },
  stats: { kick: '统计', h1: '家底与进度', sub: '只展示能核对到源头的数字' },
  writing: { kick: '作文', h1: '写一篇', sub: '本机先数能数的（词数 / 要点 / 格式），语言与文采要模型判 —— 模型没接就写「没判」，不给分' },
  agent: { kick: '设置', h1: '能力与数据', sub: '模型、题源、备份、同步 —— 所有能力都是可调用工具，点一行就真调一次' },
  canvas: { kick: '画布', h1: '笔记画布', sub: '导图存在本机，可拉 XMind / Obsidian 等来源' },
  shots: { kick: '截图库', h1: '截过的每一帧', sub: '课堂按 S 存的帧、画布导出的图、上传的图 —— 按科目和关键词找得到' },
  search: { kick: '搜索', h1: '全局搜索', sub: '页面 / 能力 / 题考点词 / 语义 / 本机文件 / AI 会话 —— 一路并排' },
}

function coverOf(s: any): string {
  const c = String(s?.cover || '')
  if (!c) return ''
  return /^https?:\/\//i.test(c) ? c : '/' + c.replace(/^\//, '')
}

/* 顶栏搜索框。
   状态只放在自己身上：打字的时候不碰路由、不碰全局，所以敲字不会跳页。
   回车才把词塞进 #search?q=… —— 跳过去之后由 Search 页自己拿 q 去问后端。

   搜索页自己那个大输入框不再显示这一只（那会变成两个框）。
   画布页也不显示 —— 那一页的 Ctrl+F 唤的是画布自己的搜节点框，
   摆一个写着「Ctrl+F」的全局搜索框在那儿，等于告诉用户按下去会搜全局，
   而实际不会。这道闸在 Shell 的 JSX 里（{page !== 'canvas'}），
   不在这里：本组件只管「框长什么样、回车往哪跳」，该不该出现由调用方决定。 */
function TopSearch({ page, initial, big }: { page: PageKey; initial?: string; big?: boolean }) {
  const [v, setV] = useState(initial || '')
  const [on, setOn] = useState(false)
  /* initial 变了要跟着变：搜索页的词是从弹窗/地址栏来的，
     不跟过来的话框里会停在旧词上 —— 用户看到的和搜的就不是一回事了。 */
  useEffect(() => { setV(initial || '') }, [initial])
  return (
    <form
      className={'srchbox' + (on ? ' on' : '') + (big ? ' big' : '')}
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        const w = v.trim()
        if (w) location.hash = 'search?q=' + encodeURIComponent(w)
      }}
    >
      <Icon n="search" size={13} />
      <input
        value={v}
        placeholder="搜索"
        aria-label="全局搜索"
        onChange={(e) => setV(e.target.value)}
        onFocus={() => setOn(true)}
        onBlur={() => setOn(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setV(''); e.currentTarget.blur() } }}
      />
      {/* 只在没输入时显示快捷键提示：打字的时候它是干扰。
          画布页渲染不到这里（见上面那道闸），所以这个 Ctrl+F 不会出现在
          画布页上误导用户去按它搜全局。 */}
      {!v ? <kbd>Ctrl+F</kbd> : null}
    </form>
  )
}

export function Shell({
  page, onGo, base, children, topRight, sid, onSid, searchQ, hideSearch,
}: {
  page: PageKey
  /* entry 说明「这一次是从哪条路进去的」：顶栏胶囊 = tab，左栏图标 = rail。
     练习页靠这个决定默认范围（tab 跟着当前讲次，rail 是整门课）。 */
  onGo: (p: PageKey, o?: { sid?: string; entry?: 'tab' | 'rail' }) => void
  base: Base | null
  children: React.ReactNode
  topRight?: React.ReactNode
  sid?: string
  onSid?: (id: string) => void
  /* 搜索页顶栏那只框要显示「当前搜的词」，由 App 传下来。 */
  searchQ?: string
  /* 什么时候藏掉顶栏框：目前只有「Ctrl+F 弹窗开着」那一下 ——
     弹窗里有框、顶栏也有框，同屏两只框就是用户说的「三个搜索框」。
     藏掉顶栏那只，同一时刻画面里就只有一只。 */
  hideSearch?: boolean
  bare?: boolean
  /* bare 已废弃（pagehead 整个删了），参数留着只是兼容旧调用 —— 下次清理时去掉 */
}) {
  const t = TITLES[page]
  const subs: any[] = (base as any)?.subjects ?? []
  const cur = subs.find((s) => s.id === sid) || subs[0]
  /* 距考天数：诚实取，取不到就写「未设考试日期」—— 不编一个倒计时。 */
  const wk = useTool<{ days_left?: number; exam_date?: string }>('plan_week', { days: 1 })
  const daysLeft = wk.data?.days_left
  const done = cur?.lessons_done ?? 0
  const total = cur?.lessons_total ?? 0
  const cv = coverOf(cur)
  /* 封面渐变铺满整个内容区（不是只铺抬头那一条）。
     做法是把它挂到 .content 自己的背景上，background-attachment: fixed ——
     图钉在视口不动，正文从上面滚过去，等于一进屋就有一层环境光。
     只在课程主页挂：课堂/练习页要的是安静的黑，不是海报。 */
  const fullCv = page === 'home' && !!cv
  /* 这门课要不要背单词：后端按词表归属算（datahub.vocab_owner）。
     高数没有词表，就不出现这一项 —— 不是前端写死一份名单。 */
  const hasVocab = !!cur?.has_vocab
  const tabs = hasVocab ? COURSE_TABS_FIXED.concat([{ k: 'vocab' as PageKey, t: '背单词' }]) : COURSE_TABS_FIXED
  /* 哪些页不显示这排胶囊：全局页与工具页（见 NO_COURSE_TABS），
     「从左栏进来的背单词」—— 那一页看的是全部词书，不属于任何一门课，
     以及一门课都没有的时候（空库）—— 那排 tab 点了也没有内容可切。 */
  const showTabs = subs.length > 0 && NO_COURSE_TABS.indexOf(page) < 0
    && (page !== 'vocab' || hasVocab)

  return (
    <div className="app app-mn app-icons">
      <aside className="rail rail-icons">
        <div className="lg" title="研学台 StudyDeck">研</div>
        <nav className="railnav">
          {ICON_NAV.map((it) => (
            <button key={it.k} className={'rb' + (page === it.k ? ' on' : '')}
              title={it.t} aria-label={it.t}
              onClick={() => onGo(it.k, { sid, entry: 'rail' })}>
              <Icon n={it.n} size={16} />
            </button>
          ))}
        </nav>
        <div className="sp" />
        <nav className="railnav">
          {ICON_NAV_TAIL.map((it) => (
            <button key={it.k} className={'rb' + (page === it.k ? ' on' : '')}
              title={it.t} aria-label={it.t}
              onClick={() => onGo(it.k)}>
              <Icon n={it.n} size={16} />
            </button>
          ))}
        </nav>
      </aside>

      <div className="main">
        {/* 课程主页的背景光：把课程封面糊成一片色，铺满整个工作区（顶栏也在它上面）。
            它不是一张图 —— 是这门课的「环境色」，所以要虚到认不出字，只剩冷暖。
            用绝对定位挂在不滚动的 .main 上：正文滚，底色不动。 */}
        {fullCv ? (
          <div className="shell-cv" aria-hidden="true">
            <i style={{ backgroundImage: `url("${cv}")` }} />
          </div>
        ) : null}
        <header className="top top-ctx">
          {/* 属于某门课的页：左段是当前课程（封面 + 课名 + 分值），点它就是换课 —— 全站只在这一处换。
              不属于某门课的页：只留一个页名，说明「你在哪」，不留空地让版式塌掉。 */}
          {showTabs ? (
            cur ? (
              <div className="tcur">
                <span className={'cv' + (cv ? '' : ' flat')}
                  style={cv ? { backgroundImage: `url("${cv}")` }
                    : { background: clsColor(cur.cls || cur.accent || cur.id) }} />
                <Sel className="tcur-sel" value={String(sid || cur.id)}
                  ariaLabel="切换当前课程"
                  onChange={(v) => (onSid ? onSid(v) : onGo('home', { sid: v }))}
                  options={subs.map((s) => ({
                    value: s.id,
                    label: s.name,
                    note: (s.score ? s.score + ' 分' : '不计分') + ' · ' + (s.lessons_done ?? 0) + '/' + (s.lessons_total ?? 0) + ' 讲',
                  }))} />
              </div>
            ) : <div className="tcur"><span className="cv flat" /><b>还没有课程</b></div>
          ) : (
            <div className="tplain">
              <span className="dot" aria-hidden="true"
                style={{ background: cur ? clsColor(cur.cls || cur.accent || cur.id) : 'var(--tx3)' }} />
              {t.kick}
            </div>
          )}

          {showTabs ? (
            <div className="tvt" role="tablist" aria-label="这门课的视图">
              {tabs.map((x) => (
                <button key={x.k} role="tab" aria-selected={page === x.k}
                  className={page === x.k ? 'on' : ''}
                  onClick={() => onGo(x.k, { sid, entry: 'tab' })}>{x.t}</button>
              ))}
            </div>
          ) : null}

          {/* 顶栏搜索框：全站**只有这一只**。
              - 普通页面：在右侧那排 pill 里，跟以前一样（不居中、不挪位置）。
              - 搜索页：同一只框改为居中 —— 不是新画一个，是它挪到中间。
              两只框会让人分不清「刚才打的字去哪了」，所以这里只有一个组件，
              靠 placement 决定放哪儿。 */}
          {page !== 'canvas' && page === 'search' && !hideSearch ? (
            <div className="tmid">
              <TopSearch page={page} initial={searchQ} big />
            </div>
          ) : null}

          <div className="trt">
            {/* 普通页面的搜索框就在这儿 —— 回到它本来的位置，不居中。 */}
            {page !== 'canvas' && page !== 'search' && !hideSearch
              ? <TopSearch page={page} /> : null}
            {showTabs ? <span className="pill"><b>{done}</b>/{total} 讲</span> : null}
            <span className="pill" title={wk.data?.exam_date ? '考试日期 ' + wk.data.exam_date : '还没设考试日期'}>
              {daysLeft != null ? <>距考 <b>{daysLeft}</b> 天</> : '未设考试日期'}
            </span>
            {topRight}
          </div>
        </header>

        <div className="content">
          {/* 不再有 pagehead 大标题。以前每页顶一条「今日 / 今天怎么排 / 按……现场算」，
              三行里有两行是自我介绍 —— 用户原话：能不能别这么人机。
              每页的内容自己会说话，壳不再替它念旁白。「我在哪」由顶栏左段的页名标回答。 */}
          {children}
        </div>
      </div>
    </div>
  )
}

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
