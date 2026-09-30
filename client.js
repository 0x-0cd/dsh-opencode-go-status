/**
 * dsh-opencode-go-status — 浏览器端（client half）。
 *
 * 手写 bundle，走 web shell 的 `window.__ModuleLoader__.load({ id, factory })` 格式，
 * 无需构建步骤：宿主把本文件原样伺服在 /plugins/dsh-opencode-go-status/client.js，
 * factory 只用 shell 注入的 `react` seed。
 *
 * 两个槽位（都是官方 ui-sidebar / ui-layout 声明的席位）：
 *   - `sidebar.panellist`（list）：侧边栏图标入口，shell 自己负责按钮与点击选中，
 *     只把 { size, active } 传给我的图标组件；
 *   - `main`（keyed，key 同 id）：选中后渲染在中间主区的面板本体。
 *
 * 数据来自宿主路由 /api/dsh-opencode-go-status/status，密钥不出宿主进程。
 *
 * 失败策略：任何挂载或渲染问题都只降级面板，绝不抛穿（一个客户端插件抛错会让整个 GUI 启动失败）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-status',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    /** 面板 id，同时是侧边栏 list 的 id 与 main 键控槽的 key。 */
    const PANEL_ID = 'opencode-go-status';

    /** 宿主路由（与 index.js 的 STATUS_API 必须一致）。 */
    const STATUS_API = '/api/dsh-opencode-go-status/status';

    /** 面板自动刷新间隔（毫秒）。宿主另有自己的缓存窗口。 */
    const REFRESH_MS = 60000;

    /** 用量分级配色：<60% 绿 / 60–85% 黄 / ≥85% 红（全部走官方主题 token）。 */
    const GREEN = 'var(--dsw-alias-state-success-primary, #3fb950)';
    const AMBER = 'var(--dsw-alias-state-warn-primary, #d29922)';
    const RED = 'var(--dsw-alias-state-error-primary, #f85149)';

    const CSS = `
.ocgs-root{display:flex;flex-direction:column;gap:16px;height:100%;box-sizing:border-box;
  padding:calc(var(--dsh-frame-top-clearance,0px) + 22px) 26px 36px;overflow-y:auto;
  font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.ocgs-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ocgs-title{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em}
.ocgs-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ocgs-spacer{flex:1 1 auto}
.ocgs-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:5px 12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.ocgs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ocgs-btn:disabled{opacity:.5;cursor:default}
.ocgs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.ocgs-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;
  background:var(--dsw-alias-bg-layer-2)}
.ocgs-label{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
.ocgs-value{font-size:20px;font-weight:600;letter-spacing:.2px}
.ocgs-window{display:flex;flex-direction:column;gap:8px}
.ocgs-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.ocgs-name{font-weight:600}
.ocgs-muted{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ocgs-bar{height:8px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-4)}
.ocgs-bar>i{display:block;height:100%;border-radius:999px;transition:width .3s ease}
.ocgs-note{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ocgs-error{border-color:color-mix(in srgb,${RED} 45%,transparent);
  background:color-mix(in srgb,${RED} 10%,var(--dsw-alias-bg-layer-2))}
.ocgs-error .ocgs-value{color:${RED}}
.ocgs-foot{margin-top:auto;font-size:11px;color:var(--dsw-alias-label-caption);padding-top:8px}
`;

    /** 语言判断：中文环境给中文标签。 */
    function zh() {
      const lang = (document.documentElement.getAttribute('lang') || navigator.language || 'en').toLowerCase();
      return lang.startsWith('zh');
    }

    /** 侧边栏入口标签（thunk 形式，语言切换后 shell 会重新解析）。 */
    function panelLabel() {
      return zh() ? '用量' : 'Usage';
    }

    /** 组件内每秒走动的当前时刻。 */
    function useNow() {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);
      return now;
    }

    /** 距离目标时刻的倒计时文本。 */
    function countdown(iso, now) {
      if (typeof iso !== 'string') return undefined;
      const target = Date.parse(iso);
      if (Number.isNaN(target)) return undefined;
      let delta = target - now;
      if (delta <= 0) return zh() ? '已到期' : 'due';
      const days = Math.floor(delta / 86400000);
      delta -= days * 86400000;
      const hours = Math.floor(delta / 3600000);
      delta -= hours * 3600000;
      const minutes = Math.floor(delta / 60000);
      // 扣掉已进位到“分”的毫秒，否则秒位拿到的是整段余数（曾出现「6 分 396 秒」）。
      delta -= minutes * 60000;
      if (days > 0) return zh() ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`;
      if (hours > 0) return zh() ? `${hours} 小时 ${minutes} 分钟` : `${hours}h ${minutes}m`;
      const seconds = Math.floor(delta / 1000);
      return zh() ? `${minutes} 分 ${seconds} 秒` : `${minutes}m ${seconds}s`;
    }

    /** 本地时区的日期时间文本。 */
    function dateTime(iso) {
      if (typeof iso !== 'string') return undefined;
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return undefined;
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** 美元金额文本。 */
    function money(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return `$${value.toFixed(2)}`;
    }

    /** 用量分级配色。 */
    function tone(percent) {
      if (typeof percent !== 'number') return GREEN;
      if (percent >= 85) return RED;
      if (percent >= 60) return AMBER;
      return GREEN;
    }

    /** 侧边栏图标：半圆仪表盘。 */
    function UsageIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { opacity: props?.active === true ? 1 : 0.75 },
        },
        h('path', { d: 'M3.5 18.5a8.5 8.5 0 1 1 17 0' }),
        h('path', { d: 'M12 18.5l4.4-5.6' }),
        h('circle', { cx: 12, cy: 18.5, r: 1.35, fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** 一条额度窗口。 */
    function WindowRow({ window: win, now }) {
      const percent = typeof win.percent === 'number' ? win.percent : undefined;
      const color = tone(percent);
      const resetIn = countdown(win.resetsAt, now);
      return h(
        'div',
        { className: 'ocgs-card ocgs-window' },
        h(
          'div',
          { className: 'ocgs-row' },
          h('span', { className: 'ocgs-name' }, win.label),
          h(
            'span',
            { className: 'ocgs-muted' },
            percent === undefined ? '—' : `${percent.toFixed(2)}%`,
          ),
        ),
        h(
          'div',
          { className: 'ocgs-bar', role: 'progressbar', 'aria-valuenow': percent ?? 0, 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('i', { style: { width: `${Math.min(100, Math.max(0, percent ?? 0))}%`, background: color } }),
        ),
        h(
          'div',
          { className: 'ocgs-row' },
          h('span', { className: 'ocgs-muted' }, `${zh() ? '已用' : 'used'} ${money(win.usedUsd)} / ${money(win.limitUsd)}`),
          h(
            'span',
            { className: 'ocgs-muted' },
            `${zh() ? '剩余' : 'left'} `,
            h('strong', { style: { color, opacity: 1 } }, money(win.remainingUsd)),
          ),
        ),
        resetIn === undefined
          ? null
          : h('div', { className: 'ocgs-muted' }, `${zh() ? '重置于' : 'resets in'} ${resetIn}${win.resetsAt ? ` · ${dateTime(win.resetsAt)}` : ''}`),
      );
    }

    /** 主区面板本体。 */
    function UsagePanel() {
      const [state, setState] = useState({ phase: 'loading' });
      const now = useNow();

      const load = useCallback(async (refresh) => {
        setState((prev) => (prev.phase === 'ready' ? { ...prev, busy: true } : { phase: 'loading' }));
        try {
          const response = await fetch(`${STATUS_API}${refresh === true ? '?refresh=1' : ''}`, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          });
          const body = await response.json();
          if (body?.success !== true) {
            setState({ phase: 'error', error: String(body?.error ?? `HTTP ${response.status}`), fetchedAt: body?.fetchedAt });
            return;
          }
          setState({ phase: 'ready', data: body, busy: false });
        } catch (error) {
          setState({ phase: 'error', error: String(error?.message ?? error) });
        }
      }, []);

      useEffect(() => {
        load(false);
      }, [load]);

      useEffect(() => {
        const timer = setInterval(() => load(false), REFRESH_MS);
        return () => clearInterval(timer);
      }, [load]);

      const head = h(
        'div',
        { className: 'ocgs-head' },
        h('h2', { className: 'ocgs-title' }, zh() ? 'OpenCode Go 套餐' : 'OpenCode Go plan'),
        h('span', { className: 'ocgs-sub' }, zh() ? '用量额度 · 剩余额度 · 到期时间' : 'usage · remaining · renewal'),
        h('span', { className: 'ocgs-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'ocgs-btn',
            disabled: state.busy === true || state.phase === 'loading',
            onClick: () => load(true),
          },
          state.busy === true || state.phase === 'loading' ? (zh() ? '刷新中…' : 'Refreshing…') : zh() ? '立即刷新' : 'Refresh',
        ),
      );

      if (state.phase === 'loading') {
        return h('div', { className: 'ocgs-root' }, head, h('div', { className: 'ocgs-note' }, zh() ? '正在读取套餐状态…' : 'Loading plan status…'));
      }

      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'ocgs-root' },
          head,
          h(
            'div',
            { className: 'ocgs-card ocgs-error' },
            h('div', { className: 'ocgs-value', style: { fontSize: 14 } }, zh() ? '读取失败' : 'Failed'),
            h('div', { className: 'ocgs-muted', style: { marginTop: 6, wordBreak: 'break-all' } }, state.error),
          ),
          h('div', { className: 'ocgs-note' }, zh()
            ? '检查：DSH 凭证里的 OPENCODE_GO_API_KEY 是否有效；宿主能否直连 opencode.ai。'
            : 'Check the OPENCODE_GO_API_KEY credential and host connectivity to opencode.ai.'),
          state.fetchedAt ? h('div', { className: 'ocgs-foot' }, `${zh() ? '抓取时间' : 'fetched'} ${dateTime(state.fetchedAt) ?? state.fetchedAt}`) : null,
        );
      }

      const plan = state.data?.plan ?? {};
      const windows = Array.isArray(state.data?.windows) ? state.data.windows : [];
      const endIn = countdown(plan.endsAt, now);
      const canceling = plan.cancelAtPeriodEnd === true;

      return h(
        'div',
        { className: 'ocgs-root' },
        head,
        h(
          'div',
          { className: 'ocgs-grid' },
          h(
            'div',
            { className: 'ocgs-card' },
            h('div', { className: 'ocgs-label' }, zh() ? '订阅到期（本期结束）' : 'Renews / expires'),
            h('div', { className: 'ocgs-value' }, dateTime(plan.endsAt) ?? '—'),
            h(
              'div',
              { className: 'ocgs-muted', style: { marginTop: 4 } },
              endIn === undefined ? (zh() ? '接口未返回到期时间' : 'not reported') : `${zh() ? '还剩' : 'in'} ${endIn}`,
            ),
          ),
          h(
            'div',
            { className: 'ocgs-card' },
            h('div', { className: 'ocgs-label' }, zh() ? '续费状态' : 'Renewal'),
            h(
              'div',
              { className: 'ocgs-value', style: { color: canceling ? RED : GREEN } },
              canceling ? (zh() ? '到期后取消' : 'Cancels') : zh() ? '自动续费' : 'Auto-renews',
            ),
            h(
              'div',
              { className: 'ocgs-muted', style: { marginTop: 4 } },
              [
                plan.renewalPending === true ? (zh() ? '续费处理中' : 'renewal pending') : undefined,
                plan.renewalCurrency ? plan.renewalCurrency.toUpperCase() : undefined,
                plan.paymentMethodKind ?? undefined,
                plan.useBalance === true ? (zh() ? '用 Zen 余额兜底' : 'balance fallback on') : undefined,
              ]
                .filter(Boolean)
                .join(' · ') || '—',
            ),
          ),
          plan.upgradePriceUsd === undefined
            ? null
            : h(
                'div',
                { className: 'ocgs-card' },
                h('div', { className: 'ocgs-label' }, zh() ? '升级价' : 'Upgrade price'),
                h('div', { className: 'ocgs-value' }, money(plan.upgradePriceUsd)),
              ),
        ),
        windows.length === 0
          ? h('div', { className: 'ocgs-note' }, zh() ? '接口未返回任何计费窗口。' : 'No billing windows reported.')
          : h(
              'div',
              { className: 'ocgs-grid' },
              windows.map((win) => h(WindowRow, { key: win.id, window: win, now })),
            ),
        h(
          'div',
          { className: 'ocgs-foot' },
          [
            state.data?.cached === true ? (zh() ? '缓存数据' : 'cached') : undefined,
            state.data?.fetchedAt ? `${zh() ? '更新于' : 'updated'} ${dateTime(state.data.fetchedAt) ?? state.data.fetchedAt}` : undefined,
            state.data?.keySource ? `${zh() ? '密钥来源' : 'key'} ${state.data.keySource}` : undefined,
            plan.startsAt ? `${zh() ? '本期开始' : 'period start'} ${dateTime(plan.startsAt)}` : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      );
    }

    /** 需要的客户端服务：槽位注册表。 */
    const inject = ['slots'];

    /** 注入一次性样式表。 */
    function injectStyles() {
      const existing = document.querySelector(`style[data-plugin-css="${PANEL_ID}"]`);
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.setAttribute('data-plugin-css', PANEL_ID);
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * 挂载侧边栏入口与主区面板。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      const disposers = [injectStyles()];
      try {
        // 入口：list 槽，shell 渲染按钮并负责点击选中。
        ctx.slots.inject('sidebar.panellist', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: panelLabel },
            UsageIcon,
          );
        });
        // 面板本体：main 键控槽，key 与入口 id 相同。
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: PANEL_ID }, UsagePanel);
        });
      } catch (error) {
        console.warn('[dsh-opencode-go-status] slot registration failed:', error);
      }
      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) dispose();
        },
        'dsh-opencode-go-status: styles',
      );
    }

    const module = { exports: {} };
    module.exports.apply = apply;
    module.exports.inject = inject;
    // 测试缝：纯函数离线单测用，shell 只认 apply / inject。
    module.exports.__test = { countdown, dateTime };
    return module.exports;
  },
});
