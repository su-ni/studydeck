/* 一串图一起办事。
   截图库和课堂右栏两处都要「勾几张再一起删 / 一起打标签」，
   而这两处的图来自同一个工具（shot_list）、删的是同一张表（shots）。
   把动作和选择状态收到这里，是为了让两边的手感一模一样 ——
   上一轮就是因为删除键只做在一处，用户找不着。

   为什么要有「逐条兜底」：批量工具是后加的，老进程上跑着旧后端时它一定返回
   「未知工具」。这时候不能整条路废掉、也不能假装删成功 —— 逐条删，然后按
   真实成功数报数。宁可慢，不许骗。 */
import { callTool } from './api'

export type BulkResult = { ok: boolean; n: number; fail: number; error?: string }

/* 缩略图地址。后端有 /shots/thumb 就用它（480 宽的 WebP，一屏 45 张从 2.3MB 降到几百 KB），
   没有就由 <img onError> 退回原图 —— 见 thumbFallback()。 */
export function thumbUrl(file: string, w = 480) {
  return '/shots/thumb/' + file + '?w=' + w
}

/* 原图地址。灯箱看大图、下载都用它。 */
export function fullUrl(file: string) {
  return '/shots/' + file
}

/* <img onError> 里调：把 src 换回原图，且只换一次（否则原图也 404 会无限重试）。 */
export function thumbFallback(e: React.SyntheticEvent<HTMLImageElement>, file: string) {
  const el = e.currentTarget
  if (el.dataset.fb === '1') return
  el.dataset.fb = '1'
  el.src = fullUrl(file)
}

/* 一次删多条。返回的 n 是「真的从库里删掉了几条」，不是「发了几条」。 */
export async function delShots(ids: string[]): Promise<BulkResult> {
  const list = ids.filter(Boolean)
  if (!list.length) return { ok: false, n: 0, fail: 0, error: '没勾任何一条' }
  const r = await callTool<any>('shot_batch_del', { ids: list }, { write: true })
  if (r.ok) {
    const d: any = r.data || {}
    return { ok: true, n: Number(d.deleted ?? list.length), fail: Number(d.failed ?? 0) }
  }
  if (!/未知工具/.test(String(r.error || ''))) {
    return { ok: false, n: 0, fail: list.length, error: r.error || '批量删除没成' }
  }
  // 后端起的是旧版本：逐条删，按真实结果报数
  let n = 0, fail = 0
  for (const id of list) {
    const one = await callTool('shot_del', { id }, { write: true })
    if (one.ok) n++; else fail++
  }
  return { ok: fail === 0, n, fail, error: fail ? fail + ' 条没删掉' : undefined }
}

/* 批量加 / 减标签。add 和 remove 都是「要动的那几个词」，不是完整标签表 ——
   完整表由后端按行算，前端不替它拼（两个人同时改才不会被对方覆盖）。

   rows 是调用方手上那一份列表（已经有 tags）：老后端上逐条兜底时，要拿它把
   「完整标签数组」拼出来 —— shot_tag 的口径是完整数组，不是增量。
   没有 rows 就不逐个兜底，直接报「这个功能要新版后端」，不编成功数。 */
export async function tagShots(rows: { id: string; tags?: string[] }[], add: string[], remove: string[]): Promise<BulkResult> {
  const list = rows.map((r) => r?.id).filter(Boolean)
  const a = add.map((t) => t.trim()).filter(Boolean)
  const rm = remove.map((t) => t.trim()).filter(Boolean)
  if (!list.length) return { ok: false, n: 0, fail: 0, error: '没勾任何一条' }
  if (!a.length && !rm.length) return { ok: false, n: 0, fail: 0, error: '标签是空的' }
  const r = await callTool<any>('shot_batch_tag', { ids: list, add: a, remove: rm }, { write: true })
  if (r.ok) {
    const d: any = r.data || {}
    return { ok: true, n: Number(d.updated ?? list.length), fail: Number(d.failed ?? 0) }
  }
  if (!/未知工具/.test(String(r.error || ''))) {
    return { ok: false, n: 0, fail: list.length, error: r.error || '批量打标签没成' }
  }
  let n = 0, fail = 0
  for (const row of rows) {
    if (!row?.id) continue
    const have: string[] = (row.tags || []).slice()
    const next = have.filter((t) => !rm.some((x) => x.toLowerCase() === t.toLowerCase()))
    for (const t of a) if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t)
    const one = await callTool('shot_tag', { id: row.id, tags: next }, { write: true })
    if (one.ok) n++; else fail++
  }
  return { ok: fail === 0, n, fail, error: fail ? fail + ' 条没改成' : undefined }
}
