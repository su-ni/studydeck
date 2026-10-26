import { useEffect, useState } from 'react'
import { loadBase, type Base } from './lib/api'
import { Shell, type PageKey } from './components/Shell'
import { Today } from './pages/Today'
import { Classroom } from './pages/Classroom'
import { Courses } from './pages/Courses'
import { Schedule } from './pages/Schedule'
import { Vocab } from './pages/Vocab'
import { Practice } from './pages/Practice'
import { Exam } from './pages/Exam'
import { Stats } from './pages/Stats'
import { Writing } from './pages/Writing'
import { Agent } from './pages/Agent'
import { Canvas } from './pages/Canvas'

const KEY = 'sd_page'
function initPage(): PageKey {
  const h = (location.hash || '').replace('#', '')
  const ok = ['today', 'classroom', 'courses', 'schedule', 'vocab', 'practice', 'exam', 'stats', 'writing', 'agent', 'canvas']
  if (ok.indexOf(h) >= 0) return h as PageKey
  const s = localStorage.getItem(KEY)
  if (s && ok.indexOf(s) >= 0) return s as PageKey
  return 'today'
}

export function App() {
  const [base, setBase] = useState<Base | null>(null)
  const [bootErr, setBootErr] = useState<string | null>(null)
  const [page, setPage] = useState<PageKey>(initPage)
  /* 画布页的工具条要住进顶栏 —— 它自己那条 98px 的工具栏把舞台压掉了六分之一。
     页往上抛一个节点，壳照着渲染；切走这一页就没了（state 跟着重置），
     不留一条属于画布的工具条挂在别的页上。
     setState 传函数时要包一层：React 会把「传进来的函数」当更新器调，传节点本身才安全。 */
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
    <Shell page={page} onGo={setPage} base={base} topRight={page === 'canvas' ? canvasTop : undefined}>
      <div key={page} className={"pagein" + (page === 'vocab' || page === 'today' || page === 'canvas' ? ' pagein-fill' : '')}>
        {page === 'today' && <Today base={base} go={setPage} />}
        {page === 'classroom' && <Classroom base={base} goCanvas={goCanvas} />}
        {page === 'courses' && <Courses base={base} go={setPage} />}
        {page === 'schedule' && <Schedule base={base} />}
        {page === 'vocab' && <Vocab base={base} />}
        {page === 'practice' && <Practice base={base} />}
        {page === 'exam' && <Exam base={base} />}
        {page === 'stats' && <Stats base={base} />}
        {page === 'writing' && <Writing base={base} />}
        {page === 'agent' && <Agent base={base} />}
        {page === 'canvas' && <Canvas base={base} openReq={cvOpen} topHost={(x: React.ReactNode) => setCanvasTop(() => x)} />}
      </div>
    </Shell>
  )
}
