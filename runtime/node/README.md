# 便携 Node.js 运行时

此目录用于放置 RelayManager 的便携 Node.js 运行时。

目标：

* 新电脑不需要单独安装 Node.js。
* 新电脑不需要执行 `npm install`。
* 用户解压或复制项目后，双击 `启动.bat` 即可运行。

目录结构必须类似：

```text
runtime/
  node/
    node.exe
    npm.cmd
    npx.cmd
    node_modules/
    ...
```

当前 Windows 启动脚本会优先执行：

```bat
runtime\node\node.exe server.js
```

源码仓库默认忽略 `runtime/node/` 下的大体积二进制文件，只保留此说明文件。发布到新电脑前，需要把官方 Windows x64 版 Node.js 压缩包解压到本目录。
