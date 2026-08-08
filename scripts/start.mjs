// Arcana one-click start — launches screenpipe + gateway + orchestrator
// Usage: node scripts/start.mjs  OR  npm start

import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(__dirname, '..'));
const homeRoot = process.env.ARCANA_HOME || resolve(join(repoRoot, 'arcana-home'));
const dataRoot = process.env.SCREENPIPE_DATA_DIR || resolve(join(repoRoot, 'screenpipe-data'));

const arcanaCli = join(repoRoot, 'bin', 'arcana.js');
const orchestratorJs = join(repoRoot, 'sidecars', 'proactive-orchestrator', 'src', 'index.js');
const screenpipePkg = join(repoRoot, 'node_modules', '@screenpipe', 'cli-win32-x64', 'bin');
const screenpipeExe = join(screenpipePkg, 'screenpipe.exe');

const port = process.env.ARCANA_PORT || '8787';
const spPort = process.env.SCREENPIPE_PORT || '3030';
const apiKey = process.env.SCREENPIPE_API_KEY || '';

const children = [];

function run(cmd, args, label){
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, ARCANA_HOME: homeRoot, SCREENPIPE_API_KEY: apiKey },
    stdio: 'pipe',
    shell: true,
  });
  children.push(child);
  child.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));
  child.on('close', code => console.log(`[${label}] 已退出 (code ${code})`));
  child.on('error', err => console.error(`[${label}] 启动失败:`, err.message));
  return child;
}

function cleanup(){
  console.log('\n🛑 正在关闭所有服务...');
  for (const c of children){
    try { c.kill('SIGTERM'); } catch {}
  }
  process.exit(0);
}

async function waitForHealth(url, timeoutMs = 15000){
  const start = Date.now();
  while (Date.now() - start < timeoutMs){
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function main(){
  console.log('🚀 Arcana 启动中...\n');
  console.log(`   ARCANA_HOME = ${homeRoot}`);
  console.log(`   数据目录     = ${dataRoot}\n`);

  // Ctrl+C graceful shutdown
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // 1. Screenpipe
  if (!existsSync(screenpipeExe)){
    console.log('[screenpipe] ❌ 未找到 screenpipe.exe');
    console.log('   请运行: npm install');
    process.exit(1);
  }
  console.log('[screenpipe] 启动...');
  run(screenpipeExe, [
    'record',
    '--disable-audio',
    '--retention-days', '1',
    '--retention-mode', 'media',
    '--data-dir', dataRoot,
    '--port', spPort,
  ], 'screenpipe');

  console.log('[screenpipe] 等待就绪...');
  const spReady = await waitForHealth(`http://127.0.0.1:${spPort}/health`);
  if (!spReady){
    console.log('[screenpipe] ⚠️ 启动超时，继续...');
  } else {
    // Disable auth if API key is not set
    console.log('[screenpipe] ✅ 就绪');
  }

  // 2. Gateway
  console.log('[gateway] 启动...');
  if (!existsSync(arcanaCli)){
    console.log('[gateway] ❌ 未找到 bin/arcana.js');
    process.exit(1);
  }
  run('node', [arcanaCli, 'gateway', 'serve'], 'gateway');
  await new Promise(r => setTimeout(r, 3000));

  // 3. Orchestrator
  if (existsSync(orchestratorJs)){
    console.log('[orchestrator] 启动...');
    run('node', [
      orchestratorJs,
      '--loop',
      '--provider', 'screenpipe',
      '--api-key', apiKey,
      '--arcana-url', `http://127.0.0.1:${port}`,
      '--interval-ms', '30000',
    ], 'orchestrator');
  } else {
    console.log('[orchestrator] ⚠️ 未找到，跳过');
  }

  console.log(`\n✅ Arcana 已启动: http://127.0.0.1:${port}`);
  console.log('   Ctrl+C 停止所有服务\n');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
