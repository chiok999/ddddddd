// Compare original compiled build (8791) with reconstruction (8792).
const PAGES = [
  ['/', 'home'],
  ['/browse', 'browse'],
  ['/ranking', 'ranking'],
  ['/me', 'me'],
  ['/title/1', 'detail'],
  ['/watch/1', 'watch'],
];

const PORT_B = Number(process.env.PORT_B || 8792);
const get = async (port, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, html: await r.text() };
};

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<link[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Text of each element, in document order.
const texts = (html) =>
  strip(html)
    .split(/<[^>]+>/)
    .map((s) => s.trim())
    .filter(Boolean);

const classes = (html) =>
  [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());

const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

let failures = 0;
const bad = (msg) => {
  failures++;
  console.log('  FAIL ' + msg);
};

for (const [path, name] of PAGES) {
  const a = await get(8791, path);
  const b = await get(PORT_B, path);
  console.log(`\n${name} ${path}  status ${a.status}/${b.status}`);
  if (a.status !== b.status) bad(`status ${a.status} vs ${b.status}`);

  const ta = texts(a.html);
  const tb = texts(b.html);
  if (ta.length !== tb.length) bad(`text nodes ${ta.length} vs ${tb.length}`);
  let diffs = 0;
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (ta[i] !== tb[i]) {
      if (diffs < 6) console.log(`   [${i}] orig=${JSON.stringify(ta[i])?.slice(0, 90)}  new=${JSON.stringify(tb[i])?.slice(0, 90)}`);
      diffs++;
    }
  }
  if (diffs) bad(`${diffs} text differences`);
  else console.log(`   text: ${ta.length} nodes identical`);

  const ca = classes(a.html);
  const cb = classes(b.html);
  const same = ca.length === cb.length && ca.every((c, i) => c === cb[i]);
  if (!same) {
    let d = 0;
    for (let i = 0; i < Math.max(ca.length, cb.length); i++)
      if (ca[i] !== cb[i] && d++ < 5) console.log(`   class[${i}] orig=${JSON.stringify(ca[i]?.slice(0,80))} new=${JSON.stringify(cb[i]?.slice(0,80))}`);
    bad(`class attr list differs (${ca.length} vs ${cb.length}, ${d} mismatches)`);
  } else console.log(`   classes: ${ca.length} attrs identical`);

  // Ignore bundler output: chunk names and their hashes differ between builds by
  // construction. Everything a user can navigate to must match.
  const nav = (h) => h.startsWith('/') && !h.startsWith('/assets/') && !h.startsWith('/@');
  const ha = hrefs(a.html).filter(nav);
  const hb = hrefs(b.html).filter(nav);
  const sameH = ha.length === hb.length && ha.every((h, i) => h === hb[i]);
  if (!sameH) {
    const onlyA = ha.filter((h) => !hb.includes(h));
    const onlyB = hb.filter((h) => !ha.includes(h));
    console.log(`   links orig=${ha.length} new=${hb.length} onlyA=${JSON.stringify(onlyA.slice(0,6))} onlyB=${JSON.stringify(onlyB.slice(0,6))}`);
    bad('link sets differ');
  } else console.log(`   links: ${ha.length} identical`);
}

// Title/meta descriptions
for (const [path, name] of PAGES) {
  const a = await get(8791, path);
  const b = await get(PORT_B, path);
  const pick = (h, re) => (h.match(re) || [])[1];
  const t = (h) => pick(h, /<title[^>]*>([\s\S]*?)<\/title>/);
  const d = (h) => pick(h, /<meta name="description" content="([^"]*)"/);
  if (t(a.html) !== t(b.html)) bad(`${name} title "${t(a.html)}" vs "${t(b.html)}"`);
  if (d(a.html) !== d(b.html)) bad(`${name} description differs:\n     orig=${d(a.html)}\n     new =${d(b.html)}`);
}

// 404
{
  const a = await get(8791, '/nope');
  const b = await get(PORT_B, '/nope');
  console.log(`\n404 status ${a.status}/${b.status}`);
  if (a.status !== b.status) bad('404 status');
  const ta = texts(a.html), tb = texts(b.html);
  if (ta.join('|') !== tb.join('|')) {
    console.log('   orig:', ta.join(' | ').slice(0, 200));
    console.log('   new :', tb.join(' | ').slice(0, 200));
    bad('404 body differs');
  } else console.log('   404 body identical');
}

console.log(`\n=== ${failures} failures ===`);
process.exit(failures ? 1 : 0);
