/**
 * 客户端倒计时离线测试。
 *
 * client.js 是手写 bundle：没有 import/export，只在加载时往
 * `window.__ModuleLoader__` 注册工厂。所以这里先铺全局桩与 react seed，
 * 再动态引入，从 `exports.__test` 取纯函数直接断言文本。
 *
 * 回归对象：不足 1 小时时秒位没有扣除已进位到「分」的秒数，
 * 渲染成「6 分 396 秒」「59 分 3599 秒」这类异常读数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 桩语言：zh 断言中文串，en 断言英文串。 */
let lang = 'zh-CN'

/** react seed 桩：工厂期只取 createElement 与三个 hook，不真正渲染。 */
const reactStub = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
}

/** 加载 client.js 时装下的模块导出。 */
let clientExports

/** Node 里 window/document 不存在、navigator 是只读 getter，统一用 defineProperty 铺桩。 */
const stubGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}

stubGlobal('window', {
  __ModuleLoader__: {
    load(mod) {
      assert.equal(mod.id, 'dsh-opencode-go-status')
      clientExports = mod.factory((name) => {
        if (name === 'react') return reactStub
        throw new Error(`未预期的 seed：${name}`)
      })
    },
  },
})
stubGlobal('navigator', { language: 'zh-CN' })
stubGlobal('document', {
  documentElement: { getAttribute: (attr) => (attr === 'lang' ? lang : null) },
})

await import('../client.js')

const countdown = clientExports?.__test?.countdown
const NOW = Date.parse('2026-09-30T06:00:00.000Z')

/** NOW + ms 毫秒的 ISO 时刻。 */
const at = (ms) => new Date(NOW + ms).toISOString()

test.beforeEach(() => { lang = 'zh-CN' })

test('bundle 仍以 module-loader 格式注册，且导出 apply/inject/test 缝', () => {
  assert.equal(typeof clientExports.apply, 'function')
  assert.deepEqual(clientExports.inject, ['slots'])
  assert.equal(typeof countdown, 'function')
})

test('不足 1 小时：秒位是扣掉「分」之后的余数（回归：6 分 396 秒）', () => {
  assert.equal(countdown(at(6 * 60000 + 36000), NOW), '6 分 36 秒')
  assert.equal(countdown(at(59 * 60000 + 59000), NOW), '59 分 59 秒')
  assert.equal(countdown(at(60000), NOW), '1 分 0 秒')
  assert.equal(countdown(at(1000), NOW), '0 分 1 秒')
})

test('英文环境同源：秒位同样扣除', () => {
  lang = 'en-US'
  assert.equal(countdown(at(6 * 60000 + 36000), NOW), '6m 36s')
  assert.equal(countdown(at(59 * 60000 + 59000), NOW), '59m 59s')
})

test('进位边界：秒/分不越界，跨小时与跨天正确进位', () => {
  assert.equal(countdown(at(3600000 - 1000), NOW), '59 分 59 秒')
  assert.equal(countdown(at(3600000), NOW), '1 小时 0 分钟')
  assert.equal(countdown(at(3600000 + 61000), NOW), '1 小时 1 分钟')
  assert.equal(countdown(at(86400000), NOW), '1 天 0 小时')
  assert.equal(countdown(at(2 * 86400000 + 3 * 3600000 + 61000), NOW), '2 天 3 小时')
})

test('两小时内的每一秒：秒位与分位都不超过 59', () => {
  for (let seconds = 1; seconds <= 7200; seconds += 1) {
    const text = countdown(at(seconds * 1000), NOW)
    const parsed = /^(\d+) 分 (\d+) 秒$/.exec(text)
    if (parsed === null) {
      assert.match(text, /^\d+ 小时 \d+ 分钟$/)
      continue
    }
    assert.ok(Number(parsed[1]) <= 59, `分位越界：${text}`)
    assert.ok(Number(parsed[2]) <= 59, `秒位越界：${text}`)
  }
})

test('到期与非法输入：给「已到期」或 undefined，不抛错', () => {
  assert.equal(countdown(at(0), NOW), '已到期')
  assert.equal(countdown(at(-1000), NOW), '已到期')
  assert.equal(countdown(undefined, NOW), undefined)
  assert.equal(countdown('not-a-date', NOW), undefined)
})
