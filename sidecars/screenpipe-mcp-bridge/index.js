// Screenpipe MCP Bridge — connects Arcana to Screenpipe REST API via MCP protocol
// stdio transport: receives JSON-RPC on stdin, sends on stdout

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SCREENPIPE_URL = process.env.SCREENPIPE_URL || 'http://127.0.0.1:3030';
const SCREENPIPE_API_KEY = process.env.SCREENPIPE_API_KEY || '';
const DEFAULT_MINUTES = 5;
const DEFAULT_LIMIT = 30;

const PRIVACY_DENYLIST = [
  'wechat', 'weixin', '微信', 'qq', 'telegram', 'discord',
  'slack', 'whatsapp', 'password', '密码', '支付', 'payment', 'bank',
];

function hasPrivacyRisk(app, windowTitle){
  const text = `${app || ''} ${windowTitle || ''}`.toLowerCase();
  return PRIVACY_DENYLIST.some((word) => text.includes(word.toLowerCase()));
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

function minutesAgoIso(minutes){
  return new Date(Date.now() - (Number(minutes) || 5) * 60 * 1000).toISOString();
}

const server = new Server(
  { name: 'screenpipe-mcp-bridge', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'query_screenpipe',
      description: 'Query recent screen OCR text from Screenpipe. Returns what the user has been looking at on screen (app name, window title, text content) for the last N minutes. Use this to understand what the user is currently working on before making decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          minutes: {
            type: 'number',
            description: 'How many minutes back to look (default: 5, max: 30)',
            default: 5,
          },
          limit: {
            type: 'number',
            description: 'Max number of results (default: 20, max: 50)',
            default: 20,
          },
          app_filter: {
            type: 'string',
            description: 'Optional: filter by app name (e.g. "code", "chrome", "terminal"). Case-insensitive contains match.',
          },
          text_filter: {
            type: 'string',
            description: 'Optional: only return results whose text contains this string. Case-insensitive.',
          },
        },
      },
    },
    {
      name: 'get_frame_context',
      description: 'Get detailed context for a specific screen frame. Returns full OCR text, app info, and window title for one captured frame. Use after query_screenpipe to drill into a specific moment.',
      inputSchema: {
        type: 'object',
        properties: {
          frame_id: {
            type: 'number',
            description: 'Frame ID from query_screenpipe results (evidenceId field contains the frame ID like "screenpipe-123")',
          },
        },
        required: ['frame_id'],
      },
    },
    {
      name: 'get_screen_activity_summary',
      description: 'Get a summary of recent screen activity: which apps were used, for how long, and key text snippets. Good for understanding overall context before planning.',
      inputSchema: {
        type: 'object',
        properties: {
          minutes: {
            type: 'number',
            description: 'How many minutes back to look (default: 10, max: 60)',
            default: 10,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const safeArgs = args || {};

  try {
    if (name === 'query_screenpipe'){
      const minutes = Math.min(Number(safeArgs.minutes) || DEFAULT_MINUTES, 30);
      const limit = Math.min(Number(safeArgs.limit) || DEFAULT_LIMIT, 50);
      const startTime = minutesAgoIso(minutes);

      const data = await callScreenpipe('/search', {
        content_type: 'ocr',
        limit,
        start_time: startTime,
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

      // Privacy filter: remove personal chat/payment apps
      rows = rows.filter((r) => !hasPrivacyRisk(r.app, r.window_title));

      // Apply filters
      const appFilter = String(safeArgs.app_filter || '').toLowerCase();
      const textFilter = String(safeArgs.text_filter || '').toLowerCase();
      if (appFilter){
        rows = rows.filter((r) => r.app.toLowerCase().includes(appFilter));
      }
      if (textFilter){
        rows = rows.filter((r) => r.text.toLowerCase().includes(textFilter));
      }

      // Dedupe by text
      const seen = new Set();
      rows = rows.filter((r) => {
        const key = (r.app + r.text.slice(0, 300)).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query: { minutes, limit, app_filter: appFilter || null, text_filter: textFilter || null },
            total_results: rows.length,
            results: rows.slice(0, limit),
          }, null, 2),
        }],
      };
    }

    if (name === 'get_frame_context'){
      const frameId = Number(safeArgs.frame_id);
      if (!Number.isFinite(frameId) || frameId <= 0){
        return { content: [{ type: 'text', text: 'Error: frame_id must be a positive number' }] };
      }

      // Use keyword-search to find the specific frame
      const data = await callScreenpipe('/search', {
        content_type: 'ocr',
        limit: 100,
        start_time: minutesAgoIso(30),
        max_content_length: 4000,
      });

      const rows = (data.data || []);
      const frame = rows.find((item) => (item.content || {}).frame_id === frameId);

      if (!frame){
        return { content: [{ type: 'text', text: `Frame ${frameId} not found in recent 30 minutes of data.` }] };
      }

      const c = frame.content || {};
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            frame_id: c.frame_id,
            app: c.app_name,
            window_title: c.window_name || c.frame_name,
            text: c.text || '',
            timestamp: c.timestamp,
            file_path: c.file_path,
            focused: c.focused,
            browser_url: c.browser_url,
          }, null, 2),
        }],
      };
    }

    if (name === 'get_screen_activity_summary'){
      const minutes = Math.min(Number(safeArgs.minutes) || 10, 60);
      const startTime = minutesAgoIso(minutes);

      const data = await callScreenpipe('/search', {
        content_type: 'ocr',
        limit: 50,
        start_time: startTime,
        max_content_length: 1500,
      });

      const rows = (data.data || []).map((item) => {
        const c = item.content || {};
        return {
          app: c.app_name || 'unknown',
          text: (c.text || '').slice(0, 300),
          timestamp: c.timestamp,
        };
      });

      // Aggregate by app
      const appStats = {};
      for (const row of rows){
        const app = row.app;
        if (!appStats[app]) appStats[app] = { app, frame_count: 0, latest_text: '' };
        appStats[app].frame_count += 1;
        if (row.text) appStats[app].latest_text = row.text.slice(0, 200);
      }

      const apps = Object.values(appStats).sort((a, b) => b.frame_count - a.frame_count);
      const latestEntries = rows.slice(0, 5).map((r) => ({
        app: r.app,
        text_snippet: r.text.slice(0, 150),
        timestamp: r.timestamp,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            time_range_minutes: minutes,
            total_frames: rows.length,
            apps_detected: apps,
            latest_entries: latestEntries,
          }, null, 2),
        }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error){
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main(){
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[screenpipe-mcp-bridge] started, connected to', SCREENPIPE_URL);
}

main().catch((error) => {
  console.error('[screenpipe-mcp-bridge] fatal:', error);
  process.exit(1);
});
