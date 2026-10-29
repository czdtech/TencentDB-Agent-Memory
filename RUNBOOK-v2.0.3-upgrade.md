# Runbook：TDAM 生产升级到上游 v2.0.3 + 3 个补丁

> 状态：待执行（2026-10-29 起草）。执行完把结果写进 `CHANGELOG.md`，本文件不保留过程记录。
> 适用仓库：`~/code/tencentdb-agent-memory-team`（fork `czdtech/TencentDB-Agent-Memory`）+ `~/ops-workspace/tdam-iac-deploy`。

## 0. 目标与边界

- **目标**：生产从 `deploy/railway-source @ 0e20fc9`（上游 v2.0.3-beta.1 + 15 个自研补丁）追平到上游 `ecc01a5`（v2.0.3 + 3 个补丁，含 `/v3/meta` agent/task 读权限修复）。
- **不做**：不上 MongoDB 后端、不导入外部任务源、不接新客户端适配、不改业务配置（模型/embedding/席位）。
- **验收**：三服务 `/health` 200 且 backends 全 true；7 项 smoke 全绿；一次真实席位会话正常写读记忆；无新增 5xx。
- **预算**：半天到一天；一次生产发布窗口。

## 1. 事实基线（2026-10-29 核对）

| 项 | 值 |
|---|---|
| 生产分支 | `deploy/railway-source`（Railway IaC 三服务均指向它） |
| 生产 commit | `0e20fc9`（2026-10-22） |
| 上游目标 | `upstream/feat/server_team @ ecc01a5`（2026-10-28） |
| 缺口 | 6 个提交 / 135 文件 / +18941 −2549 |
| 其中安全修复 | `afadb9a fix(memory-core): enforce agent and task read permissions` |
| 其中发布项 | `084bed4 feat: release v2.0.3`：会话默认绑定、Wiki 富文档（Office/PDF）、上游超时 10min→1h、Redis 中断自愈 |
| 冲突面 | 我们改过、上游也改过的文件 18 个，几乎全在 `MemoryProxy` |

**自研补丁（合并时必须保留）**：L1 prompt injection 过滤、memory-bridge 只读、FTS5 查询清洗、ops 端点 fail-closed、本地 named route 视为已托管、Reviewer 路由身份预设、upstream identity encoding、costGuard fixture、本地 embedding 默认关闭（jiang 决策）。

## 2. 阶段 0 · 前置（只读 + 备份）

1. 确认无 in-flight 交付（Lead 最多 2 并发的空窗），并告知会有一次短时发布。
2. 拉代码：
   ```bash
   cd ~/code/tencentdb-agent-memory-team
   git fetch upstream feat/server_team
   git fetch origin deploy/railway-source
   git switch -c upgrade/v2.0.3 origin/deploy/railway-source
   ```
3. 备份生产数据（sqlite 在 Railway 卷上）。`railway volume files download` 递归导目录实测只建目录、不落文件，改用 SSH 直接打 tar 流：
   ```bash
   cd ~/code/paseo-stack   # 已 link tdam-cloud
   B=~/backups/tdam-$(date +%F); mkdir -p "$B"
   for pair in memory-core:core memory-proxy:proxy memory-hub:hub; do
     railway ssh -s "${pair%%:*}" -- "tar czf - -C /data ." > "$B/${pair##*:}.tgz"
   done
   ```
   前置：本机公钥临时注册（`railway ssh keys add`），导出完立刻 `railway ssh keys remove`。
   卷 ID：core `e1e21057-5f86-40c6-a9de-56bdfbb9cf58`、proxy `f1098c6e-675e-4eed-9c89-7b5c8a02df1e`、hub `91ec8ec7-0532-4492-a2cc-d9d1c9c3723f`（各 5000MB 上限，实占 core 342MB / proxy 181MB / hub 118MB）。
   校验：`tar tzf` 可列目录；每个 `*.db` 用 `python3 -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('pragma integrity_check').fetchone())"` 逐个过；体积与 `railway volume list --json` 的 `currentSizeMB` 同量级。
   注意：活文件快照，WAL 里已提交但未 checkpoint 的事务可能滞后；作为回滚保险足够，但不保证事务级一致。
4. 记录回滚点（2026-10-29 已取证）：生产 commit `0e20fc9`；当前 SUCCESS 部署 id
   core `53b56d4e-9846-4631-9633-30424ef77666` / proxy `a907bf48-531b-4f06-89ed-3320677eac0f` / hub `b0af1b46-5081-4109-9a91-fb53b38fe643`，三者均 2026-10-23 构建。
   确认 dashboard「Redeploy 上一部署」入口可用。
5. 记录基线 smoke 结果（见阶段 3 的 7 项），作为升级后对照。

**阶段 0 完成情况（2026-10-29）**：三卷已导出到 `~/backups/tdam-20261029/{core,proxy,hub}.tgz`（42M / 1.2M / 472K，解开 165M / 17M / 4.7M）；
6 个 sqlite（core 4 个 / proxy / hub）全部 `integrity_check=ok` 且 WAL 回放后能读出真实行数（meta-v3 20 agents / 33 fixed assets / 23 assets，proxy_kv 719 行）。
临时 SSH 公钥 `tdam-backup-temp` 已 remove，账号回到原有 3 把 key。

## 3. 阶段 1 · 合并

```bash
git merge upstream/feat/server_team   # 不 rebase：生产历史不改写，回滚才简单
```

冲突处理口径：

- **安全补丁一律保留我们的**；上游对同文件的逻辑改动逐块吃进，不整文件取 ours。
- `MemoryProxy/config.railway.yaml`、`src/config.ts`、`src/namedRoute.ts`、`src/instance-upstream-cache.ts`、`src/memory/memory-bridge.ts`、`src/auth.ts`、`src/injection/**`、`src/pipeline/runners/**` 逐个过。
- `package-lock.json` 冲突不手解：以 `npm install` 重新生成的结果为准，和 `package.json` 一起提交。
- 合完做标志性断言（每条 grep 必须命中）：
  ```bash
  grep -r "prompt injection" MemoryProxy/src/injection | head
  grep -rn "read-only\|READ_ONLY\|只读" MemoryProxy/src/memory/memory-bridge.ts | head
  grep -rn "MATCH" MemoryProxy/src/store | head
  grep -rn "namedRoute" MemoryProxy/src --include=*.ts -l | head
  ```
- 提交信息写清「merge upstream ecc01a5 + 冲突裁决要点」。

## 4. 阶段 2 · 本地验证（未 push）

| 子系统 | 命令 | 关注点 |
|---|---|---|
| MemoryCore | `npm ci && npx vitest run` | 新增 `agent-task-visibility.test.ts` 必须过 |
| MemoryProxy | `npm ci && npm run typecheck && npx vitest run` | 我们 8 组测试（accept-encoding / forward-retry / local-named-route / memory-scope / namedRoute / spaceid / upstream-compression / whitelist）全绿 |
| MemoryPanel | `npm ci && npx vitest run`；web 构建 | 新增 i18n-storage 测试 |
| MemoryKnowledge | `npm ci && npx vitest run` | 新增 Office/PDF 文档转换用例 |
| 三件套 | `deploy/global-images` 起 compose | `/health`、panel 打开、写读一条记忆、`/v3/tools/list` |

再跑一次我们自己的契约级验证：用假件模拟代理请求，确认 `x-team-id` / `x-agent-id` / `x-task-id` 三元组仍按会话正确注入、`injectedSkipped=false`。

## 5. 阶段 3 · 发布

1. push 验证分支到 fork（不触发生产，生产只跟 `deploy/railway-source`）：
   ```bash
   git push -u origin upgrade/v2.0.3
   ```
2. **取得 EM 明确批准后**，把 `upgrade/v2.0.3` 合入 `deploy/railway-source` 并 push（自动触发三服务重建）：
   ```bash
   git switch deploy/railway-source && git pull --ff-only
   git merge --ff-only upgrade/v2.0.3
   git push origin deploy/railway-source
   ```
3. 观察构建与启动（三服务同时重建，约数分钟）。
4. 发布后 10 分钟内跑 smoke，**正向 + 反向**都验：
   1. 三服务 `/health` 200，hub 的 `backends.panel/knowledge` 均 true。
   2. Panel 可打开、可登录，新「会话默认绑定」页可加载。
   3. `/v3/meta/agent/get`：本团队 key 读本团队 agent → 200；**非本团队 key 读该 agent → 403**（这是本次升级的目的，必须反向验）。
   4. 记忆写读：用测试 task 写一条 L0 → 读回一致 → 按 message_id 清理。
   5. memory-proxy：一次低成本真实模型请求，确认身份头注入、记忆注入未跳过、响应正常。
   6. knowledge：`/v3/tools/list` 200，Wiki 列表可读。
   7. 跨团队观察：`omp-eval`（team `team-9ia00b0bef`）用当前团队的 key 读取，记录结果——权限修复后若由 200 变 403 属预期；我们若还依赖跨团队绑资产，改用该团队自己的 key。

## 6. 阶段 4 · 回滚

**触发条件（任一）**：`/health` 非 200 持续 5 分钟；写记忆失败；身份注入缺失；proxy 5xx 超基线；panel 无法登录。

- 手段 A（首选）：`git revert <merge-commit>` → push `deploy/railway-source` → 自动重建回旧代码。
- 手段 B：Railway dashboard 对上一 deployment 执行 Redeploy。
- 数据：上游新增结构走 `CREATE TABLE IF NOT EXISTS`，delta 中未见 `ALTER TABLE`，旧代码回滚应可直接启动；若启动失败，用阶段 0 的 `/data` 备份恢复卷。
- 回滚后重跑阶段 3 的 7 项 smoke，确认回到基线。

## 7. 风险与已知影响

| 风险 | 影响 | 处置 |
|---|---|---|
| 权限修复改变跨团队读行为 | `omp-eval` 等跨团队操作可能 403 | 记录了合法用法；必要时改用该团队 key |
| knowledge 新增 Office/PDF 依赖 | 镜像变大、构建变慢、构建失败 | 构建失败即不发布，留在验证分支 |
| 上游超时 10min→1h | 长请求占连接更久 | 观察 proxy 连接数；必要时显式配 `forwardTimeoutMs` |
| 18 个重叠文件丢补丁 | 安全/路由回退 | 阶段 1 的 grep 断言 + 阶段 2 测试兜底 |
| sqlite 迁移 | 启动失败或数据不可读 | 阶段 0 备份 + 回滚恢复 |

## 8. 收尾（发布成功后）

1. `CHANGELOG.md` 记一条：升级到 `ecc01a5`、时间、冲突裁决要点、7 项 smoke 结果、发现的跨团队行为变化。
2. `CONTEXT.md` 分支表改正：生产 = `deploy/railway-source`（原文写 `deploy/prod`，已过时）；`deploy/prod` 降为参考分支。
3. 删除 `upgrade/v2.0.3` 验证分支（若已合入）。
4. 若上游仍有新提交，按同一流程滚动跟进，但不再攒两三周才升。
