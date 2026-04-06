#!/usr/bin/env node
/**
 * Amplenote MCP Server for Claude Code
 *
 * Credentials are loaded in this order:
 *   1. AMPLENOTE_CREDS_PATH env var → path to an amplenote-config.json file
 *   2. Direct env vars: AMPLENOTE_ACCESS_TOKEN + AMPLENOTE_REFRESH_TOKEN + AMPLENOTE_CLIENT_ID
 *
 * The config file format matches api-amplenote.json:
 *   {
 *     "oauth": { "clientId": "...", "tokenUrl": "https://api.amplenote.com/oauth/token" },
 *     "credentials": { "accessToken": "...", "refreshToken": "..." }
 *   }
 *
 * On 401, the server automatically refreshes the access token and saves the new
 * token back to the config file (if one was loaded from disk).
 */

'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const https = require('https');
const fs = require('fs');

const API_HOST = 'api.amplenote.com';
const API_BASE = '/v4';
const TOKEN_PATH = '/oauth/token';

// ─── Credential Loading ───────────────────────────────────────────────────────

function loadCredentials() {
  // Option 1: config file via env var
  const credsPath = process.env.AMPLENOTE_CREDS_PATH;
  if (credsPath && fs.existsSync(credsPath)) {
    const config = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    return {
      accessToken: config.credentials.accessToken,
      refreshToken: config.credentials.refreshToken,
      clientId: config.oauth.clientId,
      tokenUrl: config.oauth.tokenUrl || 'https://api.amplenote.com/oauth/token',
      filePath: credsPath,
    };
  }

  // Option 2: direct env vars
  if (process.env.AMPLENOTE_ACCESS_TOKEN) {
    return {
      accessToken: process.env.AMPLENOTE_ACCESS_TOKEN,
      refreshToken: process.env.AMPLENOTE_REFRESH_TOKEN || '',
      clientId: process.env.AMPLENOTE_CLIENT_ID || '',
      tokenUrl: 'https://api.amplenote.com/oauth/token',
      filePath: null,
    };
  }

  throw new Error(
    'Amplenote credentials not configured.\n\n' +
    'Option 1 — config file:\n' +
    '  Copy amplenote-config.example.json to your preferred location,\n' +
    '  fill in your credentials, then set:\n' +
    '    AMPLENOTE_CREDS_PATH=/path/to/your/amplenote-config.json\n\n' +
    'Option 2 — env vars:\n' +
    '  AMPLENOTE_ACCESS_TOKEN=your_token\n' +
    '  AMPLENOTE_REFRESH_TOKEN=your_refresh_token\n' +
    '  AMPLENOTE_CLIENT_ID=your_client_id\n\n' +
    'See the plugin README for OAuth setup instructions.'
  );
}

let creds = loadCredentials();

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

function httpRequest(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const postData = body != null ? JSON.stringify(body) : null;
    const options = {
      hostname: API_HOST,
      port: 443,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ─── Token Refresh ────────────────────────────────────────────────────────────

async function refreshToken() {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
  };

  const result = await httpRequest('POST', TOKEN_PATH, body, null);

  if (result.status !== 200) {
    throw new Error(`Token refresh failed (${result.status}): ${JSON.stringify(result.body)}`);
  }

  const tokenData = result.body;
  creds.accessToken = tokenData.access_token;
  if (tokenData.refresh_token) creds.refreshToken = tokenData.refresh_token;

  // Persist updated tokens back to config file
  if (creds.filePath && fs.existsSync(creds.filePath)) {
    const config = JSON.parse(fs.readFileSync(creds.filePath, 'utf8'));
    config.credentials.accessToken = tokenData.access_token;
    if (tokenData.refresh_token) config.credentials.refreshToken = tokenData.refresh_token;
    fs.writeFileSync(creds.filePath, JSON.stringify(config, null, 2));
  }

  return tokenData.access_token;
}

// ─── API Call with Auto-Refresh ───────────────────────────────────────────────

async function apiCall(method, apiPath, body = null) {
  let result = await httpRequest(method, `${API_BASE}${apiPath}`, body, creds.accessToken);

  if (result.status === 401) {
    await refreshToken();
    result = await httpRequest(method, `${API_BASE}${apiPath}`, body, creds.accessToken);
  }

  if (result.status >= 400) {
    throw new Error(`Amplenote API ${result.status}: ${JSON.stringify(result.body)}`);
  }

  return result.body;
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

async function listNotes({ tag, since } = {}) {
  const params = [];
  if (tag) params.push(`tag=${encodeURIComponent(tag)}`);
  if (since) params.push(`since=${since}`);
  const qs = params.length ? `?${params.join('&')}` : '';

  const data = await apiCall('GET', `/notes${qs}`);
  const notes = Array.isArray(data) ? data : (data.notes || []);
  return notes.map((n) => ({
    uuid: n.uuid,
    name: n.name,
    tags: (n.tags || []).map((t) => t.text || t),
    updated_at: n.updated_at,
  }));
}

async function getNote({ uuid }) {
  return await apiCall('GET', `/notes/${uuid}`);
}

async function createNote({ title, content = '', tags = [] }) {
  const body = { name: title, text: content };
  if (tags.length) body.tags = tags.map((t) => ({ text: t }));
  return await apiCall('POST', '/notes', body);
}

async function updateNote({ uuid, content }) {
  return await apiCall('PUT', `/notes/${uuid}`, { text: content });
}

async function deleteNote({ uuid }) {
  await apiCall('DELETE', `/notes/${uuid}`);
  return { success: true, uuid };
}

async function insertContent({ uuid, text }) {
  const body = {
    type: 'INSERT_NODES',
    nodes: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
  await apiCall('POST', `/notes/${uuid}/actions`, body);
  return { success: true };
}

async function insertTask({ uuid, text, important = false }) {
  const body = {
    type: 'INSERT_NODES',
    nodes: [{
      type: 'check_list_item',
      attrs: important ? { flags: 'I' } : {},
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    }],
  };
  await apiCall('POST', `/notes/${uuid}/actions`, body);
  return { success: true };
}

async function searchNotes({ query }) {
  const data = await apiCall('GET', '/notes');
  const notes = Array.isArray(data) ? data : (data.notes || []);
  const q = query.toLowerCase();
  return notes
    .filter((n) => {
      const titleMatch = (n.name || '').toLowerCase().includes(q);
      const tagMatch = (n.tags || []).some((t) => (t.text || t).toLowerCase().includes(q));
      return titleMatch || tagMatch;
    })
    .map((n) => ({
      uuid: n.uuid,
      name: n.name,
      tags: (n.tags || []).map((t) => t.text || t),
    }));
}

async function doRefreshToken() {
  const token = await refreshToken();
  return { success: true, access_token_preview: `${token.substring(0, 16)}...` };
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'amplenote_list_notes',
    description: 'List notes from Amplenote. Optionally filter by tag or changed since a Unix timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Filter notes by tag name' },
        since: { type: 'number', description: 'Unix timestamp — return only notes changed after this time' },
      },
    },
  },
  {
    name: 'amplenote_get_note',
    description: 'Get the full content of an Amplenote note by UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Note UUID' },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'amplenote_create_note',
    description: 'Create a new note in Amplenote with a title, optional content, and optional tags.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title' },
        content: { type: 'string', description: 'Initial note body (plain text or markdown)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply to the note',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'amplenote_update_note',
    description: 'Replace the entire content of an existing Amplenote note.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Note UUID' },
        content: { type: 'string', description: 'New content — replaces all existing content' },
      },
      required: ['uuid', 'content'],
    },
  },
  {
    name: 'amplenote_delete_note',
    description: 'Delete an Amplenote note by UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Note UUID' },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'amplenote_insert_content',
    description: 'Append a paragraph of text into an existing Amplenote note via the actions endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Note UUID' },
        text: { type: 'string', description: 'Text to insert as a new paragraph' },
      },
      required: ['uuid', 'text'],
    },
  },
  {
    name: 'amplenote_insert_task',
    description: 'Insert a checkbox task item into an existing Amplenote note.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Note UUID' },
        text: { type: 'string', description: 'Task text' },
        important: { type: 'boolean', description: 'Flag as important (default: false)' },
      },
      required: ['uuid', 'text'],
    },
  },
  {
    name: 'amplenote_search_notes',
    description: 'Search notes by title or tag (case-insensitive, client-side filter over all notes).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search string — matched against note title and tags' },
      },
      required: ['query'],
    },
  },
  {
    name: 'amplenote_refresh_token',
    description: 'Manually refresh the Amplenote OAuth access token and save it to the config file.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'amplenote', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result;
    switch (name) {
      case 'amplenote_list_notes':     result = await listNotes(args); break;
      case 'amplenote_get_note':       result = await getNote(args); break;
      case 'amplenote_create_note':    result = await createNote(args); break;
      case 'amplenote_update_note':    result = await updateNote(args); break;
      case 'amplenote_delete_note':    result = await deleteNote(args); break;
      case 'amplenote_insert_content': result = await insertContent(args); break;
      case 'amplenote_insert_task':    result = await insertTask(args); break;
      case 'amplenote_search_notes':   result = await searchNotes(args); break;
      case 'amplenote_refresh_token':  result = await doRefreshToken(); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
