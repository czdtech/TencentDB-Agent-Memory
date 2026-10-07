# CONTEXT.md — 本仓库在本机的部署与维护现状

> 给 AI 和人看的"操作手册"。改动本仓库的代码/分支/部署前，先读完这份文件。
> 最后核对时间：2026-10-08。若与实际不符，以实际运行态为准并顺手更新本文。

## 一句话现状

本机 fork 了 TencentDB 开源记忆系统（TDAM），本地 commit 线已收敛到 fork 的
`deploy/prod` 分支；生产服务直接跑 `~/deploy/tdam` 工作树；该分支已被
code-graph 索引并绑定到 agent `omp-eval`，auto-sync 每 10 分钟跟随分支更新。

## 三个目录，三种角色（不要混用）

| 目录 | 角色 | 能做什么 | 不能做什么 |
|---|---|---|---|
| `~/code/tencentdb-agent-memory-team`（本目录） | **主克隆 / git 主库**（书房） | 改代码、commit、开分支、push、合并上游 | — |
| `~/deploy/tdam` | **生产运行目录**（厨房），是本目录的 linked worktree | 只做部署动作：`git checkout --detach deploy/prod` | **禁止改代码**。服务是 `tsx` 直接跑工作树，改文件 = 改运行态 |
| `~/tencentdb-agent-memory-dev` | dev worktree（历史开发线，停在 `local/prod`@111fd52） | 备查 | 不要在这里开发，避免出现第四条 commit 线 |

- `~/deploy/tdam/.git` 和 dev worktree 的 `.git` 都是指向本目录 `.git/worktrees/*` 的指针文件，
  已用 `git worktree repair` 修过一次。**不要单独移动或删除任何一处**，三处是一体的。
- 本目录原在 `~/tencentdb-agent-memory-team`，2026-10-08 迁入 `~/code/`。

## 分支与 remote

```
origin  = https://github.com/TencentCloud/TencentDB-Agent-Memory.git   （上游，默认分支 feat/server_team）
fork    = https://github.com/czdtech/TencentDB-Agent-Memory.git        （本机 push 的 fork，public）
```

| 分支 | 位置 | commit | 说明 |
|---|---|---|---|
| `deploy/prod` | 本地 + fork | `4829672` | **部署分支**。生产 = 这个 commit，索引 = 这个分支 |
| `dev/kitchen` | fork | `4829672` | 备份别名，与 deploy/prod 同 commit |
| `local/prod` | 本地 | `111fd52` | 旧合并线（dev worktree 所指），历史保留 |
| `feat/server_team` | 上游 | 移动中 | 合并上游更新的来源 |

`4829672` = "fix(memory): honor header scope and named newapi route prefixes"，
是本地 15 个 commit 线的顶端（含 proxy 路由/ACL/SSE 等改动），**不在上游里**。

## 服务拓扑（systemd，root 安装）

```
core(8420) → knowledge(8424) → panel(8125) → proxy(8096)    # Requires+After 依赖链
```

- 单元名：`tencentdb-memory-{core,knowledge,panel,proxy}.service`，
  `EnvironmentFile=/home/jiang/.config/tencentdb-agent-memory/team-memory.env`
- 四个服务的 `WorkingDirectory` 都在 `~/deploy/tdam/<模块>`，进程以 `node --import tsx` 直跑工作树
- 重启规则（`Requires` 导致 restart core 会拉死下游且不会自动拉起）：
  **bottom-up 停、top-down 起**：
  ```bash
  sudo systemctl stop tencentdb-memory-proxy tencentdb-memory-panel tencentdb-memory-knowledge
  sudo systemctl restart tencentdb-memory-core
  sleep 3
  sudo systemctl start tencentdb-memory-knowledge
  sudo systemctl start tencentdb-memory-panel tencentdb-memory-proxy
  ```
- 探针：`/health` 4 个端口都应 200（panel 8125 的 `/health` 404 属 Next.js 正常行为）

## code-graph 与 auto-sync

- `cg-kj3ecamw` = `fork@deploy/prod`（885 文件/16203 节点），team `team-9ia00b0bef`
- `cg-mpkjuied` = `czdtech/new-api-slim@main`（另一个项目，同机制，先例）
- 索引载体：knowledge 服务（8424），数据在
  `~/.local/share/tencentdb-agent-memory/knowledge/`
- auto-sync：env `KNOWLEDGE_AUTO_SYNC_ENABLED=1`（`KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN=10`），
  每 10 分钟扫描 ready 的图并跟随分支重建。**push fork 后 ≤10 分钟图自动更新**
- 查看同步：`journalctl -u tencentdb-memory-knowledge.service | grep auto-sync`

## agent 绑定

agent `agt-ixoh3wxrde`（omp-eval，team `team-9ia00b0bef` Windows TencentDB Evaluation）
的 fixed assets 共 5 条：2 个 skill + 1 个 chat_memory + 2 个 code_graph（含 cg-kj3ecamw）。
管理接口 `POST :8420/v3/meta/agent-fixed-asset/set` 是**全量替换**语义——改绑定必须带上全部现有条目。

## 日常维护 SOP

```bash
# 改代码（永远在本目录）
cd ~/code/tencentdb-agent-memory-team
# ... edit / test ...
git add -A && git commit -m "..."
git push fork deploy/prod          # ≤10 分钟后 code-graph 自动跟上

# 上线（改了要生效才需要）
git -C ~/deploy/tdam checkout --detach deploy/prod
# ↑ 按上面"重启规则"重启服务链

# 吃上游更新
git fetch origin
git merge origin/feat/server_team
git push fork deploy/prod
# 上线同上
```

**三层状态锚点**（排查"改了没效果"先对齐这三层）：
本目录 commit → fork `deploy/prod` 分支（= code-graph 内容）→ `~/deploy/tdam` checkout 的 commit（= 运行代码）。

## 已知注意事项

- `~/.config/tencentdb-agent-memory/` 里有密钥（env、proxy.yaml）；**严禁**把配置内容写进代码、
  commit 或文档。本仓库历史 commit 已做过密钥扫描（7 类检查，2026-10-08 全零命中）。
- 根目录 `这里不是生产.txt` 是给人工看的目录角色说明，未纳管（untracked），别 commit 它。
- git 元数据曾被 root 污染（`.git/HEAD/index/config` 属主），2026-10-08 已修回 jiang。
  若再遇 `detected dubious ownership`，加 `git config --global --add safe.directory <路径>`。
- 待办：credit-reporter 的 space-id 正则修复（已在 4829672 中）尚未 PR 回上游；
  开 PR 前 `git diff origin/feat/server_team..deploy/prod` 再扫一遍敏感信息。

## 历史脉络（为什么是现在这个样子）

- 上游服务在本机以"deploy worktree 直跑工作树"方式部署，早期 commit 散在
  `local/prod`（dev worktree）等多条本地线上，导致"部署内容不在任何远端"。
- 2026-10-08 收敛：确认三条本地线实为一条链（4c990a0 → 111fd52 → 4829672），
  fork 后推送 `deploy/prod`；code-graph 入图并开启 auto-sync；
  主库迁至 `~/code/`。部署方式（deploy worktree 直跑）保持不变。
