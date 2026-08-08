import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { createMockScreenpipeContext } from './mock-context.js';
import { fetchScreenpipeContext } from './screenpipe-context.js';

const DEFAULT_ARCANA_URL = 'http://127.0.0.1:8787';
const SIGNAL_PATTERNS = [
  /\bnpm ERR\b/i,
  /\bTypeError\b/i,
  /\bReferenceError\b/i,
  /\bException\b/i,
  /\bTraceback\b/i,
  /\bbuild failed\b/i,
  /\b404\b/,
  /\b500\b/,
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bmerge conflict\b/i,
];

const ACTIVITY_SIGNAL_MIN_TEXT_LENGTH = 50;

// Deduplication: track alerted error fingerprints to prevent repeat alerts
const ALERTED_FINGERPRINTS = new Map(); // fingerprint -> timestamp
const ALERT_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function makeFingerprint(item){
  const app = String(item && item.app || '').toLowerCase();
  const text = String(item && item.text || '').slice(0, 200).toLowerCase();
  return `${app}|${text}`;
}

function wasRecentlyAlerted(item){
  const fp = makeFingerprint(item);
  const ts = ALERTED_FINGERPRINTS.get(fp);
  if (!ts) return false;
  if (Date.now() - ts > ALERT_DEDUP_WINDOW_MS){
    ALERTED_FINGERPRINTS.delete(fp);
    return false;
  }
  return true;
}

function markAlerted(item){
  ALERTED_FINGERPRINTS.set(makeFingerprint(item), Date.now());
  // Cleanup stale entries periodically
  if (ALERTED_FINGERPRINTS.size > 200){
    const cutoff = Date.now() - ALERT_DEDUP_WINDOW_MS;
    for (const [fp, ts] of ALERTED_FINGERPRINTS){
      if (ts < cutoff) ALERTED_FINGERPRINTS.delete(fp);
    }
  }
}

const OrchestratorState = Annotation.Root({
  rawContext: Annotation({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  signals: Annotation({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  suggestion: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  delivery: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

function parseArgs(argv){
  const out = {
    mode: 'once',
    arcanaUrl: process.env.ARCANA_URL || DEFAULT_ARCANA_URL,
    provider: process.env.PROACTIVE_CONTEXT_PROVIDER || 'mock',
    screenpipeUrl: process.env.SCREENPIPE_URL || 'http://127.0.0.1:3030',
    screenpipeApiKey: process.env.SCREENPIPE_API_KEY || '',
    minutes: Number(process.env.PROACTIVE_LOOKBACK_MINUTES || 5),
    fallbackMock: false,
    intervalMs: Number(process.env.PROACTIVE_INTERVAL_MS || 15000),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1){
    const arg = argv[i];
    if (arg === '--once') out.mode = 'once';
    else if (arg === '--loop') out.mode = 'loop';
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--provider') out.provider = argv[i += 1] || out.provider;
    else if (arg === '--screenpipe-url') out.screenpipeUrl = argv[i += 1] || out.screenpipeUrl;
    else if (arg === '--minutes') out.minutes = Number(argv[i += 1] || out.minutes);
    else if (arg === '--fallback-mock') out.fallbackMock = true;
    else if (arg === '--arcana-url') out.arcanaUrl = argv[i += 1] || out.arcanaUrl;
    else if (arg === '--interval-ms') out.intervalMs = Number(argv[i += 1] || out.intervalMs);
    else if (arg === '--api-key') out.screenpipeApiKey = argv[i += 1] || out.screenpipeApiKey;
  }
  if (!Number.isFinite(out.intervalMs) || out.intervalMs < 1000) out.intervalMs = 15000;
  if (!Number.isFinite(out.minutes) || out.minutes <= 0) out.minutes = 5;
  out.provider = String(out.provider || 'mock').toLowerCase();
  return out;
}

function compactText(value, max = 360){
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '...' : text;
}

async function pollScreenpipeMock(){
  return { rawContext: createMockScreenpipeContext() };
}

function createPollContextNode(options){
  return async function pollContext(){
    if (options.provider !== 'screenpipe'){
      return pollScreenpipeMock();
    }
    try {
      const rawContext = await fetchScreenpipeContext({
        screenpipeUrl: options.screenpipeUrl,
        minutes: options.minutes,
        apiKey: options.screenpipeApiKey,
      });
      console.log(`[proactive-orchestrator] screenpipe context rows: ${rawContext.length}`);
      return { rawContext };
    } catch (error){
      if (!options.fallbackMock) throw error;
      console.warn('[proactive-orchestrator] screenpipe unavailable, using mock context:', error && (error.message || error));
      return pollScreenpipeMock();
    }
  };
}

async function detectSignal(state){
  const raw = Array.isArray(state.rawContext) ? state.rawContext : [];
  const signals = [];
  for (const item of raw){
    const text = String(item && item.text || '');
    const matched = SIGNAL_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern));
    if (matched.length){
      // Skip if this exact error was already alerted recently
      if (wasRecentlyAlerted(item)) continue;
      signals.push({
        kind: 'error_signal',
        confidence: 0.86,
        matched,
        evidenceId: item.evidenceId,
        evidence: item,
      });
    } else if (text.length >= ACTIVITY_SIGNAL_MIN_TEXT_LENGTH){
      signals.push({
        kind: 'activity_signal',
        confidence: 0.45,
        matched: ['screen_activity'],
        evidenceId: item.evidenceId,
        evidence: item,
      });
    }
  }
  return { signals };
}

async function createSuggestion(state){
  const signals = Array.isArray(state.signals) ? state.signals : [];
  const errorSignals = signals.filter((s) => s.kind === 'error_signal');
  if (!errorSignals.length) return { suggestion: null };
  const evidence = errorSignals.map((signal) => signal.evidence).filter(Boolean).slice(0, 5);
  // Mark as alerted so we don't repeat the same alert
  for (const item of evidence) markAlerted(item);
  const first = evidence[0] || {};
  return {
    suggestion: {
      type: 'proactive_suggestion',
      title: '检测到可能的运行错误',
      summary: `我看到 ${first.app || '当前窗口'} 里出现了疑似报错：${compactText(first.text, 180)}`,
      proposedAction: '是否要我帮你查看并修复这个错误？',
      risk: 'low',
      source: 'langgraph-sidecar-mock',
      evidence: evidence.map((item) => ({
        evidenceId: item.evidenceId,
        timestamp: item.timestamp,
        app: item.app,
        windowTitle: item.windowTitle,
        text: compactText(item.text, 500),
        source: item.source,
      })),
      raw: {
        signalCount: signals.length,
      },
    },
  };
}

function createSendToArcanaNode(options){
  return async function sendToArcana(state){
    const suggestion = state.suggestion;
    if (!suggestion){
      console.log('[proactive-orchestrator] no proactive suggestion generated');
      return { delivery: { ok: true, skipped: true, reason: 'no_suggestion' } };
    }
    if (options.dryRun){
      console.log(JSON.stringify({ dryRun: true, suggestion }, null, 2));
      return { delivery: { ok: true, dryRun: true } };
    }
    const url = new URL('/api/proactive/suggestions', options.arcanaUrl).toString();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ suggestion }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok){
      throw new Error(`Arcana rejected suggestion: HTTP ${response.status} ${JSON.stringify(body)}`);
    }
    console.log(`[proactive-orchestrator] sent suggestion: ${body.suggestion?.id || suggestion.title}`);
    return { delivery: { ok: true, status: response.status, body } };
  };
}

function buildGraph(options){
  const graph = new StateGraph(OrchestratorState)
    .addNode('poll_context', createPollContextNode(options))
    .addNode('detect_signal', detectSignal)
    .addNode('create_suggestion', createSuggestion)
    .addNode('send_to_arcana', createSendToArcanaNode(options))
    .addEdge(START, 'poll_context')
    .addEdge('poll_context', 'detect_signal')
    .addEdge('detect_signal', 'create_suggestion')
    .addEdge('create_suggestion', 'send_to_arcana')
    .addEdge('send_to_arcana', END);
  return graph.compile();
}

async function runOnce(options){
  const app = buildGraph(options);
  const result = await app.invoke({});
  return result;
}

async function main(){
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'loop'){
    console.log(`[proactive-orchestrator] loop started, arcana=${options.arcanaUrl}, intervalMs=${options.intervalMs}`);
    while (true){
      try {
        await runOnce(options);
      } catch (error){
        console.error('[proactive-orchestrator] run failed:', error && (error.stack || error.message) || error);
      }
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  }
  await runOnce(options);
}

main().catch((error) => {
  console.error('[proactive-orchestrator] fatal:', error && (error.stack || error.message) || error);
  process.exit(1);
});
