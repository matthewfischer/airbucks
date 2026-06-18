// Best-effort scenic/landmark images for the non-US airport cities the
// vintage-postcard script (fetch-postcards.mjs) can't cover. For each airport
// still lacking a postcard, grab the lead image of the city's Wikipedia
// article (editor-curated, representative), falling back to a filtered Commons
// search, and write public/postcards/<id>.jpg.
//
// Usage: node scripts/fetch-world-postcards.mjs [--force] [id ...]
//   --force   re-fetch even if a file already exists
//   id ...    limit to specific airport ids
//
// Re-runnable; safe to re-run for ids that failed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/postcards');
mkdirSync(outDir, { recursive: true });

const API = 'https://commons.wikimedia.org/w/api.php';
const HEADERS = { 'User-Agent': 'airbucks-postcard-fetch/1.0 (hobby game; matt@mattfischer.com)' };

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyIds = args.filter((a) => !a.startsWith('--'));

// Wikipedia article-title overrides where the plain city label is a
// disambiguation page or doesn't match the article (redirects=1 handles most).
const ARTICLE = {
  kin: 'Kingston, Jamaica',
  scl: 'Santiago',
  stt: 'Charlotte Amalie, United States Virgin Islands',
  sxm: 'Philipsburg, Sint Maarten',
  aua: 'Oranjestad, Aruba',
  bgi: 'Bridgetown',
  pls: 'Providenciales',
  nan: 'Nadi',
  ppg: 'Pago Pago',
  awk: 'Wake Island',
  mdy: 'Midway Atoll',
  yqx: 'Gander, Newfoundland and Labrador',
  yyr: 'Happy Valley-Goose Bay',
  pdl: 'Ponta Delgada',
  goh: 'Nuuk',
  pos: 'Port of Spain',
  ccs: 'Caracas',
  uio: 'Quito',
  snn: 'Shannon, County Clare',
  gum: 'Hagåtña, Guam',
  led: 'Saint Petersburg',
  fao: 'Faro, Portugal', // plain "Faro" is a disambiguation page
  grj: 'George, Western Cape', // plain "George" resolves to the writer George Sand
};

// Reject candidates whose title smells like a non-scenic asset.
const BAD_TITLE = /flag|\bmap\b|coat of arms|logo|\bseal\b|locator|diagram|chart|\.svg|\.pdf|emblem|escudo|bandera|mapa|location|\bicon\b|wikidata|qr code|graph|timeline/i;
const OK_MIME = new Set(['image/jpeg', 'image/png', 'image/tiff']);

function cityById() {
  const src = readFileSync(resolve(root, 'src/game/data.ts'), 'utf8');
  const block = src.slice(src.indexOf('AIRPORTS'), src.indexOf('];', src.indexOf('AIRPORTS')));
  const map = {};
  for (const m of block.matchAll(/id: '([a-z0-9]+)', code: '[A-Z0-9]+', city: '([^']+)'/g))
    map[m[1]] = m[2];
  return map;
}

const WIKI = 'https://en.wikipedia.org/w/api.php';

// City label -> Wikipedia article title (strip parentheticals & country suffix).
function articleTitle(id, city) {
  return ARTICLE[id] ?? city.replace(/\s*\([^)]*\)/g, '').replace(/,.*$/, '').trim();
}

// Lead image of the city's Wikipedia article — curated and representative.
async function wikiLeadImage(title) {
  const params = new URLSearchParams({
    format: 'json', action: 'query', redirects: '1', titles: title,
    prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '1200',
  });
  const r = await fetch(`${WIKI}?${params}`, { headers: HEADERS }).then((x) => x.json());
  const page = Object.values(r?.query?.pages ?? {})[0];
  const src = page?.thumbnail?.source;
  if (!src || /\.svg/i.test(src)) return null;
  return { title: `Wikipedia: ${page.title}`, url: src };
}

// Fallback: Commons full-text search, requiring the place name in the title.
// Tries plain name then scenic qualifiers; first good hit wins.
async function commonsSearch(name) {
  const first = name.split(/[ ,]/)[0].toLowerCase();
  for (const q of [name, `${name} skyline`, `${name} cityscape`]) {
    const params = new URLSearchParams({
      format: 'json', action: 'query', generator: 'search',
      gsrsearch: q, gsrnamespace: '6', gsrlimit: '15',
      prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: '1200',
    });
    const r = await fetch(`${API}?${params}`, { headers: HEADERS }).then((x) => x.json());
    const pages = Object.values(r?.query?.pages ?? {}).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
    for (const p of pages) {
      const ii = p.imageinfo?.[0];
      if (!ii || !OK_MIME.has(ii.mime) || !ii.thumburl) continue;
      if (BAD_TITLE.test(p.title) || (ii.width ?? 0) < 800) continue;
      if (!p.title.toLowerCase().includes(first)) continue; // must actually be the place
      return { title: p.title, url: ii.thumburl };
    }
  }
  return null;
}

async function fetchFor(id, name) {
  const hit = (await wikiLeadImage(name).catch(() => null)) ?? (await commonsSearch(name).catch(() => null));
  if (!hit) return null;
  const tmp = resolve(tmpdir(), `pc_${id}`);
  const buf = Buffer.from(await fetch(hit.url, { headers: HEADERS }).then((r) => r.arrayBuffer()));
  writeFileSync(tmp, buf);
  try {
    // Normalize to JPEG regardless of source type; skip if the file won't decode.
    execFileSync('sips', ['-s', 'format', 'jpeg', tmp, '--out', resolve(outDir, `${id}.jpg`)], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return hit.title;
}

const cities = cityById();
let ids = Object.keys(cities).filter((id) => force || !existsSync(resolve(outDir, `${id}.jpg`)));
if (onlyIds.length) ids = ids.filter((id) => onlyIds.includes(id));

const ok = [], fail = [];
for (const id of ids) {
  const title = await fetchFor(id, articleTitle(id, cities[id])).catch(() => null);
  if (title) { ok.push(id); console.log(`ok   ${id} (${cities[id]}) <- ${title}`); }
  else { fail.push(id); console.log(`FAIL ${id} (${cities[id]})`); }
  await new Promise((r) => setTimeout(r, 250)); // be gentle with the API
}
console.log(`\n${ok.length} fetched, ${fail.length} failed${fail.length ? ': ' + fail.join(' ') : ''}`);
