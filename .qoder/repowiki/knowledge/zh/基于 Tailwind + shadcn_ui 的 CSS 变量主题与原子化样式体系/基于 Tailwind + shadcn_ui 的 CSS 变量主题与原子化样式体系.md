---
kind: frontend_style
name: 基于 Tailwind + shadcn/ui 的 CSS 变量主题与原子化样式体系
category: frontend_style
scope:
    - '**'
source_files:
    - tailwind.config.js
    - src/index.css
    - components.json
    - postcss.config.js
    - src/components/ui/button.tsx
    - site/tailwind.config.mjs
    - site/src/styles/global.css
---

## 1. 采用的样式系统

仓库包含两个独立的前端产物，分别采用不同的风格策略：

- **主应用（React + Vite）**：以 **Tailwind CSS** 为原子化样式框架，通过 **shadcn/ui**（`components.json` 中 `style: "new-york"`）提供可复制粘贴的 Radix UI 组件基元；使用 **CSS 自定义属性（CSS Variables）** 作为设计令牌（design tokens），并通过 `tailwind.config.js` 将 `hsl(var(--xxx))` 映射到语义化颜色名（`primary`、`secondary`、`destructive`、`muted`、`accent`、`card`、`sidebar` 等）。暗色模式通过 `.dark` 类切换同一组 CSS 变量实现。
- **营销/文档站（Astro）**：同样使用 Tailwind，但自定一套深色品牌色系——`ink` 系列（`#0a0a0b` ~ `#2e2e34`）和单强调色 `accent: #22d3ee`（含 `soft`、`dim` 变体），并在 `global.css` 中以 `@layer components` 定义站点级复用 class（`.container-page`、`.btn-accent`、`.btn-ghost`、`.card`、`.mono-chip`、`.prose-docs` 等）。

构建管线：主应用通过 `postcss.config.js` 启用 `tailwindcss` + `autoprefixer`；Astro 站点通过 `site/tailwind.config.mjs` 单独配置。两者均无 Sass/Less，纯 CSS + Tailwind。

## 2. 关键文件

- `tailwind.config.js`：主应用 Tailwind 配置，声明 `darkMode: ["class"]`、扩展色板、圆角、阴影、动画 keyframes（`accordion-down/up`、`caret-blink`）及 `tailwindcss-animate` 插件。
- `src/index.css`：全局 CSS 入口，定义 `:root` 与 `.dark` 两套 HSL 变量（背景、前景、边框、输入、ring、radius、sidebar 等），并应用 `border-border`、`bg-background`、`text-foreground` 基础样式。
- `components.json`：shadcn/ui 配置，指向 `src/index.css`、`baseColor: "slate"`、`cssVariables: true`、`iconLibrary: "lucide"`，别名 `@/components/ui` → `@/components/ui`。
- `src/components/ui/*.tsx`：shadcn 生成的原子组件（button、badge、card、dialog、dropdown-menu、input、label、scroll-area、select、separator、sheet、slider、sonner、textarea），全部基于 `class-variance-authority`（cva）+ `@radix-ui/react-slot` 实现变体与尺寸。
- `site/tailwind.config.mjs` & `site/src/styles/global.css`：Astro 站点的 Tailwind 配置与站点级组件层样式。
- `postcss.config.js`：PostCSS 插件链（tailwindcss + autoprefixer）。

## 3. 架构与约定

- **设计令牌集中化**：所有颜色、圆角、阴影、动画都通过 CSS 变量在 `src/index.css` 的 `@layer base` 中声明，Tailwind 仅做引用，避免硬编码色值。
- **暗色模式按类切换**：`darkMode: ["class"]` + `.dark` 选择器覆盖变量，由运行时决定（非媒体查询）。
- **组件样式分层**：业务页面直接写 Tailwind 原子类；通用交互行为封装进 `src/components/ui` 下的 shadcn 组件，再通过 `data-*` 属性（如 `data-slot="button"`、`data-variant`、`data-size`）暴露状态供测试或样式钩子使用。
- **变体系统**：每个 UI 组件用 `cva` 声明 `variant`（default/destructive/outline/secondary/ghost/link）与 `size`（default/sm/lg/icon/icon-sm/icon-lg），统一视觉输出。
- **Astro 站点独立主题**：不共享主应用的 CSS 变量，而是自建 `ink` + `accent` 色系，并通过 `@layer components` 定义站点专用 class，保持营销站与产品应用视觉解耦。
- **图标库**：统一使用 Lucide（`iconLibrary: "lucide"`），Radix 负责无障碍与键盘交互。

## 4. 约定与约束

- 新增颜色必须通过 CSS 变量在 `src/index.css` 的 `:root` / `.dark` 中声明，再在 `tailwind.config.js` 的 `theme.extend.colors` 中映射，禁止在组件中硬编码十六进制色值。
- 暗色模式必须通过 `.dark` 类覆盖同名 CSS 变量实现，不得引入新的颜色命名空间。
- 所有可复用 UI 元素应放在 `src/components/ui` 下并以 shadcn/cva 形式管理变体，页面组件只组合这些原子组件。
- Astro 站点的样式集中在 `site/src/styles/global.css` 的 `@layer components` 中，新增站点级 class 需遵循已有命名约定（`.btn-*`、`.card`、`.mono-chip`、`.prose-docs-*`）。
- 动画统一通过 Tailwind 的 `keyframes` + `animation` 扩展注册（如 `accordion-down`、`caret-blink`），并由 `tailwindcss-animate` 插件驱动。
- PostCSS 仅启用 `tailwindcss` 与 `autoprefixer`，不引入其他预处理步骤，保证构建链路简洁。