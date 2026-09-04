/**
 * Luminous AI — backend server
 * Deploy this on Render as a Web Service.
 *
 * Responsibilities:
 *  - Keeps your GEMINI_API_KEY secret (never expose it in the HTML app)
 *  - Proxies chat requests to Gemini 3.6 Flash
 *  - Supports web-search grounding when the client asks for it
 *  - Accepts image attachments (base64 data URLs) for vision input
 *  - Basic per-user daily quota tracked in memory (swap for Firebase
 *    Realtime Database if you want it to persist across restarts and
 *    across devices — same pattern as the CCC app's student quotas)
 *
 * Required environment variables on Render:
 *   GEMINI_API_KEY      - your Gemini API key
 *   GEMINI_MODEL        - defaults to "gemini-3.6-flash" if unset
 *   ALLOWED_ORIGIN       - optional, lock CORS to your app's origin
 *   DAILY_LIMIT          - optional, defaults to 500
 */

const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '15mb' })); // room for image attachments
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

// Paste your Gemini API key between the quotes below if you're not using
// a Render environment variable. If GEMINI_API_KEY is set on Render, that
// takes priority automatically — you don't need to touch this line.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '10000', 10);

// --- very simple in-memory quota store -------------------------------
// NOTE: resets on server restart / redeploy, and doesn't sync across
// devices. The client also tracks its own quota in localStorage.
// For production-grade tracking, mirror this into Firebase Realtime DB
// the same way the CCC owner app tracks per-student quotas.
const quotaStore = new Map(); // userId -> { date, remaining }

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function checkAndConsumeQuota(userId) {
  const key = userId || 'anonymous';
  let entry = quotaStore.get(key);
  if (!entry || entry.date !== todayKey()) {
    entry = { date: todayKey(), remaining: DAILY_LIMIT };
  }
  if (entry.remaining <= 0) return false;
  entry.remaining -= 1;
  quotaStore.set(key, entry);
  return true;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Luminous AI backend', model: GEMINI_MODEL });
});

app.get('/api/quota/:userId', (req, res) => {
  const entry = quotaStore.get(req.params.userId);
  const remaining = entry && entry.date === todayKey() ? entry.remaining : DAILY_LIMIT;
  res.json({ remaining, limit: DAILY_LIMIT });
});

app.post('/api/quota/bonus', (req, res) => {
  const { userId, amount } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  let entry = quotaStore.get(userId);
  if (!entry || entry.date !== todayKey()) entry = { date: todayKey(), remaining: DAILY_LIMIT };
  entry.remaining += (amount || 10);
  quotaStore.set(userId, entry);
  res.json({ remaining: entry.remaining });
});

app.post('/api/chat', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
    }

    const { message, history, webSearch, images, userId } = req.body || {};
    if (!message && (!images || images.length === 0)) {
      return res.status(400).json({ error: 'Empty message' });
    }

    if (!checkAndConsumeQuota(userId)) {
      return res.status(429).json({ error: 'Daily limit reached', reply: "You've used all your requests for today — watch an ad in the app to unlock 10 more." });
    }

    // Build Gemini "contents" array from recent history + new turn
    const contents = [];
    (history || []).forEach(turn => {
      contents.push({
        role: turn.role === 'ai' ? 'model' : 'user',
        parts: [{ text: turn.text || '' }]
      });
    });

    const parts = [];
    if (message) parts.push({ text: message });
    (images || []).forEach(dataUrl => {
      const match = /^data:(image\/[a-zA-Z]+);base64,(.+)$/.exec(dataUrl);
      if (match) {
        parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
      }
    });
    contents.push({ role: 'user', parts });

    const body = {
      contents,
      systemInstruction: {
        parts: [{ text: 'You are Luminous AI, a premium, warm, precise assistant. Be clear, concise, and helpful. Format code in fenced code blocks.' }]
      }
    };

    if (webSearch) {
      body.tools = [{ google_search: {} }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini error:', JSON.stringify(data));
      return res.status(502).json({ error: 'Gemini request failed', detail: data.error && data.error.message });
    }

    const candidate = data.candidates && data.candidates[0];
    const reply = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(p => p.text || '').join('\n').trim()
      : "I couldn't generate a response for that — try rephrasing.";

    res.json({ reply, model: GEMINI_MODEL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Luminous AI backend running on port ${PORT} (model: ${GEMINI_MODEL})`));
