import { useState } from 'react'
import type { Base } from '../lib/api'
import type { PageKey } from '../components/Shell'
import { useTool } from '../lib/useTool'
import { Icon } from '../components/Icon'
import { Chat } from '../components/Chat'
import { Sect, Card, Empty, PBtn, clsColor, Skel, Kpi } from '../components/V6'

/* 今日页 v6：设计稿没画这一页，但规矩照用 ——
   上面四个 38px 数字（今天真的投入了多少），下面「今天先做这个」占主座，
   今日编排整行排在右边窄栏：一眼能看到下一步，也能看到全天的顺序。
   这里所有数字都是工具现算的，页面不自己推第二遍。 */

type PlanRow = {
  cls: string; title: string; meta: string; action: string
  page?: string; subject?: string; lesson_id?: string; group?: string; part?: string
}

const MODE_KEY = 'sd.react.today.mode'

function Cards({ go }: { go: (p: PageKey) => void }) {
  const plan = useTool<{ rows: PlanRow[]; rule: string; due_today: number; note?: string }>('plan_today')
  const st = useTool<{
    lessons: { done: number; total: number }
    words: { in_memory: number; total: number; due_today: number }
    bank: { name: string; total: number }
    answers: { answered: number; right: number; wrong: number; accuracy: number | null }
    time: { total: number; today: number }
  }>('stats_overview')

  const rows = plan.data?.rows ?? []
  const first = rows[0]
  const d = st.data
  const mins = d?.time?.today ?? 0
  const due = plan.data?.due_today ?? d?.words?.due_today ?? 0
  const lsDone = d?.lessons?.done ?? null
  const lsTotal = d?.lessons?.total ?? 0
  const acc = d?.answers?.accuracy

  return (
    <>
      <div className="kpi-mn">
        {/* 四格里三格点了能直接去干活：数字看完了要有个下一步<｜hy_place▁holder▁no▁813｜>
            目的地必须是真存在的页，凑不出来的（没有对应页的）保持普通格子。 */}
        <Kpi to="stats">
          <div className="k">今天真的投入</div>
          <div className="v">{mins}<small>分钟</small></div>
          <div className="s">本机事件库记的，不是视频长度</div>
        </Kpi>
        <Kpi to="vocab">
          <div className="k">到期复习</div>
          <div className="v">{due}<small>个词</small></div>
          <div className="s">{due ? '按 SM-2 到期日算' : '今天没有到期的词'}</div>
        </Kpi>
        <Kpi to="courses">
          <div className="k">讲次</div>
          <div className="v">
            {lsDone ?? '—'}<small>/{lsTotal || '—'}</small>
          </div>
          <div className="m">
            <i style={{ width: (lsTotal ? ((lsDone ?? 0) / lsTotal) * 100 : 0) + '%' }} />
          </div>
          <div className="s">
            {lsTotal ? `走完 ${lsDone ?? 0} 讲 · 剩 ${lsTotal - (lsDone ?? 0)} 讲` : '还没有可排的讲次'}
          </div>
        </Kpi>
        <Kpi to="practice">
          <div className="k">作答准确率</div>
          <div className="v" style={acc == null ? { color: 'var(--tx3)' } : acc < 50 ? { color: 'var(--bad)' } : { color: 'var(--ok)' }}>
            {acc == null ? '—' : acc}<small>{acc == null ? '' : '%'}</small>
          </div>
          <div className="s">
            {acc == null ? '还没答过题' : `答 ${d?.answers?.answered ?? 0} 题 · 对 ${d?.answers?.right ?? 0} · 错 ${d?.answers?.wrong ?? 0}`}
          </div>
        </Kpi>
      </div>

      <div className="twocol-mn">
        <Card title="今天先做这个" note="断点续学 · 排在最前面">
          {first ? (
            <>
              <div className="tdbig-mn" style={{ borderLeftColor: clsColor(first.cls) }}>
                {first.title.replace(/^继续上一讲\s*·\s*/, '')}
              </div>
              <div className="note-mn bare">{first.meta}</div>
              <div style={{ marginTop: 13 }}>
                <PBtn onClick={() => go((first.page as PageKey) || 'classroom')}>
                  <Icon n="play" size={13} />　{first.action}
                </PBtn>
              </div>
            </>
          ) : plan.loading ? (
            <Skel kind="text" n={3} />
          ) : (
            <Empty title="今天没有排出来的任务">
              规则跑完了没剩什么 —— 要么都做完了，要么还没有可排的讲次。
            </Empty>
          )}
          {plan.err ? <div className="note-mn bare">{plan.err}</div> : null}
        </Card>

        <Card title="今日编排" note={plan.data?.rule || '规则算的，不是我排的'}>
          {rows.length ? rows.map((r, i) => (
            <div className={'tdrow-mn' + (i === 0 ? ' hot' : '')} key={i}>
              <div className="idx">{i + 1}</div>
              <div className="nm">
                <b>{r.title}</b>
                <span>{r.meta}</span>
              </div>
              <div className="ac">
                <button className={'pbtn-mn' + (i === 0 ? '' : ' ghost')}
                  onClick={() => go((r.page as PageKey) || 'today')}>{r.action}</button>
              </div>
            </div>
          )) : (
            <div className="note-mn bare">
              {plan.loading ? '正在算…' : '没排出来 —— 可能都做完了，也可能还没定考试日期和每天时长。'}
            </div>
          )}
        </Card>
      </div>

      <div className="note-mn">
        题库 {d?.bank?.name || '—'} 共 <b style={{ color: 'var(--tx2)' }}>{d?.bank?.total ?? 0}</b> 题，
        已答 <b style={{ color: 'var(--tx2)' }}>{d?.answers?.answered ?? 0}</b> 题。
        这些数字全来自本机 SQLite 与数据文件 —— 视频播放器还没接计时，所以「今天投入」只记真看过的秒数，不拿视频长度凑。
      </div>
    </>
  )
}

/* ================= 今日页：聊天是主界面，卡片是辅助视图 ================= */
export function Today({ go }: { base: Base; go: (p: PageKey) => void }) {
  /* 默认就是聊天。卡片看板还在，靠聊天框右上角那个键切过来 ——
     它不再是「AI 主导 / 卡片主导」两个并列模式，而是一个主界面和一个辅助视图。 */
  const [cards, setCards] = useState<boolean>(() => {
    try { return sessionStorage.getItem(MODE_KEY) === 'cards' } catch { return false }
  })
  const toggle = () => {
    const v = !cards
    setCards(v)
    try { sessionStorage.setItem(MODE_KEY, v ? 'cards' : 'chat') } catch { /* 隐私模式下写不了，不影响用 */ }
  }
  /* 聊天态不占那一行按钮：.tact 有 30px 高 + 14px 外边距，正好把 .chat 顶出 .content 40px ——
     这就是「整页多出一条滚动条、输入框像浮在半空」的成因。
     聊天态把切换键交给 Chat 自己绝对定位，卡片态才用这行。 */
  if (!cards) {
    return <Chat page="today" onToggle={toggle} toggleLabel="看今天的安排" />
  }
  return (
    <>
      <div className="tact">
        <button className="btn sm tact-btn" onClick={toggle}>
          <Icon n="agent" size={14} />回去接着聊
        </button>
      </div>
      <Cards go={go} />
    </>
  )
}
