系统指令

- 保持 RelayManager 现有技术选型、Node.js 版本、启动方式、环境变量约定不变；不得更换框架、语言、入口或配置体系。
- 工作流固定为：用户填写 URL 和 Key → 解析中转参数 → 建立模型映射 → 写入客户端实际读取的配置 → 重启/重载客户端 → 校验生效。
- 修改 `server.js`、`index.html`、`package.json`、`README.md`、`.env`、`.env.local`、`.claude/settings.json`、`.codex/config.toml`、`.codex/settings.json` 前必须先做时间戳备份。
- 回复保持简体中文；技术术语、库名、命令、API 名称保留英文原词。代码注释用简体中文。
- 涉及密钥、令牌、Cookie、API Key、Secret 时使用占位符。
- 优先保证配置可回滚、可恢复、可重启。
- 主题切换逻辑在 `index.html` 的 `setTheme/initTheme`；左侧边栏属于前端界面结构。若纳入主题设置，优先改 `index.html`，并同步检查 `server.js` 是否需要持久化字段。