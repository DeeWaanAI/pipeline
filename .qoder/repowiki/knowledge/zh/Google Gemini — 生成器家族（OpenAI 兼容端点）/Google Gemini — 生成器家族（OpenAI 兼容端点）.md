---
kind: external_dependency
name: Google Gemini — 生成器家族（OpenAI 兼容端点）
slug: google-gemini
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### 角色与集成点
- 作为 Western 生成器家族（gemini-3.1-pro-preview / gemini-3.1-flash-lite），通过 Google 的 OpenAI 兼容端点接入：base URL 必须设为 `https://generativelanguage.googleapis.com/v1beta/openai`。
- 平台新增 "Google Gemini" preset 自动填入该 base URL；旧版静态模型列表已过时，需依赖 live fetch。

### 稳定用法要点
- 添加 Provider 时需选择预设或使用 Custom + 上述 base URL；仅粘贴 key 不会生效。
- 模型枚举返回的是 3.1 系列（pro-preview、flash-lite），而非旧的 2.x 列表。
- 推理参数为 `thinkingConfig.thinkingBudget`（0 = off），实验需与其他家族统一控制 reasoning depth。