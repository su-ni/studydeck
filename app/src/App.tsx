import { lazy, Suspense, useEffect, useState } from 'react'
import { loadBase, type Base } from './lib/api'
import { Shell, type PageKey } from './components/Shell'
import { SearchModal } from './components/SearchModal'
import { CourseHome } from './pages/CourseHome'
import { Skel } from './components/V6'

/* 除课程主页外，每一页都按需下。
   之前所有页面连同画布页的 reactflow 一起打进一个 700KB 的 index.js，
   打开课程主页那一刻就全量下载 —— 用户可能一整天都不点画布。
   CourseHome 不懒加载：它是首屏（/app/#home）本身，包在 Suspense 里
   等于让首屏多等一次网络往返。

   变量名必须大写开头 —— JSX 里小写开头的标签会被当成内建 HTML 元素，
   编译期就报「JSX.IntrinsicElements 上没有这个属性」。 */
const LazyToday = lazy(() => import('./pages/Today').then((m) => ({ default: m.Today })))
const LazyClassroom = lazy(() => import('./pages/Classroom').then((m) => ({ default: m.Classroom })))
const LazyCourses = lazy(() => import('./pages/Courses').then((m) => ({ default: m.Courses })))
const LazySchedule = lazy(() => import('./pages/Schedule').then((m) => ({ default: m.Schedule })))
const LazyVocab = lazy(() => import('./pages/Vocab').then((m) => ({ default: m.Vocab })))
const LazyPractice = lazy(() => import('./pages/Practice').then((m) => ({ default: m.Practice })))
const LazyNotes = lazy(() => import('./pages/Notes').then((m) => ({ default: m.Notes })))
const LazyExam = lazy(() => import('./pages/Exam').then((m) => ({ default: m.Exam })))
const LazyStats = lazy(() => import('./pages/Stats').then((m) => ({ default: m.Stats })))
const LazyWriting = lazy(() => import('./pages/Writing').then((m) => ({ default: m.Writing })))
const LazyAgent = lazy(() => import('./pages/Agent').then((m) => ({ default: m.Agent })))
const LazyCanvas = lazy(() => import('./pages/Canvas').then((m) => ({ default: m.Canvas })))
const LazyShots = lazy(() => import('./pages/Shots').then((m) => ({ default: m.Shots })))
const LazySearch = lazy(() => import('./pages/Search').then((m) => ({ default: m.Search })))

const KEY = 'sd_page'
const SID_KEY = 'sd_sid'
/* 这个数组是「哪些页能活下来」的白名单：hash 变了会走 initPage()，
   名单里没有的页会被当场弹回去（新增页面忘了加，表现就是「点了没反应」）。
   加 PageKey 的时候必须同步这里。 */
const PAGES: PageKey[] = ['home', 'today', 'classroom', 'courses', 'schedule', 'vocab',
  'practice', 'notes', 'notesAll', 'exam', 'stats', 'writing', 'agent', 'canvas', 'shots',
  'search']

/* 懒加载页面的占位。
   为什么不是一句「正在读本机数据…」：那一行是给「还没连上服务」用的，
   而这里页面内容 100 毫秒后就到，闪一行灰字再被大块内容顶开，看得出是卡了一下。
   摆一块和目标页差不多高的骨架，加载完只是把骨架换成真内容，眼感上是连续的。
   fill=true 的页（背单词/今日/画布）内容区定高，骨架跟着撑满，不能被压成一条。 */
function ChunkGate({ fill }: { fill?: boolean }) {
  return (
    <div
      className="muted"
      style={fill
        ? { height: '100%', minHeight: 0, padding: '18px 2px' }
        : { minHeight: 820, padding: '18px 2px' }}
      aria-busy="true"
      aria-label="正在读本机数据…"
    >
      <Skel kind="kpi" n={4} />
      <div style={{ marginTop: 18 }}><Skel kind="card" n={4} /></div>
    </div>
  )
}

function initPage(): PageKey {
  /* 搜索页的 hash 带查询串（#search?q=xxx），先切掉 ? 再认页名 ——
     否则 #search?q=课堂 会被判成不在白名单里，当场弹回首页。 */
  const h = (location.hash || '').replace('#', '').split('?')[0]
  if (PAGES.indexOf(h as PageKey) >= 0) return h as PageKey
  const s = localStorage.getItem(KEY)
  if (s && PAGES.indexOf(s as PageKey) >= 0) return s as PageKey
  return 'home'
}

export function App() {
  const [base, setBase] = useState<Base | null>(null)
  const [bootErr, setBootErr] = useState<string | null>(null)
  const [page, setPage] = useState<PageKey>(initPage)
  /* 当前科目是全局的：左栏「课程」一组、课程主页、课堂、练习都读同一个值。
     以前每个页面自己藏一个 sid，切页就忘、还互相打架（课堂选的计算机，
     进练习又回到英语）。 */
  const [sid, setSid] = useState<string>(() => localStorage.getItem(SID_KEY) || '')
  /* 画布页的工具条要住进顶栏 —— 它自己那条 98px 的工具栏把舞台压掉了六分之一。
     页往上抛一个节点，壳照着渲染；切走这一页就没了（state 跟着重置），
     不留一条属于画布的工具条挂在别的页上。 */
  const [canvasTop, setCanvasTop] = useState<React.ReactNode>(null)
  /* 从别的页「带着一张图进画布」的传递口。
     以前课堂右栏的笔记卡片是个 <a href="#canvas"> —— 点了只会切到画布首页，
     连挂在哪张图上的信息一起丢掉，用户以为「进不去」。这里带 mapId 或 lessonId
     进去，画布页自己决定是打开那一张还是给这一讲新建一张。
     nonce 每次都换：同一张图连点两下也要重新打开，不然 effect 不触发。 */
  const [cvOpen, setCvOpen] = useState<{ mapId?: string; lessonId?: string; nonce: number } | null>(null)
  const goCanvas = (o: { mapId?: string; lessonId?: string }) => {
    setCvOpen({ ...o, nonce: Date.now() })
    setPage('canvas')
  }

  useEffect(() => {
    loadBase().then(setBase).catch((e) => setBootErr(String(e?.message || e)))

    /* 助手在后台入库 / 改计划时界面自己跟上 —— 之前只拉一次，
       刚加进来的课要手动刷新才出现，人以为「课程库还是 0」。

       15 秒 → 60 秒：loadBase 现在带 If-None-Match，常态是一次 304
       （几百字节），但这么问一分钟四次仍然没必要 —— 入库是人主动触发的，
       分钟级完全跟得上。

       两次判据，缺一不可：
       1) loadBase 内部：304 / 内容没变都返回同一个引用（见 lib/api.ts）。
       2) 这里的 setBase(next => next === d ? next : d)：即便哪天 loadBase
          退化成返回新对象（比如后端换了序列化顺序），同一个引用也还能挡一层。
       拿到同一个引用时 React 直接 bailout，不重渲染整棵树 —— 这才是 60 秒
       那次探测真正的目的：它应该是无声的。

       页面在后台时（document.hidden）不发请求：切回来那一刻补一次，
       而不是在用户看不见的标签页里循环唤醒 CPU。 */
    const pull = (force: boolean) => {
      if (document.hidden) return
      loadBase(force)
        .then((d) => setBase((prev) => (prev === d ? prev : d)))
        .catch(() => { /* 轮询失败不吵人：下一次 tick 会再试，首屏那次失败另有 bootErr 兜底 */ })
    }
    const t = setInterval(() => pull(true), 60_000)
    /* 从后台切回来补一次 —— 否则最长要等满一个 60 秒周期才看到新数据。
       这里用 pull(false) 而不是 pull(true)：来回切两下标签页会连着触发
       visibilitychange，强制拉就变成了连点刷新。非强制那一次由 loadBase
       的 20 秒缓存挡一下 —— 刚走开几秒就回来的人不该付一次往返。 */
    const onVis = () => { if (!document.hidden) pull(false) }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  /* 科目初值：地址栏没有、localStorage 也没有，就落到第一门课。
     存过的那门课已经被删了，也落回第一门 —— 不留一个不存在的科目挂在左栏高亮。 */
  useEffect(() => {
    const subs: any[] = (base as any)?.subjects ?? []
    if (!subs.length) return
    if (!sid || !subs.some((s) => s.id === sid)) setSid(subs[0].id)
  }, [base, sid])

  useEffect(() => { localStorage.setItem(SID_KEY, sid) }, [sid])
  useEffect(() => {
    /* 写地址栏时不能把查询串冲掉：搜索页的地址是 #search?q=关键词，
       而这一句在切页后立刻执行 —— 原样 location.hash = 'search' 会把
       ?q=... 抹掉，Search 页再读 q 就是空，表现为「跳过去了但什么都没搜」。
       所以页名没变时保留 ? 后面那一段；页名变了才重写。 */
    const curh = (location.hash || '').replace('#', '')
    const seg = curh.split('?')
    const curPage = seg[0] || ''
    const qs = seg.length > 1 ? '?' + seg.slice(1).join('?') : ''
    if (curPage !== String(page)) {
      location.hash = qs ? (String(page) + qs) : String(page)
    }
    localStorage.setItem(KEY, page)
  }, [page])

  // 地址栏 hash 变了就跟着切页（无头截图与手动改地址都靠这条）
  useEffect(() => {
    const onHash = () => setPage(initPage())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /* Ctrl/Cmd+F：先弹居中的搜索弹窗，回车之后才飞到顶栏并显示搜索页。
     为什么不一步跳到搜索页：用户要的是「在任何页面上唤起一个搜索」，
     而不是「立刻离开当前页」。正在看某一讲的视频、正在背单词，按下 Ctrl+F
     只是想问一句 —— 页面不该当场被换掉。

     画布页是这条规则的例外：那一页按 Ctrl+F 要的是「在这张图里找到那个节点」，
     不是「离开画布去全局搜一遍」，所以那里连弹窗都不弹。

     三处必须让路的例外：
     1) 焦点已经在输入框/文本域/contenteditable 里时（写笔记、跟助手说话），
        Ctrl+F 的含义是「在当前这段文字里找」，让给浏览器原生 —— 抢了会没法在
        自己的笔记里找字。这一条同样覆盖画布页：画布名、搜节点框、节点备注
        文本域、Markdown 导入框都是 input/textarea，在里面打字时不被抢。
     2) 弹窗已经开着时再按，不应该叠加，交给弹窗自己处理（清空并重新聚焦）。
     3) 画布页（page === 'canvas'）：只派发 cv:find 事件，由画布页自己把它的
        搜节点框呼出来。这里既不改 hash 也不跳搜索页 —— 用户要全局搜时，
        是在搜节点的结果里主动点一条非节点结果才走，那一步跳转归画布页，
        不由这里替他决定。
     preventDefault 是必须的：不拦的话浏览器查找栏会跟着弹出来，两层 UI 叠在一起。 */
  const [srchOpen, setSrchOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || (e.key !== 'f' && e.key !== 'F')) return
      const t = e.target as HTMLElement | null
      const tag = (t?.tagName || '').toLowerCase()
      const typing = tag === 'input' || tag === 'textarea' || (t as any)?.isContentEditable
      if (typing) return
      /* 已经在搜索页了就别再弹：那一页自己有大输入框，
         再盖一层居中的弹窗等于把刚搜到的结果挡住。 */
      if (page === 'search') return
      e.preventDefault()
      /* 画布页：Ctrl+F 归画布自己的搜节点框，事件名与 Canvas.tsx 的监听约定为
         'cv:find'。这里是「通知」而不是「命令」—— 画布是懒加载的，第一次
         进画布时它可能还没挂上，那一刻没人接这个事件，按下去没有反应。
         这仍然比跳去全局搜索页更贴近用户的意图：他要找的是节点，
         不是页面 / 题 / 文件 / 会话。 */
      if (page === 'canvas') {
        window.dispatchEvent(new CustomEvent('cv:find'))
        return
      }
      setSrchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page])

  /* 带科目的跳转：点章节 → pick_lesson + 进课堂，课堂要知道是哪门课，
     否则它按自己的默认科目取断点，跳到别的课上去。
     entry 记的是「从顶栏还是左栏进来的」—— 练习页靠它决定默认范围：
     顶栏进来跟着当前讲次，左栏进来是整门课。 */
  const [navEntry, setNavEntry] = useState<'tab' | 'rail'>('rail')
  const go = (p: PageKey, o?: { sid?: string; entry?: 'tab' | 'rail' }) => {
    if (o?.sid && o.sid !== sid) setSid(o.sid)
    if (o?.entry) setNavEntry(o.entry)
    setPage(p)
  }

  /* ↓↓↓ 这几个 hook 必须放在下面那两个提前 return 之前。
     React 靠「hook 的调用顺序」认钩子：同一渲染里第 1 个 useState 永远是同一个。
     一旦 early return 走了「少调用几个 hook」的那条分支，下一次渲染回来时
     顺序就对不上了 —— 报 Minified React error #310
     （Rendered more hooks than during the previous render），整棵树直接白屏。
     所以这里是硬规矩：App 里所有 useState / useEffect 都在 return 之前。 */
  /* 搜索弹窗提交：飞行动画结束之后才切页。
     为什么不直接 setPage：动画的意义就是「让用户看见这个框去了顶栏」，
     如果跳转和动画同时发生，页面瞬间重排，那段位移根本来不及被看见。 */
  const [srchInit, setSrchInit] = useState('')
  const runSearch = (w: string) => {
    setSrchInit(w)
    setSrchOpen(false)
    setPage('search')
  }
  /* 搜索页顶栏那只框要显示「现在搜的是什么词」。
     优先用弹窗带过来的 srchInit（刚刚那一次意图），否则读地址栏
     —— 刷新、后退、直接改 hash 都靠后者。 */
  const searchQ = (() => {
    if (page !== 'search') return ''
    if (srchInit) return srchInit
    const h = (location.hash || '').replace('#', '')
    const i = h.indexOf('?')
    return i < 0 ? '' : (new URLSearchParams(h.slice(i + 1)).get('q') || '')
  })()

  /* 任何地方都能喊「开搜索」—— 包括 Chat 那种绕过 Shell、自己占满整屏的界面。
     用 window 事件是因为 App 是唯一持有 srchOpen 的地方，而 Chat/Today
     在树上是它的重孙辈，往上透传一个回调要连改三层；一个事件反而更短也更清楚：
     它就是「请把搜索弹窗打开」这一句，没有别的意思。 */
  useEffect(() => {
    const open = () => setSrchOpen(true)
    window.addEventListener('sd:search-open', open)
    return () => window.removeEventListener('sd:search-open', open)
  }, [])

  if (bootErr) {
    return (
      <div style={{ padding: 40, maxWidth: 520, margin: '80px auto' }}>
        <h2>连不上本机服务</h2>
        <p className="muted">{bootErr}</p>
        <p className="muted">先运行 start.bat，服务地址 127.0.0.1:8770</p>
      </div>
    )
  }
  if (!base) return <div style={{ padding: 40 }} className="muted">正在读本机数据…</div>

  return (
    <>
    {srchOpen ? (
      <SearchModal
        onClose={() => setSrchOpen(false)}
        onSubmit={runSearch}
      />
    ) : null}
    <Shell page={page} onGo={go} base={base} sid={sid} onSid={(id) => { setSid(id); setPage('home') }}
      topRight={page === 'canvas' ? canvasTop : undefined}
      searchQ={searchQ}
      /* 弹窗开着时把顶栏那只藏掉：同屏两只搜索框，人会分不清往哪打。
         弹窗关掉（含飞完切页）之后它自己回来。 */
      hideSearch={srchOpen}>
      <div key={page} className={"pagein" + (page === 'vocab' || page === 'today' || page === 'canvas' || page === 'home' ? ' pagein-fill' : '')}>
        {/* 懒加载的兜底必须「长得像目标页」。
            页面 chunk 是第一次点进去才下的（本机服务几十毫秒，冷缓存下也就一两百毫秒），
            但兜底如果是一条灰色小字，切页时会看到内容区塌成一行再撑开 —— 那就是闪一下。
            这里按页量身高，先摆一块同高的骨架占住：
            - vocab / today / canvas 是整屏一格（pagein-fill，高 100%），骨架自己撑满；
            - 其余页面是普通文档流。minHeight 取 820：1440×1000 下内容区实测 848，
              820 比它略矮 —— 矮一截是向下长，人的眼睛不会察觉；高过内容区就会
              凭空多出一条滚动条，再缩回去，那才叫闪。
            形状统一用 V6 的 Skel（kpi 那款：几块数字格），它已经是全站「在读」的语言；
            这里不新造花哨骨架，也不写新的 CSS。 */}
        <Suspense fallback={<ChunkGate fill={page === 'vocab' || page === 'today' || page === 'canvas'} />}>
          {page === 'home' && <CourseHome base={base} sid={sid} onGo={go} />}
          {page === 'today' && <LazyToday base={base} go={go} />}
          {page === 'classroom' && <LazyClassroom base={base} goCanvas={goCanvas} initSid={sid} />}
          {page === 'courses' && <LazyCourses base={base} go={go} />}
          {page === 'schedule' && <LazySchedule base={base} go={go} />}
          {page === 'vocab' && <LazyVocab base={base} />}
          {page === 'practice' && <LazyPractice base={base} initSid={sid} entry={navEntry} />}
          {/* 笔记两个入口：顶栏那个看这一门课（跟课程走），左栏那个看全部课（不跟）。 */}
          {page === 'notes' && <LazyNotes base={base} sid={sid} scope="course" go={go} />}
          {page === 'notesAll' && <LazyNotes base={base} sid={sid} scope="all" go={go} />}
          {page === 'exam' && <LazyExam base={base} />}
          {page === 'stats' && <LazyStats base={base} />}
          {page === 'writing' && <LazyWriting base={base} />}
          {page === 'agent' && <LazyAgent base={base} />}
          {page === 'canvas' && <LazyCanvas base={base} openReq={cvOpen} topHost={(x: React.ReactNode) => setCanvasTop(() => x)} />}
          {page === 'shots' && <LazyShots base={base} />}
          {/* Search 既认地址栏里的 q（刷新/后退/从顶栏框来），也认 srchInit
              （从 Ctrl+F 弹窗来）—— 后者的优先级更高，因为它是「刚刚那一次」
              的意图，而 hash 可能还停在上一次搜的词上。 */}
          {page === 'search' && <LazySearch base={base} go={go} initial={srchInit} />}
        </Suspense>
      </div>
    </Shell>
    </>
  )
}
