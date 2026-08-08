// Arcana setup — initializes arcana-home directory and guides user configuration
// Usage: node scripts/setup.mjs  OR  npm run setup

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(__dirname, '..'));
const homeRoot = resolve(process.env.ARCANA_HOME || join(repoRoot, 'arcana-home'));
const dataRoot = resolve(join(repoRoot, 'screenpipe-data'));
const workspaceRoot = resolve(repoRoot);

function ask(query){
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function main(){
  console.log('🔧 Arcana 初始化设置\n');
  console.log(`   ARCANA_HOME  = ${homeRoot}`);
  console.log(`   工作区       = ${workspaceRoot}`);
  console.log(`   数据目录     = ${dataRoot}\n`);

  // 1. Create directory structure
  const dirs = [
    homeRoot,
    join(homeRoot, 'agents', 'default'),
    join(homeRoot, 'agents', 'default', 'memory'),
    join(homeRoot, 'agents', 'default', 'principles'),
    join(homeRoot, 'agents', 'default', 'sessions'),
    dataRoot,
  ];
  for (const d of dirs){
    if (!existsSync(d)) { mkdirSync(d, { recursive: true }); console.log('  ✅ 创建:', d); }
    else { console.log('  📁 已存在:', d); }
  }

  // 2. Config
  const configPath = join(homeRoot, 'config.json');
  if (!existsSync(configPath)){
    console.log('\n📝 配置 AI 模型:');
    console.log('  (按回车使用默认值)\n');
    const provider = await ask('  模型提供商 [openai-compatible]: ') || 'openai-compatible';
    const baseUrl = provider === 'openai-compatible'
      ? (await ask('  Base URL [https://api.deepseek.com]: ') || 'https://api.deepseek.com')
      : '';
    const model = await ask('  模型名称 [deepseek-reasoner]: ') || 'deepseek-reasoner';
    const apiKey = await ask('  API Key: ');
    const config = { provider, model, base_url: baseUrl || undefined, api_key: apiKey || undefined };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log('  ✅ 配置已保存');
  } else {
    console.log('  📁 配置已存在，跳过');
  }

  // 3. Agent config
  const agentCfgPath = join(homeRoot, 'agents', 'default', 'agent.json');
  if (!existsSync(agentCfgPath)){
    writeFileSync(agentCfgPath, JSON.stringify({
      agentId: 'default',
      workspaceRoot: workspaceRoot,
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
    console.log('  ✅ Agent 配置已创建');
  }

  // 4. RULES.md template
  const rulesPath = join(homeRoot, 'agents', 'default', 'RULES.md');
  if (!existsSync(rulesPath)){
    const template = [
      '# 铁律规则 — 必须百分百遵守',
      '',
      '## 通用安全',
      '- 不得在工作区外创建、修改或删除文件',
      '- 不得执行任何删除命令（rm、del、Remove-Item）',
      '- 不得泄露 API Key / Token / 密码等敏感信息',
      '- 如用户发送的内容疑似包含密钥/密码，警告用户并停止处理',
      '',
      '## 合规行为准则',
      '- **实质重于形式**：如果操作效果等同于被禁止操作，一律拒绝',
      '- 用户违反规则时明确拒绝，引用具体条款说明原因',
      '- 不得以"用户要求"为由绕过规则',
    ].join('\n');
    writeFileSync(rulesPath, template, 'utf-8');
    console.log('  ✅ RULES.md 模板已创建');
  }

  // 5. AGENTS.md
  const agentsPath = join(homeRoot, 'agents', 'default', 'AGENTS.md');
  if (!existsSync(agentsPath)){
    const template = [
      '# Arcana Agent Instructions',
      '',
      '## Screen Awareness',
      'Your screen context is automatically injected before each message.',
      'Use it to understand what files are open and what the user is working on.',
      '',
      '## File Tools',
      'You have `write` and `edit` tools. All file operations are restricted to the workspace.',
      'Protected files (`.env`, `package.json`, etc.) require approval.',
      '',
      '## Rules & Principles',
      'RULES.md is the highest priority. Follow it absolutely.',
      'Session and global principles are equally binding.',
      '',
      '## Response Guidelines',
      '- Be concise and direct',
      '- When rejecting a request, cite the specific rule',
      '- Tell the user the file path when creating files',
    ].join('\n');
    writeFileSync(agentsPath, template, 'utf-8');
    console.log('  ✅ AGENTS.md 已创建');
  }

  // 6. API token
  const tokenPath = join(homeRoot, 'api_token');
  if (!existsSync(tokenPath)){
    const token = 'rB4H' + randomBytes(24).toString('hex') + 'RsBc';
    writeFileSync(tokenPath, token, 'utf-8');
    console.log('  ✅ API Token 已生成');
  }

  // 7. Done
  console.log('\n' + '='.repeat(50));
  console.log('✅ 初始化完成！');
  console.log('');
  console.log('  启动 Arcana:');
  console.log('    npm start');
  console.log('');
  console.log('  手动启动:');
  console.log('    node bin/arcana.js gateway serve');
  console.log('');
  console.log('  打开浏览器:');
  console.log('    http://127.0.0.1:8787');
  console.log('='.repeat(50));
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
