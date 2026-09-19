---
kind: build_system
name: 多模块单体工程的构建、打包与 CI/CD 流水线
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - vite.config.ts
    - Dockerfile
    - site/Dockerfile
    - .github/workflows/ci.yml
    - .github/workflows/site-ci.yml
    - .github/workflows/backup.yml
    - docker-compose.yml
    - ecosystem.config.cjs
    - drizzle.config.ts
    - deploy/install.sh
    - deploy/aliyun-setup.sh
---

## 1. 使用的构建系统与工具链

本项目采用 **Vite + esbuild** 双构建器：
- 前端（React + TypeScript）通过 `vite build` 产出静态资源至 `dist/public`，并按包维度手动拆分 chunk（react、trpc、i18n、icons），以优化首屏加载。
- 后端（Hono + tRPC）通过 `esbuild api/boot.ts api/workerEntry.ts --platform=node --bundle --format=esm --outdir=dist` 将两个 Node 入口分别打包为 `dist/boot.js` 与 `dist/workerEntry.js`，并注入 `createRequire` shim 以兼容 `require` 调用。
- 数据库 Schema 与迁移由 **Drizzle ORM** (`drizzle-kit`) 管理，提供 `db:generate` / `db:migrate` / `db:push` 三个命令。
- 营销站点（`site/`）是独立的 Astro 应用，使用其自身的 `npm run build` 生成静态文件并由 Caddy 托管。
- 进程守护使用 **PM2**（`ecosystem.config.cjs`），单实例 fork 模式，限制堆内存 256MB、总进程内存 280MB 后自动重启。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | 统一脚本入口：`dev` / `build` / `start` / `start:worker` / `check` / `test` / `db:*` / `i18n:check` |
| `vite.config.ts` | 前端构建配置、别名（`@`、`@contracts`、`@db`）、chunk 拆分策略 |
| `Dockerfile` | 多阶段镜像：builder（Node 20 Alpine）→ runner（Node 20 Alpine + mariadb-client），暴露 `/api/health` 健康检查 |
| `site/Dockerfile` | 独立 Astro 站点镜像：Node 22 构建 → Caddy 静态托管，支持 `SITE_DOMAIN` / `APP_DOMAIN` 运行时替换 |
| `.github/workflows/ci.yml` | 主应用 CI：typecheck → i18n key parity → unit tests → prod build；集成测试 job 启动 MySQL 8.0 + Redis 7 service container |
| `.github/workflows/site-ci.yml` | 营销站 CI：仅监听 `site/**` 变更，Node 22，构建后校验占位符未被污染 |
| `.github/workflows/backup.yml` | 每日定时备份工作流 |
| `docker-compose.yml` | 本地开发依赖：MySQL 8.0 + Redis 7，app 服务默认注释掉 |
| `ecosystem.config.cjs` | PM2 生产进程管理配置 |
| `drizzle.config.ts` | Drizzle 连接与迁移目录配置 |
| `deploy/install.sh`、`deploy/aliyun-setup.sh` | 阿里云低配实例一键部署脚本 |

## 3. 架构与约定

### 3.1 单一仓库多产物
根 `package.json` 的 `build` 脚本同时产出两类产物：
- `dist/public/` — Vite 构建的前端静态资源
- `dist/boot.js`、`dist/workerEntry.js` — esbuild 打包的后端入口
运行期通过 `npm start`（`node dist/boot.js`）和 `npm start:worker`（`node dist/workerEntry.js`）分别启动 API 与 Swarm Worker。

### 3.2 容器化策略
- 应用镜像采用 **双阶段构建**：builder 阶段执行 `npm ci --ignore-scripts` + `npm run build`，runner 阶段仅拷贝 `package.json`、`package-lock.json` 与 `dist/`，并通过 `--omit=dev` 安装生产依赖，减小镜像体积。
- Runner 镜像以非 root 用户 `appuser:appgroup` 运行，创建 `logs/` 目录，暴露 3000 端口，通过 `wget` 探测 `/api/health` 做健康检查。
- 营销站点镜像基于 `caddy:alpine`，在容器启动时用 `sed` 将环境变量注入到 `robots.txt` 与所有 HTML 文件中。

### 3.3 CI/CD 流水线
- **主应用 CI**（`ci.yml`）：仅在非 `site/**` 变更时触发。顺序为 `npm ci` → `npm run check`（tsc -b）→ `npm run i18n:check`（校验中英文键一致）→ `npm test` → `npm run build`。额外阻断含 `your-email@example.com` 占位符的合并。
- **集成测试**：在同一 workflow 中作为独立 job，拉起 MySQL 8.0 与 Redis 7 service container，执行 `npm run db:push` 建表后跑全量测试。
- **站点 CI**（`site-ci.yml`）：仅监听 `site/**`，Node 22，构建后断言 `{{site_domain}}` 仍存在于输出中，防止占位符被意外替换。
- Railway 自动部署 main 分支，CI 充当安全网。

### 3.4 数据库迁移
- 使用 Drizzle Kit 管理版本化 SQL 迁移（`db/migrations/*.sql`），通过 `npm run db:migrate` 在生产环境推进，`npm run db:push` 在 CI 中用于集成测试建表。
- 另有 `scripts/run-migration-019.mjs` 等独立迁移脚本用于特定场景。

### 3.5 本地开发
- `npm run dev` 通过 `@hono/vite-dev-server` 热重载后端 `api/boot.ts`，同时提供 Vite 前端开发服务器（端口 3000）。
- `docker-compose.yml` 提供 MySQL + Redis 依赖，app 服务默认注释，便于按需启用。

## 4. 约定与约束

- **Node 版本**：应用构建与运行使用 Node 20（Dockerfile、CI），营销站点使用 Node 22（`site/Dockerfile`、`site-ci.yml`）。
- **构建产物位置固定**：前端 `dist/public`，后端 `dist/boot.js`、`dist/workerEntry.js`，PM2 与 Docker CMD 均硬编码这些路径。
- **环境变量**：通过 `envDir` 指向根目录，`.env.example` 提供模板；运行时通过 `NODE_ENV`、`PORT`、`DATABASE_URL`、`REDIS_URL` 等控制行为。
- **健康检查**：容器内通过 `HEALTHCHECK` 探测 `/api/health`；本地 compose 对 MySQL/Redis 也定义了 healthcheck。
- **日志轮转**：PM2 配置限定日志文件大小 10MB、最多保留 5 个文件，防止磁盘写满。
- **内存限制**：PM2 设置 `max_memory_restart: "280M"`，Node 堆上限 `--max-old-space-size=256`，适配 0.5GB 低配实例。
- **许可证占位符阻断**：CI 扫描 LICENSE/COMMERCIAL.md/README.md/package.json，若仍含 `your-email@example.com` 则拒绝合并。
- **站点占位符保护**：`site-ci.yml` 强制要求构建产物中必须保留 `{{site_domain}}` 占位符，确保部署时由平台注入真实域名。
- **依赖安装**：所有阶段使用 `npm ci`（锁定版本），builder 阶段 `--ignore-scripts`，runner 阶段 `--omit=dev` 并清理缓存，保证可重现构建。
