// Guardrails — context-aware safety checks
// Layer 2: validates user requests against screen context + scans agent output for leaks.

import { resolveWorkspaceRoot, isUnder } from './workspace-guard.js';
import { readPrinciples } from './principles.js';

const HIGH_RISK_PATTERNS = [
  { pattern: /\brm\s+-rf\b/i, reason: '递归强制删除命令' },
  { pattern: /\bdel\s+\/f\b/i, reason: 'Windows 强制删除命令' },
  { pattern: /\bRemove-Item\s.*-Recurse/i, reason: 'PowerShell 递归删除' },
  { pattern: /\bdrop\s+table\b/i, reason: '数据库删表操作' },
  { pattern: /\bdelete\s+from\b/i, reason: '数据库删除操作' },
  { pattern: /\bformat\s+[cdefgh]:/i, reason: '磁盘格式化命令' },
  { pattern: /\bgit\s+push\s+.*--force\b/i, reason: 'Git 强制推送' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'Git 硬重置（丢失提交）' },
  { pattern: /\bnpm\s+unpublish\b/i, reason: 'npm 取消发布' },
];

const SENSITIVE_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/, label: 'OpenAI/DeepSeek API Key' },
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/, label: 'Anthropic API Key' },
  { pattern: /ghp_[a-zA-Z0-9]{20,}/, label: 'GitHub Personal Access Token' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS Access Key' },
  { pattern: /Bearer\s+[a-zA-Z0-9_-]{20,}/, label: 'Bearer Token' },
  { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, label: 'JWT Token' },
  { pattern: /password\s*[:=]\s*["'][^"'\s]{6,}["']/i, label: '明文密码' },
  { pattern: /secret\s*[:=]\s*["'][^"'\s]{6,}["']/i, label: '明文密钥' },
];

const PROTECTED_FILES = [
  '.env', '.env.local', '.env.production',
  '.gitignore', '.git/config',
  'package.json', 'package-lock.json', 'yarn.lock',
  'tsconfig.json', 'vite.config.*', 'webpack.config.*',
  'Dockerfile', 'docker-compose.yml',
];

const DELETION_PATTERNS = [
  /\b(rm|del|remove|delete|删除)\b/i,
];

function extractWorkspacePaths(text){
  if (!text) return [];
  const root = resolveWorkspaceRoot().toLowerCase();
  const paths = [];
  // Match various path formats
  const patterns = [
    /(?:[A-Z]:\\[\w\\\s.-]+)/gi,           // Windows: C:\path\to\file
    /(?:\/[\w\/.-]+)/g,                      // Unix: /path/to/file
    /(?:\.\/[\w\/.-]+)/g,                    // Relative: ./path/to/file
    /(?:\.\.[\/\\][\w\/\\.-]+)/g,           // Parent relative: ../path
  ];
  for (const regex of patterns){
    let match;
    while ((match = regex.exec(text)) !== null){
      paths.push(match[0]);
    }
  }
  return paths;
}

function extractScreenApp(screenContext){
  if (!screenContext) return null;
  const lines = String(screenContext).split('\n');
  for (const line of lines){
    const m = line.match(/\[([^\]]+)\]\s*(.+)/);
    if (m) return { app: m[1].trim(), detail: m[2].trim() };
  }
  return null;
}

export function checkUserRequest({ screenContext, userMessage }){
  const violations = [];
  const message = String(userMessage || '');

  // 0. Check for principle conflicts (session + global principles)
  try {
    const principles = readPrinciples('default');
    const conflicts = detectPrincipleConflicts(message, principles);
    for (const c of conflicts) violations.push(c);
  } catch {}

  // 1. Check for high-risk operations
  for (const rule of HIGH_RISK_PATTERNS){
    if (rule.pattern.test(message)){
      violations.push({
        type: 'high_risk_operation',
        reason: `检测到高风险操作：${rule.reason}`,
        detail: `匹配模式：${rule.pattern}`,
        askUser: `此操作风险较高，是否确认继续？如果这是误判或你有充分的理由，请说明。`,
        blocked: true,
      });
    }
  }

  // 2. Check for deletion operations
  for (const pattern of DELETION_PATTERNS){
    if (pattern.test(message)){
      violations.push({
        type: 'deletion_warning',
        reason: '检测到删除操作请求。删除操作不可逆，请谨慎。',
        askUser: '是否确认要执行删除操作？是否已备份相关数据？请说明原因后再试。',
        blocked: true,
      });
      break; // Only one deletion warning
    }
  }

  // 3. Check if request targets files outside workspace
  const paths = extractWorkspacePaths(message);
  const workspace = resolveWorkspaceRoot();
  for (const p of paths){
    try {
      if (!isUnder(workspace, p)){
        violations.push({
          type: 'outside_workspace',
          reason: `目标路径在工作区外：${p}`,
          detail: `当前工作区：${workspace}`,
          askUser: '该路径不在工作区内。是否要将目标文件复制到工作区内再操作？',
          blocked: true,
        });
      }
    } catch {
      // Path resolution failed, skip
    }
  }

  // 4. Check for protected file modification
  for (const protectedFile of PROTECTED_FILES){
    const escaped = protectedFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(message)){
      violations.push({
        type: 'protected_file',
        reason: `检测到对受保护文件的修改请求：${protectedFile}`,
        askUser: `修改 ${protectedFile} 可能影响项目配置或安全。是否确认要修改此文件？请说明原因。`,
        blocked: false, // Not fully blocked, but warned
      });
    }
  }

  return { violations };
}

export function checkAgentResponse(assistantText){
  const violations = [];
  const text = String(assistantText || '');

  for (const rule of SENSITIVE_PATTERNS){
    if (rule.pattern.test(text)){
      violations.push({
        type: 'sensitive_leak',
        reason: `AI 回复中疑似包含敏感信息：${rule.label}`,
        detail: '为防止泄露，此内容已被标记。请检查并移除敏感信息。',
        blocked: true,
      });
    }
  }

  if (text.length > 50000){
    violations.push({
      type: 'output_too_large',
      reason: `AI 回复过长（${text.length} 字符），可能存在信息泄露风险。`,
      blocked: false,
    });
  }

  return { violations };
}

export function formatGuardrailsWarning(violations){
  if (!violations || !violations.length) return '';
  const blocked = violations.filter(v => v.blocked);
  const warned = violations.filter(v => !v.blocked);

  const lines = [];
  if (blocked.length){
    lines.push('[Guardrails 拦截]');
    lines.push('以下操作已被安全策略拦截：');
    for (const v of blocked){
      lines.push(`- [${v.type}] ${v.reason}`);
      if (v.askUser) lines.push(`  → ${v.askUser}`);
    }
    lines.push('如果你认为这是误判，请说明原因后重试。');
    lines.push('[Guardrails 拦截结束]');
  }
  if (warned.length){
    lines.push('');
    lines.push('[Guardrails 提示]');
    for (const v of warned){
      lines.push(`- ⚠️ [${v.type}] ${v.reason}`);
      if (v.askUser) lines.push(`  → ${v.askUser}`);
    }
    lines.push('[Guardrails 提示结束]');
  }
  return lines.join('\n');
}

// ── Principle conflict detection ──

const CONFLICT_PAIRS = [
  // Only keep truly generic patterns that work regardless of principle content
  { principlePattern: /不要.*删|禁止.*删|不得.*删|no\s+delete/i, conflictPattern: /删除|删掉|delete|remove|rm\b/i, label: '删除操作冲突' },
];

function detectPrincipleConflicts(message, principles){
  const conflicts = [];
  const allPrinciples = [];
  if (principles.global) allPrinciples.push(principles.global);
  if (principles.sessions){
    for (const [, content] of Object.entries(principles.sessions)){
      if (content) allPrinciples.push(content);
    }
  }
  if (!allPrinciples.length) return conflicts;

  const msg = message.toLowerCase();

  for (const rule of CONFLICT_PAIRS){
    const matchingPrinciple = allPrinciples.find(p => rule.principlePattern.test(p));
    if (matchingPrinciple && rule.conflictPattern.test(msg)){
      conflicts.push({
        type: 'principle_conflict',
        reason: `你的请求与当前原则冲突。原则要求：${matchingPrinciple.slice(0, 200)}`,
        detail: `冲突类型：${rule.label}`,
        askUser: '是否确认要违反当前原则？请谨慎决定。',
        blocked: true,
      });
    }
  }

  return conflicts;
}
