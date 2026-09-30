# dsh-opencode-go-status

DSH Web 插件：**OpenCode Go 订阅状态面板** —— 侧边栏「用量」入口 + 主区面板，显示套餐
用量额度、剩余额度、订阅到期时间与续费状态。

[English](./README.en.md)

## 为什么需要它

OpenCode 公开的用量接口 `GET https://opencode.ai/zen/go/v1/usage`（API key 鉴权）只返回
三个计费窗口的**百分比**和重置时刻：

```json
{ "usage": { "rolling": { "status": "ok", "percent": 5, "resetsAt": "…" }, … } }
```

它**没有金额、没有订阅到期日**——所以社区里那批 OpenCode 用量插件（vinyumao / LTctfer /
dsh-go-balance 等）都只能显示百分比，也没有任何一个能显示到期时间。

本插件改读控制台状态接口（同样用你现有的 API key，无需 cookie）：

```
GET https://opencode.ai/console/api/go/status
Authorization: Bearer <OPENCODE_GO_API_KEY>
```

它返回 `access.meters.{fiveHour,week,month}.{usedMicroCents,limitMicroCents}`（microCents，
1e8 µ¢ = US$1）、`access.startsAt` / `access.endsAt`，以及 `cancelAtPeriodEnd` /
`renewalPending` / `paymentMethodKind` / `useBalance` / `upgradePrice`。于是可以显示：

- **每条窗口的金额用量**：已用 $9.96 / $60.00，剩余 $50.04，百分比、进度条、分级配色；
- **订阅到期时间**：`access.endsAt` + 实时倒计时 + 本期开始时间；
- **续费状态**：自动续费 / 到期后取消、是否续费处理中、续费币种与支付方式、Zen 余额兜底开关。

## 界面

- **侧边栏入口**：仪表盘图标（`sidebar.panellist` 槽，order 40），点击切到主区面板。
  图标状态由 shell 维护，与官方面板（如插件管理）行为一致。
- **主区面板**：`main` 键控槽（key 与入口 id 相同）。三张额度卡 + 到期/续费卡，
  60 秒自动刷新、可手动立即刷新，显示数据来源与更新时间。

## 安装

```sh
dsh plugin --profile web add file:/Users/qianneng/Code/dsh_optimize/dsh-opencode-go-status
```

或把 `cordis.patch.yml` 里的 insert 行抄进 `$DSH_HOME/profiles/web/cordis.patch.yml`，
再用 `file:` 装包。**两种方式只用一种**，重复挂载会起两个实例。

装完刷新浏览器页面即可（宿主端若已运行，可能需要重启 `dsh web` 才会加载新的插件行）。

## 配置

配置写在组合条目里（`cordis.patch.yml` 的 insert 行下加 `config:`）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | 无 | 直接写死 API key（不推荐，优先用凭证） |
| `apiKeyRef` | `OPENCODE_GO_API_KEY` | DSH 凭证引用名，与 opencode-go provider 的 `apiKeyEnv` 一致 |
| `statusURL` | `https://opencode.ai/console/api/go/status` | 上游状态接口 |
| `timeoutMs` | `15000` | 请求超时 |
| `cacheSeconds` | `30` | 宿主端缓存窗口，避免面板轮询反复打上游 |
| `enabled` | `true` | 总开关 |

密钥解析顺序：`apiKey` → DSH 凭证服务（`apiKeyRef`，覆盖 `$DSH_HOME/.credentials.yaml`、
启动环境、`.env` 各层）→ 进程环境变量。**密钥只在宿主进程内使用，不进入浏览器**；浏览器
只访问同源路由 `/api/dsh-opencode-go-status/status`。

## 已知限制

- `/console/api/go/status` 是 OpenCode **控制台内部接口**，不在官方公开文档里（CodexBar 读的是
  同一个接口的 `renewAt`），字段结构可能随上游变动。宿主端做了防御性解析：字段缺失只会让对应
  卡片显示「—」，不会报错。
- **Zen 预充值余额（钱）拿不到**：`/console/api/billing/status` 用 API key 返回 403，只有带浏览器
  cookie 才能读，官方功能请求（anomalyco/opencode#10448）仍未实现。本插件的「额度/剩余」指的是
  **Go 订阅的额度**，不是 Zen 钱包余额。
- 宿主需要能直连 `opencode.ai`（实测直连与 HTTP 代理均可用）。
- 到期时间是**本期结束时刻**；`cancelAtPeriodEnd=false` 时它会自动续期，所以「到期」等于「续费日」。

## 许可

MIT
