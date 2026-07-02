# RelayManager

## 发布版本说明（双版本）

当前提供两个 Windows 发布包：

* `RelayManager-Portable.zip`：便携版，内置 `runtime/node/`，目标电脑不需要安装 Node.js，也不需要执行 `npm install`。解压后双击 `启动.bat`。
* `RelayManager-SystemNode.zip`：系统 Node 版，不内置 `runtime/node/`，目标电脑必须已经安装 Node.js，并且 `node`、`npm` 在 PATH 中可用。解压后双击 `启动-系统Node.bat`。

生成两个版本：

```bat
打包便携版.bat
打包系统Node版.bat
```

也可以使用命令：

```bash
npm run portable:build
npm run system:build
```

两个发布包都会排除 `backups/`、日志、`.env`、`.env.local`、`gateway.json`、`paths.json`、各类本地预设配置、临时文件和 `.git/`，避免把本机密钥或本地状态打进发布包。

## 新电脑开箱即用（便携版）

便携版目标：新电脑不安装 Node.js、不执行 `npm install`，复制整个项目目录后直接双击 `启动.bat`。

必须随项目一起携带：

* `runtime/node/node.exe`：便携 Node.js 运行时。
* `node_modules/@iarna/toml/`：项目唯一 npm 依赖。
* `server.js`、`index.html`、`启动.bat`、`停止.bat`。

发布前在旧电脑执行静态检查：

```bash
npm run portable:check
```

生成便携发布包：

```bat
打包便携版.bat
```

脚本会先执行 `portable:check`，再输出 `RelayManager-Portable.zip`。压缩包只包含运行必需文件和便携运行时，并排除 `backups/`、`*.log`、`gateway.json`、`paths.json`、各类本地配置预设、`.env`、`.env.local`、临时文件和 `.git/`。

新电脑使用流程：

1. 将 `RelayManager-Portable.zip` 复制到新电脑并解压。
2. 双击 `启动.bat`。
3. 浏览器访问 `http://localhost:9876`。
4. 按页面流程填写 Base URL 和 API Key，占位示例：`https://api.example.com/v1`、`<API_KEY>`。
5. 解析中转参数，建立模型映射，写入客户端实际读取的配置。
6. 重启或重载客户端。
7. 校验配置生效。

如果启动脚本提示 `Portable Node runtime not found`，说明 `runtime/node/node.exe` 未随项目复制。

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
git clone https://github.com/makcoocode2024/relay-manager.git
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
