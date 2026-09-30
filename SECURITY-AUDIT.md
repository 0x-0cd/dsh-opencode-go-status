# 安全审计报告 — dsh-opencode-go-status

## 元数据

| 项 | 值 |
| --- | --- |
| 审计对象（代码与配置树） | commit `c85ca30713db636ed2eff528f3e95f22b550d54c`（2026-09-30T11:25:05+08:00） |
| 仓库路径 | `/Users/qianneng/Code/dsh-opencode-go-status` |
| 审计日期 | 2026-09-30 |
| 扫描工具 | gitleaks 8.30.1（可用）、pnpm 12.6.0；**trivy / trufflehog / checkov 未安装**（覆盖缺口见「方法限制」） |
| 机器预检 | `plugin_vet` → **PASS**（总分 87/100；许可证 100、来源 100、构建脚本 90、依赖 70、维护 60） |

本报告文件在 `c85ca30` 之后单独提交，不改变任何被审文件；复核时用
`git show c85ca30` 取被审树。

## 范围

**纳入**（`git ls-files`，共 12 个文件）：

```
.githooks/pre-commit        .github/workflows/check.yml   .gitignore
.gitleaks.toml              LICENSE                       README.en.md
README.md                   client.js                     cordis.patch.yml
index.js                    package.json                  test/host.test.mjs
```

**排除及理由**：DSH 宿主与 web shell 代码（不在本仓）；上游 `opencode.ai` 服务端；
用户本机 profile 配置（`$DSH_HOME/profiles/web/*`，含真实密钥，不属于本仓范围）；
浏览器渲染的视觉/交互走查（无浏览器自动化，见「方法限制」）。

**边界假设**：只审当前仓库 git 跟踪的文件与其全部提交历史；无子模块、无 vendored 代码。

## 资产清单

| 面 | 资产 | 结论 |
| --- | --- | --- |
| 密钥面 | `.env*` / `*.pem` / `id_rsa` / `id_ed25519` / `*.key` | **未发现** |
| 依赖面 | `package.json`（无锁文件） | 运行时依赖 **0**、devDependencies **0**、无生命周期脚本 |
| CI 面 | `.github/workflows/check.yml` | 见 F3/O4 与阶段 4 验证 |
| IaC / 容器面 | Dockerfile / compose / tf / hcl | **未发现** |
| 子模块 | — | **无** |

## 结论摘要

- 密钥面干净：gitleaks 全历史 **0 发现**（含为本仓补的 `oc_sk_` 规则），降级 grep 路径亦 0 命中。
- 供应链面干净：零依赖、无 install/postinstall 脚本、无混淆代码、CI 的 action 按 commit SHA 固定。
- 审计中发现并已修复 **3 条**（高 1 / 中 1 / 低 1），当前无未修复的严重或高危问题。
- 残留 6 条观察项，均无「可利用性 × 影响 × 已暴露」三要素齐备的定级依据。

## 发现（均已修复并复验）

| # | 发现 | 位置 | 可利用性 | 影响 | 是否已暴露 | 级别 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | API key 可被配置导向任意主机的明文 http | `index.js`（`fetchStatus`） | 中（需能改本机 profile 配置） | 高（密钥泄露 → 额度被盗用） | 否 | 中 |
| F2 | `?refresh=1` 可无限绕过缓存打上游 | `index.js`（`makeStatusRoute`） | 低（需本机回环进程） | 低（请求放大） | 否 | 低 |
| F3 | 提交前密钥门禁对 `oc_sk_` 凭据完全失效 | `.githooks/pre-commit` | 高（一次普通提交即可绕过） | 高（真实密钥会进公开历史） | 否（仅提交过假密钥，且已从历史移除） | 高 |

### F1 — statusURL 可把密钥发到任意主机的明文 http 上

原实现直接 `fetch(options.statusURL)`，而该请求携带 `Authorization: Bearer <key>`：
把 `statusURL` 写成 `http://` 目标（配错协议或被诱导改配置）会把密钥暴露给链路上的
任何观察者。**修复**：新增 `assertSecureStatusUrl()`，非回环主机强制 https，
回环地址（本地反代调试）仍允许 http。

复核：

```sh
git grep -n 'assertSecureStatusUrl' -- index.js
node --test test/    # 用例「加固：statusURL 指向非回环 http 时拒绝」
```

### F2 — ?refresh=1 无节流，可无限绕过缓存

原实现只要带 `?refresh=1` 就跳过缓存，本机任意进程可借此把上游当压测对象。
**修复**：新增 `MIN_FORCED_REFRESH_MS = 3000`，强制刷新受最小间隔限制，超频请求回落缓存。

复核：

```sh
git grep -n 'MIN_FORCED_REFRESH_MS' -- index.js
node --test test/    # 用例「加固：?refresh=1 受最小间隔限制」
```

### F3 — 门禁对本仓最该拦的凭据是瞎的（审计中实测发现）

初版门禁只用 gitleaks 默认规则，验收时**故意提交一个假密钥却成功通过了**
（产生了提交 `361b402`）。根因经复现确认：gitleaks 8.30.1 默认规则集不识别
OpenCode 的 `oc_sk_…` 前缀 —— 对一个假 `oc_sk_` 值返回 `no leaks found`、退出码 0。

**修复**（两层，无条件都跑）：

1. 新增 `.gitleaks.toml`，在默认规则之上补 `opencode-api-key`（`oc_sk_` 前缀）
   与 `inline-bearer-token` 两条规则；
2. `.githooks/pre-commit` 不再「gitleaks 返回 0 就放行」，而是 gitleaks 与 grep
   形态兜底**两层都执行**，任一层命中即阻断；命中内容不打印明文。

**复验证据**：

```sh
git show 361b402          # 修复前：假密钥提交成功（该提交已从历史移除）
git config core.hooksPath .githooks

# 修复后第 1 层：gitleaks + 自定义规则
printf 'const k = "oc_sk_FAKEdeadbeef…（截断，避免本报告自身触发门禁）"\n' > probe.js
git add probe.js && git commit -m probe   # → 退出码 1，Fingerprint: probe.js:opencode-api-key:1
git rm --cached -q probe.js && rm probe.js

# 修复后第 2 层：模拟 gitleaks 不可用
PATH=/usr/bin:/bin sh .githooks/pre-commit # → 退出码 1，「暂存区 1 行命中疑似密钥形态」

# 误拦检查：正常提交
git commit -m "..."                        # → 退出码 0
```

假密钥提交已用 `git reset` 移除，并执行 `git reflog expire --expire=now --all &&
git gc --prune=now` 清理不可达对象（仅含假值，非真实凭据）。

## 观察（无三要素齐备的定级依据，记录备查）

| # | 观察 | 判据 / 证据 |
| --- | --- | --- |
| O1 | 无锁文件 | 运行时依赖与 devDependencies 均为 0，无可解析的依赖树；插件本身不自带锁文件。`plugin_vet` 的 SBOM 项因此记 WARN，属可接受 |
| O2 | `plugin_vet` 报「直连 IP 的 URL」2 处 | **误报**：`index.js:258` 是 `new URL(req.url, 'http://127.0.0.1')` 的解析基准，不出站；`test/host.test.mjs:153` 是「回环 http 允许」用例的地址。均无外发行为 |
| O3 | 响应向浏览器返回 `keySource` 标签（如 `credentials:file`） | 只泄露「密钥来自哪一层」，不含密钥值；接收方是操作者自己的浏览器，接受 |
| O4 | 错误路径回显上游响应体前 200 字符 | 用于排障；内容为上游错误信息，非本插件持有的密钥材料，接受 |
| O5 | 回环栅栏不防本机恶意进程 | 与官方插件路由同构（`127.0.0.1`/`::1` + 同源标记 + 仅 GET）；本机进程本就能读 `$DSH_HOME`，不构成额外暴露面 |
| O6 | 无自动验证型扫描 | trivy / trufflehog 未安装，未执行「密钥是否仍然有效」的验证型扫描；如需级 A 判定，安装后跑 `trufflehog git file://. --only-verified` |

## 验证命令附录

```sh
# 阶段 0：固定对象
git rev-parse --show-toplevel && git log -1 --format='%H %cd' --date=iso-strict

# 密钥面：全历史（带本仓自定义规则）
gitleaks detect --source . --config .gitleaks.toml --redact -v      # → no leaks found

# 密钥面：降级 grep（无 gitleaks 时）
# 模式串在此写成转义形式，避免本报告自身含 PEM 头等字面标记而触发扫描器。
git rev-list --all | head -n 500 | while read rev; do
  git grep -nE 'oc_sk_[A-Za-z0-9_]{16,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}' "$rev" 2>/dev/null
done

# 密钥不出宿主：客户端只打同源路由，且无密钥处理
git grep -nE 'apiKey|oc_sk_|Bearer' -- client.js    # 仅错误提示里的凭证「名字」

# XSS 面：无 innerHTML / dangerouslySetInnerHTML，数据全走 React 文本渲染
git grep -nE 'dangerouslySetInnerHTML|\.innerHTML' -- client.js   # → 无命中

# 不落盘
git grep -nE "node:fs|writeFile|appendFile" -- index.js client.js # → 无命中

# 依赖与生命周期脚本
node -e "const p=require('./package.json');console.log(p.dependencies,p.devDependencies,p.scripts)"

# CI 面
git grep -c 'pull_request_target' -- '.github/workflows/**'                                # → 0
git grep -nE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@v[0-9]' -- '.github/workflows/**'       # → 0（按 SHA 固定）
git grep -n 'permissions:' -- '.github/workflows/**'                                       # → contents: read

# 行为回归（13 用例，桩 fetch，离线）
node --test test/*.test.mjs
```

## 方法限制

- **未执行**：trivy / trufflehog / checkov（未安装）；容器与 IaC 扫描（本仓无此类资产）；
  真实浏览器交互与视觉走查（用离线渲染 harness 替代，见 `test/` 与仓库提交信息）。
- **工具盲区**：gitleaks 默认规则不覆盖 `oc_sk_` 前缀（F3 的根因）；已用 `.gitleaks.toml`
  补齐，但**其他厂商的私有前缀同样可能不在默认规则内**，新增凭据类型时需同步扩规则。
- **范围外**：DSH 宿主与 web shell 的安全性、上游 `opencode.ai` 接口的可用性与稳定性
  （该接口为控制台内部接口，未公开文档化）、用户本机 profile 配置的权限管理。
- 本报告不含任何密钥明文；如需级 A 判定（确认密钥是否有效），须在**轮换之后**于厂商侧进行。
