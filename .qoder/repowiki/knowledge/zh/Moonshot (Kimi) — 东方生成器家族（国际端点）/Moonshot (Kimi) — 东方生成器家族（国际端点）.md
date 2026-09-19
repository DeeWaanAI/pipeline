---
kind: external_dependency
name: Moonshot (Kimi) — 东方生成器家族（国际端点）
slug: moonshot-kimi
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
    - client_constraint
scope:
    - '**'
---

### 角色与集成点
- 作为 Eastern 生成器家族（kimi-k3 / kimi-k2.6），通过 DeeWaanAI 平台 Provider 接入；base URL 必须覆盖为国际端点 `https://api.moonshot.ai/v1`（非默认的 `api.moonshot.cn`）。
- 实验期间 Kimi 路由曾从 Moonshot 直连迁移到 Together.ai（因 Moonshot 余额不足），迁移需保持模型身份一致（`moonshotai/Kimi-K3`）。

### 稳定用法要点
- Kimi 默认 `reasoning_effort: "max"`，会在简单任务上燃烧大量 reasoning tokens（hello 测试中输出 6,708 tokens vs GPT ~1,200），实验需显式关闭或统一控制。
- Together.ai 可作为备份路由（托管相同模型 ID），但切换需记录为协议偏差（定价/服务栈不同）。
- 批处理失败常表现为 "Account balance insufficient"，需区分 Moonshot 账户与 Together 账户。