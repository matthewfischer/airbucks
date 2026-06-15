// Fetch public-domain vintage postcards (Tichnor Brothers / Boston Public
// Library and Curt Teich / Newberry Library collections, via Wikimedia
// Commons) for each airport city, into public/postcards/<airport id>.jpg.
// Only cities in CITY_INFO are attempted — the collections are US-centric;
// everywhere else the slot-granted popup falls back to a text-only card.
//
// For cities the search can't crack (including non-US ones), browse Commons
// yourself and paste the exact file title into MANUAL_PICKS below; the
// license is still verified but the subject is taken on trust.
//
// Usage: node scripts/fetch-postcards.mjs [--force]
// Re-runnable; skips ids that already have a file unless --force.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/postcards');
const force = process.argv.includes('--force');
mkdirSync(outDir, { recursive: true });

const API = 'https://commons.wikimedia.org/w/api.php';
const HEADERS = { 'User-Agent': 'airbucks-postcard-fetch/1.0 (hobby game; matt@mattfischer.com)' };
const THUMB_WIDTH = 1200;

// Cities worth searching, with the state/territory used to qualify the search
// and to reject wrong-state matches (Portland ME vs OR, Charleston SC vs WV…).
// `q` overrides the name used in search + title matching where the data's city
// label wouldn't appear in postcard titles.
const CITY_INFO = {
  'Charleston, WV': { state: 'West Virginia', mustMatch: /w\.? ?va|west virginia/ },
  'Charleston, SC': { state: 'South Carolina', mustMatch: /s\.? ?c\.?\b|south carolina/ },
  'Charlotte': { state: 'North Carolina' },
  'Washington': { state: 'D. C.' },
  'Pittsburgh': { state: 'Pennsylvania' },
  'Cleveland': { state: 'Ohio' },
  'Cincinnati': { state: 'Ohio' },
  'Columbus': { state: 'Ohio' },
  'Richmond': { state: 'Virginia' },
  'Louisville': { state: 'Kentucky' },
  'Knoxville': { state: 'Tennessee' },
  'Greensboro': { state: 'North Carolina' },
  'Raleigh-Durham': { state: 'North Carolina', q: 'Raleigh' },
  'Norfolk': { state: 'Virginia' },
  'Baltimore': { state: 'Maryland' },
  'Philadelphia': { state: 'Pennsylvania' },
  'Indianapolis': { state: 'Indiana' },
  'Detroit': { state: 'Michigan' },
  'Nashville': { state: 'Tennessee' },
  'Buffalo': { state: 'New York' },
  'Boston': { state: 'Massachusetts' },
  'New York': { state: 'New York', q: 'New York City' },
  'Atlanta': { state: 'Georgia' },
  'Miami': { state: 'Florida' },
  'Chicago': { state: 'Illinois' },
  'Denver': { state: 'Colorado' },
  'Los Angeles': { state: 'California' },
  'Dallas': { state: 'Texas' },
  'San Francisco': { state: 'California' },
  'Seattle': { state: 'Washington' },
  'Phoenix': { state: 'Arizona' },
  'Houston': { state: 'Texas' },
  'Las Vegas': { state: 'Nevada' },
  'Minneapolis': { state: 'Minnesota' },
  'Portland': { state: 'Oregon' },
  'Salt Lake City': { state: 'Utah' },
  'Orlando': { state: 'Florida' },
  'Tampa': { state: 'Florida' },
  'New Orleans': { state: 'Louisiana' },
  'San Diego': { state: 'California' },
  'St. Louis': { state: 'Missouri' },
  'Kansas City': { state: 'Missouri' },
  'Austin': { state: 'Texas' },
  'San Antonio': { state: 'Texas' },
  'Memphis': { state: 'Tennessee' },
  'Jacksonville': { state: 'Florida' },
  'Albuquerque': { state: 'New Mexico' },
  'Boise': { state: 'Idaho' },
  'Bozeman': { state: 'Montana' },
  'Sacramento': { state: 'California' },
  'Milwaukee': { state: 'Wisconsin' },
  'Omaha': { state: 'Nebraska' },
  'Des Moines': { state: 'Iowa' },
  'Anchorage': { state: 'Alaska' },
  'Fairbanks': { state: 'Alaska' },
  'Juneau': { state: 'Alaska' },
  'Honolulu': { state: 'Hawaii' },
  'Kahului (Maui)': { state: 'Hawaii', q: 'Maui' },
  'Kona': { state: 'Hawaii' },
  'Lihue (Kauai)': { state: 'Hawaii', q: 'Kauai' },
  'San Juan': { state: 'Puerto Rico' },
  'Havana': { state: 'Cuba' },
  'Nassau': { state: 'Bahamas' },
  'Bermuda': { state: 'Bermuda' },
};

// Hand-picked Commons file titles by airport id. These skip the search and
// the provenance check (you vouch for the subject), but must still be
// public domain. Browse e.g.
//   https://commons.wikimedia.org/wiki/Category:Postcards_of_<City>
//   https://commons.wikimedia.org/w/index.php?search=<city>+postcard&ns6=1
const MANUAL_PICKS = {
  clt: 'File:3. Municipal Airport, Charlotte, N. C. (5756052158).jpg',
  dca: 'File:Washington National (1944).jpg',
  gcm: 'File:AA flight from Quito, Ecuador to Miami, Florida...Grand Cayman Islands.Georgetown near the airport... (26692786390).jpg',
  gso: 'File:Greetings from Greensboro, North Carolina - Large Letter Postcard (8555919882).jpg',
  mid: 'File:Mérida International Airport (Aeropuerto Internacional de Mérida Manuel Crescencio Rejón) Feb 2021 - 02.jpg',
  msq: 'File:5 50 64 2f - Belarus National Library, Minsk 2009 (3901618837).jpg',
  ric: 'File:Greetings from Richmond, Virginia - Large Letter Postcard (14395075646).jpg',
  sdf: 'File:Postcard showing Bowman Field, Kentucky. Administration Building and Hangar c.1939.jpg',
};

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
  'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
  'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
  'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
  'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
  'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia',
  'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
];

function airports() {
  const src = readFileSync(resolve(root, 'src/game/data.ts'), 'utf8');
  const re = /id: '(\w+)', code: '\w+', city: '([^']+)'/g;
  return [...src.matchAll(re)].map(([, id, city]) => ({ id, city }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', ...params })}`;
  for (let attempt = 1; ; attempt++) {
    await sleep(150);
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error.code);
      return d;
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`  .. retry ${attempt} (${e.message})`);
      await sleep(1500 * attempt);
    }
  }
}

/** Rank a candidate title: prefer skylines/aerials/greetings; reject card
 *  backs, document scans, mundane subjects (motels, hospitals…), and matches
 *  naming a different state. */
function score(title, name, state, mustMatch) {
  const t = title.toLowerCase();
  if (!t.includes(name.toLowerCase())) return -1;
  if (mustMatch && !mustMatch.test(t)) return -1;
  if (/\bback\b/.test(t) || /\.(pdf|tiff?|djvu)$/i.test(t)) return -1;
  if (/motel|hotel|hospital|school|church|dining|club|lodge|distill|sanatorium|\bcourt\b|restaurant|publishing|greeting cards|coal/.test(t))
    return -1;
  // "Greetings from X" cards must greet *this* city, not merely mention it.
  const gm = t.match(/greetings? (?:you )?from (?:the city of )?([^,(]+)/);
  if (gm && !gm[1].includes(name.toLowerCase())) return -1;
  // Modern photographs sneak into the searches; postcards predate the 2000s.
  if (/\b20\d\d\b|dsc|img_/.test(t)) return -1;
  // Reject titles naming a different state — unless that state name is part
  // of the city's own name (Washington, New York).
  for (const s of US_STATES)
    if (s !== state && !name.toLowerCase().includes(s.toLowerCase()) && t.includes(s.toLowerCase()))
      return -1;
  // Require a genuinely scenic subject — a state mention or street address
  // alone lets through motels, shop ads, and the like.
  let sc = 0;
  if (/skyline|skyscraper/.test(t)) sc += 6;
  if (/aerial|air view|airplane view|bird'?s.eye/.test(t)) sc += 5;
  if (/greeting/.test(t)) sc += 5;
  if (/large letter postcard/.test(t)) sc += 2;
  if (/general view|panorama|night scene/.test(t)) sc += 4;
  if (/waterfront|harbor|beach|capitol|downtown|business district|city hall/.test(t)) sc += 2;
  if (sc === 0) return -1;
  if (t.includes(state.toLowerCase())) sc += 1;
  // Favor obvious scans (Tichnor naming, BPL accession numbers) over photos.
  if (/tichnor|postcard|\(\d{5}\)/.test(t)) sc += 2;
  return sc;
}

/** Candidate file titles: per-city Tichnor categories (both naming patterns
 *  Commons uses) plus a text search. */
async function candidates(name, state) {
  const titles = new Set();
  const cats = [
    `Category:Postcards of ${name} published by Tichnor Brothers`,
    `Category:Tichnor Brothers postcards of ${name}`,
    `Category:Tichnor Brothers postcards of ${name}, ${state}`,
  ];
  for (const cmtitle of cats) {
    const d = await api({
      action: 'query', list: 'categorymembers', cmtitle,
      cmnamespace: '6', cmlimit: '300',
    });
    for (const m of d.query?.categorymembers ?? []) titles.add(m.title);
  }
  // Several text searches: many scans in the collection never mention Tichnor
  // in their description (the metadata gate still vouches for provenance).
  const searches = [
    `Tichnor ${name} ${state}`,
    `Greetings from ${name}`,
    `Greetings from ${name} large letter postcard`,
    `${name} ${state} skyline`,
    `${name} ${state} aerial view postcard`,
  ];
  for (const srsearch of searches) {
    const d = await api({
      action: 'query', list: 'search', srnamespace: '6', srlimit: '25', srsearch,
    });
    for (const r of d.query?.search ?? []) titles.add(r.title);
  }
  return [...titles];
}

async function findPostcard(city) {
  const info = CITY_INFO[city];
  if (!info) return null;
  const name = info.q ?? city.split(',')[0];
  const hits = (await candidates(name, info.state))
    .map((title) => ({ title, s: score(title, name, info.state, info.mustMatch) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s);
  // Title score alone ranks modern CC-licensed skyline photos above genuine
  // vintage scans, so the license gate must see well past the top few — a
  // rank-14 public-domain card behind 13 CC photos is the common case.
  for (const hit of hits.slice(0, 40)) {
    const card = await checkLicense(hit.title);
    if (card) return card;
  }
  return null;
}

/** Fetch imageinfo and pass only confirmed public-domain scans from a known
 *  vintage-postcard archive: Tichnor Brothers (credited to its holder, the
 *  Boston Public Library) or Curt Teich (Newberry Library, "NBY" files).
 *  With `anyProvenance` (manual picks) the archive check is skipped. */
async function checkLicense(title, anyProvenance = false) {
  const q = await api({
    action: 'query', titles: title, prop: 'imageinfo',
    iiprop: 'url|extmetadata', iiurlwidth: String(THUMB_WIDTH),
  });
  const ii = Object.values(q.query.pages)[0].imageinfo?.[0];
  if (!ii) return null;
  const meta = ii.extmetadata ?? {};
  const license = meta.LicenseShortName?.value ?? '';
  const provenance = (meta.Artist?.value ?? '') + (meta.Credit?.value ?? '');
  // Manual picks may be CC BY (attribution lives in CREDITS.md; Commons
  // hosts no NC/ND licenses). Auto picks must be public domain from a known
  // archive — except the "Large Letter Postcard" Flickr series, a uniformly
  // vintage set that is CC BY: there the title alone vouches for the style.
  if (anyProvenance || /large letter postcard/i.test(title)) {
    if (!/public domain|cc by/i.test(license)) return null;
  } else if (!/public domain/i.test(license)
      || !/tichnor|boston public library|teich|newberry/i.test(provenance)) {
    return null;
  }
  return { title, thumb: ii.thumburl, page: ii.descriptionurl, license };
}

// Credit lines keyed by airport id, seeded from the existing CREDITS.md so a
// re-run that skips files doesn't lose their attributions.
const creditsPath = resolve(outDir, 'CREDITS.md');
const creditById = new Map(
  (existsSync(creditsPath) ? readFileSync(creditsPath, 'utf8').split('\n') : [])
    .filter((l) => l.startsWith('- '))
    .map((l) => [l.slice(2).split(' ')[0], l]),
);
const byCity = new Map(); // first downloaded file + credit per city, for shared-city airports
let found = 0;

for (const { id, city } of airports()) {
  const out = resolve(outDir, `${id}.jpg`);
  if (existsSync(out) && !force) { found++; continue; }
  if (!MANUAL_PICKS[id] && byCity.has(city)) {
    const shared = byCity.get(city);
    copyFileSync(shared.file, out);
    creditById.set(id, shared.credit.replace(/^- \w+ /, `- ${id} `));
    found++;
    continue;
  }
  const card = MANUAL_PICKS[id]
    ? await checkLicense(MANUAL_PICKS[id], true).catch(() => null)
    : await findPostcard(city).catch((e) => (console.log(`  !! ${city}: ${e.message}`), null));
  if (!card) {
    if (MANUAL_PICKS[id]) console.log(`  !! ${id}: manual pick missing or not public domain — ${MANUAL_PICKS[id]}`);
    else if (CITY_INFO[city]) console.log(`  -- ${city}: no match`);
    continue;
  }
  const img = await fetch(card.thumb, { headers: HEADERS });
  writeFileSync(out, Buffer.from(await img.arrayBuffer()));
  const credit = `- ${id} (${city}): [${card.title}](${card.page}) — ${card.license}`;
  byCity.set(city, { file: out, credit });
  creditById.set(id, credit);
  found++;
  console.log(`  ok ${city}: ${card.title}`);
  await new Promise((r) => setTimeout(r, 200));
}

writeFileSync(creditsPath, [
  '# Postcard image credits', '',
  'Public-domain vintage postcards via Wikimedia Commons: Tichnor Brothers',
  'collection (Boston Public Library), Curt Teich collection (Newberry',
  'Library), and hand-picked files (see MANUAL_PICKS in the fetch script).', '',
  ...[...creditById.values()].sort(),
].join('\n') + '\n');
console.log(`\n${found} of ${airports().length} airports have postcards.`);
