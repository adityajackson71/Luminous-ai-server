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
const GEMINI_VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || 'veo-3.1-generate-preview';
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '500', 10);

function friendlyQuotaMessage(rawDetail) {
  return "Google's Gemini API has temporarily rate-limited this key (its own limit, separate from the app's daily counter). Free-tier keys allow a limited number of requests per minute and per day — this usually clears within a minute or so, or resets at the next daily cycle. If it keeps happening, enabling billing on the Google Cloud project tied to this API key raises those limits a lot. Details from Google: " + (rawDetail || 'quota exceeded');
}

// Gemini's 429 responses include a structured RetryInfo detail with the exact
// cooldown (e.g. "58.28s") — pull that out so the client can show a real
// countdown and auto-retry instead of dumping Google's whole error paragraph.
function extractRetryDelaySeconds(errBody) {
  try {
    const parsed = JSON.parse(errBody);
    const details = (parsed.error && parsed.error.details) || [];
    const retryInfo = details.find(d => (d['@type'] || '').includes('RetryInfo'));
    if (retryInfo && retryInfo.retryDelay) {
      const seconds = parseFloat(String(retryInfo.retryDelay).replace('s', ''));
      if (!isNaN(seconds)) return Math.ceil(seconds);
    }
  } catch (e) {}
  return null;
}

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
      quantum: 'Respond as a deep technical/coding specialist — favor complete, production-quality, idiomatic code, explain tradeoffs, anticipate bugs and edge cases, and never truncate or abbreviate code with "...rest of code..." placeholders.'
    };
    const styleInstruction = MODEL_STYLES[modelStyle] || MODEL_STYLES.nova;
    const studentInstruction = studentMode
      ? ' STUDENT MODE IS ON: teach, don\'t just answer. Explain step by step like a patient tutor, check the learner\'s understanding, and for homework-like questions guide them to the answer rather than just handing it over.'
      : '';

    const CODING_INSTRUCTION = ' When the request involves code: think through the requirements before writing, then produce complete, runnable, well-structured code with meaningful names and brief inline comments on non-obvious parts. Handle edge cases and errors explicitly rather than ignoring them. Never truncate code or replace sections with placeholders like "// rest stays the same" — always output the full file or function. After the code, briefly explain key design decisions and mention any real limitations or follow-ups. Prefer modern, idiomatic syntax for the language in question.';

    const baseBody = {
      contents,
      systemInstruction: {
        parts: [{ text: 'You are Luminous AI, a premium, warm, precise assistant. Be clear, concise, and helpful. Have genuine personality — curious, encouraging, and direct rather than generic or robotic. Format code in fenced code blocks with a language tag. Use $...$ for inline math and $$...$$ for block math — never write raw LaTeX outside these delimiters. When helping plan a trip, ask only for missing essentials (destination, dates, budget, interests) and then give a concrete day-by-day structure. When a request is ambiguous, make a reasonable assumption and say so briefly rather than stalling with clarifying questions.' + CODING_INSTRUCTION + ' ' + styleInstruction + studentInstruction }]
      },
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 }
    };

    const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

    async function openStream(withSearch) {
      const body = { ...baseBody };
      if (withSearch) body.tools = [{ google_search: {} }];
      return fetch(streamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }

    let upstream = await openStream(!!webSearch);
    let searchFellBack = false;

    // Grounding/search can fail for reasons unrelated to the rest of the request
    // (e.g. billing not enabled for grounding specifically). Fall back to a normal
    // streamed answer instead of showing a hard error — but ONLY when the failure
    // looks search-specific. A genuine quota/rate-limit error will fail identically
    // on retry, so retrying just doubles the wait and burns a second request for nothing.
    if (!upstream.ok && webSearch) {
      const errBody = await upstream.text().catch(() => '');
      const isQuotaOrAuth = /RESOURCE_EXHAUSTED|exceeded your current quota|PERMISSION_DENIED|API key/i.test(errBody);
      if (!isQuotaOrAuth) {
        console.error('Gemini web-search stream failed, retrying without search:', errBody);
        searchFellBack = true;
        upstream = await openStream(false);
      } else {
        console.error('Gemini stream failed with a quota/auth error — not retrying:', errBody);
        const retryAfterSeconds = extractRetryDelaySeconds(errBody);
        return res.status(429).json({
          error: 'Gemini quota exceeded',
          detail: retryAfterSeconds ? `Rate-limited by Google — back in about ${retryAfterSeconds}s.` : friendlyQuotaMessage(null),
          retryAfterSeconds
        });
      }
    }

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      console.error('Gemini stream error:', errBody);
      const isQuota = /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(errBody);
      if (isQuota) {
        const retryAfterSeconds = extractRetryDelaySeconds(errBody);
        return res.status(429).json({
          error: 'Gemini quota exceeded',
          detail: retryAfterSeconds ? `Rate-limited by Google — back in about ${retryAfterSeconds}s.` : friendlyQuotaMessage(null),
          retryAfterSeconds
        });
      }
      let detail;
      try { detail = JSON.parse(errBody).error?.message; } catch (e) { detail = errBody; }
      return res.status(502).json({ error: 'Gemini request failed', detail });
    }

    // From here on we're committed to an SSE response — stream text deltas as they arrive.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.flushHeaders && res.flushHeaders();

    if (searchFellBack) {
      res.write(`data: ${JSON.stringify({ note: "Web search is temporarily unavailable, so this answer isn't grounded in live results." })}\n\n`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sources = [];
    let gotAnyText = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Normalize line endings — Gemini's SSE stream may use \r\n, and if we
      // only split on \n\n, CRLF-style events never match and the whole
      // response silently buffers with nothing parsed until the stream ends.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent.split('\n').filter(l => l.startsWith('data:'));
        if (!dataLines.length) continue;
        const jsonStr = dataLines.map(l => l.slice(5).trim()).join('');
        if (!jsonStr) continue;
        let evt;
        try { evt = JSON.parse(jsonStr); } catch (e) { console.error('SSE parse failed for chunk:', jsonStr.slice(0,200)); continue; }
        const cand = evt.candidates && evt.candidates[0];
        const textPiece = cand && cand.content && cand.content.parts
          ? cand.content.parts.map(p => p.text || '').join('')
          : '';
        if (textPiece) {
          gotAnyText = true;
          res.write(`data: ${JSON.stringify({ delta: textPiece })}\n\n`);
        }
        const gm = cand && cand.groundingMetadata;
        if (gm && Array.isArray(gm.groundingChunks)) {
          sources = gm.groundingChunks.map(c => c.web && { title: c.web.title || c.web.uri, uri: c.web.uri }).filter(Boolean);
        }
      }
    }

    if (!gotAnyText) {
      // Handle a trailing event that never got a final \n\n terminator.
      const dataLines = buffer.split('\n').filter(l => l.startsWith('data:'));
      if (dataLines.length) {
        const jsonStr = dataLines.map(l => l.slice(5).trim()).join('');
        try {
          const evt = JSON.parse(jsonStr);
          const cand = evt.candidates && evt.candidates[0];
          const textPiece = cand && cand.content && cand.content.parts ? cand.content.parts.map(p => p.text || '').join('') : '';
          if (textPiece) { gotAnyText = true; res.write(`data: ${JSON.stringify({ delta: textPiece })}\n\n`); }
        } catch (e) {}
      }
    }
    if (!gotAnyText) {
      res.write(`data: ${JSON.stringify({ delta: "I couldn't generate a response for that — try rephrasing." })}\n\n`);
    }
    if (sources.length) {
      const seen = new Set();
      sources = sources.filter(s => !seen.has(s.uri) && seen.add(s.uri));
      res.write(`data: ${JSON.stringify({ sources })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(err);
    try { res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`); res.end(); } catch (e) {}
  }
});

/**
 * Summarize an existing AI reply in 2-3 sentences — used by the "Summarize"
 * action under long replies in the app. Cheap, non-streamed, no history needed.
 */
app.post('/api/summarize', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
    const { text, userId } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Missing text' });
    if (!checkAndConsumeQuota(userId)) {
      return res.status(429).json({ error: 'Daily limit reached' });
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Summarize the following in 2-3 short, plain sentences. No preamble, no markdown headers, just the summary:\n\n' + text }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.3 }
      })
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = data.error && data.error.message;
      const isQuota = (data.error && data.error.status === 'RESOURCE_EXHAUSTED') || /exceeded your current quota/i.test(msg || '');
      return res.status(isQuota ? 429 : 502).json({ error: 'Summarize failed', detail: isQuota ? friendlyQuotaMessage(msg) : msg });
    }
    const candidate = data.candidates && data.candidates[0];
    const summary = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(p => p.text || '').join(' ').trim()
      : null;
    res.json({ summary: summary || "Couldn't summarize that." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Free, no-key fallback image generator (Pollinations.ai). Used automatically
 * whenever Gemini's image model fails — which, on a free-tier key with no
 * billing enabled, is effectively always. This is what actually makes image
 * generation and anime avatars work out of the box with zero configuration.
 */
// Pollinations' watermark removal (`nologo`) requires a free registered token as of
// 2026 — anonymous requests get a small "pollinations.ai" mark regardless of the
// nologo param. Get a free token at https://auth.pollinations.ai and set it as
// POLLINATIONS_TOKEN on Render to remove it. Without a token, images still generate
// fine, just with the mark.
const POLLINATIONS_TOKEN = process.env.POLLINATIONS_TOKEN || '';

async function generateWithPollinations(prompt) {
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&seed=${seed}`;
  const headers = {};
  if (POLLINATIONS_TOKEN) headers['Authorization'] = `Bearer ${POLLINATIONS_TOKEN}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('Pollinations request failed: ' + r.status);
  const buf = await r.arrayBuffer();
  const base64 = Buffer.from(buf).toString('base64');
  const contentType = r.headers.get('content-type') || 'image/jpeg';
  return `data:${contentType};base64,${base64}`;
}

/**
 * Image generation endpoint — used for the general "generate an image" feature
 * and for the anime-avatar unlocks in the XP/challenges system.
 * Tries Gemini's native image model first (better quality when billing is
 * enabled on the key), and falls back automatically to a free no-key provider
 * if Gemini fails for any reason (quota, billing, transient error). Costs 1
 * request from the same daily quota as chat either way.
 */
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, image, userId } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    const isEdit = !!image;

    if (!checkAndConsumeQuota(userId)) {
      return res.status(429).json({ error: 'Daily limit reached', reply: "You've used all your requests for today — watch an ad in the app to unlock 10 more." });
    }

    if (GEMINI_API_KEY) {
      try {
        const parts = [{ text: prompt }];
        if (isEdit) {
          const match = /^data:(image\/[a-zA-Z]+);base64,(.+)$/.exec(image);
          if (match) parts.unshift({ inline_data: { mime_type: match[1], data: match[2] } });
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
          })
        });
        const data = await r.json();
        if (r.ok) {
          const resParts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
          const imgPart = resParts.find(p => p.inlineData || p.inline_data);
          const inline = imgPart && (imgPart.inlineData || imgPart.inline_data);
          if (inline) {
            const mime = inline.mimeType || inline.mime_type || 'image/png';
            return res.json({ image: `data:${mime};base64,${inline.data}`, provider: 'gemini' });
          }
        } else {
          console.error('Gemini image gen/edit failed:', JSON.stringify(data));
          if (isEdit) {
            // Can't fall back to Pollinations for an edit — it would ignore the input photo entirely.
            const msg = (data.error && data.error.message) || '';
            const isQuota = /quota|exceeded|RESOURCE_EXHAUSTED/i.test(msg);
            return res.status(isQuota ? 429 : 502).json({
              error: 'AI edit failed',
              detail: isQuota
                ? "AI photo editing needs Gemini's image model, which requires billing enabled on your API key's Google Cloud project — there's no free fallback for editing an existing photo (only for generating a brand-new one). The manual sliders and filters still work for free."
                : (msg || 'Unknown error from the image model.')
            });
          }
        }
      } catch (e) {
        console.error('Gemini image gen threw:', e.message);
        if (isEdit) {
          return res.status(502).json({ error: 'AI edit failed', detail: 'Connection error reaching the image model.' });
        }
      }
    } else if (isEdit) {
      return res.status(500).json({ error: 'Server missing GEMINI_API_KEY', detail: 'AI photo editing needs a configured Gemini API key.' });
    }

    // Fallback path for plain text-to-image generation only — free, no key, works without billing.
    try {
      const generated = await generateWithPollinations(prompt);
      return res.json({ image: generated, provider: 'pollinations' });
    } catch (e) {
      console.error('Pollinations fallback also failed:', e.message);
      return res.status(502).json({ error: 'Image generation failed', detail: 'Both the primary and fallback image providers failed. Try again in a moment.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// HONEST NOTE ON FREE VIDEO: there is currently no verified, genuinely free,
// zero-setup hosted API for AI video generation. The obvious open-source
// candidate (damo-vilab/text-to-video-ms-1.7b) is NOT deployed by any
// Hugging Face Inference Provider — HF's own docs say so explicitly — so it
// cannot be called as a hosted API at all, only run on your own GPU via code.
// Pollinations' video endpoint runs on paid "Pollen credits," not a free tier.
// HUGGINGFACE_TOKEN is still read here in case you find and configure a model
// that IS actually deployed on an Inference Provider later (check a model's
// page for "Inference Providers" support before trusting it) — but there is
// no working default right now, so this fallback is off unless you set
// HF_VIDEO_MODEL yourself to something confirmed working.
const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN || '';
const HF_VIDEO_MODEL = process.env.HF_VIDEO_MODEL || '';

async function generateVideoWithHuggingFace(prompt) {
  const url = `https://api-inference.huggingface.co/models/${HF_VIDEO_MODEL}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HUGGINGFACE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ inputs: prompt })
    });
    if (r.status === 503) {
      const info = await r.json().catch(() => ({}));
      await new Promise(res => setTimeout(res, Math.min(15000, (info.estimated_time || 8) * 1000)));
      continue;
    }
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`HF request failed (${r.status}): ${errText.slice(0, 300)}`);
    }
    const buf = await r.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    const contentType = r.headers.get('content-type') || 'video/mp4';
    return `data:${contentType};base64,${base64}`;
  }
  throw new Error('Model stayed unavailable after retries.');
}

/**
 * Video generation. Tries Veo first (real quality, needs billing — Google
 * gives it no free tier). Only attempts the Hugging Face path if you've
 * explicitly set HF_VIDEO_MODEL to a model you've confirmed is actually
 * deployed on an Inference Provider — there's no safe default, since the
 * obvious free candidate turned out not to be callable at all.
 */
app.post('/api/generate-video', async (req, res) => {
  try {
    const { prompt, userId } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    if (!checkAndConsumeQuota(userId)) {
      return res.status(429).json({ error: 'Daily limit reached' });
    }

    if (GEMINI_API_KEY) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VIDEO_MODEL}:predictLongRunning?key=${GEMINI_API_KEY}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instances: [{ prompt }] })
        });
        const data = await r.json();
        if (r.ok) {
          return res.json({ operationName: data.name, provider: 'veo' });
        }
        console.error('Veo start failed:', JSON.stringify(data));
      } catch (e) {
        console.error('Veo threw:', e.message);
      }
    }

    if (HUGGINGFACE_TOKEN && HF_VIDEO_MODEL) {
      try {
        const video = await generateVideoWithHuggingFace(prompt);
        return res.json({ video, provider: 'huggingface' });
      } catch (e) {
        console.error('Hugging Face video fallback failed:', e.message);
        return res.status(502).json({ error: 'Video generation failed', detail: `Free fallback failed: ${e.message}` });
      }
    }

    return res.status(429).json({
      error: 'Video generation unavailable',
      detail: "Veo (Google's video model) needs billing enabled on your API key — there's genuinely no free tier for it. I checked for a free alternative and couldn't find one that's actually callable as a hosted API right now (the obvious open-source option isn't deployed on any provider). Enabling billing on GEMINI_API_KEY is currently the only working path to AI video here."
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Poll a video generation operation until it's done. */
app.get('/api/video-status', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
    const operation = req.query.operation;
    if (!operation) return res.status(400).json({ error: 'Missing operation' });

    const url = `https://generativelanguage.googleapis.com/v1beta/${operation}?key=${GEMINI_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Status check failed', detail: data.error && data.error.message });
    if (!data.done) return res.json({ done: false });

    const sample = data.response
      && data.response.generateVideoResponse
      && data.response.generateVideoResponse.generatedSamples
      && data.response.generateVideoResponse.generatedSamples[0];
    const video = sample && sample.video;
    if (!video) {
      return res.json({ done: true, error: 'The model finished but returned no video — try a different prompt.' });
    }
    if (video.bytesBase64Encoded) {
      return res.json({ done: true, video: `data:video/mp4;base64,${video.bytesBase64Encoded}` });
    }
    if (video.uri) {
      const sep = video.uri.includes('?') ? '&' : '?';
      const fileRes = await fetch(`${video.uri}${sep}key=${GEMINI_API_KEY}`);
      if (!fileRes.ok) return res.status(502).json({ error: 'Could not download the generated video file' });
      const buf = await fileRes.arrayBuffer();
      const base64 = Buffer.from(buf).toString('base64');
      return res.json({ done: true, video: `data:video/mp4;base64,${base64}` });
    }
    res.json({ done: true, error: 'Unrecognized video response from the model.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Luminous AI backend running on port ${PORT} (model: ${GEMINI_MODEL})`));
