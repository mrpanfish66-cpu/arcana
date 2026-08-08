// Approval Manager — pauses tool execution and waits for user confirmation
// Used by wrapToolWithSecrets to gate high-risk operations before they execute.

import { emit } from './event-bus.js';
import { resolveWorkspaceRoot, isUnder } from './workspace-guard.js';

const APPROVAL_TIMEOUT_MS = 60_000; // 60 seconds auto-deny
const pending = new Map(); // requestId -> { resolve, reject, timeout, info }

let nextId = 0;
function generateId(){
  nextId += 1;
  return `approval_${Date.now()}_${nextId}`;
}

/**
 * Request user approval before executing a tool.
 * Returns a Promise that resolves when the user responds (or auto-denies after timeout).
 */
export function requestApproval({ toolName, args, callId, sessionId, agentId, reason }){
  return new Promise((resolve) => {
    const requestId = generateId();

    const timeout = setTimeout(() => {
      pending.delete(requestId);
      try { emit({ type: 'approval_timeout', requestId, toolName, sessionId, agentId }); } catch {}
      resolve({ approved: false, reason: 'timeout' });
    }, APPROVAL_TIMEOUT_MS);

    pending.set(requestId, { resolve, timeout, toolName, sessionId });

    // Notify frontend via event bus → WebSocket
    try {
      console.log('[arcana:approval] requestApproval:', { requestId, toolName, sessionId, reason });
      emit({
        type: 'approval_required',
        requestId,
        toolName,
        toolCallId: callId,
        args: safeSerializeArgs(args),
        sessionId,
        agentId,
        reason: reason || `工具 "${toolName}" 需要你的确认后才能执行。`,
      });
    } catch {}
  });
}

/**
 * Called by the REST endpoint when the user clicks Approve or Deny in the UI.
 */
export function respondToApproval(requestId, approved){
  const entry = pending.get(requestId);
  if (!entry) return { ok: false, reason: 'unknown_request' };

  clearTimeout(entry.timeout);
  pending.delete(requestId);

  entry.resolve({ approved: Boolean(approved), reason: approved ? 'user_approved' : 'user_denied' });
  return { ok: true };
}

/**
 * Check whether a tool+args combination requires user approval.
 * Returns { required: boolean, reason?: string }
 */
export function needsApproval(toolName, args){
  const name = String(toolName || '').toLowerCase();
  const safeArgs = args && typeof args === 'object' ? args : {};

  // bash always needs approval (if enabled)
  if (name === 'bash'){
    const cmd = String(safeArgs.command || safeArgs.cmd || '').slice(0, 100);
    return { required: true, reason: `即将执行命令: ${cmd || '(未指定)'}` };
  }

  // write/edit to protected files need approval
  if (name === 'write' || name === 'edit'){
    const path = String(safeArgs.path || safeArgs.file || safeArgs.filePath || '');
    if (isProtectedPath(path)){
      return { required: true, reason: `即将${name === 'write' ? '写入' : '编辑'}受保护文件: ${path}` };
    }
    // Outside workspace check — if path is absolute and not under workspace root
    if (isOutsideWorkspace(path)){
      return { required: true, reason: `目标路径可能在工作区外: ${path}` };
    }
  }

  // delete-like operations via bash/cron
  if (name === 'cron'){
    const kind = String(safeArgs.kind || safeArgs.type || '');
    if (kind === 'exec'){
      const cmd = String(safeArgs.command || '').slice(0, 100);
      if (/\b(rm|del|remove|delete)\b/i.test(cmd)){
        return { required: true, reason: `定时任务包含删除命令: ${cmd}` };
      }
    }
  }

  return { required: false };
}

function isProtectedPath(p){
  const path = String(p || '').toLowerCase();
  const protectedFiles = [
    '.env', '.env.local', '.env.production',
    '.gitignore', '.git/config',
    'package.json', 'package-lock.json', 'yarn.lock',
    'tsconfig.json', 'dockerfile', 'docker-compose.yml',
  ];
  for (const pf of protectedFiles){
    if (path.endsWith(pf) || path.includes('/' + pf) || path.includes('\\' + pf)){
      return true;
    }
  }
  return false;
}

function isOutsideWorkspace(p){
  const path = String(p || '').trim();
  if (!path) return false;
  // Only check absolute paths — relative paths are always within workspace scope
  if (!/^[A-Z]:[/\\]/i.test(path) && !path.startsWith('/')) return false;
  try {
    const root = resolveWorkspaceRoot();
    return !isUnder(root, path);
  } catch {
    return false;
  }
}

function safeSerializeArgs(args){
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)){
    if (v === undefined || v === null){
      out[k] = v;
    } else if (typeof v === 'string'){
      out[k] = v.length > 500 ? v.slice(0, 497) + '...' : v;
    } else if (typeof v === 'number' || typeof v === 'boolean'){
      out[k] = v;
    } else {
      out[k] = String(v).slice(0, 200);
    }
  }
  return out;
}

export default { requestApproval, respondToApproval, needsApproval };
