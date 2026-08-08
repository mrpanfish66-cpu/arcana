// Screenpipe context injector — fetches OCR data for prompt injection
// Never throws; returns empty string if screenpipe is unavailable

const SCREENPIPE_URL = process.env.SCREENPIPE_URL || 'http://127.0.0.1:3030';
const SCREENPIPE_API_KEY = process.env.SCREENPIPE_API_KEY || '';
const FETCH_TIMEOUT_MS = 3000;
const DEFAULT_MINUTES = 5;
const DEFAULT_LIMIT = 8;

const PRIVACY_DENYLIST = [
  'wechat', 'weixin', '微信', 'qq', 'telegram', 'discord',
  'whatsapp', 'password', '密码', '支付', 'payment', 'bank',
];

function hasPrivacyRisk(app, windowTitle){
  const text = `${app || ''} ${windowTitle || ''}`.toLowerCase();
  return PRIVACY_DENYLIST.some((word) => text.includes(word.toLowerCase()));
}

function minutesAgoIso(minutes){
  const m = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MINUTES;
  return new Date(Date.now() - m * 60 * 1000).toISOString();
}

async function fetchWithTimeout(url, timeoutMs){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (SCREENPIPE_API_KEY) headers['Authorization'] = `Bearer ${SCREENPIPE_API_KEY}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getScreenpipeContext(minutes = DEFAULT_MINUTES, limit = DEFAULT_LIMIT){
  try {
    const url = new URL('/search', SCREENPIPE_URL);
    url.searchParams.set('content_type', 'ocr');
    url.searchParams.set('limit', String(Math.min(limit + 10, 30)));
    url.searchParams.set('start_time', minutesAgoIso(minutes));
    url.searchParams.set('max_content_length', '800');

    const data = await fetchWithTimeout(url.toString(), FETCH_TIMEOUT_MS);
    if (!data || !Array.isArray(data.data) || !data.data.length) return '';

    const rows = data.data
      .map((item) => {
        const c = item.content || {};
        return {
          app: c.app_name || 'unknown',
          window_title: c.window_name || c.frame_name || '',
          text: (c.text || '').slice(0, 500),
          focused: c.focused,
        };
      })
      .filter((r) => !hasPrivacyRisk(r.app, r.window_title))
      .filter((r) => r.text.trim());

    if (!rows.length) return '';

    // Dedupe by text prefix
    const seen = new Set();
    const unique = rows.filter((r) => {
      const key = `${r.app}|${r.text.slice(0, 150)}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Put focused window first, then sort by recency (implied by order)
    const focused = unique.filter(r => r.focused);
    const unfocused = unique.filter(r => !r.focused);
    const sorted = [...focused, ...unfocused].slice(0, limit);

    if (!sorted.length) return '';

    // Identify the primary app (first focused entry) for context hint
    const primary = sorted[0];
    const primaryHint = primary && primary.app !== 'unknown'
      ? `Primary focus: ${primary.app}${primary.window_title ? ' — ' + primary.window_title : ''}`
      : '';

    const lines = sorted.map((r) => {
      const tag = r.focused ? '[FOCUSED]' : '';
      const win = r.window_title ? ` | ${r.window_title}` : '';
      const snippet = r.text.slice(0, 300);
      return `${tag}[${r.app}]${win}\n  ${snippet}`;
    });

    return `[Screen Context — use this to understand what the user is currently working on]
${primaryHint ? '  ' + primaryHint : '  (no clear focus)'}
${lines.join('\n\n')}
[End Screen Context]
`;
  } catch {
    return '';
  }
}
