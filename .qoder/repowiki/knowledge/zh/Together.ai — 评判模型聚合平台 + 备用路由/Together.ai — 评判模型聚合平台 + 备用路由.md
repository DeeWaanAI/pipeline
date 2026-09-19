---
kind: external_dependency
name: Together.ai — 评判模型聚合平台 + 备用路由
slug: together-ai
category: external_dependency
category_hints:
    - vendor_identity
    - sdk_real_api
scope:
    - '**'
---

### 角色与集成点
- 作为 **评判面板** 的统一平台：三个 judge 模型（mistralai/Mistral-Small-24B-Instruct-2501、zai-org/GLM-4.7、meta-llama/Llama-3.3-70B-Instruct-Turbo）均通过 Together 调用，与生成器家族保持 disjoint 以避免自偏好偏差。
- 也可作为 Eastern 模型的备份路由（托管 open-weight 版本的 Qwen、DeepSeek、Kimi），但切换需记录为协议偏差。
- 密钥通过 `TOGETHER_AI_API_KEY` 或 `TOGETHER_API_KEY` 环境变量注入，本地 `.env` 读取。

### 稳定用法要点
- Together 拒绝 Python 默认 user-agent（403），调用脚本需自定义 UA header。
- 模型目录约 270 个，价格字段来自 `/v1/models` 响应，冻结入 `price_vector.json`。
- 评判阶段在本地运行（不经过 DeeWaanAI 平台），以保持评估成本与生成成本分离。