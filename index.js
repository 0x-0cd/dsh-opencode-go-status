/**
 * dsh-opencode-go-status — 宿主端（Node half）。
 *
 * 读取 OpenCode Go 的控制台状态接口，把「套餐额度（按金额计）、剩余额度、订阅到期时间、
 * 续费状态」规范化成一份 JSON，供浏览器端面板取用：
 *
 *   GET https://opencode.ai/console/api/go/status
 *   Authorization: Bearer <OPENCODE_GO_API_KEY>
 *
 * 该接口返回 access.meters.{fiveHour,week,month}.{usedMicroCents,limitMicroCents}
 * （microCents，1e8 µ¢ = US$1）以及 access.startsAt / access.endsAt。它比公开的
 * /zen/go/v1/usage 多出「金额」和「到期日」——后者只有三个百分比和重置时刻。
 *
 * API key 解析顺序：插件配置 apiKey → DSH 凭证服务（默认引用 OPENCODE_GO_API_KEY，
 * 覆盖 ~/.dsh/.credentials.yaml、启动环境、.env 各层）→ 进程环境变量。
 *
 * 设计约束：本文件不 import 任何 @deepseek-ai/* 包。插件以 file: 方式装进 profile 后，
 * profile 的 node_modules 里并没有 dsh-credentials 等包，导入会直接让插件加载失败。
 * 这里只用宿主注入的服务（ctx.get('credentials')）与全局 fetch。
 */

/** 稳定 cordis 插件名。 */
export const name = 'opencode-go-status'

/** 需要的宿主服务：webServer 提供同源 JSON 路由。 */
export const inject = ['webServer']

/** 浏览器端与宿主端共用的路由路径。 */
export const STATUS_API = '/api/dsh-opencode-go-status/status'

/** 默认状态接口。可用 statusURL 覆盖。 */
const DEFAULT_STATUS_URL = 'https://opencode.ai/console/api/go/status'

/** 默认 API key 引用名（与 DSH 的 opencode-go provider apiKeyEnv 一致）。 */
const DEFAULT_API_KEY_REF = 'OPENCODE_GO_API_KEY'

/** 三个计费窗口的展示元数据。 */
const WINDOWS = [
  { id: 'fiveHour', label: '5 小时滚动' },
  { id: 'week', label: '每周' },
  { id: 'month', label: '每月' },
]

/** microCents → 美元（1e8 µ¢ = US$1）。非数字返回 undefined。 */
function toUsd(microCents) {
  if (microCents === undefined || microCents === null) return undefined
  const value = Number(microCents)
  return Number.isFinite(value) ? value / 1e8 : undefined
}

/** ISO 字符串原样透传；非法值返回 undefined。 */
function toIso(value) {
  if (typeof value !== 'string' || value === '') return undefined
  return Number.isNaN(Date.parse(value)) ? undefined : value
}

/** 解析配置，缺省值全部在代码里，不依赖 schemastery。 */
function resolveConfig(config) {
  const source = config ?? {}
  return {
    apiKey: typeof source.apiKey === 'string' && source.apiKey !== '' ? source.apiKey : undefined,
    apiKeyRef: typeof source.apiKeyRef === 'string' && source.apiKeyRef !== '' ? source.apiKeyRef : DEFAULT_API_KEY_REF,
    statusURL: typeof source.statusURL === 'string' && source.statusURL !== '' ? source.statusURL : DEFAULT_STATUS_URL,
    timeoutMs: Number.isFinite(source.timeoutMs) ? source.timeoutMs : 15000,
    cacheSeconds: Number.isFinite(source.cacheSeconds) ? source.cacheSeconds : 30,
    enabled: source.enabled !== false,
  }
}

/** 回环主机判定：只有这些主机允许明文 http（本地调试用）。 */
function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/**
 * 校验状态接口地址：非回环主机必须使用 https。
 *
 * 该请求携带 API key，明文 http 会把密钥暴露给链路上的任何观察者；把
 * statusURL 指到第三方主机则会直接把密钥送给对方。这里不做主机白名单
 * （自建反代是合法用法），但强制 https，挡掉最常见的「配错协议」型泄露。
 * @param raw - 配置里的 statusURL。
 * @returns 解析后的 URL 对象。
 */
function assertSecureStatusUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`statusURL 不是合法 URL：${raw}`)
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `statusURL 必须是 https（当前 ${url.protocol}//${url.hostname}）：该请求携带 API key，明文 http 会泄露密钥；仅回环地址允许 http。`,
    )
  }
  return url
}

/**
 * 解析 API key，并报告来源层级。
 * @param ctx - 宿主插件上下文。
 * @param options - 已解析的配置。
 * @returns 密钥值与来源标签。
 */
async function resolveApiKey(ctx, options) {
  if (options.apiKey !== undefined) return { key: options.apiKey, source: 'plugin-config' }
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      // 运行时就是一个字符串引用（CredentialRef 只是 TS 侧的品牌类型）。
      const hit = await credentials.resolve(options.apiKeyRef)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') {
        return { key: hit.value, source: `credentials:${hit.source ?? 'unknown'}` }
      }
    } catch {
      // 凭证服务不可用时退回进程环境，不抛出。
    }
  }
  const fromEnv = process.env[options.apiKeyRef]
  if (typeof fromEnv === 'string' && fromEnv !== '') return { key: fromEnv, source: 'process-env' }
  return undefined
}

/** 把上游响应规范化成面板直接可渲染的形状。 */
function normalize(body) {
  const access = body?.access ?? {}
  const meters = access?.meters ?? {}
  const windows = []
  for (const meta of WINDOWS) {
    const meter = meters[meta.id]
    if (meter === undefined || meter === null) continue
    const usedUsd = toUsd(meter.usedMicroCents)
    const limitUsd = toUsd(meter.limitMicroCents)
    const remainingUsd = usedUsd !== undefined && limitUsd !== undefined ? Math.max(0, limitUsd - usedUsd) : undefined
    const percent = usedUsd !== undefined && limitUsd !== undefined && limitUsd > 0 ? (usedUsd / limitUsd) * 100 : undefined
    windows.push({
      id: meta.id,
      label: meta.label,
      usedUsd,
      limitUsd,
      remainingUsd,
      percent,
      startsAt: toIso(meter.startsAt),
      resetsAt: toIso(meter.resetsAt),
    })
  }
  return {
    plan: {
      product: typeof body?.product === 'string' ? body.product : undefined,
      startsAt: toIso(access.startsAt),
      endsAt: toIso(access.endsAt),
      cancelAtPeriodEnd: body?.cancelAtPeriodEnd === true,
      renewalPending: body?.renewalPending === true,
      renewalCurrency: typeof body?.renewalCurrency === 'string' ? body.renewalCurrency : undefined,
      paymentMethodKind: typeof body?.paymentMethodKind === 'string' ? body.paymentMethodKind : undefined,
      useBalance: body?.useBalance === true,
      upgradePriceUsd: toUsd(body?.upgradePrice?.amountMicroCents),
    },
    windows,
  }
}

/**
 * 拉取并规范化一次状态。
 * @param ctx - 宿主插件上下文。
 * @param options - 已解析的配置。
 * @returns 规范化的状态快照。
 */
async function fetchStatus(ctx, options) {
  const resolved = await resolveApiKey(ctx, options)
  if (resolved === undefined) {
    throw new Error(`未找到 API key：请配置插件 apiKey，或让凭证 ${options.apiKeyRef} 可从 DSH 凭证 / 环境变量解析`)
  }
  const response = await fetch(assertSecureStatusUrl(options.statusURL), {
    method: 'GET',
    headers: { authorization: `Bearer ${resolved.key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`状态接口返回 HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}`)
  }
  const body = await response.json()
  return { ...normalize(body), keySource: resolved.source }
}

/** 回环 + 同源校验（与官方插件路由同一道信任栅栏）。 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 写一份 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/**
 * 强制刷新（`?refresh=1`）的最小间隔。
 *
 * 本路由只对回环开放，但仍要防止本地进程拿刷新参数无限绕过缓存、把上游
 * 接口当压测对象（也顺带限制了重复触发上游计费无关请求的频次）。
 */
const MIN_FORCED_REFRESH_MS = 3000

/**
 * 构建状态路由。resolveConfig 每次请求重新求值，配置改动无需重挂路由。
 * @param ctx - 宿主插件上下文。
 * @param getConfig - 返回当前配置快照。
 * @returns 交给 ctx.webServer.register 的 WebRoute。
 */
export function makeStatusRoute(ctx, getConfig) {
  /** 进程内缓存：避免面板轮询反复打上游。 */
  let cache
  /** 上一次被接受的强制刷新时刻。 */
  let lastForcedAt = 0
  return {
    kind: 'exact',
    path: STATUS_API,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { success: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { success: false, error: 'method not allowed' })
        return
      }
      const options = resolveConfig(getConfig())
      if (!options.enabled) {
        writeJson(res, 200, { success: false, error: '插件已禁用（enabled: false）' })
        return
      }
      const wantsRefresh = (() => {
        try {
          return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('refresh') === '1'
        } catch {
          return false
        }
      })()
      const now = Date.now()
      const refresh = wantsRefresh && now - lastForcedAt >= MIN_FORCED_REFRESH_MS
      if (refresh) lastForcedAt = now
      if (!refresh && cache !== undefined && now - cache.at < options.cacheSeconds * 1000) {
        writeJson(res, 200, { success: true, ...cache.snapshot, cached: true })
        return
      }
      try {
        const snapshot = await fetchStatus(ctx, options)
        const payload = { ...snapshot, fetchedAt: new Date().toISOString() }
        cache = { at: now, snapshot: payload }
        writeJson(res, 200, { success: true, ...payload, cached: false })
      } catch (error) {
        writeJson(res, 200, {
          success: false,
          error: String(error?.message ?? error),
          fetchedAt: new Date().toISOString(),
        })
      }
    },
  }
}

/**
 * 挂载插件。
 * @param ctx - 宿主插件上下文（含 webServer 服务）。
 * @param config - 组合条目传入的配置。
 */
export function apply(ctx, config) {
  const current = () => config ?? {}
  ctx.effect(() => {
    const dispose = ctx.webServer.register(makeStatusRoute(ctx, current))
    return () => dispose()
  }, 'opencode-go-status: status route')
}
