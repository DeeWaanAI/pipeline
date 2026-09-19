---
kind: external_dependency
name: DeepSeek — 评判模型 + 回退家族
slug: deepseek
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### 角色与集成点
- 同时作为实验的 **fallback family**（deepseek-v4-pro / -flash），当其他家族不可用时启用。
- 定价策略包含峰值加价（UTC+8 9:00–12:00 和 14:00–18:00 为 2×），需避开执行窗口。

### 稳定用法要点
- 峰值加价尚未生效（"effective date TBA"），当前为 flat pricing；但执行窗口仍应避开未来可能生效的峰值时段。
- 密钥无效时返回 401，需从 platform.deepseek.com 重新复制完整 key。
- 评判面板替换 Mistral-Small 为 deepseek-chat 时，需确保评分格式一致（1–5 分）。