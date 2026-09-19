---
kind: logging_system
name: 基于 JSON 结构化日志与 Sentry 的轻量级后端日志系统
category: logging_system
scope:
    - '**'
source_files:
    - api/lib/logger.ts
    - api/lib/observability.ts
    - api/boot.ts
    - api/context.ts
---

## 1. 使用方案

后端采用**自实现的极简结构化日志器**（`api/lib/logger.ts`），无第三方日志框架依赖。日志输出为单行 JSON，通过 `console.log/warn/error` 直接写入进程标准输出，由运行环境（Docker/Railway/PM2）负责收集。

错误上报通过可选的 **Sentry**（`@sentry/node`）实现，以懒加载方式在 `api/lib/observability.ts` 中初始化；当未配置 `SENTRY_DSN` 时 SDK 不会被引入，且所有初始化失败路径均被吞掉，确保可观测性组件永远不会导致服务启动失败。

前端（`src/`）未发现专用日志模块，主要依赖浏览器原生 `console.*`，本仓库的日志体系聚焦于 Node.js 后端。

## 2. 核心文件

- `api/lib/logger.ts` — 日志门面：定义 `debug/info/warn/error` 四个级别、JSON 序列化、按 `LOG_LEVEL` 过滤、请求 ID 生成器 `createRequestId()`
- `api/lib/observability.ts` — Sentry 初始化入口 `initObservability()`，根据 `env.sentryDsn` 决定是否加载并注入 `environment`
- `api/boot.ts` — 应用启动入口：注册全局 `uncaughtException` / `unhandledRejection` 处理器、优雅关闭钩子、健康检查端点，并在启动成功时输出 `Server started` 日志
- `api/context.ts` — tRPC 上下文工厂，通过 `createRequestId()` 为每个请求生成唯一 `requestId` 并注入到 `TrpcContext`，供下游 handler 复用

## 3. 架构与约定

### 日志格式
每条日志均为单行 JSON，固定字段包括：
- `ts`: ISO 8601 时间戳（`new Date().toISOString()`）
- `level`: `"debug" | "info" | "warn" | "error"`
- `msg`: 人类可读的消息字符串
- `...data`: 调用方传入的任意键值对（如 `{ error, runId, batchId }` 等）

### 级别控制
通过环境变量 `LOG_LEVEL` 控制最低输出级别，默认 `"info"`。内部维护 `LEVELS` 映射表，低于当前级别的日志会被静默丢弃。

### 请求追踪
- HTTP 层中间件从 `x-request-id` 请求头读取或生成 UUID，并通过响应头回显
- tRPC 层通过 `createRequestId()` 生成形如 `req_<timestamp>_<counter>` 的请求 ID，注入到 tRPC context
- 业务代码通过 `logger.info("...", { requestId })` 将两者关联（实际使用中多数日志未显式携带 requestId，但基础设施已预留该能力）

### 错误上报策略
- Sentry 仅在 `SENTRY_DSN` 配置时启用，`isProduction` 决定 environment 标签
- 初始化失败仅记录 `logger.warn("Observability init failed — continuing without Sentry")`，不抛异常
- 进程级 `uncaughtException` / `unhandledRejection` 统一通过 `logger.error` 输出堆栈和原因

### 优雅关闭
`SIGTERM` / `SIGINT` 触发后，先停止 Swarm Worker、关闭队列/Redis，超时 30 秒强制退出，全程通过 `logger` 记录关键阶段。

## 4. 约定与约束

- **禁止直接使用 `console.log` 输出业务日志**：所有业务日志必须经过 `api/lib/logger.ts` 暴露的 `logger.debug/info/warn/error`，以保证结构化 JSON 格式与级别过滤生效（全仓库各模块统一通过 `import { logger } from "./lib/logger"` 接入）
- **日志级别语义**：`debug` 用于调试/诊断细节（如 reconciler 重入队），`info` 用于关键业务流程事件（如 DB-HEAL、RECONCILER、Server started），`warn` 用于降级/非致命异常（如 Sentry 初始化失败），`error` 用于故障与不可恢复错误（如 uncaught exception、DB-HEAL 失败）
- **数据字段命名**：附加数据使用小驼峰字段名（`error`, `runId`, `batchId`, `found`, `enqueued` 等），便于外部日志聚合工具解析
- **可观测性隔离**：Sentry 初始化位于独立模块并以 try/catch 包裹，确保任何第三方 SDK 故障不会污染主流程；未配置 DSN 时整个模块等价于空操作
- **生产/开发区分**：Sentry 的 `environment` 由 `env.isProduction` 决定；其他日志行为不随环境切换，仅受 `LOG_LEVEL` 控制
- **进程生命周期日志**：启动、健康检查、优雅关闭、Worker 启停等关键节点均有对应日志，配合 `/api/health` 与 `/api/ready` 端点构成完整的运行时可观测性基线