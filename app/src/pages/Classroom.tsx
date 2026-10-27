import { useCallback, useEffect, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import { Icon } from '../components/Icon'
import { Empty, Skel } from '../components/V6'
import { Sel } from '../components/Sel'
import { upName } from '../lib/fmt'
import { ShapeThumb } from './canvas/ShapeThumb'
import type { Base, Lesson } from '../lib/api'

/* 课堂页 v6：左目录 + 右讲台，这个布局本来就对，不动结构，只换语言。
   v6 的规矩在这页怎么落：
   · 唯一一块亮面是讲台，但它放的是视频不是字 —— 所以这页没有米白纸，全靠底色分层；
   · 琥珀只给「当前这一讲」和「现在该点的」：目录里的 .on、播放按钮、标记看完的确认态；
   · 字阶只在顶部拉开：讲次标题 15px，副标题 11.5px，其余一律 12/11.5；
   · 标记看完仍是两步确认 —— 它是写盘动作，不可撤回。 */

type Subj = { id: string; name: string; score: number; cover?: string; video_up?: any; lessons_done?: number; lessons_total?: number }
type Cur = { subject: Subj; lesson: Lesson; pos_sec: number; lessons_done: number; lessons_total: number; done: string[] }
type Content = { title: string; chapter: string; points: string[]; covers: { kind: string; name: string; n: number; why: string }[]; resources: any[] }

const TABS: { k: 'words' | 'doc' | 'test' | 'ask'; t: string }[] = [
  { k: 'words', t: '词群' },
  { k: 'doc', t: '讲义' },
  { k: 'test', t: '当堂测' },
  { k: 'ask', t: '提问' },
]

/* 后端给的章节顺序是文件里的原序（第七章可能排在第三章前面）。
   目录是给人找位置的，按 其他 → 第一章…第N章 排一遍；认不出中文数字的保持原序垫底。 */
const CH_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
function chRank(name: string) {
  if (!name) return 9999
  if (name.startsWith('其他')) return -1
  const m = name.match(/第([一二三四五六七八九十]+)章/)
  if (!m) return 9000
  const s = m[1]
  if (s.length === 1) return CH_NUM[s] ?? 9000
  if (s.length === 2 && s[0] === '十') return 10 + (CH_NUM[s[1]] ?? 0)
  if (s.length === 2 && s[1] === '十') return (CH_NUM[s[0]] ?? 0) * 10
  return 9000
}

export function Classroom({ base, goCanvas, initSid }: {
  base: Base
  /* 右栏笔记卡的出口。以前这里是 <a href="#canvas"> —— 只会切到画布首页，
     「打开的是哪一张」这个信息当场丢掉，所以用户说「进不去本讲笔记」。
     交给上层带 mapId / lessonId 走。 */
  goCanvas?: (o: { mapId?: string; lessonId?: string }) => void
  /* 左栏选的科目：从课程主页点进来时必须听它的，
     否则课堂按自己的默认科目取断点，跳到别的课上去。 */
  initSid?: string
}) {
  const subs: Subj[] = (base as any).subjects ?? []
  /* 默认跟 base 走（后端已按分值 + 最近动过排过序）；库里没科目就留空让后端自己挑。 */
  const [sid, setSid] = useState<string>(initSid || subs[0]?.id || '')
  const [sidTouched, setSidTouched] = useState(false)
  useEffect(() => {
    if (sidTouched) return
    const want = initSid || subs[0]?.id
    if (want && want !== sid) setSid(want)
  }, [subs, sidTouched, sid, initSid])

  const cur = useTool<Cur>('get_current_lesson', { subject: sid })
  const lid = cur.data?.lesson?.id
  const cont = useTool<Content>('list_lesson_content', { lesson_id: lid }, { skip: !lid })
  const toc = useTool<{ groups: { chapter: string; lessons: Lesson[] }[] }>('list_lessons', { subject: sid })

  const [tab, setTab] = useState<'words' | 'doc' | 'test' | 'ask'>('words')
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [openG, setOpenG] = useState<Record<number, boolean>>({})
  const vid = useRef<HTMLVideoElement | null>(null)
  const [vErr, setVErr] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  // 合流/缓冲态：B 站 dash 首次播放要先落成本地 mp4，这段时间必须给说法
  const [buf, setBuf] = useState(false)
  // 时间轴要用：视频总长 + 当前秒。都从 <video> 自己读，不另算。
  const [dur, setDur] = useState(0)
  const [curSec, setCurSec] = useState(0)
  /* 真实观看秒数：只在「正常播放推进」时累计，拖动跳转不计（差值过大当跳转）。
     每 15 秒上报一次 log_playback —— 不这样的话统计页的投入时长永远是 0，
     而页面还写着「只算播放器真的报上来的秒数」，等于在说一句假话。 */
  const accSec = useRef(0)
  const lastPos = useRef(0)
  const lastUp = useRef(0)
  /* 影院模式：整页铺满，目录和右栏都收起来，只留播放器 + 顶栏一条。
     不用浏览器原生全屏 —— 原生全屏里 keydown 不再进页面，S 键截帧会失效。
     所以在页面内自己做「铺满」，Esc 退出。 */
  const [theater, setTheater] = useState(false)

  const subj = cur.data?.subject ?? subs.find((s) => s.id === sid)
  const les = cur.data?.lesson
  // 播放地址统一走本机 /stream/<lesson_id>（服务端会把本地 mp4 302 到 /media，
  // B 站分 P 则现场合流成能拖进度条的 mp4）。直链不能直接给 <video>：
  // 它带签名、约 2 小时过期，还要求 Referer —— 浏览器里带不出来。
  const src = les?.local
    ? '/media/' + encodeURI(les.local)
    : (lid ? '/stream/' + encodeURIComponent(lid) : '')
  const coverRaw = (subj?.cover || '') as string
  const poster = /^https?:\/\//i.test(coverRaw) ? coverRaw : (coverRaw ? '/' + coverRaw.replace(/^\//, '') : '')

  async function markDone() {
    if (!lid) return
    if (!armed) { setArmed(true); return }
    setDoneMsg('标记中…')
    const r = await callTool('finish_lesson',
      { lesson_id: lid, pos_sec: Math.round(vid.current?.currentTime ?? cur.data?.pos_sec ?? 0) }, { write: true })
    setArmed(false)
    setDoneMsg(r.ok ? '已看完 · 写进本机事件库' : '标记失败：' + (r.error || '未知原因'))
    if (r.ok) cur.run()
  }

  useEffect(() => {
    setStarted(false); setVErr(null); setArmed(false); setBuf(false)
    accSec.current = 0; lastPos.current = 0; lastUp.current = 0
  }, [lid])

  /* ── 截这一帧（S 键）────────────────────────────────────────────
     帧从 <video> 上直接 drawImage 抓，不重新去要一路视频 —— B 站的流带签名、
     还要 Referer，第二次请求拿不到。抓完走 shot_frame，带 pos_sec：
     素材库靠这个秒数在进度条上打点，也靠它点一下跳回那一刻。
     没有秒数就只是一张不知道在哪儿的图，所以宁可截失败也不裸存。 */
  // 右栏要跟着截帧刷新 —— 工具句柄提到这里，子组件用同一个
  const refreshShots = useTool<{ shots: any[]; count: number }>('shot_list', { lesson_id: lid, limit: 24 }, { skip: !lid })

  const [shotMsg, setShotMsg] = useState<string | null>(null)
  const [shotBusy, setShotBusy] = useState(false)
  /* 截完那一下的闪光。截帧是个「没有物理反馈」的动作 —— 快门的声响和灯闪都没有，
     不给人一点确认，按完只会怀疑按没按上。所以存成功就闪一帧白光（160ms）。
     只在成功时闪：失败还闪等于骗人。 */
  const [flash, setFlash] = useState(0)
  const grabFrame = useCallback(async () => {
    const v = vid.current
    if (!v || !lid) { setShotMsg('先点开播，再截这一帧'); return }
    if (!v.videoWidth) { setShotMsg('画面还没出来，等一下再截'); return }
    // 同一秒连按两下 S 会存出两张一模一样的图 —— 库里立刻变噪点。
    // 这一步不写库，只在本地拦，够用且没有额外往返。
    const sec = Math.round(v.currentTime * 100) / 100
    const dup = (refreshShots.data?.shots || []).some((x: any) => x.pos_sec != null && Math.abs(x.pos_sec - sec) < 1.5)
    if (dup) { setShotMsg(clock(sec) + ' 这一帧已经截过了'); return }
    setShotBusy(true)
    try {
      const c = document.createElement('canvas')
      c.width = v.videoWidth; c.height = v.videoHeight
      const g = c.getContext('2d')
      if (!g) { setShotMsg('截不了：画布没拿到'); return }
      g.drawImage(v, 0, 0, c.width, c.height)
      const data = c.toDataURL('image/jpeg', 0.86).replace(/^data:image\/jpeg;base64,/, '')
      const r = await callTool('shot_frame', {
        data, subject: sid, lesson_id: lid, pos_sec: Math.round(v.currentTime * 100) / 100,
        title: String(les?.title || '截帧').slice(0, 40), w: c.width, h: c.height,
      }, { write: true })
      const d: any = r.data || {}
      setShotMsg(r.ok ? '已存 · ' + clock(v.currentTime) + ' · 库里现在 ' + (d.count ?? '?') + ' 张'
        : '截失败：' + (r.error || d.error || '未知原因'))
      if (r.ok) { setFlash((n) => n + 1); refreshShots.run() }
    } finally { setShotBusy(false) }
    /* 依赖里必须带 refreshShots.data：grabFrame 闭包是在上一次渲染里造的，
       不跟着列表更新的话，去重永远看到空数组 —— 表现就是「连按两下存两张」。 */
  }, [lid, sid, les?.title, refreshShots.data])

  // 右栏缩略图点一下 = 回到那一刻；不带秒数的（普通截图）开原图。
  const seekTo = useCallback((sec: number | null, file: string) => {
    if (sec == null) { window.open('/shots/' + file, '_blank', 'noopener'); return }
    const v = vid.current
    if (!v) { setShotMsg('播放器还没起来，先点开播'); return }
    v.currentTime = sec
    v.play().catch(() => {})
    setShotMsg('已跳回 ' + clock(sec))
  }, [])

  // S 键截帧。输入框里打字时不能抢键，否则搜索框里打不出 s。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 's' && e.key !== 'S') return
      const t = e.target as HTMLElement | null
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      grabFrame()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [grabFrame])

  // 影院模式：Esc 退出。另外 Space 不该被我们吃掉 —— 留给播放器自己的暂停/播放。
  useEffect(() => {
    if (!theater) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setTheater(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [theater])

  useEffect(() => {
    const v = vid.current
    if (!v) return
    const onErr = () => {
      const why: Record<number, string> = {
        1: '加载被中断', 2: '网络取不到这个文件', 3: '解码失败（文件坏了）',
        4: '这个格式浏览器放不了（MEDIA_ERR_SRC_NOT_SUPPORTED）',
      }
      setVErr(why[v.error?.code ?? 0] || '播放出错（code ' + (v.error?.code ?? '?') + '）')
    }
    const onOk = () => setVErr(null)
    v.addEventListener('error', onErr); v.addEventListener('loadeddata', onOk)
    return () => { v.removeEventListener('error', onErr); v.removeEventListener('loadeddata', onOk) }
  }, [src])

  const doneList = cur.data?.done || []
  const groups = [...(toc.data?.groups ?? [])].sort((a, b) => chRank(a.chapter || '') - chRank(b.chapter || ''))

  /* 两侧折叠状态记 localStorage：看课的人通常一整天都在同一页，每次进来重置很烦。
     '0' = 收起来了。左栏默认开，右栏默认开（默认两边都开是定过的设计决策）。 */
  const [tocOpen, setTocOpen] = useState(() => localStorage.getItem('sd.class.toc') !== '0')
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem('sd.class.side') !== '0')
  const toggleToc = () => { const v = !tocOpen; setTocOpen(v); localStorage.setItem('sd.class.toc', v ? '1' : '0') }
  const toggleSide = () => { const v = !sideOpen; setSideOpen(v); localStorage.setItem('sd.class.side', v ? '1' : '0') }
  const cls2 = 'cls2' + (tocOpen ? '' : ' toc-shut') + (sideOpen ? ' side-open' : '') + (theater ? ' theater' : '')

  return (
    <div className={cls2}>
      <aside className={'cls2-toc' + (tocOpen ? '' : ' shut')} aria-hidden={!tocOpen}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 4px 10px' }}>
          <b style={{ fontSize: 12.5 }}>本门目录</b>
          <span className="dv" style={{
            fontSize: 11.5, color: 'var(--tx3)', fontVariantNumeric: 'tabular-nums', marginLeft: 'auto',
          }}>
            {cur.data?.lessons_done ?? 0} / {cur.data?.lessons_total ?? 0}
          </span>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, margin: '0 -6px', padding: '0 6px' }}>
          {groups.map((g, gi) => {
            const hits = (g.lessons || []).some((l) => l.id === lid)
            const open = openG[gi] ?? hits
            return (
              <div key={gi}>
                <button className="cls2-gh" onClick={() => setOpenG((o) => ({ ...o, [gi]: !open }))}>
                  <svg className="cv" viewBox="0 0 10 10" width="9" height="9" aria-hidden
                    style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .16s', flex: 'none' }}>
                    <path d="M3 1 L7 5 L3 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.chapter || '未分章'}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--tx3)', fontVariantNumeric: 'tabular-nums' }}>{(g.lessons || []).length}</span>
                </button>
                {open ? (
                  <div style={{ paddingLeft: 10 }}>
                    {(g.lessons || []).map((l) => {
                      const isDone = doneList.indexOf(l.id) >= 0
                      return (
                        <button key={l.id} className={'cls2-li' + (l.id === lid ? ' on' : '')}
                          onClick={async () => { await callTool('pick_lesson', { lesson_id: l.id }, { write: true }); cur.run() }}>
                          <span className="d" />
                          <span style={{ flex: 1, textAlign: 'left' }}>{l.title}</span>
                          {isDone ? <Icon n="check" size={10} /> : null}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )
          })}
          {!toc.data && <div style={{ padding: 12, fontSize: 12, color: 'var(--tx3)' }}>正在读目录…</div>}
          {toc.data && !(toc.data.groups || []).length && (
            <Empty title="这门课还没有讲次">去课程库导一门，或跟助手说一句要学什么。</Empty>
          )}
        </div>
      </aside>

      <div className="cls2-stage">
        {/* 顶栏两行：身份行（讲次 + 科目/来源 + 两侧开关）和动作行（截帧 / 看完）。
            一行塞满的后果是标题被压成竖排、按钮折成两行 —— 三栏布局里中间这一栏本来就窄。 */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '0 0 6px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 750, letterSpacing: '-.015em', lineHeight: 1.4 }}>
              {les?.title || (cur.loading ? '正在读…' : '—')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 4 }}>
              {[subj?.name, upName(subj?.video_up), les?.chapter].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          <Sel value={sid} ariaLabel="切换科目"
            onChange={(v) => { setSid(v); setSidTouched(true) }}
            options={subs.map((s) => ({ value: s.id, label: s.name }))} />
          <span className="tg-mn im" style={{ height: 22, display: 'inline-flex', alignItems: 'center' }}>
            {les?.local ? '本地 MP4 · 可离线' : 'B 站分 P'}
          </span>
          {/* 两侧栏的开关放这里，不放在栏边上。
              原来的做法是在两栏外面各插一根 28px 竖条 —— 结果那两根竖条
              紧贴着右栏，看着像两根游标，中间还多出一条没有由头的分界线。 */}
          <div className="panels-mn" role="group" aria-label="显示哪几栏">
            <button className={'pbtn-mn icon' + (tocOpen ? ' on' : '')} aria-pressed={tocOpen}
              title={tocOpen ? '收起本门目录' : '展开本门目录'} onClick={() => toggleToc()}>
              <Icon n="panel-left" size={15} />
            </button>
            <button className={'pbtn-mn icon' + (sideOpen ? ' on' : '')} aria-pressed={sideOpen}
              title={sideOpen ? '收起右栏' : '展开右栏'} onClick={() => toggleSide()}>
              <Icon n="panel-right" size={15} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 0 12px', flexWrap: 'wrap' }}>
          <button className="pbtn-mn ghost" onClick={grabFrame} disabled={shotBusy}
            title="把当前画面存进这一讲的素材库（快捷键 S）">
            <Icon n="cam" size={14} />{shotBusy ? '存中…' : '截这一帧'}
            {/* 快捷键得写在按钮上。原来只有 title 里提一句「快捷键 S」——
                鼠标不悬停就看不见，等于没写。 */}
            <span className="kbd-mn">S</span>
          </button>
          {doneMsg ? (
            <span className="tg-mn ok" style={{ height: 22, display: 'inline-flex', alignItems: 'center' }}>{doneMsg}</span>
          ) : (
            <button className={'pbtn-mn' + (armed ? '' : ' ghost')} onClick={markDone}>
              {armed ? '再点一次确认' : '标记看完'}
            </button>
          )}
          {/* 回执。原来挤成 10.5px 灰字贴在顶栏第二行，人扫不到 ——
              现在带图标的绿/黄胶囊，尺寸和旁边那排标签一致。 */}
          {shotMsg ? <span className="tg-mn ok shotmsg-mn">{shotMsg}</span> : null}
        </div>

        <div className="cls2-screen">
          {src ? (
            <>
              <video ref={vid} src={src} poster={poster || undefined} controls playsInline
                preload="metadata"
                onPlay={() => { setStarted(true); setBuf(false) }}
                onEnded={() => setStarted(true)}
                onWaiting={() => setBuf(true)}
                onPlaying={() => setBuf(false)}
                onCanPlay={() => setBuf(false)}
                onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime || 0
                  setCurSec(t)
                  const d = t - lastPos.current
                  lastPos.current = t
                  if (d > 0 && d < 2.5) accSec.current += d
                  const now = Date.now()
                  if (lid && accSec.current >= 15 && now - lastUp.current >= 15000) {
                    const sec = Math.round(accSec.current)
                    accSec.current = 0
                    lastUp.current = now
                    callTool('log_playback',
                      { lesson_id: lid, pos_sec: Math.round(t), seconds: sec }, { write: true }).catch(() => {})
                  }
                }}
                onError={() => setVErr('这一讲取不到播放文件 —— 合流没成，或 B 站那边改了规矩。'
                  + ' 下面「去 B 站看」还能用。')}
                style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} />
              {!started && poster ? <img className="vposter" src={poster} alt="" referrerPolicy="no-referrer" /> : null}
              {!started ? (
                <button className="vplay" aria-label="播放本讲"
                  onClick={() => {
                    // 首次点播要等合流（B 站 dash 得先落成本地 mp4，约 10~30 秒）。
                    // 这段时间必须给出「在准备」的说法，否则看着就是卡死。
                    setBuf(true)
                    const v = vid.current
                    if (v) { v.load(); v.play().catch(() => {}) }
                  }}>
                  <i><Icon n="play" size={26} /></i><em>{les?.local ? '点这里开始看' : '点这里开始看 · 第一次要合流，等十几秒'}</em>
                </button>
              ) : null}
              {buf ? (
                <div className="vbuf" aria-live="polite">
                  <i /><span>正在把这讲合成本机能拖的 mp4 —— 只做这一次，之后秒开</span>
                </div>
              ) : null}
              {/* 闪光板：key 一变就重挂，动画从头放一遍（同一张图连截也能再闪）。
                  aria-hidden + pointer-events:none —— 它只是视觉回执，不是控件。 */}
              {flash ? <span key={flash} className="vflash" aria-hidden /> : null}
              {/* 「影院」：自己接管全屏，不用浏览器原生那个。
                  原生全屏里键盘事件不再传给页面，S 就废了 —— 而截帧恰恰常在
                  放大看的时候最想用。这颗按钮进的是 .cls2-theater（整页铺满、
                  侧栏和目录都收起来），视频还是同一个 <video>，S 照旧生效。
                  要看原生的话，controls 里那颗全屏按钮还在，两个都能用。 */}
              <button className="vtheater" title="影院模式：铺满窗口，S 照样能截"
                aria-label="影院模式" onClick={() => setTheater((v) => !v)}>
                <Icon n={theater ? 'fit' : 'full'} size={15} />
              </button>
            </>
          ) : (
            /* 没有播放源时的空位。三种情况分开说，别用一句话糊过去：
               ① 还在读 → 别喊错，就说在读；
               ② 有讲次但没 bvid 也没本地文件 → 说清「去看不了」；
               ③ 连讲次都没有 → 这不是播放问题，是还没选课。 */
            <div className="vscreen-empty">
              {poster ? <img src={poster} alt="" referrerPolicy="no-referrer" className="bg" /> : null}
              {cur.loading ? (
                <span className="t2">正在读这一讲…</span>
              ) : !les ? (
                <>
                  <b>还没选讲次</b>
                  <span className="t2">左边目录点一讲，或者去「课程库」先把课导进来。</span>
                </>
              ) : (
                <>
                  <Icon n="play" size={26} />
                  <b>这一讲没有播放源</b>
                  <span className="t2">既没有本地文件，也没记 B 站号。</span>
                </>
              )}
            </div>
          )}
          {vErr ? (
            <div className="verr"><b>放不了</b><span>{vErr}</span></div>
          ) : null}
        </div>

        {/* 进度条打点：每张截帧在这个讲次的时间轴上留一个刻度。
            长度按视频时长算，不是按最大秒数算 —— 没看过的地方也得有位置。 */}
        <Ticks
          shots={(refreshShots.data?.shots || []) as any[]}
          dur={dur}
          cur={curSec}
          onSeek={(sec) => seekTo(sec, '')} />

        <div style={{ display: 'flex', gap: 18, borderBottom: '1px solid var(--line)', marginTop: 16 }}>
          {TABS.map((x) => (
            <button key={x.k} className={'cls2-tab' + (tab === x.k ? ' on' : '')} onClick={() => setTab(x.k)}>{x.t}</button>
          ))}
        </div>
        <div style={{ padding: '14px 0 0' }}>
          {tab === 'words' && <WordTab lid={lid} />}
          {tab === 'doc' && <DocTab cont={cont.data ?? undefined} />}
          {tab === 'test' && <TestTab cont={cont.data ?? undefined} sid={sid} lid={lid}
            pct={(() => {
              const total = dur || Number((les as any)?.dur || 0)
              if (!total) return cur.data?.pos_sec && Number((les as any)?.dur) ? 100 : 0
              return Math.min(100, (Math.max(curSec, cur.data?.pos_sec || 0) / total) * 100)
            })()} />}
          {tab === 'ask' && <AskBox lid={lid} title={les?.title} />}
        </div>
      </div>

      {/* 右栏：本讲笔记 + 本讲截图。两块各自能折。 */}
      {sideOpen ? <SidePanel lid={lid} subject={sid} lessonTitle={les?.title || ''} shots={refreshShots} seekTo={seekTo} goCanvas={goCanvas} /> : null}

    </div>
  )
}

/* 右栏。笔记走 note_list({lesson_id})，图走 shot_list({lesson_id})。
   两块都只读，不加写操作 —— 写操作在画布页和「截这一帧」按钮上，
   这里再放一份会让人分不清哪个是真的入口。
   但「进得去」和「建得出来」是导航，不是写盘：所以这里放两枚按钮，
   点「新建本讲笔记」只把 lessonId 交给画布页，真正落库仍由画布页第一次改动完成。 */
function SidePanel({ lid, subject, lessonTitle, shots, seekTo, goCanvas }: {
  lid?: string; subject: string; lessonTitle?: string
  /* 截帧句柄由上面传进来：右栏自己再挂一份的话，截完这一张不刷新，
     得切页回来才看得到 —— 那就不叫「存进这一讲的素材库」了。 */
  shots: ReturnType<typeof useTool<{ shots: any[]; count: number }>>
  /* 点带秒数的缩略图 = 让播放器跳回那一刻。视频元素在上面，所以由上面给动作。 */
  seekTo: (sec: number | null, file: string) => void
  goCanvas?: (o: { mapId?: string; lessonId?: string }) => void
}) {
  const maps = useTool<{ maps: { id: string; title: string; shape?: any }[]; count: number }>(
    'note_list', { lesson_id: lid }, { skip: !lid })
  const has = (maps.data?.maps || []).length > 0

  /* 删两张卡上的东西（笔记 / 截图），都是两步确认。
     为什么两步：这两个动作都不好回退 —— 笔记删了库里就真没了，
     截图虽然盘上还留着图，但这一讲的记录没了。第一下把按钮变成红底「再点一次」，
     第二下才发工具。跟画布页图库、素材库那两枚是同一套手感。 */
  const [delNoteArm, setDelNoteArm] = useState<string | null>(null)
  const [delShotArm, setDelShotArm] = useState<string | null>(null)
  const [msg2, setMsg2] = useState('')

  const delNote = useCallback(async (m: { id: string; title: string }) => {
    if (delNoteArm !== m.id) { setDelNoteArm(m.id); return }
    setDelNoteArm(null)
    const r = await callTool('note_del', { map_id: m.id }, { confirm: true, write: true })
    if (!r.ok) { setMsg2('删不掉：' + (r.error || '未知原因')); return }
    setMsg2('已删掉「' + (m.title || '未命名') + '」')
    maps.run()
  }, [delNoteArm, maps])

  const delShot = useCallback(async (s: { id: string; title?: string }) => {
    if (delShotArm !== s.id) { setDelShotArm(s.id); return }
    setDelShotArm(null)
    const r = await callTool('shot_del', { id: s.id }, { write: true })
    if (!r.ok) { setMsg2('删不掉：' + (r.error || '未知原因')); return }
    setMsg2('已从素材库摘掉「' + (s.title || '这一张') + '」· 盘上的图还在')
    shots.run()
  }, [delShotArm, shots])

  return (
    <aside className="cls2-side">
      <div className="sc-mn">
        <div className="h">这一讲的笔记</div>
        {!lid ? (
          <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>还没选讲次</div>
        ) : maps.loading ? (
          <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>正在读…</div>
        ) : !has ? (
          <div style={{ fontSize: 11.5, color: 'var(--tx3)', lineHeight: 1.7 }}>
            这一讲还没有笔记。点下面那枚按钮新建一张，它会挂在这一讲上 ——
            之后在这一页点卡片就能直接打开。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {(maps.data?.maps || []).map((m) => (
              <div className={'note-miniwrap' + (delNoteArm === m.id ? ' arming' : '')} key={m.id}>
                <button className="note-mini-mn" title={'打开「' + m.title + '」'}
                  onClick={() => goCanvas?.({ mapId: m.id })}>
                  <ShapeThumb shape={m.shape} W={196} H={54} cls="sthumb mind mini" />
                  <span>{m.title}</span>
                </button>
                {/* 跟图库里那枚一样：两步确认，第二下才真删。
                    前一版这一格连按钮都没有 —— 人只能进画布再把整张图删掉。 */}
                <button className="notedel" aria-label="删掉这张笔记"
                  title={delNoteArm === m.id ? '再点一次就删掉' : '删掉这张笔记'}
                  onClick={(e) => { e.stopPropagation(); delNote(m) }}>
                  {delNoteArm === m.id ? <span>再点一次</span> : <Icon n="trash" size={12} />}
                </button>
              </div>
            ))}
          </div>
        )}
        {lid ? (
          <button className="pbtn-mn ghost" style={{ marginTop: 9, width: '100%' }}
            disabled={!goCanvas}
            title={lessonTitle ? '新建一张挂在「' + lessonTitle + '」上的画布' : '新建一张挂在这一讲上的画布'}
            onClick={() => goCanvas?.({ lessonId: lid })}>
            <Icon n="plus" size={13} />新建本讲笔记
          </button>
        ) : null}
      </div>

      <div className="sc-mn">
        <div className="h">这一讲的截图</div>
        {!lid ? (
          <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>还没选讲次</div>
        ) : shots.loading ? (
          <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>正在读…</div>
        ) : !(shots.data?.shots || []).length ? (
          <div style={{ fontSize: 11.5, color: 'var(--tx3)', lineHeight: 1.7 }}>
            还没有截图。看到要记的地方按 <b style={{ color: 'var(--tx2)' }}>S</b> 截这一帧。
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {(shots.data?.shots || []).map((s) => (
              /* 点带秒数的那张 = 跳回那一刻（在播放器上 seek），不是开新标签 ——
                 截帧的意义就是「我讲过这里」，得能回去看。普通截图才开原图。 */
              <div className={'shotcellwrap' + (delShotArm === s.id ? ' arming' : '')} key={s.id}>
                <button className="shotcell-mn" title={s.pos_sec != null ? '跳回 ' + clock(s.pos_sec) : (s.title || '')}
                  onClick={() => seekTo(s.pos_sec, s.file)}>
                  <img src={'/shots/' + s.file} alt={s.title || ''} loading="lazy" />
                  {s.pos_sec != null ? <em>{clock(s.pos_sec)}</em> : null}
                </button>
                {/* 右栏这格以前只有「点开看图」，没有「删掉」——
                    用户的原话：「你把截图放在了右手边，我怎么删？你给我按键去删的吗？」
                    所以按钮必须在这儿，而且要常显。 */}
                <button className="shotdel cell" aria-label="删掉这张截图"
                  title={delShotArm === s.id ? '再点一次就删掉' : '从素材库摘掉这一张'}
                  onClick={(e) => { e.stopPropagation(); delShot(s) }}>
                  {delShotArm === s.id ? <span>再点</span> : <Icon n="trash" size={11} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {msg2 ? <div className="tg-mn ok shotmsg-mn" style={{ alignSelf: 'flex-start' }}>{msg2}</div> : null}
      <div style={{ fontSize: 10.5, color: 'var(--tx3)', lineHeight: 1.7, padding: '0 2px' }}>
        截图和画布导出进的是同一个素材库，靠来源标区分。
      </div>
    </aside>
  )
}

/* 进度条上的打点。鼠标移上去给出秒数，点一下跳过去。
   一条 1px 的轨 + 若干 2px 竖线就够 —— 这里不是播放器控件，是「我讲过哪儿」的地图。 */
function Ticks({ shots, dur, cur, onSeek }: {
  shots: { id: string; pos_sec?: number | null; title?: string }[]
  dur: number; cur: number
  onSeek: (sec: number) => void
}) {
  const marks = shots.filter((s) => s.pos_sec != null) as { id: string; pos_sec: number; title?: string }[]
  if (!dur || !marks.length) return null
  return (
    <div className="ticks-mn" title="有截图的时刻。点一下跳过去">
      <i className="fill" style={{ width: Math.min(100, (cur / dur) * 100) + '%' }} />
      {marks.map((m) => (
        <button key={m.id} className="mark"
          style={{ left: Math.min(99.6, Math.max(0, (m.pos_sec / dur) * 100)) + '%' }}
          title={clock(m.pos_sec) + (m.title ? ' · ' + m.title : '')}
          onClick={() => onSeek(m.pos_sec)} />
      ))}
    </div>
  )
}

/* 秒 → 12:34。超过一小时给 1:02:03，别让人自己算。 */
function clock(sec: number) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const p = (n: number) => (n < 10 ? '0' + n : '' + n)
  return h ? h + ':' + p(m) + ':' + p(r) : m + ':' + p(r)
}

/* 画布缩略图：只画服务端给的骨架 shape（前 3 层、最多 16 节点），不画假图。
   画法是最朴素的树状：根在左，子节点往下排，用横线连 —— 120×54 的格子里
   只求「能看出这张画布大概长什么样」，不求可读。 */
function WordTab({ lid }: { lid?: string }) {
  const d = useTool<{ is_word_lesson: boolean; words: { w: string; pos?: string; cn?: string }[]; count: number; reason?: string }>(
    'list_lesson_words', { lesson_id: lid }, { skip: !lid })
  if (!lid) return <div style={{ fontSize: 12, color: 'var(--tx3)' }}>还没选讲次</div>
  if (d.loading) return <Skel kind="row" n={4} />
  if (!d.data?.is_word_lesson) {
    return <div style={{ fontSize: 12, color: 'var(--tx3)' }}>{d.data?.reason || '这一讲不是单词课，不给词表'}</div>
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
      {(d.data.words || []).map((w, i) => (
        <div key={i} style={{ padding: '9px 11px', background: 'var(--card)', borderRadius: 10 }}>
          <b style={{ fontSize: 13, display: 'block' }}>{w.w}</b>
          <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>{w.pos ? w.pos + ' ' : ''}{w.cn}</span>
        </div>
      ))}
    </div>
  )
}

function DocTab({ cont }: { cont?: Content }) {
  const res = cont?.resources || []
  if (!res.length) {
    return <div style={{ fontSize: 12, color: 'var(--tx3)' }}>这一讲没有挂资料 —— 资料来自 workbench/data，没挂就是没有。</div>
  }
  return (
    <>
      {res.slice(0, 8).map((r: any, i: number) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
          <span style={{ fontSize: 11, color: 'var(--tx3)', minWidth: 52 }}>{r.kind}</span>
          <span style={{ fontSize: 12.5, flex: 1 }}>{r.label || r.file}</span>
          <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
            {[r.kb ? r.kb + ' KB' : '', r.pdf ? r.pdf + ' 份 PDF' : ''].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
    </>
  )
}

type IQ = { no: number; stem: string; opts: Record<string, string>; part?: string; topic?: string
  done?: boolean; last_ok?: number }
type LQ = { lesson_id: string; lesson_title?: string; source?: string
  total: number; done: number; right: number; questions: IQ[]; say?: string }

/* 讲题四段固定顺序（服务端按 key 给，这里只负责摆，不重排不改名）。
   练习页那份是印在米白纸上的，这一段是深色壳里，所以排版另写一份 ——
   但**数据是同一个 explain_question**，四段、依据、命中与否都一致。 */
const EX_ORDER = ['locate', 'basis', 'evidence', 'judge', 'fix']

function ExplainBox({ doc }: { doc: any }) {
  if (!doc) return null
  if (doc.found === false || doc.reason) {
    return (
      <div className="izex izex-none">
        {doc.reason || '这题没有可讲的依据 —— 捞不到就不编。'}
      </div>
    )
  }
  const parts = (doc.parts || []).slice().sort(
    (a: any, b: any) => EX_ORDER.indexOf(a.key) - EX_ORDER.indexOf(b.key))
  return (
    <div className="izex">
      <div className="hd">
        <b>这题怎么想的</b>
        {doc.verdict ? (
          <span className={'vd' + (doc.verified ? ' ok' : '')}>{doc.verdict}</span>
        ) : null}
        {doc.model ? <span className="md">{doc.model}</span> : null}
      </div>
      {parts.map((p: any) => (
        <div className="pt" key={p.key}>
          <div className="tt" data-k={p.key}>{p.title}</div>
          {p.text ? <div className="tx">{p.text}</div> : null}
          {(p.lines || []).map((l: any, i: number) => (
            <div className={'ln' + (l.verified === false ? ' bad' : '')} key={i}>
              <span>{l.text}</span>
              {l.where || l.verified === false ? (
                <i>{l.where || ''}{l.verified === false ? '　· 未在原文命中' : ''}</i>
              ) : null}
            </div>
          ))}
          {(p.opts || []).map((o: any, i: number) => (
            <div className={'op ' + (o.state || '')} key={'o' + i}>
              <b>{o.opt}</b><span>{o.text}</span>
              {o.note ? <i>{o.note}</i> : null}
            </div>
          ))}
        </div>
      ))}
      {(doc.gaps || []).length ? (
        <div className="gap">没讲到：{(doc.gaps || []).join('、')}</div>
      ) : null}
    </div>
  )
}

/* 当堂测：出完就地做，而且做完挂在「这一讲」名下 ——
   切走再回来还在，能接着做没做完的，也能再出一批。
   以前 q 只活在内存里：切个讲次回来就是空的，等于每次重出，
   出的题也不知道属于哪一讲（题一股脑进了「AI 生成 · 某科」那个题源）。
   现在题从 lesson_quiz 读（按题上的 lesson_id 捞回来），判分仍走 grade_answer，
   跟练习页同一条链路 —— 这里答的题同时进 answers 表，不是两套成绩。 */
function TestTab({ cont, sid, lid, pct }: {
  cont?: Content; sid?: string; lid?: string; pct: number
}) {
  const covers = cont?.covers || []
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [pick, setPick] = useState<Record<number, string>>({})
  const [judged, setJudged] = useState<Record<number, { ok: boolean; ans: string }>>({})
  const [ex, setEx] = useState<Record<number, any>>({})
  const [exBusy, setExBusy] = useState<number | null>(null)

  const lq = useTool<LQ>('lesson_quiz', { lesson_id: lid }, { skip: !lid })
  const qs: IQ[] = lq.data?.questions || []
  const src = String(lq.data?.source || '')

  // 换讲次清本地作答痕迹：上一讲勾选的选项不该留在这一讲底下。
  useEffect(() => {
    setMsg(null); setPick({}); setJudged({}); setEx({})
  }, [lid])

  /* 出题参数不用人填：科目和讲次就在这儿，考点由后端从 lesson_content 里取。
     没对上考点的讲次也照出 —— 但回执会如实说是「按本科考点卡出的」，不冒充「贴这一讲」。 */
  async function gen() {
    if (!lid || busy) return
    setBusy(true)
    setMsg('正在出题…（要真调一次模型，约 10–20 秒）')
    const r = await callTool('quiz_gen', { lesson_id: lid, subject: sid, n: 5 }, { write: true })
    setBusy(false)
    const d: any = r.data || {}
    setMsg(r.ok ? (d.say || '出好了，题挂在这一讲名下') : (d.say || d.error || r.error || '没出成'))
    if (r.ok) { setPick({}); setJudged({}); setEx({}); lq.run() }
  }

  async function answer(q: IQ, chosen: string) {
    if (!src || q.done || judged[q.no]) return
    setPick((p) => ({ ...p, [q.no]: chosen }))
    const r = await callTool('grade_answer',
      { source: src, qno: q.no, chosen, kind: 'practice' }, { write: true })
    const d: any = r.data || {}
    /* 判错的时候外层 ok 也是 false —— 那一位表示「这题对不对」，不是「判分成没成」。
       拿 r.ok 当成功判据，会把「答错了」显示成「判不了」。只看 judged。 */
    if (d.judged) {
      setJudged((j) => ({ ...j, [q.no]: { ok: !!d.ok, ans: String(d.ans || '') } }))
      lq.run()   // 让「做完几道、对几道」立刻跟上去，不用切走再回来才看得见
    } else {
      setMsg(d.note || d.error || r.error || '这题判不了（没写作答记录）')
    }
  }

  /* 这一题的判定：本地刚判的优先；没判过的看库里有没有做过（上一次切走前做的）。 */
  const stateOf = (q: IQ): { ok: boolean; ans: string } | null =>
    judged[q.no] || (q.done ? { ok: q.last_ok === 1, ans: '' } : null)
  const doneN = qs.filter((q) => !!stateOf(q)).length
  const rightN = qs.filter((q) => !!stateOf(q)?.ok).length

  /* 答错才给「为什么错」——答对的题不需要再讲一遍，
     给了只会让人多点一次。讲题走的是 explain_question：先捞依据再说话，
     捞不到就返回 reason，界面上照实显示「没有依据的不编」。 */
  async function explain(no: number) {
    if (exBusy !== null || !src) return
    setExBusy(no)
    const r = await callTool<any>('explain_question',
      { source: src, ref: no, chosen: pick[no] || null })
    setExBusy(null)
    setEx((m) => ({ ...m, [no]: (r.data as any) || { reason: r.error || '讲不了：没有依据' } }))
  }

  return (
    <>
      {covers.length ? (
        <div className="srcbar-mn" style={{ marginBottom: 10 }}>
          {covers.map((c, i) => (
            <span key={i} className="schip-mn" style={{ cursor: 'default' }}>
              <b>{c.name}</b><i>{c.n} 题</i>
            </span>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--tx3)', lineHeight: 1.7 }}>
          这一讲的标题没对上具体考点 —— 出题只能按这一科的考点卡出，不冒充「贴这一讲」。
        </div>
      )}

      {covers.length ? (
        <div style={{ fontSize: 12, color: 'var(--tx3)', lineHeight: 1.8, marginBottom: 12 }}>
          {covers.map((c, i) => <div key={i}>· {c.why}</div>)}
        </div>
      ) : null}

      <div className="genrow-mn">
        <button className="aigen-mn" disabled={busy || !lid} onClick={gen}>
          {busy ? '出题中…' : (qs.length ? '再出 5 题' : (covers.length ? '这一讲练 5 题' : '按本科目出 5 题'))}
        </button>
        <span className="genrow-n">
          {pct >= 80 ? '看得差不多了，正好回头测一次' :
            `才看到 ${Math.round(pct)}%，现在测是提前考自己 —— 也能测，就是会偏难`}
        </span>
      </div>

      {msg ? <div className="genmsg-mn">{msg}</div> : null}

      {/* 这一讲的题是存下来的：切走再回来这一段还在，不用重新出。
          以前没有这一行，人切回来只看见一个「出 5 题」按钮，
          根本不知道刚才那批题去哪了。 */}
      {qs.length ? (
        <div className="lzbar-mn">
          <span>这一讲共 <b>{qs.length}</b> 题 · 做完 <b>{doneN}</b> · 对 <b>{rightN}</b></span>
          <i>{doneN < qs.length ? '没做完的接着做，切走再回来也还在' : '这批都做过了，想加练就再出 5 题'}</i>
        </div>
      ) : !busy && lq.data ? (
        <div className="genmsg-mn">{lq.data.say || '这一讲还没出过题。'}</div>
      ) : null}

      {qs.length ? (
        <div className="inzq-mn">
          {qs.map((q) => {
            const j = stateOf(q)
            /* 库里记着做过、但这一轮还没在本机判过的 —— 是上一次切走前做的，
               如实标出来，别假装这是刚答的，也别把人已经做过的题又算一遍。 */
            const wasBefore = !judged[q.no] && !!q.done
            return (
              <div className="inzq" key={q.no}>
                <div className="st">
                  <b>{q.no}</b><span>{q.stem}</span>
                  {wasBefore ? <i className="iztag">{j?.ok ? '之前做对' : '之前错过'}</i> : null}
                </div>
                <div className="ops">
                  {Object.keys(q.opts).map((k) => {
                    const on = pick[q.no] === k
                    const cls = j ? (k === j.ans ? ' ok' : (on ? ' bad' : '')) : (on ? ' on' : '')
                    return (
                      <button key={k} className={'izop' + cls} disabled={!!j}
                        onClick={() => answer(q, k)}>
                        <i>{k}</i><span>{q.opts[k]}</span>
                      </button>
                    )
                  })}
                </div>
                {j ? (
                  <div className={'izfb' + (j.ok ? ' ok' : ' bad')}>
                    {wasBefore
                      ? (j.ok ? '这题你之前做对了' : '这题你之前做错过')
                      : (j.ok ? '答对' : '答错 · 正确答案 ' + (j.ans || '—'))}
                    {j.ok ? null : (ex[q.no] ? null : (
                      <button className="izex-btn" disabled={exBusy === q.no}
                        onClick={() => explain(q.no)}>
                        {exBusy === q.no ? '在捞依据…' : '这题为什么错'}
                      </button>
                    ))}
                  </div>
                ) : null}
                {ex[q.no] ? <ExplainBox doc={ex[q.no]} /> : null}
              </div>
            )
          })}
          <div className="izsum">
            做完 {doneN}/{qs.length} · 对 {rightN} 道
            <a className="genmsg-go" href="#practice">去练习页看汇总 →</a>
          </div>
        </div>
      ) : null}
    </>
  )
}

function AskBox({ lid, title }: { lid?: string; title?: string }) {
  const [q, setQ] = useState('')
  const [a, setA] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function ask() {
    if (!q.trim()) return
    setBusy(true); setA(null)
    const r = await callTool('ask_ai', { question: q, lesson_id: lid, context: title })
    setBusy(false)
    setA(r.ok ? String((r.data as any)?.answer ?? (r.data as any)?.text ?? JSON.stringify(r.data)) : (r.error || '没问出来'))
  }
  return (
    <>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="inp-mn" style={{ flex: 1, height: 30 }} value={q} placeholder="就这一讲问一句"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') ask() }} />
        <button className="pbtn-mn" disabled={busy} onClick={ask}>{busy ? '问着…' : '问'}</button>
      </div>
      {a ? (
        <div style={{ marginTop: 10, padding: '11px 14px', background: 'var(--card)', borderRadius: 10,
          fontSize: 12.5, lineHeight: 1.85, color: 'var(--tx2)', whiteSpace: 'pre-wrap' }}>{a}</div>
      ) : null}
    </>
  )
}
