import { useEffect, useState, type ReactNode } from 'react'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import type { Base } from '../lib/api'
import { Icon } from '../components/Icon'
import { Empty } from '../components/V6'
import { Sel } from '../components/Sel'
import { takeIntent } from '../lib/intent'
import { asrStatus, type AsrStatus } from '../lib/recorder'
import { BiliLogin } from '../components/BiliLogin'

/* 设置页 v7：配置台，不是仪表盘。
   上一版是「4 个数字 + 三张卡」——四件互不相干的事靠卡片边框隔着，
   改一个 Key 要在一张卡底部找一段表单，危险操作和普通配置同一层滚动就能撞上。
   这一版按「分区 → 一行一件事 → 抽屉里改」重排：
     左侧四个分区只做导航，右侧一行只放一件事（标题 + 一句说明 + 状态 + 一个动作），
     凡是需要填东西的，一律从右侧滑出抽屉，不在行里展开。
   规矩照旧：这层不是装饰 —— 要点确认才能跑的工具拦的是改课程库、清记录、写盘。 */

type Prov = {
  provider: string; name: string; configured: boolean; usable: boolean; why: string
  login: string; selected: boolean; model: string; account?: string; expires_text?: string
  base_url?: string; key_masked?: string
}
/* 厂家预设：地址是公开常量，替人记住就行 —— 人只该填 Key 这一件本机独有的东西。 */
type Pre = { id: string; name: string; base: string; note?: string; local?: boolean }
type ModelRow = { id: string; ctx?: number | null }
type Src = {
  id: string; name: string; kind: string; how: string; ready: boolean
  connected: boolean; state: string; missing: string | null
  hint?: { field?: string; label?: string; eg?: string; help?: string }
}

type SecKey = 'account' | 'model' | 'sources' | 'voice' | 'backup' | 'danger'
const SECS: { k: SecKey; t: string; icon: string }[] = [
  { k: 'account', t: 'B 站账号', icon: 'sound' },
  { k: 'model', t: '模型接入', icon: 'agent' },
  { k: 'sources', t: '数据来源', icon: 'tag' },
  /* 语音单列一区，不塞进「模型接入」—— 它跟主模型不是两码事里的同一码：
     主模型负责答话，这个只把人说的话变成字，装不装都不影响聊天。 */
  { k: 'voice', t: '语音输入', icon: 'mic' },
  { k: 'backup', t: '数据与备份', icon: 'stack' },
  { k: 'danger', t: '危险区', icon: 'trash' },
]

/* 一行一件事。左标题 + 一句说明，右状态 + 动作；长的原因文案折到说明里，
   不许挤在标题旁边变成一列日志。 */
function Row({ title, sub, tag, tagCls, act }: {
  title: ReactNode; sub?: ReactNode; tag?: string; tagCls?: string; act?: ReactNode
}) {
  return (
    <div className="setrow">
      <div className="setrow-mn">
        <b>{title}</b>
        {sub ? <span>{sub}</span> : null}
      </div>
      <div className="setrow-ac">
        {tag ? <span className={'tg-mn ' + (tagCls || 'im')}>{tag}</span> : null}
        {act}
      </div>
    </div>
  )
}

export function Agent({ base }: { base: Base }) {
  const ai = useTool<{ current: string; current_name: string; model: string; providers: Prov[] }>('ai_providers')
  const ns = useTool<{ sources: Src[]; count: number; ready?: string[]; note?: string }>('note_sources')
  const bk = useTool<{ backups?: any[]; count?: number }>('list_backups')
  const sy = useTool<{ bundles?: number; last_push?: string; peers?: number }>('sync_status')
  const calls = useTool<{ calls: any[] }>('recent_tool_calls', { limit: 30 })
  const pre = useTool<{ presets: Pre[] }>('ai_presets')
  const pq = useTool<{ qn: number; logged_in: boolean }>('play_quality')
  const bsync = useTool<{ on: boolean }>('bili_sync')

  const [sec, setSec] = useState<SecKey>('account')
  const [msg, setMsg] = useState<string | null>(null)
  /* 抽屉：null 就是关着。两种内容 —— 自己的 API / 某个笔记来源。
     关掉不丢已存配置，也不清正在填的字（清字是「算了」那个动作的事）。 */
  const [sheet, setSheet] = useState<{ kind: 'api' | 'src'; id?: string } | null>(null)

  // 自己的 API：四个空格。窗宽只做提示，填 0 或不填就不写。
  const [api, setApi] = useState({ base: '', model: '', key: '', ctx: '' })
  const [apiBusy, setApiBusy] = useState<string | null>(null)
  /* 厂家预设 + 现场拉到的型号。
     型号不写死：三个月就换一批，宁可现场问一次 /models，也不给一份会过期的清单。 */
  const [presel, setPresel] = useState('')
  const [models, setModels] = useState<ModelRow[]>([])
  const [pullMsg, setPullMsg] = useState<string | null>(null)
  const [cfgVal, setCfgVal] = useState('')
  // 清空平台：必须手打「清空」两个字，按钮才亮
  const [wipeWord, setWipeWord] = useState('')
  const [xBusy, setXBusy] = useState(false)

  /* ---- 语音输入 ---------------------------------------------------------
     模型不在启动时加载：这里只问「装没装」，问一次就够（本地接口，1ms）。
     装的过程中每秒刷一次，进度是真的（按已落盘字节算）。 */
  const [av, setAv] = useState<AsrStatus | null>(null)
  const [avTick, setAvTick] = useState(0)
  const [avBusy, setAvBusy] = useState(false)

  useEffect(() => { asrStatus().then(setAv) }, [avTick])
  useEffect(() => {
    if (!av?.job?.running) return
    const t = setInterval(() => setAvTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [av?.job?.running])

  /* 从聊天框点麦克风过来的人，要直接落在这一区，并且看到为什么来的。 */
  useEffect(() => {
    const it = takeIntent('agent')
    if (!it) return
    if (it.sec === 'voice') setSec('voice')
    if (it.note) setMsg(it.note)
  }, [])

  async function installAsr(force = false) {
    setAvBusy(true)
    // force：已装之后再点就是「重装」—— 模型文件坏了、想重新拉一份时用。
    // 不传 force 的话后端会回「已经有了，不用再装」，那颗按钮就成了点不动的死键。
    const r = await callTool('asr_setup', { force }, { write: true })
    const d = r.data || {}
    setMsg(r.ok ? (d.say || '开始装') : (r.error || '没装上'))
    setAvTick((x) => x + 1)

    /* 装是后台线程干的，接口一返回就说「开始了」——但那时文件还没落地。
       只刷新一次的话，人看到的就是「点了没反应」。这里盯着看，每秒问一次，
       装好 / 明确报错 / 90 秒超时才退出。进度条上的数是服务端真实写盘字节。 */
    for (let i = 0; i < 90; i++) {
      await new Promise((res) => setTimeout(res, 1000))
      const s = await asrStatus()
      if (!s) break
      setAv(s)
      if (s.installed) break
      if (s.job && !s.job.running && s.job.error) break
    }
    setAvBusy(false)
    setAvTick((x) => x + 1)
  }

  useEffect(() => {
    if (!sheet) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(null) }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [sheet])

  const tools: string[] = (base as any).tools ?? []
  const confirm: string[] = (base as any).confirm_tools ?? []
  const provs = ai.data?.providers ?? []
  const srcs = ns.data?.sources ?? []
  const connected = srcs.filter((s) => s.connected).length
  const backups = bk.data?.count ?? (bk.data?.backups || []).length
  const callList = calls.data?.calls || []
  const apiProv = provs.find((p) => p.provider === 'apikey')
  const presets = pre.data?.presets || []
  const curPreset = presets.find((x) => x.id === presel)

  /* 打开抽屉时把已经存过的地址回填 —— 每次重粘一遍不算「配置」，算抄写。 */
  function openApi() {
    const b = apiProv?.base_url || 'https://api.deepseek.com'
    const m = presets.find((x) => x.base && x.base.toLowerCase().replace(/\/$/, '') === b.toLowerCase().replace(/\/$/, ''))
    setApi({ base: b, model: apiProv?.model || '', key: '', ctx: '' })
    setPresel(m ? m.id : 'custom')
    setModels([]); setPullMsg(null)
    setSheet({ kind: 'api' })
  }
  function pickPreset(id: string) {
    setPresel(id)
    const p = presets.find((x) => x.id === id)
    /* 换厂家就把型号清掉：留着「deepseek-chat」配 moonshot 的地址，
       存下去就是一个必然失败的配置 —— 这种「看着填满了其实是错的」最难查。 */
    if (p && p.base) setApi((a) => ({ ...a, base: p.base, model: a.base === p.base ? a.model : '' }))
    setModels([]); setPullMsg(null)
  }
  /* 拉型号：只读、不保存。拉不到就让人手填 —— 不编清单。 */
  async function pullModels() {
    setPullMsg('在问这家有哪些型号…')
    setModels([])
    const r = await callTool('ai_models_probe',
      { base_url: api.base.trim(), api_key: api.key.trim() }, { write: false })
    const d = r.data || {}
    if (r.ok && d.ok) {
      setModels(d.models || [])
      setPullMsg(d.say || `拉到 ${d.count} 个型号`)
    } else {
      setPullMsg(d.error || r.error || '没拉到')
    }
  }
  const sheetSrc = sheet?.kind === 'src' ? srcs.find((s) => s.id === sheet.id) : null

  async function useProv(p: Prov) {
    const r = await callTool('ai_use', { provider: p.provider }, { write: true })
    setMsg(r.ok ? '已切到 ' + p.name : (r.error || '没切'))
    ai.run()
  }
  async function saveApi() {
    if (!api.base.trim() && !api.model.trim() && !api.key.trim() && !api.ctx.trim()) {
      setMsg('四样都空着：地址 / 模型 / Key / 窗宽，至少填一样'); return
    }
    setApiBusy('save')
    const r = await callTool('ai_apikey_set', {
      base_url: api.base.trim(), model: api.model.trim(),
      api_key: api.key.trim(),
      ctx: api.ctx.trim() ? Number(api.ctx.trim()) : undefined,
    }, { confirm: true, write: true })
    setApiBusy(null)
    setMsg(r.ok ? (r.data?.say || '存好了') : (r.error || '没存上'))
    if (r.ok) { setApi({ base: '', model: '', key: '', ctx: '' }); ai.run(); setSheet(null) }
  }
  async function probeKey() {
    setApiBusy('probe')
    const r = await callTool('ai_probe', { provider: 'apikey' }, { write: false })
    setApiBusy(null)
    // ai_probe 的字段是 said / elapsed_ms / reason —— 别拿 reply 这种不存在的键去读。
    const d = r.data || {}
    setMsg(r.ok && d.usable
      ? `试通了：它回「${d.said}」（${d.model || '模型名没记'}，${d.elapsed_ms || 0}ms）`
      : `没通：${d.reason || r.error || '没给原因'}`)
  }
  async function clearKey() {
    setApiBusy('clear')
    const r = await callTool('ai_apikey_clear', {}, { confirm: true, write: true })
    setApiBusy(null)
    setMsg(r.ok ? 'Key 清掉了（地址和模型名留着）' : (r.error || '没清掉'))
    if (r.ok) ai.run()
  }
  async function saveCfg(id: string) {
    /* note_src_cfg 只认 src / path / token / base 四个键（tools.py:2713）——
       往里塞 values 这种包装它看不懂，存完还是没连上。按 hint.field 分头传。 */
    const f = srcs.find((s) => s.id === id)?.hint?.field || 'path'
    const r = await callTool('note_src_cfg', { src: id, [f]: cfgVal }, { write: true })
    setMsg(r.ok ? id + '：' + (r.data?.state || '已保存') : (r.error || '没存上'))
    setSheet(null); setCfgVal(''); ns.run()
  }
  async function doBackup() {
    const r = await callTool('make_backup', {}, { write: true })
    setMsg(r.ok ? '快照已存' : (r.error || '没存上'))
    if (r.ok) bk.run()
  }
  async function push() {
    const r = await callTool('sync_push', {}, { write: true })
    setMsg(r.ok ? '已推送' : (r.error || '没推成'))
    sy.run()
  }
  /* XMind 走 OAuth：现开授权页，回调落到本服务的 /oauth/xmind/callback */
  async function xmindLogin() {
    setXBusy(true)
    try {
      const r = await fetch('/api/xmind/login', { method: 'POST' })
      const d = await r.json()
      if (d.url) {
        window.open(d.url, '_blank', 'noopener')
        setMsg('授权页开出来了：在浏览器里点同意，回来点「检查状态」就通了。')
      } else {
        setMsg(d.error || '授权页没开出来（联网了吗）')
      }
    } catch (e: any) {
      setMsg('连不上本地服务：' + (e?.message || e))
    }
    setXBusy(false)
  }
  async function xmindOut() {
    setXBusy(true)
    try { await fetch('/api/xmind/logout', { method: 'POST' }) } catch { /* 本地服务不在也照说结果 */ }
    setXBusy(false)
    setMsg('XMind 断开了（只清本机 token，云端没动）')
    ns.run()
  }
  async function doWipe() {
    if (wipeWord.trim() !== '清空') { setMsg('要清空得先打「清空」两个字'); return }
    setApiBusy('wipe')
    const r = await callTool('platform_reset', { confirm: '清空', keep_model: true },
      { confirm: true, write: true })
    setApiBusy(null)
    setMsg(r.ok ? (r.data?.say || '清空了') : (r.error || '没清'))
    if (r.ok) { setWipeWord(''); ai.run(); ns.run(); bk.run() }
  }

  return (
    <div className="setpage">
      <nav className="setnav" aria-label="设置分区">
        <div className="setnav-h">设置</div>
        {SECS.map((s, i) => (
          <button key={s.k} className={'setnav-i' + (sec === s.k ? ' on' : '')}
            data-i={i} aria-current={sec === s.k ? 'page' : undefined}
            onClick={() => { setSec(s.k); setMsg(null) }}>
            <Icon n={s.icon} size={16} />
            <span>{s.t}</span>
          </button>
        ))}
      </nav>

      <div className="setmain">
        {sec === 'account' && (
          <>
            <div className="set-h">B 站账号</div>
            <div className="set-sub">登录后能看 1080P；看视频的进度也会同步进 B 站历史，两边对齐。凭证只存本机。</div>
            {msg ? <div className="set-note">{msg}</div> : null}

            <div className="set-group">身份</div>
            <div className="set-account"><BiliLogin label={false} /></div>
            {/* 这句要写出来：用户明确问过「为什么没有验证码登录」。
                不说清楚，人只会以为我们漏做了。 */}
            <Row title="验证码登录"
              sub="B 站网页端的短信登录必须过极验人机验证，程序替人过不去 —— 只能扫码。手机扫一下和收验证码一样快。"
              tag="只支持扫码" tagCls="im" />

            <div className="set-group">播放</div>
            <Row title="默认画质"
              sub={pq.data?.logged_in ? '登录状态下可用 1080P；不同画质各占一份缓存。' : '没登录最高 480P —— 先扫码登录。'}
              act={
                <Sel ariaLabel="默认画质" value={String(pq.data?.qn || 64)}
                  style={{ width: 110 }}
                  onChange={async (v) => {
                    const r = await callTool('play_quality', { qn: Number(v) })
                    setMsg(r.ok ? ('默认画质改成 ' + (r.data?.name || v) + ' 了') : (r.error || '没改上'))
                    pq.run()
                  }}
                  options={[
                    { value: '80', label: '1080P', disabled: !pq.data?.logged_in },
                    { value: '64', label: '720P', disabled: !pq.data?.logged_in },
                    { value: '32', label: '480P' },
                  ]} />
              } />
            <Row title="进度同步到 B 站"
              sub="看视频时每 5 分钟报一次进度；打开一讲时如果 B 站那边更靠后，就接着那儿放。"
              tag={bsync.data?.on ? '已开' : '已关'} tagCls={bsync.data?.on ? 'ok' : 'im'}
              act={
                <button className="pbtn-mn ghost" onClick={async () => {
                  const r = await callTool('bili_sync', { on: !bsync.data?.on })
                  setMsg(r.ok ? (r.data?.say || '改好了') : (r.error || '没改上'))
                  bsync.run()
                }}>{bsync.data?.on ? '关掉' : '打开'}</button>
              } />
          </>
        )}

        {sec === 'model' && (
          <>
            <div className="set-h">模型接入</div>
            <div className="set-sub">谁来思考。选中的那家会用在讲题、作文批改、提问和助手上。</div>
            {msg ? <div className="set-note">{msg}</div> : null}

            <div className="set-group">正在说话</div>
            {provs.length ? provs.map((p) => {
              const isApi = p.provider === 'apikey'
              /* 副行只回答两件事：这家现在能不能用、能用到哪天。
                 账号昵称（沉默的鸟 / 用户8577257195）和配置文件路径（server/config.local.json）
                 一律不往界面上摆 —— 那是本机的事，不是用户要读的信息。
                 具体模型名留在 title 里，鼠标停一下能看到。 */
              const state = p.usable
                ? (p.expires_text ? '登录态到 ' + String(p.expires_text).slice(0, 10) : '已登录')
                : (isApi ? (p.configured ? 'Key 已填，没连通' : '还没填 Key')
                  : (p.configured ? '登录态过期了，续一下' : '还没登录'))
              return (
                <Row key={p.provider}
                  title={<>
                    {p.name}
                    {p.selected ? <span className="set-cur">当前</span> : null}
                  </>}
                  sub={state}
                  tag={p.selected ? '在用' : p.usable ? '可用' : p.configured ? '不可用' : '没配'}
                  tagCls={p.selected ? 'ok' : p.usable ? 'ok' : p.configured ? 'md' : 'im'}
                  act={<>
                    {isApi ? (
                      <button className={'pbtn-mn' + (p.configured ? ' ghost' : '')} onClick={openApi}>
                        设置
                      </button>
                    ) : null}
                    {/* 切过去只该在「这家现在真能说话」时给 —— 点一个没配的不叫切换，叫掉进坑里。 */}
                    {p.selected || !p.usable ? null : (
                      <button className="pbtn-mn" onClick={() => useProv(p)}>换这家</button>
                    )}
                  </>}
                />
              )
            }) : (
              <Empty title="还没有模型">
                装一个本地模型，或接一家在线 API —— 没接也能用，本机那部分照常跑。
              </Empty>
            )}
            {apiProv ? null : (
              <div className="set-note">
                「自己的 Key」是给你那条 OpenAI 兼容线路留的：填地址 / 模型 / Key 就行。
              </div>
            )}

            <div className="set-group">主观题判分</div>
            <Row title="作文和填空由谁判"
              sub="现在用主模型判语言那部分，本机能数的（词数、要点、格式）先算完；不单独接一家判断模型"
              tag="跟随主模型" tagCls="im" />

            <div className="set-foot">
              这一套接了 <b>{tools.length}</b> 个工具，其中 <b>{confirm.length}</b> 个会先问一句再动手。
            </div>
          </>
        )}

        {sec === 'sources' && (
          <>
            <div className="set-h">数据来源</div>
            <div className="set-sub">
              {srcs.length} 个来源，{connected} 个已连上。这些是「把别处的东西记进来」用的，不连也不影响做题。
            </div>
            {msg ? <div className="set-note">{msg}</div> : null}

            <div className="set-group">笔记与画布</div>
            {srcs.length ? srcs.map((s) => {
              const isX = s.id === 'xmind'
              const canCfg = !!(s.hint?.field) && !isX
              return (
                <Row key={s.id}
                  title={s.name}
                  sub={<>{s.state}{s.how ? '　· ' + s.how : ''}</>}
                  tag={s.connected ? '能用' : s.ready ? '待配' : '未装'}
                  tagCls={s.connected ? 'ok' : s.ready ? 'md' : 'im'}
                  act={<>
                    {isX ? (
                      s.connected ? (
                        <>
                          <button className="pbtn-mn ghost" onClick={() => ns.run()}>检查状态</button>
                          <button className="pbtn-mn ghost" disabled={xBusy} onClick={xmindOut}>断开</button>
                        </>
                      ) : (
                        <>
                          <button className="pbtn-mn" disabled={xBusy} onClick={xmindLogin}>
                            {xBusy ? '在开…' : '登录 XMind'}
                          </button>
                          <button className="pbtn-mn ghost" onClick={() => ns.run()}>检查状态</button>
                        </>
                      )
                    ) : null}
                    {canCfg && !s.connected ? (
                      <button className="pbtn-mn ghost"
                        onClick={() => { setCfgVal(''); setSheet({ kind: 'src', id: s.id }) }}>
                        {s.missing ? '设置' : '连接'}
                      </button>
                    ) : null}
                    {canCfg && s.connected ? (
                      <button className="pbtn-mn ghost"
                        onClick={() => { setCfgVal(''); setSheet({ kind: 'src', id: s.id }) }}>
                        {s.hint?.field === 'token' ? '改令牌' : '改路径'}
                      </button>
                    ) : null}
                  </>}
                />
              )
            }) : (
              <Empty title="没有数据来源">这是给「把别处的东西记进来」用的 —— 不接也不影响做题。</Empty>
            )}
          </>
        )}

        {sec === 'voice' && (
          <>
            <div className="set-h">语音输入</div>
            <div className="set-sub">
              在聊天框里按麦克风说话，本机转成文字再填进输入框。音频只在这台机器上转，
              不出门；模型不装也能正常用键盘打字，装了才多这一个入口。
            </div>
            {msg ? <div className="set-note">{msg}</div> : null}

            <div className="set-group">转写模型</div>
            {(() => {
              const job = av?.job
              const busy = !!job?.running
              const installed = !!av?.installed
              const loaded = !!av?.loaded
              const mb = (n?: number) => ((n || 0) / 1048576).toFixed(1) + ' MB'
              const pct = job && job.total > 0 ? Math.min(100, Math.round((job.bytes / job.total) * 100)) : 0

              const state = busy
                ? (job!.stage || '装着…')
                : installed
                  ? (loaded ? '已装好，正在内存里待命' : '已装好，第一次转写时才读进内存（约 0.4 秒）')
                  : av && av.cached > 0
                    ? '还没装进本项目，但本机缓存里已有 ' + mb(av.cached) + '，点装是秒完成'
                    : '还没装。约 141MB，要联网下'

              return (
                <>
                  <Row
                    title="faster-whisper base（中文）"
                    sub={state}
                    tag={busy ? '在装' : installed ? (loaded ? '在用' : '已装') : '没装'}
                    tagCls={busy ? 'md' : installed ? 'ok' : 'im'}
                    act={busy ? (
                      <span className="set-cur">{pct}%</span>
                    ) : (
                      <button className={'pbtn-mn' + (installed ? ' ghost' : '')}
                        disabled={avBusy} onClick={() => installAsr(installed)}>
                        {installed ? '重装' : '装'}
                      </button>
                    )}
                  />
                  {busy ? (
                    <div className="asr-prog">
                      <i style={{ width: Math.max(2, pct) + '%' }} />
                    </div>
                  ) : null}
                  {job?.error ? (
                    <div className="set-note" style={{ color: 'var(--bad, #f87171)' }}>没装成：{job.error}</div>
                  ) : null}

                  <Row title="转写引擎"
                    sub="faster-whisper / CTranslate2，纯 CPU int8。不占显卡，也不往云上传。"
                    tag="本机" tagCls="im" />
                  <Row title="一次最长"
                    sub="5 分钟。到点自己停并照常转成文字 —— 不是把这段丢掉。"
                    tag="300 秒" tagCls="im" />
                  <Row title="听错同音字怎么办"
                    sub="base 是最小的那个模型，语速快或口音重时会听错（比如「语气」听成「与弃」）。转出来的字会填进输入框，发出去之前自己看一眼改一下就行。"
                    tag="先改再发" tagCls="md" />
                </>
              )
            })()}

            <div className="set-foot">
              装了模型之后，聊天框那颗麦克风就是「点一下开始说，再点一下停」。
              中途点别处、翻讲义、切课程都不会打断 —— 只有点麦克风才会停。
            </div>
          </>
        )}

        {sec === 'backup' && (
          <>
            <div className="set-h">数据与备份</div>
            <div className="set-sub">整套学习数据都在本机 SQLite 里，一个字节都不上传。</div>
            {msg ? <div className="set-note">{msg}</div> : null}

            <div className="set-group">存与搬</div>
            <Row title="现在存一份快照"
              sub={`整库打包落进 data/backup，随时能挑一份回来　·　现在有 ${backups} 份`}
              act={<button className="pbtn-mn" onClick={doBackup}>存一份</button>} />
            <Row title="跨机合并"
              sub={`${sy.data?.bundles ?? 0} 个包${sy.data?.last_push ? '　·　上次推 ' + sy.data.last_push : ''}`}
              act={<button className="pbtn-mn ghost" onClick={push}>推一份</button>} />

            <div className="set-group">最近调用（{callList.length} 条真实记录）</div>
            {callList.length ? (
              <div className="setlogs">
                {callList.slice(0, 12).map((c: any, i: number) => (
                  <div className="setlog" key={i}>
                    <span className="t">{String(c.ts || '').slice(11, 19)}</span>
                    <span className="n">{c.name}</span>
                    <span className="m">{c.ms}ms · {c.perm}</span>
                    <span className={'tg-mn ' + (c.ok ? 'ok' : 'im')}>{c.ok ? 'ok' : '失败'}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="set-note">助手跑过工具之后这里才有记录。</div>
            )}
          </>
        )}

        {sec === 'danger' && (
          <>
            <div className="set-h">危险区</div>
            <div className="set-sub">这两件都会改写本机数据。快照留着就能退回来，所以清之前先存一份。</div>
            {msg ? <div className="set-note">{msg}</div> : null}

            <div className="set-group">不可撤回</div>
            <Row title="清掉全部学习数据"
              sub="进度、作答、词记忆、事件、课程库、拉进来的词书、自己导的题源 —— 一起清空。模型 Key 和 XMind 登录态留着。"
              act={<>
                <input className="inp-mn" style={{ width: 132 }} placeholder="打「清空」两个字"
                  value={wipeWord} onChange={(e) => setWipeWord(e.target.value)} />
                <button className="pbtn-mn danger" disabled={wipeWord.trim() !== '清空' || apiBusy === 'wipe'}
                  onClick={doWipe}>{apiBusy === 'wipe' ? '在清…' : '清空'}</button>
              </>} />
            <Row title="退路：清之前的快照"
              sub={`${backups} 份全在 data/backup。清空不删备份 —— 那是唯一的退路。`}
              act={<button className="pbtn-mn ghost" onClick={doBackup}>再存一份</button>} />
          </>
        )}
      </div>

      {sheet ? (
        <aside className="setsheet" role="dialog" aria-label="编辑配置">
          <div className="setsheet-hd">
            <b>{sheet.kind === 'api' ? '自己的 API' : (sheetSrc?.name || '来源设置')}</b>
            <button className="pbtn-mn icon" aria-label="关闭" onClick={() => setSheet(null)}>
              <Icon n="x" size={16} />
            </button>
          </div>

          {sheet.kind === 'api' ? (
            <>
              <div className="setsheet-sub">挑一家、粘 Key、选型号，三步。只存本机，不自动切过去。</div>

              <label className="sfld">
                <span>厂家</span>
                <Sel value={presel} onChange={(v) => pickPreset(v)}
                  options={presets.map((p) => ({ value: p.id, label: p.name }))} />
                {curPreset?.note ? <i className="sfld-hint">{curPreset.note}</i> : null}
              </label>

              <label className="sfld">
                <span>地址{curPreset && curPreset.id !== 'custom' ? '（已按厂家填好，可改）' : ''}</span>
                <input className="inp-mn" placeholder="https://api.deepseek.com"
                  value={api.base} onChange={(e) => setApi({ ...api, base: e.target.value })} />
              </label>

              <label className="sfld">
                <span>API Key{curPreset?.local ? '（本地模型不用填）' : ''}</span>
                <input className="inp-mn" type="password" placeholder="sk-…（只存本机）"
                  value={api.key} onChange={(e) => setApi({ ...api, key: e.target.value })} />
              </label>

              <div className="sfld">
                <span>型号</span>
                <div className="sfld-row">
                  <input className="inp-mn" placeholder="拉取后点一下，或自己填"
                    value={api.model} onChange={(e) => setApi({ ...api, model: e.target.value })} />
                  <button className="pbtn-mn ghost" disabled={apiBusy === 'pull'} onClick={async () => {
                    setApiBusy('pull'); await pullModels(); setApiBusy(null)
                  }}>{apiBusy === 'pull' ? '在问…' : '拉取'}</button>
                </div>
                {pullMsg ? <i className="sfld-hint">{pullMsg}</i> : null}
              </div>

              {models.length ? (
                <div className="smodels" role="listbox" aria-label="这家现在能用的型号">
                  {models.map((m) => (
                    <button key={m.id} role="option" aria-selected={api.model === m.id}
                      className={'smodel' + (api.model === m.id ? ' on' : '')}
                      onClick={() => setApi((a) => ({ ...a, model: m.id, ctx: m.ctx ? String(m.ctx) : a.ctx }))}>
                      <span className="id">{m.id}</span>
                      <span className="ctx">{m.ctx ? Math.round(m.ctx / 1000) + 'k' : ''}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              <label className="sfld">
                <span>上下文窗宽{models.length ? '（选型号时自动带，不知道就空着）' : '（不知道就空着）'}</span>
                <input className="inp-mn" inputMode="numeric" placeholder="例如 128000"
                  value={api.ctx} onChange={(e) => setApi({ ...api, ctx: e.target.value.replace(/[^\d]/g, '') })} />
              </label>

              {apiProv?.configured ? (
                <div className="setsheet-sub">
                  现有配置：{apiProv.base_url || '地址没记'}　·　{apiProv.model || '型号没记'}
                  {apiProv.key_masked ? '　·　Key ' + apiProv.key_masked : ''}
                  {apiProv.usable ? '' : '（' + (apiProv.why || '不可用') + '）'}
                </div>
              ) : null}

              <div className="setsheet-ft">
                <button className="pbtn-mn" disabled={apiBusy === 'save'} onClick={saveApi}>
                  {apiBusy === 'save' ? '在存…' : '存下来'}
                </button>
                <button className="pbtn-mn ghost" disabled={apiBusy === 'probe'} onClick={probeKey}>
                  {apiBusy === 'probe' ? '在问…' : '试一句'}
                </button>
                {apiProv?.configured ? (
                  <button className="pbtn-mn ghost" disabled={apiBusy === 'clear'} onClick={clearKey}>
                    清掉 Key
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="setsheet-sub">
                {sheetSrc?.hint?.help || sheetSrc?.how || '填好这一项就能连上。'}
              </div>
              <label className="sfld">
                <span>{sheetSrc?.hint?.label || (sheetSrc?.hint?.field === 'token' ? '令牌' : '路径')}</span>
                <input className="inp-mn" value={cfgVal}
                  placeholder={sheetSrc?.hint?.eg || ''}
                  onChange={(e) => setCfgVal(e.target.value)} />
              </label>
              <div className="setsheet-ft">
                <button className="pbtn-mn" onClick={() => sheetSrc && saveCfg(sheetSrc.id)}>保存</button>
                <button className="pbtn-mn ghost" onClick={() => setSheet(null)}>算了</button>
              </div>
            </>
          )}
        </aside>
      ) : null}
    </div>
  )
}
