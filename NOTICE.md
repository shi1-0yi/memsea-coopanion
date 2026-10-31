# 第三方代码与改动说明

本仓库由 **Shi1-0Yi**（[@shi1-0yi](https://github.com/shi1-0yi)）编写与维护。以下内容属于他人，按许可随附。

## memory-sea（上游，作者 asdfd3）

- 作者：asdfd3
- 来源：https://github.com/asdfd3/3d-memory-sea
- 许可：MIT（全文见 `memory-sea-LICENSE.txt`）
- 本仓库包含的上游文件：
  - `src/mind-sea.js`（点 / 边 / 簇 / 场景）
  - `src/memory-store.js`（相似度与状态机）
  - `public/index.html`（三维渲染器）

### 改动

上游代码只改了两处，都为了本项目的需要：

1. **`src/mind-sea.js`** — `pointFromLongTerm()` 与 `pointFromMessage()` 原本会丢掉调用方传入的 `id`，改用"文本 + 时间"重新哈希。遗忘层是按 id 挂重要度的，id 一变就全挂错，所以补上了 `id: entry.id / msg.id` 的透传（两行）。
2. **`public/index.html`** — 点的透明度原本只按远近算。为了让"遗忘"看得见，补了一层按权重的透明度（三行）。

### 未包含的上游文件

`src/memory-retrieve.js`（检索打分）、`src/scene-service.mjs`（胶水层）、`tests/`、`data/demo.json` 未包含：本项目用自己的 `sea.mjs` 组装场景，也不需要上游的演示数据。

## Coopanion / Cortico

本项目**不包含**任何 Coopanion 或 Cortico 的代码。

- `src/` 只读 Coopanion 部署目录里的数据文件（JSON / JSONL / Markdown）。
- `extension/` 是一个独立的 Cortico World 包，按公开的 World 契约（`id` / `label` / `defaults` / `create` / `tools()`）实现，不 import 宿主的内部模块。

Coopanion 自身以其 AGPL-3.0-or-later 许可发布，与本仓库无代码衍生关系。

## 关于隐私

本仓库不含任何真实对话、账号或群名。`groups.example.json` 里的群名是占位符；`README.md` 里的账号示例是虚构的。

生成出来的 `memory-sea.html` 内嵌真实记忆，已在 `.gitignore` 里排除——**不要提交它**。
