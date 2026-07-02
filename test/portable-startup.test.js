// 便携启动链路静态测试。
// 目标：新电脑不安装 Node.js，也能通过项目内 runtime/node/node.exe 启动。

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

function check(name, ok) {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name);
  ok ? pass++ : fail++;
}

function readText(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

const startBat = readText('启动.bat');
const gitignore = readText('.gitignore');

check('Windows 启动脚本优先引用 runtime\\node\\node.exe', /runtime\\node\\node\.exe/i.test(startBat));
check('Windows 启动脚本使用便携 NODE_EXE 变量启动 server.js', /"%NODE_EXE%"\s+server\.js/i.test(startBat));
check('Windows 启动脚本缺少便携 Node 时给出明确提示', /Portable Node runtime not found/i.test(startBat));
check('Windows 启动脚本不再直接调用系统 node server.js', !/^\s*node\s+server\.js\s*$/mi.test(startBat));
check('runtime/node 被 gitignore 排除，避免提交大体积运行时', /runtime\/node\//.test(gitignore));
check('runtime/node 说明文件允许提交', /!runtime\/node\/README\.md/.test(gitignore));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
