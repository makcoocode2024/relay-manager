# Codex CLI 多套配置管理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Codex CLI 配置页接入多套预设管理（新建/切换/重命名/删除/导出/导入），对称复用已验证的 Claude Code 实现，采用保守策略。

**Architecture:** 后端管理函数（`*CodexConfig`）已存在，4 个路由（list/create/apply/update）已接入；本计划补 3 个路由（delete/rename/export），并在 `#panel-codex-cli` 加「当前配置」工具条与 7 个配套 JS 函数。保守策略：仅下拉切换触发 `applyCodexConfig` 覆写 `~/.codex/config.toml`，新建/导入不写盘。

**Tech Stack:** Node.js 原生 http（server.js）、原生 DOM/fetch（index.html）。

## Global Constraints

- 回复与代码注释一律使用简体中文。
- 不引入新依赖；叠加式改动，不动 `saveCodexCli` 之外的现有逻辑。
- `applyCodexConfig` 是唯一允许覆写 `~/.codex/config.toml` 的入口。
- 新建/导入只创建预设，绝不自动 apply（与 Claude Code 版本的关键差异）。
- 改动须保持配置可回滚（沿用既有 history/backup 机制）。
- 敏感文件修改前必须时间戳备份（server.js / index.html 已在敏感清单内）。

---

## Task 1: 后端补 3 个 HTTP 路由

**Files:**
- Modify: `server.js:2395`（在 update 路由后、Feature #2 前插入）

**Interfaces:**
- Consumes: `deleteCodexConfig(id)`、`renameCodexConfig(id, name)`、`exportCodexConfig(id, stripKey)`、`listCodexConfigs()`（均已存在于 server.js）
- Produces: HTTP 路由 `/api/codex-cli/config/{delete,rename,export}`

- [ ] **Step 1: 在 update 路由后插入 delete/rename/export 三个路由**

对称复制 Claude Code 第 2339–2366 行，改路径为 `codex-cli`、改调用为 `*CodexConfig` 函数、导出文件名前缀改 `codex-cli-`。

- [ ] **Step 2: 手动验证（curl）**

```bash
curl -s http://127.0.0.1:PORT/api/codex-cli/config/list
curl -s -X POST http://127.0.0.1:PORT/api/codex-cli/config/rename -d '{"id":"<id>","name":"test"}'
curl -s -X POST http://127.0.0.1:PORT/api/codex-cli/config/delete -d '{"id":"<id>"}'
curl -sI 'http://127.0.0.1:PORT/api/codex-cli/config/export?id=<id>'
```
预期：list 返回 JSON；rename/delete 返回 `{success:true,...}`；export 返回 `Content-Disposition: attachment`。

- [ ] **Step 3: 提交**

---

## Task 2: 前端 UI 工具条

**Files:**
- Modify: `index.html:545`（Codex CLI 配置 `<p>` 后插入）

- [ ] **Step 1: 插入「当前配置」工具条**

对称 Claude Code 第 369–378 行，id 前缀 `cc-` → `cx-`，函数名 `*CC*` → `*CX*`，路径文案改 `~/.codex/config.toml`。

- [ ] **Step 2: 手动验证** — 刷新页面，Codex CLI 页出现下拉 + 5 个按钮。

- [ ] **Step 3: 提交**

---

## Task 3: 前端 7 个 JS 函数 + 接线

**Files:**
- Modify: `index.html`（JS 区，紧邻现有 Codex 函数）

**Interfaces:**
- Consumes: `api()`、`getVal()`、`toast()`、`collectCXConfig()`（若无则用现有字段收集逻辑）、`loadState()`
- Produces: `loadCXConfigs/switchCXConfig/newCXConfig/renameCXConfigUI/deleteCXConfigUI/exportCXConfigUI/importCXConfigUI`、模块级 `cxConfigList`

- [ ] **Step 1: 新增 7 个函数**（newCXConfig/importCXConfigUI 去掉自动 apply，保守策略）
- [ ] **Step 2: `loadState` Codex 区调用 `loadCXConfigs()`**
- [ ] **Step 3: `saveCodexCli()` 末尾同步进生效中预设**
- [ ] **Step 4: 手动验证** — 新建不写盘、下拉切换才写盘、导出下载、导入只创建。
- [ ] **Step 5: 提交**
