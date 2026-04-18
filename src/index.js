#!/usr/bin/env node
/**
 * Amplenote + Todoist + UniFi MCP Server for Claude Code
 *
 * Amplenote credentials (in priority order):
 *   1. AMPLENOTE_CREDS_PATH env var → path to an amplenote-config.json file
 *   2. Direct env vars: AMPLENOTE_ACCESS_TOKEN + AMPLENOTE_REFRESH_TOKEN + AMPLENOTE_CLIENT_ID
 *
 * Todoist credentials:
 *   TODOIST_API_TOKEN env var
 *
 * UniFi credentials:
 *   UNIFI_API_KEY env var (from https://unifi.ui.com → Settings → API Keys)
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

// ─── Amplenote Config ─────────────────────────────────────────────────────────

const AMPLENOTE_HOST = 'api.amplenote.com';
const AMPLENOTE_BASE = '/v4';
const TOKEN_PATH = '/oauth/token';

function loadAmplenoteCredentials() {
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
  if (process.env.AMPLENOTE_ACCESS_TOKEN) {
    return {
      accessToken: process.env.AMPLENOTE_ACCESS_TOKEN,
      refreshToken: process.env.AMPLENOTE_REFRESH_TOKEN || '',
      clientId: process.env.AMPLENOTE_CLIENT_ID || '',
      tokenUrl: 'https://api.amplenote.com/oauth/token',
      filePath: null,
    };
  }
  throw new Error('Amplenote credentials not configured. Set AMPLENOTE_CREDS_PATH or AMPLENOTE_ACCESS_TOKEN.');
}

let ampCreds = loadAmplenoteCredentials();

// ─── Todoist Config ───────────────────────────────────────────────────────────

const TODOIST_HOST = 'api.todoist.com';
const TODOIST_BASE = '/rest/v2';

let todoistCreds;
try {
  if (!process.env.TODOIST_API_TOKEN) throw new Error();
  todoistCreds = { apiToken: process.env.TODOIST_API_TOKEN };
} catch (_) {
  todoistCreds = null;
}

// ─── UniFi Config ─────────────────────────────────────────────────────────────

const UNIFI_HOST = 'api.ui.com';
const UNIFI_BASE = '/v1';

let unifiCreds;
try {
  if (!process.env.UNIFI_API_KEY) throw new Error();
  unifiCreds = { apiKey: process.env.UNIFI_API_KEY };
} catch (_) {
  unifiCreds = null;
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

function httpRequest(hostname, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const postData = body != null ? JSON.stringify(body) : null;
    const options = {
      hostname,
      port: 443,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
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

// ─── Amplenote: Token Refresh ─────────────────────────────────────────────────

async function refreshAmplenoteToken() {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: ampCreds.refreshToken,
    client_id: ampCreds.clientId,
  };
  const result = await httpRequest(AMPLENOTE_HOST, 'POST', TOKEN_PATH, body, {});
  if (result.status !== 200) throw new Error(`Token refresh failed (${result.status}): ${JSON.stringify(result.body)}`);
  const tokenData = result.body;
  ampCreds.accessToken = tokenData.access_token;
  if (tokenData.refresh_token) ampCreds.refreshToken = tokenData.refresh_token;
  if (ampCreds.filePath && fs.existsSync(ampCreds.filePath)) {
    const config = JSON.parse(fs.readFileSync(ampCreds.filePath, 'utf8'));
    config.credentials.accessToken = tokenData.access_token;
    if (tokenData.refresh_token) config.credentials.refreshToken = tokenData.refresh_token;
    fs.writeFileSync(ampCreds.filePath, JSON.stringify(config, null, 2));
  }
  return tokenData.access_token;
}

// ─── API Call Helpers ─────────────────────────────────────────────────────────

async function ampCall(method, apiPath, body = null) {
  let result = await httpRequest(AMPLENOTE_HOST, method, `${AMPLENOTE_BASE}${apiPath}`, body,
    { Authorization: `Bearer ${ampCreds.accessToken}` });
  if (result.status === 401) {
    await refreshAmplenoteToken();
    result = await httpRequest(AMPLENOTE_HOST, method, `${AMPLENOTE_BASE}${apiPath}`, body,
      { Authorization: `Bearer ${ampCreds.accessToken}` });
  }
  if (result.status >= 400) throw new Error(`Amplenote API ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function todoCall(method, apiPath, body = null) {
  if (!todoistCreds) throw new Error('Todoist not configured. Set TODOIST_API_TOKEN env var.');
  const result = await httpRequest(TODOIST_HOST, method, `${TODOIST_BASE}${apiPath}`, body,
    { Authorization: `Bearer ${todoistCreds.apiToken}` });
  if (result.status >= 400) throw new Error(`Todoist API ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function unifiCall(method, apiPath, body = null) {
  if (!unifiCreds) throw new Error('UniFi not configured. Set UNIFI_API_KEY env var.');
  const result = await httpRequest(UNIFI_HOST, method, `${UNIFI_BASE}${apiPath}`, body,
    { 'X-API-KEY': unifiCreds.apiKey, Accept: 'application/json' });
  if (result.status >= 400) throw new Error(`UniFi API ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

// ─── Amplenote Tools ──────────────────────────────────────────────────────────

async function listNotes({ tag, since } = {}) {
  const params = [];
  if (tag) params.push(`tag=${encodeURIComponent(tag)}`);
  if (since) params.push(`since=${since}`);
  const qs = params.length ? `?${params.join('&')}` : '';
  const data = await ampCall('GET', `/notes${qs}`);
  const notes = Array.isArray(data) ? data : (data.notes || []);
  return notes.map((n) => ({ uuid: n.uuid, name: n.name, tags: (n.tags || []).map((t) => t.text || t), updated_at: n.updated_at }));
}
async function getNote({ uuid }) { return await ampCall('GET', `/notes/${uuid}`); }
async function createNote({ title, content = '', tags = [] }) {
  const body = { name: title, text: content };
  if (tags.length) body.tags = tags.map((t) => ({ text: t }));
  return await ampCall('POST', '/notes', body);
}
async function updateNote({ uuid, content }) { return await ampCall('PUT', `/notes/${uuid}`, { text: content }); }
async function deleteNote({ uuid }) { await ampCall('DELETE', `/notes/${uuid}`); return { success: true, uuid }; }
async function insertContent({ uuid, text }) {
  await ampCall('POST', `/notes/${uuid}/actions`, { type: 'INSERT_NODES', nodes: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  return { success: true };
}
async function insertTask({ uuid, text, important = false }) {
  await ampCall('POST', `/notes/${uuid}/actions`, { type: 'INSERT_NODES', nodes: [{ type: 'check_list_item', attrs: important ? { flags: 'I' } : {}, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }] });
  return { success: true };
}
async function searchNotes({ query }) {
  const data = await ampCall('GET', '/notes');
  const notes = Array.isArray(data) ? data : (data.notes || []);
  const q = query.toLowerCase();
  return notes.filter((n) => (n.name || '').toLowerCase().includes(q) || (n.tags || []).some((t) => (t.text || t).toLowerCase().includes(q)))
    .map((n) => ({ uuid: n.uuid, name: n.name, tags: (n.tags || []).map((t) => t.text || t) }));
}
async function doRefreshAmplenoteToken() {
  const token = await refreshAmplenoteToken();
  return { success: true, access_token_preview: `${token.substring(0, 16)}...` };
}

// ─── Todoist Tools ────────────────────────────────────────────────────────────

async function todoListProjects() { return await todoCall('GET', '/projects'); }
async function todoGetTasks({ project_id, label, priority, filter } = {}) {
  const params = [];
  if (project_id) params.push(`project_id=${encodeURIComponent(project_id)}`);
  if (label) params.push(`label=${encodeURIComponent(label)}`);
  if (priority) params.push(`priority=${priority}`);
  if (filter) params.push(`filter=${encodeURIComponent(filter)}`);
  return await todoCall('GET', `/tasks${params.length ? '?' + params.join('&') : ''}`);
}
async function todoGetTask({ id }) { return await todoCall('GET', `/tasks/${id}`); }
async function todoCreateTask({ content, description, project_id, due_string, priority, labels }) {
  const body = { content };
  if (description) body.description = description;
  if (project_id) body.project_id = project_id;
  if (due_string) body.due_string = due_string;
  if (priority) body.priority = priority;
  if (labels) body.labels = labels;
  return await todoCall('POST', '/tasks', body);
}
async function todoUpdateTask({ id, content, description, due_string, priority, labels }) {
  const body = {};
  if (content) body.content = content;
  if (description) body.description = description;
  if (due_string) body.due_string = due_string;
  if (priority) body.priority = priority;
  if (labels) body.labels = labels;
  return await todoCall('POST', `/tasks/${id}`, body);
}
async function todoCompleteTask({ id }) { await todoCall('POST', `/tasks/${id}/close`, null); return { success: true, id }; }
async function todoDeleteTask({ id }) { await todoCall('DELETE', `/tasks/${id}`); return { success: true, id }; }

// ─── UniFi Tools ──────────────────────────────────────────────────────────────

async function unifiListHosts() { return await unifiCall('GET', '/hosts'); }
async function unifiGetHost({ id }) { return await unifiCall('GET', `/hosts/${id}`); }
async function unifiListSites({ host_id } = {}) {
  const qs = host_id ? `?hostId=${encodeURIComponent(host_id)}` : '';
  return await unifiCall('GET', `/sites${qs}`);
}
async function unifiListDevices({ host_id, site_id } = {}) {
  const params = [];
  if (host_id) params.push(`hostId=${encodeURIComponent(host_id)}`);
  if (site_id) params.push(`siteId=${encodeURIComponent(site_id)}`);
  return await unifiCall('GET', `/devices${params.length ? '?' + params.join('&') : ''}`);
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  // Amplenote
  { name: 'amplenote_list_notes', description: 'List notes from Amplenote. Optionally filter by tag or changed since a Unix timestamp.', inputSchema: { type: 'object', properties: { tag: { type: 'string' }, since: { type: 'number' } } } },
  { name: 'amplenote_get_note', description: 'Get the full content of an Amplenote note by UUID.', inputSchema: { type: 'object', properties: { uuid: { type: 'string' } }, required: ['uuid'] } },
  { name: 'amplenote_create_note', description: 'Create a new note in Amplenote.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title'] } },
  { name: 'amplenote_update_note', description: 'Replace the entire content of an Amplenote note.', inputSchema: { type: 'object', properties: { uuid: { type: 'string' }, content: { type: 'string' } }, required: ['uuid', 'content'] } },
  { name: 'amplenote_delete_note', description: 'Delete an Amplenote note.', inputSchema: { type: 'object', properties: { uuid: { type: 'string' } }, required: ['uuid'] } },
  { name: 'amplenote_insert_content', description: 'Append a paragraph to an Amplenote note.', inputSchema: { type: 'object', properties: { uuid: { type: 'string' }, text: { type: 'string' } }, required: ['uuid', 'text'] } },
  { name: 'amplenote_insert_task', description: 'Insert a checkbox task into an Amplenote note.', inputSchema: { type: 'object', properties: { uuid: { type: 'string' }, text: { type: 'string' }, important: { type: 'boolean' } }, required: ['uuid', 'text'] } },
  { name: 'amplenote_search_notes', description: 'Search Amplenote notes by title or tag.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'amplenote_refresh_token', description: 'Refresh the Amplenote OAuth token.', inputSchema: { type: 'object', properties: {} } },
  // Todoist
  { name: 'todoist_list_projects', description: 'List all Todoist projects.', inputSchema: { type: 'object', properties: {} } },
  { name: 'todoist_get_tasks', description: 'Get active Todoist tasks with optional filters.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, label: { type: 'string' }, priority: { type: 'number' }, filter: { type: 'string', description: 'Todoist filter string e.g. "today", "overdue"' } } } },
  { name: 'todoist_get_task', description: 'Get a specific Todoist task by ID.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'todoist_create_task', description: 'Create a new Todoist task.', inputSchema: { type: 'object', properties: { content: { type: 'string' }, description: { type: 'string' }, project_id: { type: 'string' }, due_string: { type: 'string' }, priority: { type: 'number' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['content'] } },
  { name: 'todoist_update_task', description: 'Update a Todoist task.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, description: { type: 'string' }, due_string: { type: 'string' }, priority: { type: 'number' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['id'] } },
  { name: 'todoist_complete_task', description: 'Mark a Todoist task complete.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'todoist_delete_task', description: 'Delete a Todoist task.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  // UniFi
  { name: 'unifi_list_hosts', description: 'List all UniFi hosts (consoles) in the Site Manager account.', inputSchema: { type: 'object', properties: {} } },
  { name: 'unifi_get_host', description: 'Get details of a specific UniFi host by ID.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Host ID' } }, required: ['id'] } },
  { name: 'unifi_list_sites', description: 'List UniFi sites, optionally filtered by host.', inputSchema: { type: 'object', properties: { host_id: { type: 'string', description: 'Filter by host ID' } } } },
  { name: 'unifi_list_devices', description: 'List UniFi devices, optionally filtered by host or site.', inputSchema: { type: 'object', properties: { host_id: { type: 'string', description: 'Filter by host ID' }, site_id: { type: 'string', description: 'Filter by site ID' } } } },
];

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'amplenote-todoist-unifi', version: '3.0.0' },
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
      case 'amplenote_refresh_token':  result = await doRefreshAmplenoteToken(); break;
      case 'todoist_list_projects':    result = await todoListProjects(); break;
      case 'todoist_get_tasks':        result = await todoGetTasks(args); break;
      case 'todoist_get_task':         result = await todoGetTask(args); break;
      case 'todoist_create_task':      result = await todoCreateTask(args); break;
      case 'todoist_update_task':      result = await todoUpdateTask(args); break;
      case 'todoist_complete_task':    result = await todoCompleteTask(args); break;
      case 'todoist_delete_task':      result = await todoDeleteTask(args); break;
      case 'unifi_list_hosts':         result = await unifiListHosts(); break;
      case 'unifi_get_host':           result = await unifiGetHost(args); break;
      case 'unifi_list_sites':         result = await unifiListSites(args); break;
      case 'unifi_list_devices':       result = await unifiListDevices(args); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => { process.stderr.write(`Fatal: ${err.message}\n`); process.exit(1); });
