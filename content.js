// YouTube Clip Finder — finds the best clip ranges of a video.
// Signals: timestamps + quotes in comments and replies (weighted by likes),
// live chat replay spikes, transcript hype words, and the "most replayed" graph.
(() => {
  const g = typeof window !== 'undefined' ? window : globalThis;
  if (g.__ycfLoaded) return;
  g.__ycfLoaded = true;

  // =====================================================================
  // PURE HELPERS (no page access)
  // =====================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findAll(obj, pred, out = [], depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 40) return out;
    if (pred(obj)) out.push(obj);
    for (const v of Array.isArray(obj) ? obj : Object.values(obj)) findAll(v, pred, out, depth + 1);
    return out;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function parseCount(s) {
    if (!s) return 0;
    const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return 0;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return Math.round(parseFloat(m[1]) * mult);
  }

  function compact(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  const runsToText = (runs = []) =>
    runs.map((r) => r.text ?? (r.emoji ? r.emoji.shortcuts?.[0] || r.emoji.emojiId || '' : '')).join('');

  const TS_RE = /(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])/g;

  // Timestamps in a comment. "1:03-1:20" / "1:03 to 1:20" becomes one mention with an end.
  function extractMentions(text) {
    const ms = [];
    for (const m of text.matchAll(TS_RE)) {
      const h = m[1] ? +m[1] : 0, mi = +m[2], s = +m[3];
      if (s >= 60 || (m[1] && mi >= 60)) continue;
      ms.push({ t: h * 3600 + mi * 60 + s, i: m.index, j: m.index + m[0].length });
    }
    const out = [];
    for (let k = 0; k < ms.length; k++) {
      const a = ms[k], b = ms[k + 1];
      if (b && /^\s*(-|–|—|~|to|until|till)\s*$/i.test(text.slice(a.j, b.i)) && b.t > a.t && b.t - a.t <= 180) {
        out.push({ t: a.t, end: b.t });
        k++;
      } else out.push({ t: a.t });
    }
    return out;
  }

  // Time at which the cumulative weight reaches fraction q (list sorted by t)
  function wQuantile(list, q) {
    const total = list.reduce((s, m) => s + m.w, 0);
    let acc = 0;
    for (const m of list) {
      acc += m.w;
      if (acc >= total * q) return m.t;
    }
    return list[list.length - 1].t;
  }

  const words = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);

  const chatNorm = (t) => t.toLowerCase().replace(/\s+/g, ' ').replace(/(.)\1{2,}/g, '$1$1').trim().slice(0, 40);
  function topRepeated(texts, n = 3) {
    const c = new Map();
    for (const t of texts) {
      const k = chatNorm(t);
      if (k) c.set(k, (c.get(k) || 0) + 1);
    }
    return [...c.entries()].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  const HYPE_RE =
    /\b(no way|oh my (god|gosh)|omg|what the|wtf|holy|let'?s go+|insane|unbelievable|are you kidding|oh no+|wow+|whoa+|yoo+|clutch|what just happened|i can'?t believe|ha(ha)+|lmao|sheesh|grabe|hala|lupet|ang galing)\b|[\[(](laughter|laughs|laughing|applause|cheering|cheers|screams?|screaming|gasps?)[\])]/gi;

  // Transcript lookups: sentence edges, hype words, preview text, quote search
  function buildTranscript(segs) {
    if (!segs || !segs.length) return null;
    segs = segs.filter((s) => s.text && s.s >= 0).sort((a, b) => a.s - b.s);
    if (!segs.length) return null;
    const B = 10;
    const bins = [];
    for (const s of segs) {
      const n = (s.text.match(HYPE_RE) || []).length;
      if (n) bins[Math.floor(s.s / B)] = (bins[Math.floor(s.s / B)] || 0) + n;
    }
    const maxBin = Math.max(0, ...bins.filter(Boolean));
    const hypeOn = maxBin >= 2;

    // 4-word phrases that appear at only one place in the video
    const grams = new Map();
    const all = [];
    for (const s of segs) for (const w of words(s.text)) all.push({ w, t: s.s });
    for (let i = 0; i + 4 <= all.length; i++) {
      const key = `${all[i].w} ${all[i + 1].w} ${all[i + 2].w} ${all[i + 3].w}`;
      if (key.length < 16) continue;
      const old = grams.get(key);
      if (old === undefined) grams.set(key, all[i].t);
      else if (old >= 0 && Math.abs(old - all[i].t) > 15) grams.set(key, -1);
    }

    return {
      segs,
      hypeBins: hypeOn ? bins.map((v, i) => ({ t: i * B, v: (v || 0) / maxBin })).filter((b) => b.v > 0) : [],
      hypeAt(a, b) {
        if (!hypeOn) return 0;
        let mx = 0;
        for (let i = Math.floor(a / B); i <= Math.floor(b / B); i++) mx = Math.max(mx, bins[i] || 0);
        return mx / maxBin;
      },
      snapStart(t) {
        for (const s of segs) {
          if (s.s > t + 2) break;
          if (s.s <= t && t < s.e) return t - s.s <= 5 ? s.s : t;
          if (s.s > t) return s.s;
        }
        return t;
      },
      snapEnd(t) {
        for (const s of segs) {
          if (s.s > t) break;
          if (t < s.e) return s.e - t <= 5 ? s.e : t;
        }
        return t;
      },
      preview(a, b) {
        return segs.filter((s) => s.s < b && s.e > a).map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 110);
      },
      // Where in the video was this comment's quote said? (-1 = not found)
      findQuote(text) {
        const w = words(text);
        for (let i = 0; i + 4 <= w.length; i++) {
          const t = grams.get(`${w[i]} ${w[i + 1]} ${w[i + 2]} ${w[i + 3]}`);
          if (t !== undefined && t >= 0) return t;
        }
        return -1;
      },
    };
  }

  // Chat messages -> spikes
  function analyzeChat(msgs) {
    if (!msgs || msgs.length < 30) return null;
    const B = 10;
    const maxT = msgs.reduce((m, x) => Math.max(m, x.t), 0);
    const n = Math.ceil(maxT / B) + 1;
    const counts = new Array(n).fill(0);
    const texts = Array.from({ length: n }, () => []);
    for (const m of msgs) {
      const i = Math.floor(m.t / B);
      counts[i]++;
      texts[i].push(m.text);
    }
    const smooth = counts.map((_, i) => (counts[i - 1] || 0) + counts[i] + (counts[i + 1] || 0));
    const avg = smooth.reduce((a, b) => a + b, 0) / n || 1;
    const order = smooth.map((v, i) => i).sort((a, b) => smooth[b] - smooth[a]);
    const picked = [];
    for (const i of order) {
      if (picked.length >= 20 || smooth[i] < avg * 1.5) break;
      if (picked.some((p) => Math.abs(p - i) * B < 60)) continue;
      picked.push(i);
    }
    const max = Math.max(1, ...smooth);
    return {
      heat: smooth.map((v, i) => ({ t: i * B, v })),
      spikes: picked.map((i) => {
        const win = [...(texts[i - 1] || []), ...texts[i], ...(texts[i + 1] || [])];
        return {
          peak: i * B,
          v: smooth[i] / max,
          label: `${smooth[i]} msgs/30s · ${(smooth[i] / avg).toFixed(1)}× normal`,
          tags: topRepeated(win).map(([k, c]) => `${k} ×${c}`),
        };
      }),
    };
  }

  // Everything collected -> ranked clip ranges
  function analyze({ comments, transcript, chatMsgs, replay, dur }) {
    const tr = buildTranscript(transcript);
    const chat = analyzeChat(chatMsgs);
    replay = (replay || []).slice().sort((a, b) => a.s - b.s);
    const seg = replay.length ? replay[0].d || (replay[1] ? replay[1].s - replay[0].s : 0) : 0;
    const replayAt = (a, b) => replay.reduce((mx, r) => (r.s < b && r.s + (r.d || seg) > a ? Math.max(mx, r.v) : mx), 0);

    // ---- mentions from comments + replies ----
    const mentions = [];
    let nTs = 0, nQuote = 0;
    for (const c of comments) {
      const base = (1 + Math.log2(1 + c.likes)) * (1 + 0.3 * Math.log2(1 + (c.replies || 0)));
      const ms = extractMentions(c.text);
      if (ms.length) {
        const share = ms.length > 3 ? 1 / ms.length : 1; // chapter lists are diluted
        for (const m of ms) {
          if (dur && m.t > dur + 1) continue;
          nTs++;
          mentions.push({ t: m.t, end: m.end, w: base * share, text: c.text, likes: c.likes, single: ms.length <= 3 });
        }
      } else if (tr) {
        const t = tr.findQuote(c.text);
        if (t >= 0) {
          nQuote++;
          mentions.push({ t, w: base * 0.7, text: c.text, likes: c.likes, single: true, quote: true });
        }
      }
    }
    mentions.sort((a, b) => a.t - b.t);

    const clusters = [];
    let prev = null;
    for (const m of mentions) {
      const last = clusters[clusters.length - 1];
      if (last && m.t - prev.t <= 8 && m.t - last.list[0].t <= 40) last.list.push(m);
      else clusters.push({ list: [m] });
      prev = m;
    }
    for (const c of clusters) c.weight = c.list.reduce((s, m) => s + m.w, 0);
    const maxW = Math.max(1e-9, ...clusters.map((c) => c.weight));

    // ---- candidates ----
    const cands = [];
    const usedSpikes = new Set();
    for (const c of clusters) {
      const list = c.list;
      if (list.every((m) => !m.single)) continue; // only chapter lists point here
      const first = wQuantile(list, 0.1);
      const lastT = wQuantile(list, 0.9);
      const start = Math.max(0, first - 3);
      const tags = [];
      const ranged = list.filter((m) => m.end).sort((a, b) => b.w - a.w);
      let end = ranged.length ? ranged[0].end + 2 : lastT + 20;
      if (ranged.length) tags.push('✂ range from comments');

      // A chat spike shortly after the commented time is the same moment
      let sp = null;
      if (chat) {
        const i = chat.spikes.findIndex((x, idx) => !usedSpikes.has(idx) && x.peak >= first - 5 && x.peak <= lastT + 45);
        if (i >= 0) {
          sp = chat.spikes[i];
          usedSpikes.add(i);
          if (!ranged.length) end = Math.max(end, sp.peak + 10);
        }
      }
      if (!ranged.length && seg && seg <= 10) {
        const peak = replayAt(start, end);
        if (peak >= 0.4) while (end - start < 60 && replayAt(end, end + seg) >= peak * 0.7) end += seg;
      }

      const likes = list.reduce((s, m) => s + (m.single ? m.likes : 0), 0);
      const nq = list.filter((m) => m.quote).length;
      const samples = list.filter((m) => m.single).sort((a, b) => b.likes - a.likes).slice(0, 2);
      const sub = [`💬 ${list.length} mention${list.length > 1 ? 's' : ''}${nq ? ` (${nq} by quote)` : ''} · 👍 ${compact(likes)}`];
      if (sp) sub.push(`📺 chat: ${sp.label}`);
      for (const s of samples) sub.push(`“${s.text.replace(/\s+/g, ' ').slice(0, 90)}”${s.likes ? ` 👍${s.likes}` : ''}`);
      if (sp) tags.unshift('🔥 comments + chat');
      cands.push({ start, end, cs: c.weight / maxW, chs: sp ? sp.v : 0, both: !!sp, sub, tags: [...tags, ...(sp ? sp.tags.slice(0, 2) : [])] });
    }
    if (chat) {
      chat.spikes.forEach((sp, i) => {
        if (usedSpikes.has(i)) return;
        // chat reacts late: start 15s before the spike
        cands.push({ start: Math.max(0, sp.peak - 15), end: sp.peak + 15, cs: 0, chs: sp.v, both: false, sub: [`📺 chat: ${sp.label}`], tags: sp.tags.slice() });
      });
    }
    if (tr) {
      for (const b of tr.hypeBins) {
        if (b.v < 0.6) continue;
        const start = Math.max(0, b.t - 5), end = b.t + 25;
        if (cands.some((k) => start < k.end && end > k.start)) continue;
        cands.push({ start, end, cs: 0, chs: 0, both: false, sub: [], tags: [] });
      }
    }
    if (!cands.length && replay.length) {
      replay.forEach((r, i) => {
        if (r.v < 0.5 || r.v < (replay[i - 1]?.v || 0) || r.v < (replay[i + 1]?.v || 0)) return;
        cands.push({ start: Math.max(0, r.s - 5), end: r.s + Math.max(seg, 20), cs: 0, chs: 0, both: false, sub: ['🔁 Most replayed part of the video'], tags: [] });
      });
    }

    // ---- finish each candidate: clean edges, score, preview ----
    for (const k of cands) {
      if (tr) {
        k.start = tr.snapStart(k.start);
        k.end = tr.snapEnd(k.end);
      }
      k.end = Math.min(Math.max(k.end, k.start + 15), k.start + 60);
      if (dur) k.end = Math.min(k.end, dur);
      const hot = replayAt(k.start, k.end);
      const hype = tr ? tr.hypeAt(k.start, k.end) : 0;
      if (hot >= 0.6) k.tags.push('🔁 most replayed');
      if (hype >= 0.5) k.tags.push('🗣 hype words');
      k.raw = k.cs + k.chs + (k.both ? 0.25 : 0) + 0.5 * hot + 0.3 * hype;
      const pv = tr ? tr.preview(k.start, k.end) : '';
      if (pv) k.sub.push(`🗣 ${pv}`);
      k.t = k.start;
    }

    cands.sort((a, b) => b.raw - a.raw);
    const kept = [];
    for (const k of cands) {
      if (kept.length >= 10) break;
      if (!(k.raw > 0) || k.end - k.t < 5) continue;
      if (kept.some((o) => k.t < o.end && k.end > o.t)) continue;
      kept.push(k);
    }
    const best = kept[0]?.raw || 1;
    for (const k of kept) k.label = `★ ${Math.round((k.raw / best) * 100)}`;

    return {
      items: kept,
      heat: chat ? chat.heat : clusters.length ? clusters.map((c) => ({ t: c.list[0].t, v: c.weight })) : replay.map((r) => ({ t: r.s, v: r.v })),
      stats: { nTs, nQuote, hasTranscript: !!tr, hasChat: !!chat, hasReplay: replay.length > 0 },
    };
  }

  if (typeof document === 'undefined') {
    // Loaded outside a browser (tests)
    g.__ycfPure = { analyze, extractMentions, buildTranscript, analyzeChat, fmt };
    return;
  }

  // =====================================================================
  // PAGE ACCESS
  // =====================================================================
  // Build DOM without innerHTML (YouTube enforces Trusted Types)
  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.append(c instanceof Node ? c : String(c));
    }
    return e;
  }

  const cfg = (k) => window.ytcfg?.get?.(k) ?? window.ytcfg?.data_?.[k];

  async function yt(endpoint, body) {
    const key = cfg('INNERTUBE_API_KEY');
    const url = `/youtubei/v1/${endpoint}?prettyPrint=false${key ? `&key=${key}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
        'X-Youtube-Client-Version': String(cfg('INNERTUBE_CLIENT_VERSION') || ''),
      },
      body: JSON.stringify({ context: cfg('INNERTUBE_CONTEXT'), ...body }),
    });
    if (!res.ok) throw new Error(`${endpoint} failed (HTTP ${res.status})`);
    return res.json();
  }

  const videoId = () => new URLSearchParams(location.search).get('v');
  const video = () => document.querySelector('video.html5-main-video') || document.querySelector('video');
  const duration = () => (video()?.duration && isFinite(video().duration) ? video().duration : 0);

  function seek(t) {
    const v = video();
    if (!v) return;
    v.currentTime = Math.max(0, t);
    v.play?.();
  }

  let stopFlag = false;
  let busy = false;
  let lastResults = null;

  // One page of comments or replies
  function parsePage(r) {
    const items = [];
    for (const ep of r.onResponseReceivedEndpoints || []) {
      const c = ep.reloadContinuationItemsCommand || ep.appendContinuationItemsAction;
      if (c?.continuationItems) items.push(...c.continuationItems);
    }
    let token = null;
    const threads = [];
    const comments = [];
    for (const it of items) {
      if (it.continuationItemRenderer) {
        token = findAll(it, (o) => o.continuationCommand?.token)[0]?.continuationCommand.token || token;
      }
      const th = it.commentThreadRenderer;
      if (th) {
        const id = th.commentViewModel?.commentViewModel?.commentId || th.comment?.commentRenderer?.commentId;
        const replyToken = findAll(th.replies || {}, (o) => o.continuationCommand?.token)[0]?.continuationCommand.token;
        if (replyToken) threads.push({ id, replyToken });
      }
      const cr = th?.comment?.commentRenderer || it.commentRenderer;
      if (cr) {
        comments.push({
          id: cr.commentId,
          text: runsToText(cr.contentText?.runs),
          likes: parseCount(cr.voteCount?.simpleText),
          replies: Number(cr.replyCount) || 0,
        });
      }
    }
    for (const m of r.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
      const p = m.payload?.commentEntityPayload;
      if (!p) continue;
      comments.push({
        id: p.properties?.commentId || m.entityKey,
        text: p.properties?.content?.content || '',
        likes: parseCount(p.toolbar?.likeCountNotliked),
        replies: parseCount(p.toolbar?.replyCount),
      });
    }
    return { token, threads, comments };
  }

  async function readComments(next, maxComments) {
    const section = findAll(next, (o) => o.itemSectionRenderer?.sectionIdentifier === 'comment-item-section')[0];
    let token = findAll(section || {}, (o) => o.continuationCommand?.token)[0]?.continuationCommand.token;
    const byId = new Map();
    const threads = [];
    let pages = 0;
    const add = (list) => {
      for (const c of list) if (c.id && !byId.has(c.id)) byId.set(c.id, c);
    };
    while (token && !stopFlag && byId.size < maxComments) {
      const p = parsePage(await yt('next', { continuation: token }));
      pages++;
      add(p.comments);
      threads.push(...p.threads);
      token = p.token;
      setStatus(`Reading comments… ${byId.size} loaded (page ${pages})`, Math.min(0.5, (byId.size / maxComments) * 0.5));
      await sleep(80);
    }
    const nTop = byId.size;

    // Replies: the 40 most-discussed threads, first page of each
    const ranked = threads
      .map((t) => ({ ...t, c: byId.get(t.id) }))
      .sort((a, b) => (b.c?.replies || 0) - (a.c?.replies || 0) || (b.c?.likes || 0) - (a.c?.likes || 0))
      .slice(0, 40);
    for (let i = 0; i < ranked.length && !stopFlag; i++) {
      try {
        add(parsePage(await yt('next', { continuation: ranked[i].replyToken })).comments);
      } catch (e) { /* skip this thread */ }
      setStatus(`Reading replies… thread ${i + 1} of ${ranked.length}`, 0.5 + ((i + 1) / ranked.length) * 0.1);
      await sleep(80);
    }
    return { comments: [...byId.values()], nTop, nReplies: byId.size - nTop };
  }

  async function readTranscript(next, vid) {
    // 1) YouTube's "Show transcript" panel
    try {
      const params = findAll(next, (o) => o.getTranscriptEndpoint?.params)[0]?.getTranscriptEndpoint.params;
      if (params) {
        const r = await yt('get_transcript', { params });
        const segs = findAll(r, (o) => o.transcriptSegmentRenderer).map((o) => {
          const s = o.transcriptSegmentRenderer;
          return { s: Number(s.startMs) / 1000, e: Number(s.endMs) / 1000, text: runsToText(s.snippet?.runs) || s.snippet?.simpleText || '' };
        });
        if (segs.length) return segs;
      }
    } catch (e) { /* try the caption track */ }
    // 2) Caption track from the player
    try {
      const pr = document.getElementById('movie_player')?.getPlayerResponse?.();
      if (pr?.videoDetails?.videoId !== vid) return null;
      const track = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
      if (!track?.baseUrl) return null;
      const j = await (await fetch(track.baseUrl + '&fmt=json3', { credentials: 'same-origin' })).json();
      const segs = (j.events || [])
        .filter((ev) => ev.segs)
        .map((ev) => ({
          s: ev.tStartMs / 1000,
          e: (ev.tStartMs + (ev.dDurationMs || 3000)) / 1000,
          text: ev.segs.map((x) => x.utf8 || '').join('').replace(/\n/g, ' ').trim(),
        }));
      return segs.length ? segs : null;
    } catch (e) {
      return null;
    }
  }

  // Live chat replay (finished streams only). Returns null when there is none.
  async function readChat(next) {
    const lcr = next?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
    let cont = lcr?.continuations?.[0]?.reloadContinuationData?.continuation;
    if (!cont || lcr.isReplay === false) return null;
    const msgs = [];
    const dur = duration();
    let lastOff = -1, stuck = 0;
    while (cont && !stopFlag) {
      let r;
      try {
        r = await yt('live_chat/get_live_chat_replay', { continuation: cont, currentPlayerState: { playerOffsetMs: '0' } });
      } catch (e) { break; }
      const lc = r.continuationContents?.liveChatContinuation;
      if (!lc) break;
      let maxOff = lastOff;
      for (const a of lc.actions || []) {
        const rp = a.replayChatItemAction;
        if (!rp) continue;
        const off = Number(rp.videoOffsetTimeMsec) / 1000;
        if (!(off >= 0)) continue;
        for (const ia of rp.actions || []) {
          const item = ia.addChatItemAction?.item;
          const m = item?.liveChatTextMessageRenderer || item?.liveChatPaidMessageRenderer;
          if (m) msgs.push({ t: off, text: runsToText(m.message?.runs) });
        }
        if (off > maxOff) maxOff = off;
      }
      stuck = maxOff <= lastOff ? stuck + 1 : 0;
      lastOff = maxOff;
      if (stuck > 5) break;
      cont = lc.continuations?.find((c) => c.liveChatReplayContinuationData)?.liveChatReplayContinuationData?.continuation;
      setStatus(
        `Reading live chat… ${msgs.length} messages, at ${fmt(lastOff)}${dur ? ' / ' + fmt(dur) : ''}`,
        0.6 + (dur ? Math.min(1, lastOff / dur) : 0) * 0.4
      );
      await sleep(40);
    }
    return msgs;
  }

  async function scanClips(maxComments) {
    const vid = videoId();
    const next = await yt('next', { videoId: vid });
    const replay = findAll(next, (o) => typeof o.intensityScoreNormalized === 'number' && o.startMillis != null)
      .map((o) => ({ s: Number(o.startMillis) / 1000, d: Number(o.durationMillis || 0) / 1000, v: o.intensityScoreNormalized }))
      .filter((r) => r.s >= 0);

    setStatus('Reading transcript…', 0);
    const transcript = await readTranscript(next, vid);
    const { comments, nTop, nReplies } = await readComments(next, maxComments);
    const chatMsgs = stopFlag ? null : await readChat(next);

    const res = analyze({ comments, transcript, chatMsgs, replay, dur: duration() });
    const st = res.stats;
    const yes = (b) => (b ? '✔' : '✖');
    res.note =
      `Comments: ${nTop} + ${nReplies} replies (${st.nTs} timestamps, ${st.nQuote} quotes found) · ` +
      `Transcript ${yes(st.hasTranscript)} · Live chat ${st.hasChat ? `✔ ${chatMsgs.length} msgs` : '✖'} · Most replayed ${yes(st.hasReplay)}`;
    if (!res.items.length) res.note += ' — no standout moments found.';
    return res;
  }

  // =====================================================================
  // UI
  // =====================================================================
  let fab, panel, statusEl, barEl, resultsEl, heatEl, noteEl, btnScan, btnStop, btnCopy, maxSel;

  function buildUI() {
    fab = el('button', { id: 'ycf-fab', onclick: () => panel.classList.toggle('ycf-hidden') }, '🔥 Clip Finder');
    statusEl = el('div', { class: 'ycf-status' });
    barEl = el('div');
    resultsEl = el('div');
    noteEl = el('div', { class: 'ycf-hint' });
    heatEl = el('canvas', { class: 'ycf-heat', width: '700', height: '100', style: 'display:none' });
    heatEl.addEventListener('click', (e) => {
      const d = duration() || heatMax();
      if (!d) return;
      const rect = heatEl.getBoundingClientRect();
      seek(((e.clientX - rect.left) / rect.width) * d);
    });
    maxSel = el(
      'select',
      { class: 'ycf-select', title: 'How many comments to read' },
      ...[500, 2000, 5000, 20000].map((v) => el('option', { value: String(v) }, `${v} comments`))
    );
    maxSel.value = '2000';
    btnScan = el('button', { class: 'ycf-btn ycf-primary', onclick: run }, '⭐ Find best clips');
    btnStop = el('button', { class: 'ycf-btn ycf-stop', style: 'display:none', onclick: () => (stopFlag = true) }, '■ Stop & show results');
    btnCopy = el('button', { class: 'ycf-btn', style: 'display:none', onclick: copyResults }, '📋 Copy list');

    panel = el(
      'div',
      { id: 'ycf-panel', class: 'ycf-hidden' },
      el('div', { class: 'ycf-head' }, '🔥 Clip Finder', el('button', { class: 'ycf-x', onclick: () => panel.classList.add('ycf-hidden') }, '✕')),
      el(
        'div',
        { class: 'ycf-body' },
        el('div', { class: 'ycf-hint' }, 'Finds clip ranges from comments and replies (timestamps, quotes, likes), the transcript, the live chat replay of finished streams, and the most replayed parts.'),
        el('div', { class: 'ycf-row' }, btnScan, btnStop),
        el('div', { class: 'ycf-row' }, 'Read up to', maxSel),
        statusEl,
        el('div', { class: 'ycf-bar' }, barEl),
        heatEl,
        noteEl,
        resultsEl,
        el('div', { class: 'ycf-row' }, btnCopy)
      )
    );
    document.body.append(fab, panel);
  }

  function setStatus(text, progress) {
    statusEl.textContent = text;
    if (progress != null) barEl.style.width = `${Math.round(progress * 100)}%`;
  }

  function heatMax() {
    const h = lastResults?.heat || [];
    return h.length ? h[h.length - 1].t : 0;
  }

  function drawHeat(heat) {
    const ctx = heatEl.getContext('2d');
    const W = heatEl.width, H = heatEl.height;
    ctx.clearRect(0, 0, W, H);
    if (!heat.length) { heatEl.style.display = 'none'; return; }
    heatEl.style.display = 'block';
    const d = duration() || heat[heat.length - 1].t || 1;
    const cols = new Array(W).fill(0);
    for (const p of heat) {
      const x = Math.min(W - 1, Math.floor((p.t / d) * W));
      cols[x] = Math.max(cols[x], p.v);
    }
    const max = Math.max(...cols) || 1;
    for (let x = 0; x < W; x++) {
      if (!cols[x]) continue;
      const h = Math.max(2, (cols[x] / max) * (H - 4));
      ctx.fillStyle = cols[x] / max > 0.6 ? '#ff283c' : cols[x] / max > 0.3 ? '#ff8a3c' : '#5a5a5a';
      ctx.fillRect(x, H - h, 2, h);
    }
  }

  function render(res) {
    lastResults = res;
    resultsEl.replaceChildren();
    noteEl.textContent = res.note || '';
    drawHeat(res.heat);
    if (!res.items.length) {
      btnCopy.style.display = 'none';
      return;
    }
    res.items.forEach((it, idx) => {
      resultsEl.append(
        el(
          'div',
          { class: 'ycf-item', onclick: () => seek(it.t), title: 'Click to jump to the start of this clip' },
          el(
            'div',
            { class: 'ycf-item-top' },
            el('span', { class: 'ycf-time' }, `#${idx + 1}  ▶ ${fmt(it.t)} → ${fmt(it.end)}`),
            el('span', { class: 'ycf-score' }, `${Math.round(it.end - it.t)}s · ${it.label}`)
          ),
          ...it.sub.map((s) => el('div', { class: 'ycf-sample', title: s }, s)),
          it.tags.length ? el('div', { class: 'ycf-tags' }, ...it.tags.map((t) => el('span', { class: 'ycf-tag' }, t))) : null
        )
      );
    });
    btnCopy.style.display = '';
  }

  function copyResults() {
    if (!lastResults) return;
    const url = `https://youtu.be/${videoId()}`;
    const lines = [`Best clips — ${document.title.replace(/ - YouTube$/, '')}`, url, ''];
    lastResults.items.forEach((it, i) =>
      lines.push(`${i + 1}. ${fmt(it.t)}–${fmt(it.end)}  (${Math.round(it.end - it.t)}s, ${it.label})  ${url}?t=${Math.floor(it.t)}`)
    );
    navigator.clipboard.writeText(lines.join('\n')).then(() => setStatus('Copied to clipboard ✔'));
  }

  async function run() {
    if (busy) return;
    if (!videoId()) return setStatus('Open a video first.');
    busy = true;
    stopFlag = false;
    btnScan.disabled = true;
    btnStop.style.display = '';
    resultsEl.replaceChildren();
    setStatus('Starting…', 0);
    try {
      render(await scanClips(+maxSel.value));
      setStatus(stopFlag ? 'Stopped early — showing results from what was read.' : 'Done ✔', 1);
    } catch (e) {
      setStatus('⚠ ' + (e.message || e), 0);
    } finally {
      busy = false;
      btnScan.disabled = false;
      btnStop.style.display = 'none';
    }
  }

  function onNavigate() {
    const onWatch = location.pathname === '/watch';
    fab.style.display = onWatch ? '' : 'none';
    if (!onWatch) panel.classList.add('ycf-hidden');
    stopFlag = true; // cancel any scan from the previous video
    lastResults = null;
    resultsEl.replaceChildren();
    noteEl.textContent = '';
    heatEl.style.display = 'none';
    btnCopy.style.display = 'none';
    setStatus('', 0);
  }

  buildUI();
  onNavigate();
  // Called when the toolbar icon is clicked
  window.__ycfToggle = () => {
    if (location.pathname !== '/watch') return false;
    panel.classList.toggle('ycf-hidden');
    return true;
  };
  window.addEventListener('yt-navigate-finish', onNavigate);
})();
