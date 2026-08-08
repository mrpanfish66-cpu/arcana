const DEFAULT_WORK_APP_ALLOWLIST = [
  'code',
  'visual studio code',
  'cursor',
  'claude',
  'terminal',
  'windows terminal',
  'powershell',
  'pwsh',
  'cmd',
  'chrome',
  'edge',
  'firefox',
  'arc',
  'explorer',
  'notepad',
  'notepad++',
  'sublime',
  'intellij',
  'webstorm',
  'pycharm',
  'vim',
  'nvim',
  'obsidian',
  'slack',
  'teams',
  'zoom',
];

const DEFAULT_PRIVACY_DENYLIST = [
  'wechat',
  'weixin',
  '微信',
  'qq',
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'password',
  '密码',
  '支付',
  'payment',
  'bank',
];

function minutesAgoIso(minutes){
  const n = Number(minutes);
  const safe = Number.isFinite(n) && n > 0 ? n : 5;
  return new Date(Date.now() - safe * 60 * 1000).toISOString();
}

function includesAny(value, words){
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return words.some((word) => text.includes(String(word || '').toLowerCase()));
}

function isWorkContext(item, allowlist){
  const app = item.app || '';
  const windowTitle = item.windowTitle || '';
  return includesAny(app, allowlist) || includesAny(windowTitle, allowlist);
}

function hasPrivacyRisk(item, denylist){
  const app = item.app || '';
  const windowTitle = item.windowTitle || '';
  return includesAny(app, denylist) || includesAny(windowTitle, denylist);
}

function normalizeSearchResult(result, index){
  const content = result && result.content && typeof result.content === 'object' ? result.content : {};
  const type = String((result && result.type) || '');
  const text = content.text || content.transcription || content.text_content || content.content || '';
  const app = content.app_name || content.device_name || '';
  const windowTitle = content.window_name || content.window_title || content.frame_name || '';
  const timestamp = content.timestamp || content.created_at || '';
  const source = type ? `screenpipe:${type.toLowerCase()}` : 'screenpipe';
  const rawId = content.frame_id || content.id || content.chunk_id || content.audio_chunk_id || index;
  return {
    timestamp: String(timestamp || new Date().toISOString()),
    app: String(app || 'unknown'),
    windowTitle: String(windowTitle || ''),
    text: String(text || ''),
    source,
    evidenceId: `screenpipe-${rawId}`,
    privacyFlags: [],
  };
}

function dedupeByText(items){
  const seen = new Set();
  const out = [];
  for (const item of items){
    const key = [
      String(item.app || '').toLowerCase(),
      String(item.windowTitle || '').toLowerCase(),
      String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 240).toLowerCase(),
    ].join('|');
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function fetchScreenpipeContext(options = {}){
  const baseUrl = String(options.screenpipeUrl || 'http://127.0.0.1:3030').replace(/\/+$/, '');
  const minutes = Number(options.minutes || 5);
  const limit = Number(options.limit || 30);
  const allowlist = Array.isArray(options.allowlist) && options.allowlist.length
    ? options.allowlist
    : DEFAULT_WORK_APP_ALLOWLIST;
  const denylist = Array.isArray(options.denylist) && options.denylist.length
    ? options.denylist
    : DEFAULT_PRIVACY_DENYLIST;

  const params = new URLSearchParams();
  params.set('content_type', 'ocr');
  params.set('limit', String(Number.isFinite(limit) && limit > 0 ? limit : 30));
  params.set('start_time', minutesAgoIso(minutes));
  params.set('max_content_length', '1200');

  let response;
  try {
    const headers = {};
    const apiKey = options.apiKey || process.env.SCREENPIPE_API_KEY || '';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    response = await fetch(`${baseUrl}/search?${params.toString()}`, { headers });
  } catch (error){
    throw new Error(`Screenpipe API is not reachable at ${baseUrl}. Start Screenpipe first, or pass --fallback-mock.`);
  }
  if (!response.ok){
    throw new Error(`Screenpipe search failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  const normalized = rows
    .map(normalizeSearchResult)
    .filter((item) => item.text && item.text.trim())
    .map((item) => {
      const privacyFlags = [];
      if (hasPrivacyRisk(item, denylist)) privacyFlags.push('privacy-denylist');
      return { ...item, privacyFlags };
    })
    .filter((item) => !item.privacyFlags.length)
    .filter((item) => isWorkContext(item, allowlist));

  return dedupeByText(normalized).slice(0, Number.isFinite(limit) && limit > 0 ? limit : 30);
}

export function getDefaultWorkAppAllowlist(){
  return DEFAULT_WORK_APP_ALLOWLIST.slice();
}
