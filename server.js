require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// Only the public/ folder is ever served over HTTP — server.js, package.json,
// .env, node_modules, etc. are never reachable by a client.
app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny', index: false }));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasKey: !!process.env.GEMINI_API_KEY });
});

/* ---------- tiny in-memory rate limiter for /api/ask ----------
   Keeps a free-tier Gemini key from being drained by a bot or a
   refresh loop. Not meant to replace a real rate limiter at scale,
   but plenty for a competition/demo deployment. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 12;
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recent = (hits.get(ip) || []).filter(t => t > windowStart);

  if (recent.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many questions at once — please wait a moment and try again.' });
  }

  recent.push(now);
  hits.set(ip, recent);
  next();
}

// Periodic cleanup so the map doesn't grow forever on a long-running server.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, arr] of hits) {
    const kept = arr.filter(t => t > cutoff);
    if (kept.length) hits.set(ip, kept);
    else hits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

app.post('/api/ask', rateLimit, async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is empty.' });
  if (message.length > 500) return res.status(400).json({ error: 'Message is too long (500 characters max).' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured.' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key);
    const prompt = `You are Terra, a friendly sustainability assistant for a student web competition.
Answer clearly and practically. Focus on environment, climate, water, energy, waste, recycling, biodiversity, food and everyday sustainable choices.
Keep the answer concise and useful. Do not invent live statistics.
User question: ${message}`;

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
      }),
      signal: controller.signal
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('Gemini error:', data);
      return res.status(r.status).json({ error: data?.error?.message || 'Gemini API request failed.' });
    }

    const answer = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    if (!answer) return res.status(502).json({ error: 'Gemini returned no answer.' });

    res.json({ answer });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('Gemini request timed out for message:', message.slice(0, 80));
      return res.status(504).json({ error: 'The AI took too long to respond.' });
    }
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error.' });
  } finally {
    clearTimeout(timeout);
  }
});

// Anything else under /api is an unknown endpoint.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => console.log(`Terra running at http://localhost:${PORT}`));
