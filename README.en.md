# dsh-opencode-go-status

A DeepSeek Harness (DSH) Web plugin: an **OpenCode Go subscription panel** — a sidebar
entry plus a main-column panel showing plan usage quota, remaining quota, subscription
expiry and renewal state.

[中文说明](./README.md)

## Why

OpenCode's public usage API — `GET https://opencode.ai/zen/go/v1/usage` (API-key auth) —
returns only the three billing windows' **percentages** and reset instants:

```json
{ "usage": { "rolling": { "status": "ok", "percent": 5, "resetsAt": "…" }, … } }
```

No money, no subscription end date. That is why every OpenCode usage plugin in the wild
shows percentages only, and none of them can show an expiry date.

This plugin reads the console status endpoint instead (same API key, no cookie):

```
GET https://opencode.ai/console/api/go/status
Authorization: Bearer <OPENCODE_GO_API_KEY>
```

It returns `access.meters.{fiveHour,week,month}.{usedMicroCents,limitMicroCents}`
(microCents; 1e8 µ¢ = US$1), `access.startsAt` / `access.endsAt`, plus
`cancelAtPeriodEnd` / `renewalPending` / `paymentMethodKind` / `useBalance` /
`upgradePrice`. So the panel can show:

- **per-window money usage** — used $9.96 / $60.00, remaining $50.04, percent, bar, colour grade;
- **subscription expiry** — `access.endsAt` with a live countdown and the period start;
- **renewal state** — auto-renew vs cancel-at-period-end, renewal pending, currency and
  payment method, Zen balance fallback flag.

## UI

- **Sidebar entry** — a gauge icon in the `sidebar.panellist` slot (order 40). The shell owns
  the button and the selection, exactly like the built-in panels.
- **Main panel** — the `main` keyed slot under the same id: three quota cards plus an
  expiry/renewal card, 60 s auto-refresh, manual refresh, and data-source/updated-at footer.

## Install

```sh
dsh plugin --profile web add file:/path/to/dsh-opencode-go-status
```

Or copy the `insert` row from `cordis.patch.yml` into
`$DSH_HOME/profiles/web/cordis.patch.yml` and install the package separately. **Use one
mechanism only** — mounting twice starts two instances.

Then reload the browser page.

## Configuration

Set on the composition entry (`config:` under the insert row):

| Field | Default | Notes |
| --- | --- | --- |
| `apiKey` | — | Literal API key (prefer the credential reference) |
| `apiKeyRef` | `OPENCODE_GO_API_KEY` | DSH credential reference, same name as the opencode-go provider's `apiKeyEnv` |
| `statusURL` | `https://opencode.ai/console/api/go/status` | Upstream status endpoint |
| `timeoutMs` | `15000` | Request timeout |
| `cacheSeconds` | `30` | Host-side cache window |
| `enabled` | `true` | Master switch |

Key resolution: `apiKey` → DSH credentials service (`apiKeyRef`, covering
`$DSH_HOME/.credentials.yaml`, the launch environment and `.env` layers) → process
environment. **The key never leaves the host process**; the browser only calls the
same-origin route `/api/dsh-opencode-go-status/status`.

## Known limitations

- `/console/api/go/status` is an OpenCode **console-internal** endpoint, undocumented
  (CodexBar reads the same endpoint's `renewAt`). Its shape may change; parsing here is
  defensive — a missing field degrades one card to "—" instead of failing.
- **The Zen prepaid balance is not reachable**: `/console/api/billing/status` returns 403
  with an API key and needs a browser cookie (upstream request
  [anomalyco/opencode#10448](https://github.com/anomalyco/opencode/issues/10448) is still
  open). "Quota / remaining" here means the **Go subscription quota**, not the Zen wallet.
- The host must reach `opencode.ai` directly.
- The expiry shown is the **end of the current period**; with `cancelAtPeriodEnd=false` it
  auto-renews, so "expiry" equals "renewal date".

## License

MIT
