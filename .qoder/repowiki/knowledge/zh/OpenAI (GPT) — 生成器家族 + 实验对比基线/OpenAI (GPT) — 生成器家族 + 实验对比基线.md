---
kind: external_dependency
name: OpenAI (GPT) — 生成器家族 + 实验对比基线
slug: openai
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### 角色与集成点
- 作为实验的 **Western 生成器家族**（gpt-5.6-sol / gpt-5.6-luna），通过 DeeWaanAI 平台的 BYOK Provider 机制接入：在 Settings → Providers 添加 OpenAI，base URL 使用默认值。
- 密钥以环境变量形式注入（`OPENAI_API_KEY`），由平台 `llm_providers` 表 AES-256-GCM 加密存储；pipeline 执行时按 step 绑定 provider id 调用官方端点。

### 稳定用法要点
- 生产部署需确保 `AI_SWARM_MASTER_KEY`、`APP_SECRET`、`MARKETPLACE_MASTER_KEY` 已设置（否则应用拒绝启动或旧密钥无法解密）。
- 若需要批量/并发调优，通过 Railway 环境变量 `SWARM_WORKER_CONCURRENCY` 控制 BullMQ worker 并发度（默认 2）。
- 验证 API 连通性后，模型版本需在 `model_registry.json` 中 pin 并记录价格快照。