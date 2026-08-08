// Arcana Screenpipe Plugin — adds screen-aware tools to Arcana agents
// Tools: query_screenpipe, get_frame_context, get_screen_activity_summary

const SCREENPIPE_URL = process.env.SCREENPIPE_URL || 'http://127.0.0.1:3030';
const SCREENPIPE_API_KEY = process.env.SCREENPIPE_API_KEY || '';
const DEFAULT_MINUTES = 5;
const DEFAULT_LIMIT = 20;

const PRIVACY_DENYLIST = [
  'wechat', 'weixin', '微信', 'qq', 'telegram', 'discord',
  'whatsapp', 'password', '密码', '支付', 'payment', 'bank',
];

function hasPrivacyRisk(app, windowTitle){
  const text = `${app || ''} ${windowTitle || ''}`.toLowerCase();
  return PRIVACY_DENYLIST.some((word) => text.includes(word.toLowerCase()));
}

function minutesAgoIso(minutes){
  const m = Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
  return new Date(Date.now() - m * 60 * 1000).toISOString();
}

async function callScreenpipe(path, params = {}){
  const url = new URL(path, SCREENPIPE_URL);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  const headers = {};
  if (SCREENPIPE_API_KEY) headers['Authorization'] = `Bearer ${SCREENPIPE_API_KEY}`;
  const response = await fetch(url.toString(), { headers });
  if (!response.ok){
    throw new Error(`Screenpipe API error: HTTP ${response.status}`);
  }
  return response.json();
}

async function queryScreenpipe(args){
  const minutes = Math.min(Number(args.minutes) || DEFAULT_MINUTES, 30);
  const limit = Math.min(Number(args.limit) || DEFAULT_LIMIT, 50);
  const data = await callScreenpipe('/search', {
    content_type: 'ocr',
    limit,
    start_time: minutesAgoIso(minutes),
    max_content_length: 2000,
  });

  let rows = (data.data || []).map((item) => {
    const c = item.content || {};
    return {
      frame_id: c.frame_id,
      app: c.app_name || 'unknown',
      window_title: c.window_name || c.frame_name || '',
      text: (c.text || '').slice(0, 2000),
      timestamp: c.timestamp || '',
      focused: c.focused,
    };
  });

  rows = rows.filter((r) => !hasPrivacyRisk(r.app, r.window_title));

  const appFilter = String(args.app_filter || '').toLowerCase();
  const textFilter = String(args.text_filter || '').toLowerCase();
  if (appFilter) rows = rows.filter((r) => r.app.toLowerCase().includes(appFilter));
  if (textFilter) rows = rows.filter((r) => r.text.toLowerCase().includes(textFilter));

  // Dedupe by text similarity
  const seen = new Set();
  rows = rows.filter((r) => {
    const key = `${r.app}|${r.text.slice(0, 300)}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return JSON.stringify({
    query: { minutes, limit, app_filter: appFilter || null, text_filter: textFilter || null },
    total_results: rows.length,
    results: rows.slice(0, limit),
  }, null, 2);
}

async function getFrameContext(args){
  const frameId = Number(args.frame_id);
  if (!Number.isFinite(frameId) || frameId <= 0) return 'Error: frame_id must be a positive number';

  const data = await callScreenpipe('/search', {
    content_type: 'ocr',
    limit: 200,
    start_time: minutesAgoIso(30),
    max_content_length: 4000,
  });

  const frame = (data.data || []).find((item) => (item.content || {}).frame_id === frameId);
  if (!frame) return `Frame ${frameId} not found in recent 30 minutes.`;

  const c = frame.content || {};
  return JSON.stringify({
    frame_id: c.frame_id,
    app: c.app_name,
    window_title: c.window_name || c.frame_name,
    text: c.text || '',
    timestamp: c.timestamp,
    focused: c.focused,
  }, null, 2);
}

async function getScreenActivitySummary(args){
  const minutes = Math.min(Number(args.minutes) || 10, 60);
  const data = await callScreenpipe('/search', {
    content_type: 'ocr',
    limit: 60,
    start_time: minutesAgoIso(minutes),
    max_content_length: 1000,
  });

  const rows = (data.data || []).map((item) => {
    const c = item.content || {};
    return { app: c.app_name || 'unknown', text: (c.text || '').slice(0, 300), timestamp: c.timestamp };
  });

  const appStats = {};
  for (const row of rows){
    const app = row.app;
    if (hasPrivacyRisk(app, '')) continue;
    if (!appStats[app]) appStats[app] = { app, frame_count: 0, latest_text: '' };
    appStats[app].frame_count += 1;
    if (row.text) appStats[app].latest_text = row.text.slice(0, 200);
  }

  const apps = Object.values(appStats).sort((a, b) => b.frame_count - a.frame_count);
  const latestEntries = rows
    .filter((r) => !hasPrivacyRisk(r.app, ''))
    .slice(0, 5)
    .map((r) => ({ app: r.app, text_snippet: r.text.slice(0, 150), timestamp: r.timestamp }));

  return JSON.stringify({
    time_range_minutes: minutes,
    total_frames: rows.length,
    apps_detected: apps,
    latest_entries: latestEntries,
  }, null, 2);
}

function textResult(text){
  return { content: [{ type: 'text', text: String(text || '') }] };
}

export const tools = [
  {
    name: 'query_screenpipe',
    description: 'Query the last N minutes of screen OCR data from Screenpipe. Shows what apps the user has been looking at and the text on screen. Use BEFORE making plans or decisions to understand what the user is currently working on.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'How many minutes back to look (default: 5, max: 30)' },
        limit: { type: 'number', description: 'Max results to return (default: 20, max: 50)' },
        app_filter: { type: 'string', description: 'Optional: filter by app name' },
        text_filter: { type: 'string', description: 'Optional: only return results whose text contains this string' },
      },
      required: [],
    },
    execute: async (_id, args) => textResult(await queryScreenpipe(args || {})),
  },
  {
    name: 'get_frame_context',
    description: 'Get detailed context for a specific screen frame by frame_id. Use after query_screenpipe to drill into a specific moment.',
    parameters: {
      type: 'object',
      properties: {
        frame_id: { type: 'number', description: 'Frame ID from query_screenpipe results' },
      },
      required: ['frame_id'],
    },
    execute: async (_id, args) => textResult(await getFrameContext(args || {})),
  },
  {
    name: 'get_screen_activity_summary',
    description: 'Get a summary of recent screen activity: which apps were used and recent text snippets. Good for understanding overall context before planning.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'How many minutes back to look (default: 10, max: 60)' },
      },
      required: [],
    },
    execute: async (_id, args) => textResult(await getScreenActivitySummary(args || {})),
  },
];
