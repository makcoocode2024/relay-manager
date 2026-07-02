// 便携发布包静态检查。
// 只检查本项目开箱即用所需文件是否存在，不读取任何密钥配置。

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checks = [
  {
    name: '便携 Node 可执行文件',
    path: path.join(root, 'runtime', 'node', 'node.exe'),
  },
  {
    name: '项目依赖 @iarna/toml',
    path: path.join(root, 'node_modules', '@iarna', 'toml', 'package.json'),
  },
  {
    name: '后端入口 server.js',
    path: path.join(root, 'server.js'),
  },
  {
    name: '前端页面 index.html',
    path: path.join(root, 'index.html'),
  },
  {
    name: 'Windows 启动脚本',
    path: path.join(root, '启动.bat'),
  },
  {
    name: 'Windows 停止脚本',
    path: path.join(root, '停止.bat'),
  },
];

let failed = 0;

for (const item of checks) {
  if (fs.existsSync(item.path)) {
    console.log('PASS: ' + item.name);
  } else {
    failed++;
    console.log('FAIL: ' + item.name + ' 缺失: ' + path.relative(root, item.path));
  }
}

const startBat = fs.readFileSync(path.join(root, '启动.bat'), 'utf8');
if (/runtime\\node\\node\.exe/i.test(startBat) && /"%NODE_EXE%"\s+server\.js/i.test(startBat)) {
  console.log('PASS: 启动脚本使用便携 Node 启动 server.js');
} else {
  failed++;
  console.log('FAIL: 启动脚本未正确使用便携 Node');
}

console.log('');
if (failed) {
  console.log('便携检查未通过，请补齐缺失文件后重试。');
  process.exit(1);
}

console.log('便携检查通过：可复制到新电脑后双击 启动.bat。');
