// Add one hand-picked postcard: download it, verify the license, register it
// in MANUAL_PICKS (fetch-postcards.mjs) and CREDITS.md.
//
// Usage: node scripts/add-postcard.mjs <airport-id> <Commons File: title or upload URL>

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEADERS = { 'User-Agent': 'airbucks-postcard-fetch/1.0 (hobby game; matt@mattfischer.com)' };

const [id, ...rest] = process.argv.slice(2);
let title = rest.join(' ');
if (!id || !title) {
  console.error('usage: node scripts/add-postcard.mjs <airport-id> <File: title or URL>');
  process.exit(1);
}
if (/^https?:\/\//.test(title))
  title = 'File:' + decodeURIComponent(new URL(title).pathname.split('/').pop()).replace(/_/g, ' ');

const dataSrc = readFileSync(resolve(root, 'src/game/data.ts'), 'utf8');
const m = dataSrc.match(new RegExp(`id: '${id}', code: '\\w+', city: '([^']+)'`));
if (!m) { console.error(`unknown airport id: ${id}`); process.exit(1); }
const city = m[1];

const q = await fetch(`https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
  format: 'json', action: 'query', titles: title,
  prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '1200',
})}`, { headers: HEADERS }).then((r) => r.json());
const ii = Object.values(q.query.pages)[0].imageinfo?.[0];
if (!ii) { console.error(`no such file on Commons: ${title}`); process.exit(1); }
const license = ii.extmetadata?.LicenseShortName?.value ?? '';
if (!/public domain|cc by/i.test(license)) {
  console.error(`unusable license "${license}": ${title}`);
  process.exit(1);
}

const img = await fetch(ii.thumburl, { headers: HEADERS });
writeFileSync(resolve(root, `public/postcards/${id}.jpg`), Buffer.from(await img.arrayBuffer()));

// Register in MANUAL_PICKS so a --force refetch keeps the pick.
const fetchPath = resolve(root, 'scripts/fetch-postcards.mjs');
const fetchSrc = readFileSync(fetchPath, 'utf8');
const entry = `  ${id}: ${JSON.stringify(title).replace(/'/g, "\\'").replace(/^"|"$/g, "'")},`;
const picksRe = /(const MANUAL_PICKS = \{\n)([\s\S]*?)(\};)/;
const [, open, body, close] = fetchSrc.match(picksRe);
const lines = body.split('\n').filter((l) => l.trim() && !l.trim().startsWith(`${id}:`));
lines.push(entry);
writeFileSync(fetchPath, fetchSrc.replace(picksRe, open + lines.sort().join('\n') + '\n' + close));

// Upsert the credit line, keeping the list sorted by airport id.
const creditsPath = resolve(root, 'public/postcards/CREDITS.md');
const credits = readFileSync(creditsPath, 'utf8').split('\n');
const header = credits.filter((l) => !l.startsWith('- ') && l !== '').concat('');
const byId = new Map(credits.filter((l) => l.startsWith('- ')).map((l) => [l.slice(2).split(' ')[0], l]));
byId.set(id, `- ${id} (${city}): [${title}](${ii.descriptionurl}) — ${license}`);
writeFileSync(creditsPath, [...header, ...[...byId.values()].sort(), ''].join('\n'));

console.log(`ok ${id} (${city}): ${title} — ${license}`);
