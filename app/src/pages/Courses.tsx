import type { Base } from '../lib/api'
import { Sect, clsColor } from '../components/V6'
import { upName } from '../lib/fmt'

/* 课程库页 v6：按 design-v6.html:583-657 重画。
   五门课五张卡，卡上是 96px 的封面（有真封面就用真的，没有就用科目色渐变 + 科名分值），
   卡里只有课名 / 讲数 / 时长 / 已学 四件事。最后一张是虚线的「从 B 站链接入库」。
   题源单独一排：判分档做成小标签 —— 这是「这题源能不能自己判」的唯一凭据。 */

const LOCAL_COVER: Record<string, string> = {
  english: '/img/courses/BV1QcEv6PEzK.jpg',
  politics: '/img/courses/BV19tb6z4EwR.jpg',
  math: '/img/courses/BV1HP411t7cS.jpg',
  clang: '/img/courses/BV1cp421X755.jpg',
  cs: '/img/courses/BV1nH4y1o7qX.jpg',
}

// 科目色渐变：没有真封面时的底 —— 颜色只表达「这是哪一科」，不表达好坏。
const COVER_BG: Record<string, string> = {
  cs: 'linear-gradient(135deg,#7A3A1E,#FF7A4D 130%)',
  en: 'linear-gradient(135deg,#1B6E6B,#4FC4C0 130%)',
  ma: 'linear-gradient(135deg,#2A4570,#7FA8F0 130%)',
  po: 'linear-gradient(135deg,#6E5215,#E0B84A 130%)',
}
// 科目色只有一份实现，在 V6.clsColor 里。
// 以前每个页面自己抄一份，抄漏 coral/teal 这种颜色词就整列变灰。

function coverOf(s: any): string {
  if (LOCAL_COVER[s.id]) return LOCAL_COVER[s.id]
  const c = s.cover || ''
  if (!c) return ''
  return /^https?:\/\//i.test(c) ? c : '/' + c.replace(/^\//, '')
}

// 判分档 → 小标签的档位色：能自己判的绿，要模型的黄，纯导入的灰。
function judgeTone(j: string): string {
  if (j === 'exact') return 'ok'
  if (j === 'ai_exact' || j === 'ai_semantic') return 'md'
  return 'im'
}

export function Courses({ base, go }: { base: Base; go: (p: any) => void }) {
  const subs: any[] = (base as any).subjects ?? []
  const res: any[] = (base as any).resources ?? []
  const srcs: any[] = (base as any).sources ?? []
  const total = subs.reduce((a, s) => a + (s.lessons_total || 0), 0)
  const done = subs.reduce((a, s) => a + (s.lessons_done || 0), 0)
  const srcTotal = srcs.reduce((a: number, s: any) => a + (s.total || 0), 0)
  const srcSubs = new Set(srcs.map((s: any) => s.subject).filter(Boolean)).size
  // lessons[].dur 是秒。合计成小时只算一遍，跟 plan_budget 的 pending_hours 对得上。
  const hours = subs.reduce((a, s) => a + ((s.lessons || []) as any[]).reduce((b, x) => b + (x.dur || 0), 0) / 3600, 0)
  const pct = total ? (done / total) * 100 : 0

  return (
    <>
      <div className="kpi-mn">
        <div>
          <div className="k">课程</div>
          <div className="v">{subs.length}<small>门</small></div>
          <div className="s">{total} 讲 · {hours ? hours.toFixed(1) : '—'} 小时</div>
        </div>
        <div>
          <div className="k">学过的讲次</div>
          <div className="v">{done}<small>/ {total}</small></div>
          <div className="m"><i style={{ width: pct + '%' }} /></div>
          <div className="s">{(pct || 0).toFixed(1)}% · 剩 {Math.max(0, total - done)} 讲</div>
        </div>
        <div>
          <div className="k">题源</div>
          <div className="v">{srcs.length}<small>个</small></div>
          <div className="s">{srcTotal} 道题 · {srcSubs} 个科目</div>
        </div>
        <div>
          <div className="k">本地资料</div>
          <div className="v">{res.length}<small>份</small></div>
          <div className="s">{res.length ? '笔记 · 讲义 · 快照' : '本机没挂资料'}</div>
        </div>
      </div>

      <Sect title="课程" right={`${subs.length} 门 · ${total} 讲`} />

      {subs.length ? (
        <div className="cgrid-mn">
          {subs.map((s) => {
            const cv = coverOf(s)
            const p = s.lessons_total ? (s.lessons_done / s.lessons_total) * 100 : 0
            const h = ((s.lessons || []) as any[]).reduce((b, x) => b + (x.dur || 0), 0) / 3600
            const col = clsColor(s.cls || s.accent || s.id)
            const bg = COVER_BG[s.cls || s.accent || s.id] || 'linear-gradient(135deg,#3A3328,#5B5344 130%)'
            return (
              <button key={s.id} className="cc-mn" onClick={() => go('classroom')}
                title={`${s.video_title || s.name} · ${s.lessons_done}/${s.lessons_total} 讲`}>
                {/* 封面统一走 background：B 站真封面尺寸不一，<img> 会把 96px 的条撑高，
                    背景图 + cover 才能保证每张卡一样高。有真图时加 has-cover 压暗一档。 */}
                <div className={'cv' + (cv ? ' has-cover' : '')} style={cv
                  ? { backgroundImage: `url("${cv}")` }
                  : { background: bg }}>
                  <div className="bd">{s.name} · {s.score ? s.score + ' 分' : '不计分'}</div>
                </div>
                <div className="in">
                  <b>{s.video_title || s.name}</b>
                  <div className="m">
                    <span>{s.lessons_total} 讲</span>
                    <span>{h ? h.toFixed(1) + ' 小时' : '时长未记'}</span>
                    <span>已学 {s.lessons_done}</span>
                  </div>
                  <div className="tr-mn"><i style={{ width: p + '%', background: col }} /></div>
                  <div className="ft">
                    <span>{p ? (p < 1 ? p.toFixed(1) : Math.round(p)) + '% 走完' : '没开始'}</span>
                    <span className="go">{p ? '继续 →' : '开始 →'}</span>
                  </div>
                </div>
              </button>
            )
          })}
          <button className="cc-mn dash" onClick={() => go('agent')}>
            <div className="in">
              <div className="plus">+</div>
              <div className="t1">从 B 站链接入库</div>
              <div className="t2">粘一个 BV 号或课程链接，<br />它自己去拉分集、时长、封面</div>
            </div>
          </button>
        </div>
      ) : (
        <div className="empty-mn">
          <b>还没有课程</b>
          跟助手说一句「我想学 C 语言」，它会去 B 站找到整门课、一集一讲地落进本机。
          也可以点右下角那张虚线卡去设置里手动导一门。
        </div>
      )}

      <Sect title={`题源 ${srcs.length} 个 · ${srcTotal} 题`} right="判分档不是 exact 的，得模型才判得动" />
      {srcs.length ? (
        <div className="srcs-mn">
          {srcs.map((s: any) => (
            <div key={s.id} className="src-mn" title={s.why || ''}>
              <div className="sh">
                <b>{s.name}</b>
                <span className={'tg-mn ' + judgeTone(s.judge)}>{s.judge}</span>
              </div>
              <div className="sm">
                <span>{s.subject_name || s.subject || '—'}</span>
                <span>{s.total} 题</span>
                <span>{s.why || '—'}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-mn"><b>本机没有题源</b>题源来自题库文件与 data/sources.json，源头没数据就不摆出入口。</div>
      )}
      <div className="note-mn bare" style={{ marginTop: 8 }}>
        每一行都是 <code style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--tx2)' }}>list_item_sources</code>
        现场返回的 id / total / judge —— 没有一个是写死的常量。
      </div>

      {!!res.length ? (
        <>
          <Sect title="本地资料" right={`${res.length} 份 · 不计入讲次`} />
          <div className="srcs-mn">
            {res.map((r: any, i: number) => (
              <div key={i} className="src-mn">
                <div className="sh"><b>{r.label || r.file}</b><span className="tg-mn im">{r.kind || '文件'}</span></div>
                <div className="sm">
                  <span>{r.kb ? r.kb + ' KB' : '大小未知'}</span>
                  <span>{r.pdf ? r.pdf + ' 份 PDF' : '—'}</span>
                  <span>{upName(r.src) || '本机目录'}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="note-mn">
        课程数字读的是本机 <b>workbench/data</b> 与 SQLite 里的真实记录；
        助手从 B 站新落的课会进 <b>data/courses_extra.json</b>，页面 15 秒自己跟上，不用刷新。
        封面只认真封面 —— 没有就上科目色渐变，不塞灰色占位块假装有图。
      </div>
    </>
  )
}
