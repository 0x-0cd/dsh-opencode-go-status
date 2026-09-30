/**
 * 宿主端离线测试：用桩 fetch 覆盖路由的信任栅栏、密钥处理与加固项。
 * 零依赖，直接 `node --test`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeStatusRoute, STATUS_API } from '../index.js'

const KEY_REF = 'OPENCODE_GO_API_KEY'
const DEFAULT_URL = 'https://opencode.ai/console/api/go/status'

/** 一份典型的上游状态响应。 */
const UPSTREAM_BODY = {
  product: 'go',
  cancelAtPeriodEnd: false,
  renewalPending: false,
  renewalCurrency: 'usd',
  paymentMethodKind: 'alipay',
  useBalance: false,
  upgradePrice: { amountMicroCents: '3166000000', currency: 'usd' },
  access: {
    startsAt: '2026-09-14T02:54:48.000Z',
    endsAt: '2026-10-14T02:54:48.000Z',
    meters: {
      fiveHour: { startsAt: '2026-09-30T01:17:49.819Z', resetsAt: '2026-09-30T06:17:49.819Z', limitMicroCents: '1200000000', usedMicroCents: '69982672' },
      week: { startsAt: '2026-09-28T00:00:00.000Z', resetsAt: '2026-10-05T00:00:00.000Z', limitMicroCents: '3000000000', usedMicroCents: '76086645' },
      month: { resetsAt: '2026-10-14T02:54:48.000Z', limitMicroCents: '6000000000', usedMicroCents: '995911294' },
    },
  },
}

/** 假 res：收集写出的 JSON。 */
function fakeRes() {
  const out = {}
  return {
    writeHead(status) { out.status = status },
    end(body) { out.body = JSON.parse(body) },
    result: out,
  }
}

/** 假 req：默认回环 + 同源 GET。 */
function fakeReq(overrides = {}) {
  return {
    method: 'GET',
    url: STATUS_API,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    ...overrides,
  }
}

/** 调用一次路由。 */
async function call(route, req = fakeReq()) {
  const res = fakeRes()
  await route.handler(req, res)
  return res.result
}

/** 安装桩 fetch，返回调用记录与恢复函数。 */
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** 一个不含凭证服务的宿主上下文。 */
const bareCtx = { get: () => undefined }

test.beforeEach(() => { process.env[KEY_REF] = 'oc_sk_test_key_value' })
test.afterEach(() => { delete process.env[KEY_REF] })

test('正常路径：规范化三个窗口与到期时间，且 key 只出现在宿主发出的请求头里', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => UPSTREAM_BODY }))
  try {
    const route = makeStatusRoute(bareCtx, () => ({}))
    const res = await call(route)

    assert.equal(res.status, 200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.plan.endsAt, '2026-10-14T02:54:48.000Z')
    assert.equal(res.body.plan.upgradePriceUsd, 31.66)
    assert.equal(res.body.windows.length, 3)
    assert.equal(res.body.windows[0].limitUsd, 12)
    assert.equal(res.body.keySource, 'process-env')

    // 出站请求只有一次，且带 https + Bearer
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].url, DEFAULT_URL)
    assert.equal(stub.calls[0].init.headers.authorization, 'Bearer oc_sk_test_key_value')
  } finally {
    stub.restore()
  }
})

test('信任栅栏：非回环来源返回 403，且不发起任何出站请求', async () => {
  const stub = stubFetch(() => { throw new Error('不应发起请求') })
  try {
    const route = makeStatusRoute(bareCtx, () => ({}))
    const res = await call(route, fakeReq({ address: '10.0.0.5', headers: { host: '10.0.0.5:3080' } }))
    assert.equal(res.status, 403)
    assert.equal(res.body.success, false)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('信任栅栏：跨站来源被拒', async () => {
  const stub = stubFetch(() => { throw new Error('不应发起请求') })
  try {
    const route = makeStatusRoute(bareCtx, () => ({}))
    const res = await call(route, fakeReq({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }))
    assert.equal(res.status, 403)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('只读：非 GET 方法返回 405', async () => {
  const stub = stubFetch(() => { throw new Error('不应发起请求') })
  try {
    const route = makeStatusRoute(bareCtx, () => ({}))
    const res = await call(route, fakeReq({ method: 'POST' }))
    assert.equal(res.status, 405)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('加固：statusURL 指向非回环 http 时拒绝，避免明文外发 API key', async () => {
  const stub = stubFetch(() => { throw new Error('不应发起请求') })
  try {
    const route = makeStatusRoute(bareCtx, () => ({ statusURL: 'http://example.com/status' }))
    const res = await call(route)
    assert.equal(res.body.success, false)
    assert.match(res.body.error, /必须是 https/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('加固：回环 http 仍被允许（本地反代场景）', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => UPSTREAM_BODY }))
  try {
    const route = makeStatusRoute(bareCtx, () => ({ statusURL: 'http://127.0.0.1:9999/status' }))
    const res = await call(route)
    assert.equal(res.body.success, true)
    assert.equal(stub.calls[0].url, 'http://127.0.0.1:9999/status')
  } finally {
    stub.restore()
  }
})

test('加固：?refresh=1 受最小间隔限制，无法无限绕过缓存打上游', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => UPSTREAM_BODY }))
  try {
    const route = makeStatusRoute(bareCtx, () => ({}))
    await call(route, fakeReq({ url: `${STATUS_API}?refresh=1` }))
    assert.equal(stub.calls.length, 1)
    // 紧接着再来一次强制刷新：应被节流，直接吃缓存，不再打上游
    const second = await call(route, fakeReq({ url: `${STATUS_API}?refresh=1` }))
    assert.equal(stub.calls.length, 1)
    assert.equal(second.body.cached, true)
  } finally {
    stub.restore()
  }
})

test('缓存：窗口内重复请求复用快照', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => UPSTREAM_BODY }))
  try {
    const route = makeStatusRoute(bareCtx, () => ({}))
    await call(route)
    const second = await call(route)
    assert.equal(stub.calls.length, 1)
    assert.equal(second.body.cached, true)
  } finally {
    stub.restore()
  }
})

test('上游失败：返回 success:false 且带状态码，不抛出', async () => {
  const stub = stubFetch(() => ({ ok: false, status: 403, text: async () => 'forbidden' }))
  try {
    const route = makeStatusRoute(bareCtx, () => ({}))
    const res = await call(route)
    assert.equal(res.status, 200)
    assert.equal(res.body.success, false)
    assert.match(res.body.error, /HTTP 403/)
  } finally {
    stub.restore()
  }
})

test('缺少凭证：给出可操作的错误，且不发起请求', async () => {
  delete process.env[KEY_REF]
  const stub = stubFetch(() => { throw new Error('不应发起请求') })
  try {
    const route = makeStatusRoute(bareCtx, () => ({}))
    const res = await call(route)
    assert.equal(res.body.success, false)
    assert.match(res.body.error, /未找到 API key/)
    assert.match(res.body.error, new RegExp(KEY_REF))
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('配置关闭：enabled=false 时不发起请求', async () => {
  const stub = stubFetch(() => { throw new Error('不应发起请求') })
  try {
    const route = makeStatusRoute(bareCtx, () => ({ enabled: false }))
    const res = await call(route)
    assert.equal(res.body.success, false)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('密钥优先级：凭证服务优先于进程环境变量', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => UPSTREAM_BODY }))
  try {
    const ctx = { get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'oc_sk_from_store', source: 'file' }) } : undefined) }
    const route = makeStatusRoute(ctx, () => ({}))
    const res = await call(route)
    assert.equal(res.body.keySource, 'credentials:file')
    assert.equal(stub.calls[0].init.headers.authorization, 'Bearer oc_sk_from_store')
  } finally {
    stub.restore()
  }
})

test('防御性解析：上游结构变化时降级为缺失字段，而不是报错', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ product: 'go' }) }))
  try {
    const route = makeStatusRoute(bareCtx, () => ({}))
    const res = await call(route)
    assert.equal(res.body.success, true)
    assert.deepEqual(res.body.windows, [])
    assert.equal(res.body.plan.endsAt, undefined)
    assert.equal(res.body.plan.cancelAtPeriodEnd, false)
  } finally {
    stub.restore()
  }
})
