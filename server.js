'use strict';
const http = require('http');
const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const DATA_DIR   = process.env.HERMES_HOME || '/data';
const SESSIONS_F = path.join(DATA_DIR, 'sessions.json');
// v0.15.0 patch: explicit opt-in for 0.0.0.0 bind — no bind-host inference
const BIND_HOST  = process.env.HERMES_INSECURE === '1' ? '0.0.0.0' : '127.0.0.1';
// Railway / cloud deployments expose PORT and need 0.0.0.0 automatically
const LISTEN_HOST = process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME
  ? '0.0.0.0'
  : BIND_HOST;

// ── Persistent session store ──────────────────────────────────────
let sessions = new Map();

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_F)) {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_F, 'utf8'));
      sessions = new Map(Object.entries(raw));
      console.log(`[memory] Loaded ${sessions.size} sessions from disk`);
    }
  } catch (e) {
    console.error('[memory] Failed to load sessions:', e.message);
  }
}

function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [k, v] of sessions) obj[k] = v;
    fs.writeFileSync(SESSIONS_F, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.error('[memory] Failed to save sessions:', e.message);
  }
}

loadSessions();

// Prune sessions older than 7 days, autosave every 5 min
setInterval(() => {
  const cut = Date.now() - 7 * 24 * 3600000;
  for (const [k, v] of sessions) if (v.t < cut) sessions.delete(k);
  saveSessions();
}, 5 * 60 * 1000);

// ── Sliding context window ────────────────────────────────────────
// v0.15.0: hindsight observation-default — keep last 20, summarise older
function buildContext(history) {
  const KEEP = 20;
  if (history.length <= KEEP) return history;
  const older  = history.slice(0, history.length - KEEP);
  const recent = history.slice(-KEEP);
  const summary = older.map(m => `${m.role}: ${m.content.slice(0, 150)}`).join('\n');
  return [
    { role: 'system', content: `[Earlier conversation summary]\n${summary}\n[End summary]` },
    ...recent
  ];
}

// ── CORS helper ───────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,Authorization,x-ic-url,x-session-id,x-session-name,x-model');
}

// v0.15.0: web-URL redaction passthrough — strip bearer tokens from logs
function redactUrl(u) {
  try { return new URL(u).hostname; } catch { return u; }
}

function jsonReply(content, model) {
  return JSON.stringify({
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'claude-sonnet-4-5',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: content.length, total_tokens: content.length }
  });
}

// ── /model picker — unified list (v0.15.0) ───────────────────────
const MODELS = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-3-5',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022'
];

// ── Request handler ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  const url = req.url.split('?')[0];

  // Health / gateway probe-stepdown safety (v0.15.0)
  if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/status')) {
    const list = [];
    for (const [k, v] of sessions)
      list.push({ id: k, name: v.name || k, messages: v.h.length, last: new Date(v.t).toISOString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'hermesclaude', version: '0.15.0', sessions: list }));
  }

  // /model — unified picker (v0.15.0)
  if (req.method === 'GET' && url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: MODELS.map(id => ({ id, object: 'model' })) }));
  }

  // DELETE /session
  if (req.method === 'DELETE' && url === '/session') {
    const sid = req.headers['x-session-id'];
    if (sid && sessions.has(sid)) { sessions.delete(sid); saveSessions(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Chat completions
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/api/chat')) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      const userMsgs = (payload.messages || []).filter(m => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No user message' }));
      }

      const prompt = typeof last.content === 'string'
        ? last.content
        : (last.content || []).map(c => c.text || '').join(' ');

      // v0.15.0: /yolo session bypass — x-session-id: yolo skips history
      const sid  = req.headers['x-session-id'] || 'default';
      const yolo = sid === 'yolo';
      const sname = req.headers['x-session-name'] || sid;
      // v0.15.0: unified /model header takes precedence over payload model
      const model = req.headers['x-model'] || payload.model || 'claude-sonnet-4-5';

      if (!yolo) {
        if (!sessions.has(sid)) {
          sessions.set(sid, { h: [], t: Date.now(), name: sname });
          console.log(`[memory] New session: ${sid}`);
        }
      }
      const sess = yolo ? { h: [], t: Date.now(), name: 'yolo' } : sessions.get(sid);
      if (!yolo) { sess.t = Date.now(); if (sname !== sid) sess.name = sname; }

      const ctx = buildContext(sess.h);
      console.log(`[memory] Session ${sid}: ${sess.h.length} stored, ${ctx.length} in context`);

      // Write history + output temp files
      const histFile = path.join(os.tmpdir(), `hist_${Date.now()}.json`);
      const outFile  = path.join(os.tmpdir(), `out_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
      try { fs.writeFileSync(histFile, JSON.stringify(ctx)); } catch {}

      // Spawn hermes-agent v0.15.0 runner with Claude model
      // MCP server bare-command PATH resolution (v0.15.0): use env PATH as-is
      const env = {
        ...process.env,
        HERMES_QUIET: '1',
        HOME: '/data',
        PYTHONUNBUFFERED: '1',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        HERMES_MODEL: model
      };

      // hermes-agent v0.15.0 installed via pip — available on PATH
      const child = spawn('python3', ['-m', 'hermes', 'run',
        '--out', outFile,
        '--history', histFile,
        '--model', model,
        '--', prompt
      ], { env, shell: false });

      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });

      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      // Keep-alive ping every 10 s (v0.15.0 gateway probe-stepdown)
      const ka = setInterval(() => { try { res.write(''); } catch {} }, 10000);

      // 5-minute timeout
      const timer = setTimeout(() => {
        clearInterval(ka);
        child.kill('SIGTERM');
        // v0.15.0: kanban worker SIGTERM — give 2s grace before SIGKILL
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
        if (res.writableEnded) return;
        let text = 'Timed out after 5 minutes.';
        try { if (fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf8').trim() || text; } catch {}
        try { fs.unlinkSync(outFile); } catch {}
        try { fs.unlinkSync(histFile); } catch {}
        res.end(jsonReply(text, model));
      }, 300000);

      child.on('close', () => {
        clearTimeout(timer);
        clearInterval(ka);
        if (res.writableEnded) return;

        let text = '';
        try { if (fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
        try { fs.unlinkSync(outFile); } catch {}
        try { fs.unlinkSync(histFile); } catch {}

        if (!text) {
          text = stderr ? 'Error: ' + stderr.slice(0, 600) : '(no response)';
          if (stderr) console.error('[hermes] stderr:', redactUrl(stderr.slice(0, 400)));
        }

        if (!yolo) {
          sess.h.push({ role: 'user',      content: prompt });
          sess.h.push({ role: 'assistant', content: text   });
          if (sess.h.length > 100) sess.h = sess.h.slice(-100);
          saveSessions();
          console.log(`[memory] Session ${sid} now has ${sess.h.length} messages`);
        }

        res.end(jsonReply(text, model));
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.timeout = 360000;
server.listen(PORT, LISTEN_HOST, () => {
  console.log(`HermesClaude v0.15.0 gateway on ${LISTEN_HOST}:${PORT}`);
  console.log(`Insecure bind: ${process.env.HERMES_INSECURE === '1' ? 'YES (HERMES_INSECURE=1)' : 'no'}`);
});
