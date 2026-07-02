#!/usr/bin/env node
/**
 * RelayManager 配置同步诊断和修复工具
 *
 * 问题：修改配置并保存后，客户端的配置并没有改变
 * 原因：预设配置与实际配置文件不同步
 *
 * 本工具会：
 * 1. 检查预设配置与实际配置的差异
 * 2. 提供修复选项
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const HOME = require('os').homedir();

// 配置文件路径
const PATHS = {
  claudeCode: path.join(HOME, '.claude', 'settings.json'),
  claudeCodePresets: path.join(__dirname, 'cc-configs.json'),
  codexCli: path.join(HOME, '.codex', 'config.toml'),
  codexCliPresets: path.join(__dirname, 'codex-cli-configs.json'),
};

console.log('='.repeat(70));
console.log('RelayManager 配置同步诊断工具');
console.log('='.repeat(70));

// 读取 JSON 文件
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

// 检查 Claude Code 配置
function checkClaudeCode() {
  console.log('\n【Claude Code 配置检查】');

  const actualConfig = readJSON(PATHS.claudeCode);
  const presets = readJSON(PATHS.claudeCodePresets);

  if (!actualConfig) {
    console.log('❌ 无法读取实际配置文件:', PATHS.claudeCode);
    return;
  }

  if (!presets) {
    console.log('⚠️  没有预设配置文件');
    return;
  }

  const appliedPreset = presets.entries.find(e => e.id === presets.appliedId);

  console.log('\n当前实际配置 (settings.json):');
  console.log('  Base URL:', actualConfig.env?.ANTHROPIC_BASE_URL || '(未设置)');
  console.log('  API Key:', maskKey(actualConfig.env?.ANTHROPIC_AUTH_TOKEN || ''));
  console.log('  Model:', actualConfig.env?.ANTHROPIC_MODEL || actualConfig.model || '(未设置)');

  if (appliedPreset) {
    console.log('\n当前应用的预设:');
    console.log('  名称:', appliedPreset.name);
    console.log('  Base URL:', appliedPreset.config.baseUrl || '(未设置)');
    console.log('  API Key:', maskKey(appliedPreset.config.authToken || ''));
    console.log('  Model:', appliedPreset.config.model || '(未设置)');

    // 检查是否一致
    const baseUrlMatch = actualConfig.env?.ANTHROPIC_BASE_URL === appliedPreset.config.baseUrl;
    const keyMatch = actualConfig.env?.ANTHROPIC_AUTH_TOKEN === appliedPreset.config.authToken;

    if (baseUrlMatch && keyMatch) {
      console.log('\n✅ 预设配置与实际配置一致');
    } else {
      console.log('\n❌ 预设配置与实际配置不一致！');
      if (!baseUrlMatch) console.log('   - Base URL 不同');
      if (!keyMatch) console.log('   - API Key 不同');
    }
  } else {
    console.log('\n⚠️  没有应用任何预设');
  }

  console.log('\n可用预设列表 (共 ' + presets.entries.length + ' 个):');
  presets.entries.slice(0, 5).forEach((e, i) => {
    const applied = e.id === presets.appliedId ? ' ✓' : '';
    console.log(`  ${i+1}. ${e.name}${applied}`);
    console.log(`     ${e.config.baseUrl || '(无URL)'}`);
  });
  if (presets.entries.length > 5) {
    console.log(`  ... 还有 ${presets.entries.length - 5} 个预设`);
  }
}

// 检查 Codex CLI 配置
function checkCodexCli() {
  console.log('\n【Codex CLI 配置检查】');

  if (!fs.existsSync(PATHS.codexCli)) {
    console.log('⚠️  配置文件不存在:', PATHS.codexCli);
    return;
  }

  const actualConfig = fs.readFileSync(PATHS.codexCli, 'utf-8');
  const presets = readJSON(PATHS.codexCliPresets);

  // 简单解析 TOML（提取 base_url）
  const baseUrlMatch = actualConfig.match(/base_url\s*=\s*["']([^"']+)["']/);
  const actualBaseUrl = baseUrlMatch ? baseUrlMatch[1] : '(未找到)';

  console.log('\n当前实际配置 (config.toml):');
  console.log('  Base URL:', actualBaseUrl);

  if (!presets) {
    console.log('⚠️  没有预设配置文件');
    return;
  }

  const appliedPreset = presets.entries.find(e => e.id === presets.appliedId);

  if (appliedPreset) {
    console.log('\n当前应用的预设:');
    console.log('  名称:', appliedPreset.name);
    console.log('  Base URL:', appliedPreset.config.baseUrl || '(未设置)');

    const match = actualBaseUrl === appliedPreset.config.baseUrl;
    if (match) {
      console.log('\n✅ 预设配置与实际配置一致');
    } else {
      console.log('\n❌ 预设配置与实际配置不一致！');
      console.log('   - Base URL 不同');
    }
  } else {
    console.log('\n⚠️  没有应用任何预设');
  }

  console.log('\n可用预设列表 (共 ' + presets.entries.length + ' 个):');
  presets.entries.slice(0, 5).forEach((e, i) => {
    const applied = e.id === presets.appliedId ? ' ✓' : '';
    console.log(`  ${i+1}. ${e.name}${applied}`);
    console.log(`     ${e.config.baseUrl || '(无URL)'}`);
  });
  if (presets.entries.length > 5) {
    console.log(`  ... 还有 ${presets.entries.length - 5} 个预设`);
  }
}

// 掩码密钥
function maskKey(key) {
  if (!key) return '(未设置)';
  if (key.length <= 12) return key.slice(0, 4) + '***';
  return key.slice(0, 8) + '...' + key.slice(-4);
}

// 提供修复建议
function showFixSuggestions() {
  console.log('\n' + '='.repeat(70));
  console.log('【修复建议】');
  console.log('='.repeat(70));

  console.log('\n如果配置不一致，请按以下步骤操作：');
  console.log('\n方案1：通过 Web 界面操作（推荐）');
  console.log('  1. 打开 http://127.0.0.1:9876');
  console.log('  2. 找到对应产品的标签页（Claude Code / Codex CLI）');
  console.log('  3. 在"当前配置"下拉框中选择你想要的预设');
  console.log('  4. 点击"应用所选到 config.toml" 或切换下拉框会自动应用');
  console.log('  5. 重启客户端生效');

  console.log('\n方案2：通过 API 操作');
  console.log('  # 应用 Claude Code 预设');
  console.log('  curl -X POST http://127.0.0.1:9876/api/claude-code/config/apply \\');
  console.log('       -H "Content-Type: application/json" \\');
  console.log('       -d \'{"id":"<预设ID>"}\'');
  console.log('');
  console.log('  # 应用 Codex CLI 预设');
  console.log('  curl -X POST http://127.0.0.1:9876/api/codex-cli/config/apply \\');
  console.log('       -H "Content-Type: application/json" \\');
  console.log('       -d \'{"id":"<预设ID>"}\'');

  console.log('\n方案3：保存并应用当前编辑的配置');
  console.log('  1. 在 Web 界面编辑配置');
  console.log('  2. 点击"保存"按钮（会自动更新当前预设）');
  console.log('  3. 如果当前预设已应用，配置会立即写入实际文件');
  console.log('  4. 重启客户端生效');

  console.log('\n⚠️  重要提示：');
  console.log('  - "保存"只是更新预设内容，不会立即写入客户端配置');
  console.log('  - 必须确保该预设是"已应用"状态，保存才会同步到客户端');
  console.log('  - 或者保存后手动"应用"该预设');
  console.log('  - 配置更新后，必须重启 Claude Code / Codex CLI 才能生效');
}

// 主函数
function main() {
  checkClaudeCode();
  checkCodexCli();
  showFixSuggestions();

  console.log('\n' + '='.repeat(70));
  console.log('诊断完成！');
  console.log('='.repeat(70));
}

main();
