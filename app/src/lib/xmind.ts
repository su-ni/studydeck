// XMind 是 OAuth 链路，不走 /api/tool，是 main.py 上单独挂的四个路由。
// 这里把它们收成四个函数，页面里别再自己拼 fetch。

async function j(url: string, init?: RequestInit) {
  const r = await fetch(url, { cache: 'no-store', ...(init || {}) })
  try { return await r.json() } catch { return { ok: false, error: 'HTTP ' + r.status } }
}

export type XmStatus = {
  connected: boolean
  reason?: string
  detail?: string
  scope?: string
  expires_in?: number
  has_refresh?: boolean
  login?: string
  token_file?: string
}

export function xmindStatus() { return j('/api/xmind/status') as Promise<XmStatus> }

export function xmindLogin() {
  return j('/api/xmind/login', { method: 'POST' }) as Promise<{ ok?: boolean; url?: string; error?: string }>
}

export function xmindCode(url: string) {
  return j('/api/xmind/code', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  }) as Promise<{ ok: boolean; error?: string; status?: XmStatus }>
}

export function xmindLogout() {
  return j('/api/xmind/logout', { method: 'POST' }) as Promise<{ ok: boolean; connected?: boolean }>
}
