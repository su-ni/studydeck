import { useMemo, useState } from 'react'
import { callTool } from '../lib/api'
import type { Base } from '../lib/api'
import { useTool } from '../lib/useTool'
import { Icon } from '../components/Icon'
import { Sel } from '../components/Sel'
import { Empty, Skel } from '../components/V6'

/* 截图库：所有截过的帧都在这一页。

   以前只有两个地方能看到图：课堂右栏（只有本讲那 24 张）和画布里的一个小抽屉。
   人在课堂截了 200 张，想回头找「上次那张进制表」——没地方找。
   这一页就是那个地方：按科目筛、按关键词搜、点开看原图、不要了就地删。

   后端就一个工具 shot_list（本来就支持 subject/q/origin），这里只是给它一个完整的界面。 */

type Shot = {
  id: string; subject?: string; lesson_id?: string; lesson_title?: string
  title?: string; file: string; w?: number; h?: number; bytes?: number
  pos_sec?: number | null; tag?: string; origin?: string; age?: string; ts?: string
}

const ORIGINS = [
  { value: '', label: '全部来源' },
  { value: 'frame', label: '视频截帧' },
  { value: 'canvas', label: '画布导出' },
  { value: 'upload', label: '上传' },
  { value: 'note', label: '笔记里的图' },
]

function clock(sec?: number | null) {
  if (sec == null) return ''
  const m = Math.floor(sec / 60), s = Math.round(sec % 60)
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}

export function Shots({ base }: { base: Base }) {
  const subs: any[] = (base as any)?.subjects ?? []
  const [subject, setSubject] = useState('')
  const [origin, setOrigin] = useState('')
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)

  const args = useMemo(() => ({
    subject: subject || undefined,
    origin: origin || undefined,
    q: q.trim() || undefined,
    limit: 300,
  }), [subject, origin, q])
  const ls = useTool<{ shots: Shot[]; count: number; total: number; tags?: string[] }>('shot_list', args)
  const shots = ls.data?.shots || []

  async function del(s: Shot) {
    if (armed !== s.id) { setArmed(s.id); return }
    const r = await callTool('shot_del', { id: s.id })
    setArmed(null)
    setMsg(r.ok ? '已从库里摘掉这一条' : (r.error || '没删掉'))
    if (r.ok) ls.run()
  }

  return (
    <section className="shots">
      <div className="shots-filter">
        <Sel ariaLabel="科目" value={subject} onChange={setSubject} style={{ width: 132 }}
          options={[{ value: '', label: '全部科目' },
          ...subs.map((s) => ({ value: s.id, label: s.name }))]} />
        <Sel ariaLabel="来源" value={origin} onChange={setOrigin} style={{ width: 126 }} options={ORIGINS} />
        <input className="inp-mn" style={{ flex: 1, minWidth: 160 }} placeholder="搜标题 / 讲次名，例如「进制」"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="shots-n">
          {ls.data ? shots.length + ' 张' + (shots.length < (ls.data.total || 0) ? ' / 共 ' + ls.data.total : '') : '—'}
        </span>
      </div>

      {msg ? <div className="shots-msg">{msg}</div> : null}

      {ls.loading && !shots.length ? (
        <Skel kind="card" n={4} />
      ) : shots.length ? (
        <div className="shots-grid">
          {shots.map((s) => {
            const sub = subs.find((x) => x.id === s.subject)
            return (
              <div className="shot-c" key={s.id}>
                <a className="shot-img" href={'/shots/' + s.file} target="_blank" rel="noreferrer"
                  title="点开看原图">
                  <img src={'/shots/' + s.file} alt={s.title || ''} loading="lazy" />
                  {s.pos_sec != null ? <span className="t">{clock(s.pos_sec)}</span> : null}
                </a>
                <div className="shot-b">
                  <b title={s.title || ''}>{s.title || '没写标题'}</b>
                  <i>
                    {sub?.name || s.subject || '—'}
                    {s.lesson_title ? ' · ' + s.lesson_title : ''}
                  </i>
                  <span className="shot-foot">
                    <em>{s.age || (s.ts || '').slice(0, 16)}</em>
                    <button className={'shot-del' + (armed === s.id ? ' on' : '')}
                      onClick={() => del(s)} title="从库里摘掉（盘上的图不删）">
                      {armed === s.id ? '再点一次' : <Icon n="trash" size={13} />}
                    </button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <Empty title={q || subject || origin ? '这个条件下没有截图' : '还没有截图'}>
          课堂里按 S（或点「截这一帧」）存下来的每一帧都会进这里；
          画布导出的图、从别处上传的图也在。
        </Empty>
      )}
    </section>
  )
}
