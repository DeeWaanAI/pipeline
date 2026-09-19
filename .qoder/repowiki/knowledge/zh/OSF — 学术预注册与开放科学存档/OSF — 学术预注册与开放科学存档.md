---
kind: external_dependency
name: OSF — 学术预注册与开放科学存档
slug: osf
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### 角色与集成点
- 用于存放研究预注册文档（pre-registration protocol + A1/A2 amendments），通过 OSF API 完成注册与版本管理。
- 令牌存储在 `research/orchestration-economics/.env`（纯文本，非 RTF），需勾选 `osf.full_read` 和 `osf.full_write` 权限。
- 账号需先验证邮箱才能发布注册；公开 API 可查询是否存在公共注册。

### 稳定用法要点
- 本项目实际从未通过 API 完成过 OSF 注册（之前声称的 A1/A2 注册未验证），论文中的 "pre-registered" 主张目前仅依赖仓库时间戳记录。
- 如需正式注册，需创建 OSF 账号 → 生成 token → 保存为纯文本 `.env` → 后续可由脚本驱动注册流程。