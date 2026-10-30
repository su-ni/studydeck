// 跨页的一次性意图。
//
// 场景：聊天框里第一次点麦克风，发现语音模型还没装 —— 这时候该做的是把人送到
// 设置页的「语音输入」分区，而不是在原地弹一句「请去设置里装」然后什么都不发生。
//
// 为什么不塞进 App 的 go() 签名：go 是给「带科目跳转」用的，再加个 sec
// 会让每个调用点都要想「我要不要传」。这里只是「去那一页、顺便落在那个分区」，
// 一次性、取完即清，跟 URL 参数比也不用担心刷新后还赖在设置页。

export type Intent = { page: string; sec?: string; note?: string }

let _pending: Intent | null = null

export function setIntent(o: Intent) {
  _pending = o
}

/** 目标页取走属于它的那条意图；不是这页的就原样留着。 */
export function takeIntent(page: string): Intent | null {
  if (!_pending || _pending.page !== page) return null
  const x = _pending
  _pending = null
  return x
}
