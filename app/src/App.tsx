import { useEffect, useState } from 'react'
import { loadBase, type Base } from './lib/api'
import { Shell, type PageKey } from './components/Shell'
import { CourseHome } from './pages/CourseHome'
import { Today } from './pages/Today'
import { Classroom } from './pages/Classroom'
import { Courses } from './pages/Courses'
import { Schedule } from './pages/Schedule'
import { Vocab } from './pages/Vocab'
import { Practice } from './pages/Practice'
import { Notes } from './pages/Notes'
import { Exam } from './pages/Exam'
import { Stats } from './pages/Stats'
import { Writing } from './pages/Writing'
import { Agent } from './pages/Agent'
import { Canvas } from './pages/Canvas'
import { Shots } from './pages/Shots'

const KEY = 'sd_page'
const SID_KEY = 'sd_sid'
/* 这个数组是「哪些页能活下来」的白名单：hash 变了会走 initPage()，
   名单里没有的页会被当场弹回去（新增页面忘了加，表现就是「点了没反应」）。
   加 PageKey 的时候必须同步这里。 */
const PAGES: PageKey[] = ['home', 'today', 'classroom', 'courses', 'schedule', 'vocab',
  'practice', 'notes', 'notesAll', 'exam', 'stats', 'writing', 'agent', 'canvas', 'shots']

function initPage(): PageKey {
  const h = (location.hash || '').replace('#', '')
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
    // 助手在后台入库 / 改计划时界面自己跟上 —— 之前只拉一次，
    // 刚加进来的课要手动刷新才出现，人以为「课程库还是 0」。
    const t = setInterval(() => {
      loadBase(true).then(setBase).catch(() => {})
    }, 15_000)
    return () => clearInterval(t)
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
    location.hash = page
    localStorage.setItem(KEY, page)
  }, [page])

  // 地址栏 hash 变了就跟着切页（无头截图与手动改地址都靠这条）
  useEffect(() => {
    const onHash = () => setPage(initPage())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

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
    <Shell page={page} onGo={go} base={base} sid={sid} onSid={(id) => { setSid(id); setPage('home') }}
      topRight={page === 'canvas' ? canvasTop : undefined}>
      <div key={page} className={"pagein" + (page === 'vocab' || page === 'today' || page === 'canvas' || page === 'home' ? ' pagein-fill' : '')}>
        {page === 'home' && <CourseHome base={base} sid={sid} onGo={go} />}
        {page === 'today' && <Today base={base} go={go} />}
        {page === 'classroom' && <Classroom base={base} goCanvas={goCanvas} initSid={sid} />}
        {page === 'courses' && <Courses base={base} go={go} />}
        {page === 'schedule' && <Schedule base={base} go={go} />}
        {page === 'vocab' && <Vocab base={base} />}
        {page === 'practice' && <Practice base={base} initSid={sid} entry={navEntry} />}
        {/* 笔记两个入口：顶栏那个看这一门课（跟课程走），左栏那个看全部课（不跟）。 */}
        {page === 'notes' && <Notes base={base} sid={sid} scope="course" go={go} />}
        {page === 'notesAll' && <Notes base={base} sid={sid} scope="all" go={go} />}
        {page === 'exam' && <Exam base={base} />}
        {page === 'stats' && <Stats base={base} />}
        {page === 'writing' && <Writing base={base} />}
        {page === 'agent' && <Agent base={base} />}
        {page === 'canvas' && <Canvas base={base} openReq={cvOpen} topHost={(x: React.ReactNode) => setCanvasTop(() => x)} />}
        {page === 'shots' && <Shots base={base} />}
      </div>
    </Shell>
  )
}
