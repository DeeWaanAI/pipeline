---
kind: dependency_management
name: Node.js 单仓多包依赖管理（npm + lockfile + CI）
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - site/package.json
    - site/package-lock.json
    - .github/workflows/ci.yml
    - .github/workflows/site-ci.yml
    - .env.example
    - drizzle.config.ts
---

## 1. 使用的系统与工具

- **包管理器**：npm。根目录 `package.json` 声明全部运行时与开发依赖，仓库内存在 `package-lock.json` 作为锁定文件；CI（`.github/workflows/ci.yml`、`site-ci.yml`）统一使用 `npm ci` 安装，确保构建可重现。
- **Node 版本**：CI 通过 `actions/setup-node@v4` 固定为 Node 20，并启用 `cache: npm` 缓存 node_modules。
- **子包**：`site/` 是独立的 Astro 站点，拥有自己的 `package.json` 与 `package-lock.json`，与根应用解耦；`research/orchestration-economics/code/` 下的脚本直接以裸 `.mjs` / `.py` 运行，未引入独立包管理。
- **私有注册表/镜像**：从 `package-lock.json` 中可见大量 `registry.npmmirror.com` 解析记录，说明本地或 CI 环境配置了 npm 镜像（如 npmmirror），但仓库内未检出 `.npmrc` 文件，因此该镜像策略由外部环境注入。
- **无 vendoring**：未发现 `vendor/`、`node_modules/`（除 site 的构建产物外）、`pnpm-lock.yaml` 等 vendoring 痕迹，所有第三方库均通过 npm registry 拉取。

## 2. 关键文件

- `package.json`：根应用（Hono + tRPC + React）的依赖清单与脚本入口（`build`、`start`、`db:migrate`、`test`、`check` 等）。
- `package-lock.json`：根应用依赖锁定文件，CI 通过 `npm ci` 强制使用。
- `site/package.json` + `site/package-lock.json`：Astro 营销站点的独立依赖声明。
- `.github/workflows/ci.yml`：主应用 CI，顺序执行 typecheck → i18n 检查 → 单元测试 → 生产构建，并启动 MySQL/Redis service container 跑集成测试。
- `.github/workflows/site-ci.yml`：站点 CI，仅对 `site/**` 变更触发，执行 `astro build`。
- `.env.example`：集中列出所有运行时环境变量（数据库、Redis、Stripe、S3、Sentry、AI triage 等），作为依赖外部服务的配置契约。
- `drizzle.config.ts`：Drizzle ORM 迁移配置，配合 `npm run db:migrate` / `db:push` 管理数据库 schema。

## 3. 架构与约定

- **单一 package.json 聚合依赖**：前端（React + Vite）、后端（Hono + tRPC）、共享类型（`contracts/`）、CLI 脚本（`scripts/`）共用同一份依赖声明，避免多包分裂带来的版本漂移。
- **构建产物分离**：`vite build` 产出前端静态资源，`esbuild api/boot.ts api/workerEntry.ts --platform=node --bundle --format=esm --outdir=dist` 将两个 Node 入口打包为 ESM 二进制，再经 `NODE_ENV=production node dist/boot.js` 启动。
- **数据库迁移即依赖演进**：Schema 变更通过 Drizzle migration 文件（`db/migrations/*.sql`）版本化，CI 在集成测试前执行 `npm run db:push` 创建 schema，保证测试环境与代码同步。
- **站点解耦**：`site/` 作为独立 npm 包，依赖 `astro`、`@astrojs/tailwind` 等，与主应用完全隔离，便于单独部署到 Railway/Caddy。
- **研究脚本不纳入包管理**：`research/orchestration-economics/code/` 中的 Python/JS 脚本直接调用系统 Python 与 Node，未维护 `requirements.txt` 或 `package.json`，属于一次性实验资产而非产品依赖。

## 4. 约定与约束

- **必须使用 `npm ci` 进行 CI 安装**：所有 GitHub Actions 工作流均显式调用 `npm ci`，禁止交互式 `npm install`，确保锁文件生效。
- **Node 版本锁定为 20**：CI 通过 `setup-node` 的 `node-version: 20` 固定运行时版本，避免本地与 CI 差异。
- **依赖范围严格区分**：`dependencies` 仅包含运行时所需包（如 `hono`、`drizzle-orm`、`bullmq`、`stripe`、`react` 等），构建/类型/测试工具（`vite`、`typescript`、`vitest`、`eslint`、`prettier`、`tailwindcss` 等）放在 `devDependencies`。
- **无私有 npm 包**：所有依赖均来自公共 npm registry（或其镜像），未见 `@deewaanai/*` 等内部 scope 包。
- **外部服务通过环境变量接入**：数据库、Redis、Stripe、S3、Sentry、AI triage 等外部依赖均以 `.env.example` 中的键名声明，应用启动时读取，未硬编码地址。
- **迁移与 schema 同步**：新增列/表需同时提交 `db/migrations/*.sql` 并通过 `drizzle-kit generate` 生成，CI 会在集成测试前用 `db:push` 落库。
- **站点与主应用依赖互不影响**：`site/package.json` 与根 `package.json` 各自维护，站点构建不依赖主应用产物。
- **已清理冗余依赖**：根据 `DeeWaanAI-Next/PROGRESS.md` 记录，项目曾通过 knip + grep 验证后删除 31 个未使用的 npm 依赖，保持依赖集精简。