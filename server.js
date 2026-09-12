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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'PASTE_YOUR_GEMINI_API_KEY_HERE';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
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

    const { message, history, webSearch, images, userId, studentMode, modelStyle } = req.body || {};
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

    // Model "personality" tiers — same backend model, different system-prompt presets.
    // Unlocked client-side via the XP system, same mechanism as avatar tiers.
    const MODEL_STYLES = {
      nova: 'Respond in a balanced, friendly, all-purpose style.',
      atlas: 'Respond with precise, structured, analytical reasoning — favor clarity and rigor, lay out logic step by step, flag assumptions and edge cases.',
      comet: 'Respond with a creative, expressive, conversational voice — vivid language, engaging framing, still accurate.',
      quantum: 'Respond as a deep technical/coding specialist — favor complete, production-quality code, explain tradeoffs, anticipate bugs.'
    };
    const styleInstruction = MODEL_STYLES[modelStyle] || MODEL_STYLES.nova;
    const studentInstruction = studentMode
      ? ' STUDENT MODE IS ON: teach, don\'t just answer. Explain step by step like a patient tutor, check the learner\'s understanding, and for homework-like questions guide them to the answer rather than just handing it over.'
      : '';

    const baseBody = {
      contents,
      systemInstruction: {
        parts: [{ text: 'You are Luminous AI, a premium, warm, precise assistant. Be clear, concise, and helpful. Format code in fenced code blocks with a language tag. Use $...$ for inline math and $$...$$ for block math — never write raw LaTeX outside these delimiters. When asked for coding help, give complete, working, well-commented code and briefly explain the key decisions. When helping plan a trip, ask only for missing essentials (destination, dates, budget, interests) and then give a concrete day-by-day structure. ' + styleInstruction + studentInstruction }]
      }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    async function callGemini(withSearch) {
      const body = { ...baseBody };
      if (withSearch) body.tools = [{ google_search: {} }];
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      return { ok: r.ok, status: r.status, data: d };
    }

    let result = await callGemini(!!webSearch);
    let searchFellBack = false;

    // Grounding/search can fail for reasons unrelated to the rest of the request
    // (e.g. billing not enabled on the key's project). Don't let that kill the whole reply —
    // fall back to a normal answer instead of showing a hard error.
    if (!result.ok && webSearch) {
      console.error('Gemini web-search request failed, retrying without search:', JSON.stringify(result.data));
      searchFellBack = true;
      result = await callGemini(false);
    }

    if (!result.ok) {
      console.error('Gemini error:', JSON.stringify(result.data));
      return res.status(502).json({
        error: 'Gemini request failed',
        detail: result.data && result.data.error && result.data.error.message
      });
    }

    const candidate = result.data.candidates && result.data.candidates[0];
    let reply = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(p => p.text || '').join('\n').trim()
      : "I couldn't generate a response for that — try rephrasing.";

    if (searchFellBack) {
      reply = "*(Web search is temporarily unavailable, so this answer isn't grounded in live results.)*\n\n" + reply;
    }

    // Pull the sites actually used for grounding, if any, so the client can show them.
    let sources = [];
    const gm = candidate && candidate.groundingMetadata;
    if (gm && Array.isArray(gm.groundingChunks)) {
      sources = gm.groundingChunks
        .map(c => c.web && { title: c.web.title || c.web.uri, uri: c.web.uri })
        .filter(Boolean);
      // de-dupe by uri
      const seen = new Set();
      sources = sources.filter(s => !seen.has(s.uri) && seen.add(s.uri));
    }

    res.json({ reply, model: GEMINI_MODEL, searchFellBack, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Image generation endpoint — used for the general "generate an image" feature
 * and for the anime-avatar unlocks in the XP/challenges system.
 * Uses Gemini's native image-output model ("Nano Banana"). Costs 1 request
 * from the same daily quota as chat, to keep the quota logic in one place.
 */
app.post('/api/generate-image', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
    }
    const { prompt, userId } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    if (!checkAndConsumeQuota(userId)) {
      return res.status(429).json({ error: 'Daily limit reached', reply: "You've used all your requests for today — watch an ad in the app to unlock 10 more." });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Image gen error:', JSON.stringify(data));
      return res.status(502).json({ error: 'Image generation failed', detail: data.error && data.error.message });
    }
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const imgPart = parts.find(p => p.inlineData || p.inline_data);
    const inline = imgPart && (imgPart.inlineData || imgPart.inline_data);
    if (!inline) {
      return res.status(502).json({ error: 'No image returned', detail: 'Model responded without image data — try a different prompt.' });
    }
    const mime = inline.mimeType || inline.mime_type || 'image/png';
    res.json({ image: `data:${mime};base64,${inline.data}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Luminous AI backend running on port ${PORT} (model: ${GEMINI_MODEL})`));
