---
kind: external_dependency
name: Railway — 应用托管、MySQL、Redis 与变量管理
slug: railway
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### 角色与集成点
- DeeWaanAI 生产部署在 Railway 项目 `pacific-art`（environment `production`），单服务 `deewaanai` 同时运行 HTTP + 进程内 worker（`START_WORKER` 未设置）。
- 提供 MySQL（含 `swarm_runs.error`、`mediumtext` 列）和 Redis（BullMQ 队列），通过 `SWARM_WORKER_CONCURRENCY` 环境变量控制并发度（默认 2）。
- 通过 Project Token（非 OAuth App）进行程序化访问，可读写环境变量、触发 redeploy。

### 稳定用法要点
- 迁移文件不在部署流程中自动执行，需手动运行 `run-migration-*.mjs` 或 SQL 脚本。
- 数据库磁盘满会导致 MySQL 进入只读模式（所有写操作失败），需扩容 volume 或清理数据。
- 项目级 token 只能访问绑定项目，不能执行 account-level 查询（如 `whoami`）。