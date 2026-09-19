---
kind: external_dependency
name: Anthropic (Claude) — 生成器家族 + 批处理计费账户
slug: anthropic
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### 角色与集成点
- 作为 Western 生成器家族（claude-opus-5 / claude-haiku-4-5），通过 DeeWaanAI 平台 Provider 接入；密钥经平台加密存储。
- 实验主运行期间 Anthropic 账户余额会耗尽（约 ~93 次调用），需充值后恢复；kimi 走 Together.ai 而 claude 直连 Anthropic，两者计费账户独立。

### 稳定用法要点
- Claude 的 extended thinking 参数为 `thinking.budget_tokens`，实验要求统一关闭/最小化 reasoning 以避免跨家族不可比。
- 批处理失败常见原因为 workspace spending limit 而非账户余额不足，需检查 Anthropic console → Workspaces → Spending limits。
- 生产环境需确认 `AI_SWARM_MASTER_KEY` 已正确设置，否则新密钥会被用开发 fallback 加密。