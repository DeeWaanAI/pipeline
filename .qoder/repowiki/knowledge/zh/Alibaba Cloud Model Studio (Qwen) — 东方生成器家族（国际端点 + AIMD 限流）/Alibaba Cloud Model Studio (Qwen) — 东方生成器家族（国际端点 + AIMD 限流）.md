---
kind: external_dependency
name: Alibaba Cloud Model Studio (Qwen) — 东方生成器家族（国际端点 + AIMD 限流）
slug: alibaba-qwen
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
    - client_constraint
scope:
    - '**'
---

### 角色与集成点
- 作为 Eastern 生成器家族（qwen3.7-max / qwen3.7-plus），通过 DeeWaanAI 平台 Provider 接入；base URL 必须覆盖为国际端点 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`。
- 项目自建 AIMD 限流器（`providerThrottle.ts`，initRpm=30, floorRpm=6, ceilingRpm=2000），当收到 429/rate-limit 信号时会减半并发直至地板 6 RPM，再缓慢爬升。

### 稳定用法要点
- 当前调用方式为实时端点（非 Batch API），因此受 RPM/TPM 限制；"Batch API 无限流"不适用于本项目的调用方式。
- 429 错误被误判为 "credit exhausted" 会暂停整个批次（`CREDIT_ERROR_PATTERNS` 匹配 `/429.*rate.*limit/i`），需修复为走 throttle backoff 路径。
- 高并发下 Aliyun 是主要瓶颈（~20 concurrent 即触发 rate-limit），且 kimi/qwen 的 reasoning 深度会显著放大 token 消耗。