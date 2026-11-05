// Construye catalog.json a partir de profile.json.
// Solo entra contenido de canales confiables, voces confiables o libros clave.
// Sin API keys: lee las páginas públicas de YouTube. Uso: node scripts/build-catalog.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Usa profile.json (repo privado, contexto completo) o feed-config.json (repo público, sin datos privados).
const cfgFile = await fs.access(path.join(ROOT, 'profile.json')).then(() => 'profile.json', () => 'feed-config.json');
const profile = JSON.parse(await fs.readFile(path.join(ROOT, cfgFile), 'utf8'));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'CONSENT=YES+1; SOCS=CAI',
};

// ---------- taxonomía de temas ----------
const TOPICS = {
  ofertas: [/\boffers?\b/, /\boferta/, /pricing|\bprice\b|precio/, /value equation|grand slam|guarantee|garant/, /\$100m offers/],
  leads: [/\bleads?\b/, /lead gen|acquisition|adquisici|outreach|cold (email|call)|prospect/, /\$100m leads/, /get (more )?customers|clientes/],
  advertising: [/\bads?\b|advertis|anuncio|publicidad|creative|creativ|media buy|facebook ads|meta ads|google ads|ugc/, /cashvertising|ogilvy|breakthrough advertising|scientific advertising/],
  psicologia: [/psycholog|psicolog|persua|influence|cialdini|behavio|sutherland|alchemy|bias|sesgo|brain|cerebro|status|desire|deseo/],
  copywriting: [/copy|headline|titular|\bhooks?\b|sales letter|email|writing|escrib|storytell|story\b|boron/],
  growth: [/growth|crecimiento|scale|scaling|escalar|funnel|conversion|conversi|retention|churn|\bltv\b|\bcac\b|metric|experiment|loops?\b|plg|virality|viral/],
  'ia-growth': [/\bai\b|\bia\b|artificial intelligence|gpt|chatgpt|claude|\bllm|agent|automat|n8n|vibe cod|cursor/],
  estrategia: [/strateg|estrateg|positioning|posicionamiento|business model|moat|niche|nicho|brand|marca|competit|obviously awesome|how brands grow/],
  ventas: [/\bsales\b|\bsell|vender|venta|closing|\bclose\b|objection|objeci/],
  sistemas: [/system|sistema|process|proceso|\bsops?\b|hiring|hire|team|equipo|manage|operat|delegat|leadership|lider/],
  mentalidad: [/mindset|mentalidad|discipline|disciplina|motivat|motiva|consisten|hard work|fear|miedo|confidence|habits?|hábito|patience|quit/],
  libros: [/\bbooks?\b|libro|summary|resumen|cashvertising|influence|alchemy|contagious|made to stick|hooked|storybrand|mom test|traction|hacking growth|\$100m/],
};
const BOOKS = ['cashvertising', 'breakthrough advertising', 'ogilvy', 'influence', 'alchemy', '$100m', 'contagious', 'how brands grow',
  'obviously awesome', 'storybrand', 'hooked', 'the mom test', 'traction', 'hacking growth', 'made to stick', 'scientific advertising', 'boron letters'];

const exclude = (profile.excluir_palabras || []).map(s => s.toLowerCase());
const voices = profile.voces_confiables || [];
const trustedHandles = new Map((profile.canales_confiables || []).map(c => [c.handle.toLowerCase(), c]));

const tagTopics = t => {
  const s = t.toLowerCase();
  return Object.entries(TOPICS).filter(([, res]) => res.some(r => r.test(s))).map(([k]) => k);
};
const squash = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const findVoice = s => { const l = s.toLowerCase(), q = squash(s); return voices.find(v => l.includes(v.toLowerCase()) || q.includes(squash(v))); };

const PART_RES = [
  /\b(?:part|parte|pt\.?|ep(?:isode)?\.?|episodio|chapter|cap[ií]tulo|lesson|lecci[oó]n)\s*#?\s*(\d{1,2})\b/i,
  /\((\d{1,2})\s*\/\s*\d{1,2}\)/,
  /\b(\d{1,2})\s+of\s+\d{1,2}\b/i,
  /^#\s?(\d{1,2})\b/,
];
function parsePart(title) {
  for (const re of PART_RES) {
    const m = title.match(re);
    if (m && +m[1] >= 1 && +m[1] <= 12) {
      const base = title.replace(re, ' ').toLowerCase().replace(/[^a-z0-9$áéíóúñ]+/g, ' ').trim();
      return { n: +m[1], base };
    }
  }
  return null;
}
const tokens = s => new Set(s.split(' ').filter(w => w.length > 2));
const jaccard = (a, b) => { const A = tokens(a), B = tokens(b); let i = 0; A.forEach(x => B.has(x) && i++); return i / (A.size + B.size - i || 1); };

const parseViews = s => {
  if (!s) return 0;
  const m = s.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1));
};
const parseDur = s => (s && /^\d+(:\d+)+$/.test(s)) ? s.split(':').reduce((a, x) => a * 60 + +x, 0) : 0;

// ---------- lectura de YouTube ----------
async function getData(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      const h = await r.text();
      const m = h.match(/var ytInitialData = (\{.*?\});<\/script>/s);
      if (m) return JSON.parse(m[1]);
    } catch (e) { /* reintento */ }
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  console.warn('  sin datos:', url);
  return null;
}

// Recorre el JSON y extrae todos los videos, sin importar el formato de tarjeta que use YouTube.
function extractVideos(data, ctx = {}) {
  const out = [];
  const seen = new Set();
  const push = v => { if (v.id && v.id.length === 11 && !seen.has(v.id)) { seen.add(v.id); out.push(v); } };
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.videoRenderer) {
      const r = o.videoRenderer;
      const owner = r.ownerText?.runs?.[0] || r.longBylineText?.runs?.[0];
      push({
        id: r.videoId, t: r.title?.runs?.map(x => x.text).join('') || '',
        ch: owner?.text || ctx.ch || '', h: (owner?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '').replace('/@', '') || ctx.h || '',
        d: parseDur(r.lengthText?.simpleText), v: parseViews(r.viewCountText?.simpleText), ago: r.publishedTimeText?.simpleText || '',
        s: false, live: !!r.badges?.some(b => /LIVE/.test(JSON.stringify(b))) || !r.lengthText,
      });
      return;
    }
    if (o.lockupViewModel && o.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const l = o.lockupViewModel;
      const md = l.metadata?.lockupMetadataViewModel;
      const parts = md?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap(r => r.metadataParts || []) || [];
      const badge = JSON.stringify(l.contentImage || {}).match(/"thumbnailBadgeViewModel":\{"text":"([^"]+)"/);
      const chPart = parts.find(p => p.text?.commandRuns);
      push({
        id: l.contentId, t: md?.title?.content || '',
        ch: ctx.ch || chPart?.text?.content || '', h: ctx.h || '',
        d: parseDur(badge?.[1]), v: parseViews(parts.find(p => /view/i.test(p.accessibilityLabel || '') || /K$|M$/.test(p.text?.content || ''))?.text?.content),
        ago: parts.find(p => /ago/.test(p.text?.content || ''))?.text?.content || '',
        s: false, live: !badge || /LIVE|UPCOMING/i.test(badge[1]),
      });
      return;
    }
    if (o.shortsLockupViewModel) {
      const s = o.shortsLockupViewModel;
      const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
      push({
        id, t: s.overlayMetadata?.primaryText?.content || '', ch: ctx.ch || '', h: ctx.h || '',
        d: 0, v: parseViews(s.overlayMetadata?.secondaryText?.content), ago: '', s: true, live: false,
      });
      return;
    }
    for (const k in o) walk(o[k]);
  })(data);
  return out;
}

const searchUrl = q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en`;

async function pool(items, n, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}

// ---------- construcción ----------
const all = new Map();
function accept(v, source) {
  if (!v.id || v.live || !v.t) return;
  const low = v.t.toLowerCase();
  if (exclude.some(w => low.includes(w))) return;
  const trustedCh = trustedHandles.get((v.h || '').toLowerCase());
  const voice = findVoice(v.t) || findVoice(v.ch || '');
  const book = BOOKS.find(b => low.includes(b));
  if (!trustedCh && !voice && !book) return;            // fuera: no es una fuente confiable
  if (!trustedCh && v.v && v.v < 20000) return;         // fuentes externas: solo con tracción real
  if (!v.s && v.d && v.d > 3 * 3600) return;
  let topics = tagTopics(v.t + ' ' + (book ? 'book' : ''));
  if (!topics.length && trustedCh?.temas) topics = trustedCh.temas.slice(0, 2);
  const part = parsePart(v.t);
  const item = {
    id: v.id, t: v.t, ch: v.ch || trustedCh?.speaker || '', h: v.h || '',
    sp: voice || trustedCh?.speaker || v.ch || 'Fuente externa',
    s: v.s, d: v.d, v: v.v, ago: v.ago, tp: topics, src: source,
  };
  if (part) { item.ser = `${(v.h || v.ch).toLowerCase()}|${part.base}`; item.pn = part.n; }
  const prev = all.get(v.id);
  if (!prev || (!prev.d && item.d)) all.set(v.id, { ...prev, ...item });
}

console.log('Canales…');
await pool([...trustedHandles.values()], 4, async c => {
  for (const tab of ['videos', 'shorts']) {
    const d = await getData(`https://www.youtube.com/@${c.handle}/${tab}?hl=en`);
    if (!d) continue;
    const title = d.metadata?.channelMetadataRenderer?.title || c.speaker;
    const vids = extractVideos(d, { ch: title, h: c.handle });
    vids.forEach(v => { v.s = v.s || tab === 'shorts'; accept(v, 'canal'); });
    console.log(`  @${c.handle}/${tab}: ${vids.length}`);
  }
});

console.log('Búsquedas…');
const queries = [...(profile.busquedas || [])];
for (const q of [...queries]) queries.push(q + ' shorts');
await pool(queries, 4, async q => {
  const d = await getData(searchUrl(q));
  if (!d) return;
  const vids = extractVideos(d);
  vids.forEach(v => accept(v, 'busqueda'));
  console.log(`  "${q}": ${vids.length}`);
});

console.log('Series (parte 2, 3…)…');
const items = [...all.values()];
const series = new Map();
items.filter(i => i.ser).forEach(i => { (series.get(i.ser) || series.set(i.ser, []).get(i.ser)).push(i); });
const toFind = [...series.entries()].map(([key, arr]) => {
  const max = Math.max(...arr.map(a => a.pn));
  return { key, sample: arr.find(a => a.pn === max), next: max + 1 };
}).slice(0, 40);
await pool(toFind, 4, async ({ sample, next }) => {
  const base = parsePart(sample.t).base;
  const d = await getData(searchUrl(`${sample.sp} ${base} part ${next}`));
  if (!d) return;
  extractVideos(d).forEach(v => {
    const p = parsePart(v.t);
    if (p && p.n > sample.pn && jaccard(p.base, base) >= 0.5) {
      if (!v.h && !v.ch) return;
      accept(v, 'serie');
      const got = all.get(v.id);
      if (got) { got.ser = sample.ser; got.pn = p.n; }
    }
  });
});

const final = [...all.values()];
const out = {
  generated: new Date().toISOString(),
  count: final.length,
  // Solo lo que la app necesita. El resto de profile.json (proyectos, contexto) nunca se publica.
  profile: { actualizado: profile.actualizado, prioridad_ahora: profile.prioridad_ahora, prioridades: profile.prioridades },
  items: final,
};
await fs.writeFile(path.join(ROOT, 'catalog.json'), JSON.stringify(out));
const shorts = final.filter(i => i.s).length;
console.log(`Listo: ${final.length} videos (${shorts} shorts, ${final.length - shorts} largos), ${new Set(final.filter(i => i.ser).map(i => i.ser)).size} series.`);
