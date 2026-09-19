---
kind: error_handling
name: 错误处理体系：TRPCError + Hono中间件 + 结构化日志 + 前端ErrorBoundary
category: error_handling
scope:
    - '**'
source_files:
    - contracts/errors.ts
    - contracts/constants.ts
    - api/middleware.ts
    - api/router.ts
    - api/boot.ts
    - api/lib/logger.ts
    - api/lib/messages.ts
    - src/components/ErrorBoundary.tsx
    - api/routers/billing.ts
    - api/routers/gitee.ts
    - api/routers/certification.ts
    - api/routers/export.ts
---

## 1. 整体方案

本仓库采用分层错误模型：
- 共享契约层 `contracts/errors.ts` 定义轻量级 `AppError`（tagged union `{ tag: "app_error"; status; message }`）及工厂 `Errors.badRequest/unauthorized/forbidden/notFound/internal`，用于业务层返回标准化 HTTP 语义的错误对象。
- tRPC 层统一通过 `@trpc/server` 的 `TRPCError`（code 为 `UNAUTHORIZED/FORBIDDEN/NOT_FOUND/BAD_REQUEST/INTERNAL_SERVER_ERROR`）表达客户端可感知的错误，由 tRPC 自动序列化为 JSON 响应。
- 原始 HTTP 路由（Hono）在 `api/boot.ts` 中注册全局中间件（request-id、安全头、bodyLimit），并通过 try/catch 包裹可选模块（MCP/SSO/Relay）的 route 注册，确保单个模块初始化失败不会阻断整个应用启动。
- 后端结构化日志通过 `api/lib/logger.ts` 输出带 `ts/level/msg/data` 字段的 JSON 行，支持 `LOG_LEVEL` 环境变量过滤；所有异常路径均调用 `logger.error(...)` 并附带上下文。
- 前端 React 应用使用 `src/components/ErrorBoundary.tsx` 捕获渲染期未处理异常，展示兜底 UI 并提供“Reload Application”按钮恢复。

## 2. 关键文件与职责

| 文件 | 职责 |
|---|---|
| `contracts/errors.ts` | 定义 `AppError` tagged union 与 `Errors.*` 工厂 |
| `contracts/constants.ts` | 集中 `ErrorMessages.unauthenticated / insufficientRole` 等硬编码提示 |
| `api/middleware.ts` | tRPC 认证/鉴权中间件，抛 `TRPCError({ code, message })` |
| `api/router.ts` | 聚合全部 tRPC router，不直接处理错误 |
| `api/boot.ts` | Hono 应用装配：request-id、安全头、健康检查、各子路由注册（try/catch 隔离）、后台 heal/reconciler |
| `api/lib/logger.ts` | 结构化 JSON 日志，按 `LOG_LEVEL` 过滤 |
| `api/lib/messages.ts` | 服务端 i18n 消息查找（`msg(key, locale, params)`），用于将错误信息本地化 |
| `src/components/ErrorBoundary.tsx` | 前端 React Error Boundary，捕获组件树崩溃 |
| 各 `api/routers/*.ts` | 业务端点抛出 `TRPCError`（如 `billing.ts`、`gitee.ts`、`certification.ts`、`export.ts`） |

## 3. 架构与约定

### 3.1 错误类型分层
- **业务层**：优先构造 `AppError`（`Errors.notFound(...)`, `Errors.forbidden(...)` 等），便于被上层统一转换为 HTTP 状态码。该类型仅存在于 `contracts/`，供跨模块共享。
- **tRPC 层**：在 router 或 middleware 中直接 `throw new TRPCError({ code, message })`，由 tRPC 框架负责序列化与状态码映射。认证/权限校验集中在 `middleware.ts` 的 `requireAuth` / `requireRole` 中间件。
- **HTTP 层**：非 tRPC 的 Hono 路由（上传、webhook、beacon 等）使用 try/catch 包裹业务逻辑，失败时记录 `logger.error` 并返回合适的 JSON 响应。

### 3.2 中间件式鉴权错误
`t/api/middleware.ts` 提供 `authedQuery = publicQuery.use(requireAuth)` 和 `adminQuery = authedQuery.use(requireRole("admin"))`，所有需要认证的 procedure 复用此链，保证未认证/无权限场景统一抛出 `TRPCError`，避免在各 router 重复实现。

### 3.3 启动容错（Graceful Degradation）
`api/boot.ts` 对可选功能模块（MCP、SSO、Relay）的 route 注册使用 `try { registerXxxRoutes(app) } catch (err) { logger.error(...) }` 包裹，使单一模块初始化失败仅记录日志并跳过，不影响主服务启动。这是显式的“降级”策略。

### 3.4 运行时自愈与重试
`boot.ts` 内启动两个后台任务：
- **DB-HEAL**：启动时扫描数据库中卡住的 `running`/`pending` 任务，重置状态并重入队列。
- **RECONCILER**：每 60 秒运行一次，修复丢失的 pending run、过期的 running claim，以及终态 batch 的最终化。
每个子步骤都独立 try/catch，失败仅记录 `logger.error`，保证自愈循环持续运行。

### 3.5 前端错误边界
`src/components/ErrorBoundary.tsx` 是类组件实现的 React Error Boundary，捕获子树渲染异常后显示兜底页面（标题 “Something went wrong”，附带错误消息），并提供刷新按钮重置状态。它通过 `getDerivedStateFromError` 更新 state，通过 `componentDidCatch` 输出到控制台。

### 3.6 日志规范
`api/lib/logger.ts` 暴露 `logger.debug/info/warn/error(msg, data?)`，所有日志输出为单行 JSON，包含 `ts`、`level`、`msg` 及扩展字段。错误级别走 `console.error`，可通过 `LOG_LEVEL` 环境变量控制最小级别（默认 `info`）。所有异常路径均附带结构化上下文（如 `swarmRunId`、`error.message`）。

## 4. 约定与约束

- **tRPC 端点**：禁止直接 `return c.json(500, ...)`，应 `throw new TRPCError({ code, message })`，由框架统一处理。
- **认证/授权**：必须通过 `authedQuery` / `adminQuery` 中间件，而非在每个 router 内手写鉴权逻辑。
- **可选模块初始化**：新增外部依赖（OAuth、SAML、第三方 SDK）的 route 注册必须用 `try/catch` 包裹并 `logger.error`，不得让异常冒泡导致进程退出。
- **后台任务**：任何定时/异步任务（heal、reconciler、queue consumer）内部必须 try/catch 每个子操作，失败仅记录日志，不得中断循环。
- **用户可见错误**：业务错误消息应通过 `contracts/constants.ts` 的 `ErrorMessages` 或 `api/lib/messages.ts` 的 `msg()` 获取，以支持多语言（en/zh）。
- **前端崩溃**：组件级错误由 `ErrorBoundary` 兜底，禁止让未捕获 Promise rejection 或同步异常穿透到浏览器空白页。

## 5. 观察到的不一致点

- `contracts/errors.ts` 定义了 `AppError` 与 `Errors.*` 工厂，但在当前代码库中并未广泛使用——大多数 router 直接 `throw new TRPCError`，而非先构造 `AppError` 再转换。这表明 `AppError` 可能作为未来统一错误模型的预留设计，尚未完全落地。
- 部分 router（如 `gitee.ts`）大量重复硬编码字符串 "Gitee sync is not enabled"，未通过 `ErrorMessages` 或 i18n 管理，存在可维护性隐患。
- 前端 `ErrorBoundary` 仅捕获渲染期错误，未集成 Sentry 或其他上报通道（后端有 `initObservability()` 但前端未引用）。