# RelayManager

中转站统一配置工具 —— 给 Claude Code CLI、Claude Desktop (3P)、Codex CLI、Codex Desktop 统一设置第三方中转站的 Base URL、API Key、模型映射，并控制 Clash Verge 代理启停。内置中转网关，完全脱离 CC Switch。

## 功能

- **一键同步**：同一个 Base URL + API Key 应用到所有产品
- **四个产品配置**：Claude Code / Claude Desktop / Codex CLI / Codex Desktop 各自的详细配置
- **模型映射**：可视化编辑各产品的模型名映射
- **中转网关**：内置本地网关（端口 9877），把 Anthropic 模型名（如 `claude-sonnet-4-5`）改写成后端模型（如 `glm-5.2`）再转发给真实中转站。让 Claude Desktop 能用没有 Claude 模型的中转站，无需 CC Switch
- **代理控制**：启动/停止/重启 Clash Verge
- **重启客户端**：一键重启 Claude Desktop / Codex Desktop / Clash Verge
- **开机自启**：通过启动文件夹 VBS 静默启动
- **获取模型列表**：从中转站拉取可用模型，方便挑选
- **安全**：修改任何配置前自动时间戳备份，原子写入

## 快速开始

### 环境要求

- Windows（中文版兼容）
- [Node.js](https://nodejs.org/) v18+（推荐 v20+）

### 安装

```bash
git clone <repo-url>
cd relay-manager
npm install
```

### 运行

双击 `启动.bat`，或：

```bash
node server.js
```

浏览器打开 http://localhost:9876

停止：双击 `停止.bat`，或关闭启动时的命令行窗口。

## 工作原理

```
Claude Desktop ──┐
                 ├──► RelayManager 网页 (localhost:9876) ──► 读写各客户端配置文件
Codex Desktop ───┘
                                                      
Claude Desktop ──► 本地中转网关 (localhost:9877) ──► 真实中转站
                  （改写模型名 claude-sonnet-4-5 → glm-5.2）
```

### 中转网关

Claude Desktop 3P 的 gateway 模式要求 `inferenceModels` 必须是 Anthropic 模型名（如 `claude-sonnet-4-5`），但很多中转站只有 glm/deepseek 等非 Claude 模型。中转网关在本地接收 Claude Desktop 的请求，把模型名改写成中转站支持的后端模型，再转发：

1. 在「中转网关」标签页填入真实中转站 URL + Key
2. 配置模型映射（如 `claude-sonnet-4-5` → `glm-5.2`）
3. 点「应用到 Claude Desktop」
4. 重启 Claude Desktop

网关随 RelayManager 启动，需保持运行。可开启「开机自启」。

## 管理的配置文件

| 产品 | 文件 |
|------|------|
| Claude Code | `~/.claude/settings.json` |
| Claude Desktop 3P | `AppData/Local/Claude-3p/configLibrary/<id>.json` |
| Codex CLI | `~/.codex/config.toml` |
| Codex Desktop | `AppData/Roaming/ccx-desktop/.config/config.json` + `agent-config-state/codex.json` |
| 代理 | `~/.codex/.env` |

所有路径基于用户目录，自动适配不同用户名。

## 项目结构

```
relay-manager/
├── server.js        # 后端（Node http 模块，端口 9876 + 网关 9877）
├── index.html       # 前端（单页，纯 HTML/CSS/JS）
├── package.json
├── 启动.bat          # 双击启动（Windows）
├── 停止.bat          # 双击停止
├── .gitignore
└── README.md
```

`gateway.json`、`paths.json` 在运行时生成，含本地配置/密钥，已在 `.gitignore` 中排除。

## 技术栈

- Node.js + 内置 `http` 模块（无 Express）
- `@iarna/toml`（唯一依赖，解析 Codex 的 TOML）
- 纯 HTML/CSS/JS 前端（无框架、无构建）

## 许可

MIT
