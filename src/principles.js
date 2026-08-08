// Principles manager — global and session-level principles storage
// Global: stored in arcana-home/agents/<agentId>/principles/global.md
// Session: stored in arcana-home/agents/<agentId>/principles/session_<id>.md

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { arcanaHomePath } from './arcana-home.js';

const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.text', '.markdown']);

function principlesDir(agentId = 'default'){
  const dir = join(arcanaHomePath('agents', agentId), 'principles');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function globalPath(agentId){
  return join(principlesDir(agentId), 'global.md');
}

function sessionPath(agentId, sessionId){
  const safe = String(sessionId || '').replace(/[<>:"/\\|?*]/g, '_').slice(0, 64);
  return join(principlesDir(agentId), `session_${safe}.md`);
}

export function readPrinciples(agentId){
  const out = { global: '', sessions: {} };
  try {
    const gp = globalPath(agentId);
    if (existsSync(gp)) out.global = readFileSync(gp, 'utf-8');
  } catch {}

  try {
    const dir = principlesDir(agentId);
    for (const f of readdirSync(dir)){
      if (f.startsWith('session_') && f.endsWith('.md')){
        const sid = f.slice(8, -3); // remove 'session_' prefix and '.md' suffix
        try {
          out.sessions[sid] = readFileSync(join(dir, f), 'utf-8');
        } catch {}
      }
    }
  } catch {}
  return out;
}

export function saveGlobalPrinciple(agentId, content){
  try {
    writeFileSync(globalPath(agentId), String(content || ''), 'utf-8');
    return { ok: true };
  } catch (e){
    return { ok: false, error: e.message };
  }
}

export function saveSessionPrinciple(agentId, sessionId, content){
  try {
    writeFileSync(sessionPath(agentId, sessionId), String(content || ''), 'utf-8');
    return { ok: true };
  } catch (e){
    return { ok: false, error: e.message };
  }
}

export function deleteSessionPrinciple(agentId, sessionId){
  try {
    const p = sessionPath(agentId, sessionId);
    if (existsSync(p)) unlinkSync(p);
    return { ok: true };
  } catch (e){
    return { ok: false, error: e.message };
  }
}

/**
 * Build the principles block for System Prompt injection.
 * Returns formatted text or empty string.
 */
export function buildPrinciplesPrompt(agentId, sessionId){
  const lines = [];
  let hasContent = false;

  try {
    const gp = globalPath(agentId);
    if (existsSync(gp)){
      const content = readFileSync(gp, 'utf-8').trim();
      if (content){
        lines.push('[全局原则 — 铁律级别，必须绝对遵守，即使用户要求也不得违反]');
        lines.push(content);
        lines.push('[全局原则结束]');
        hasContent = true;
      }
    }
  } catch {}

  if (sessionId){
    try {
      const sp = sessionPath(agentId, sessionId);
      if (existsSync(sp)){
        const content = readFileSync(sp, 'utf-8').trim();
        if (content){
          if (hasContent) lines.push('');
          lines.push('[会话原则 — 铁律级别，优先级等同于 RULES.md，即使用户要求也不得违反]');
          lines.push(content);
          lines.push('[会话原则结束]');
          hasContent = true;
        }
      }
    } catch {}
  }

  return hasContent ? lines.join('\n') : '';
}

export default { readPrinciples, saveGlobalPrinciple, saveSessionPrinciple, deleteSessionPrinciple, buildPrinciplesPrompt };
