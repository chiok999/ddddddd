'use strict';
/**
 * The app shell: routing, the static layer it depends on, and the CSP that has to
 * allow the shell's own inline scripts without allowing anyone else's.
 *
 * The static layer now serves nested paths (the bundle has an `assets/`
 * directory), so the traversal rules are re-proved here rather than assumed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStatic } = require('./static');

const SHELL = path.join(__dirname, 'app', 'dist', 'public', '_shell.html');
const hasShell = fs.existsSync(SHELL);

async function withServer(fn) {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), CINEMA_PASSWORD: 'a-strong-test-password' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

test('the static layer refuses traversal while serving nested bundle paths', () => {
  const files = createStatic({ root: __dirname });
  // A nested asset is the reason this changed: the bundle lives in assets/.
  assert.ok(files.resolve('/assets/app.js'), 'nested asset should resolve');
  assert.ok(files.resolve('/index.html'));
  for (const attempt of [
    '/../package.json',
    '/assets/../../package.json',
    '/./package.json',
    '/..%2fpackage.json',
    '/.env',
    '/assets/.hidden',
    '//package.json',
    '/assets/',
  ]) {
    assert.equal(files.resolve(attempt), null, `${attempt} must not resolve`);
  }
  // A single segment that is exactly `..` is caught by the segment check above.
  // The containment check is the second line of defence, for a path whose
  // segments look ordinary but which still lands outside the directory --- an
  // over-long run of `..` is the case the segment check alone cannot be trusted
  // with once the resolver is ever changed.
  assert.equal(files.resolve('/assets/../../../package.json'), null);
});

test('the app owns /, the classic player keeps /classic/, and a typo is a 404', async () => {
  if (!hasShell) {
    assert.ok(true, 'no published shell; run `npm run build` in reelbox-src first');
    return;
  }
  await withServer(async (base) => {
    const root = await fetch(base + '/');
    assert.equal(root.status, 200);
    const body = await root.text();
    assert.match(body, /data-tsr-stream-part/, 'the shell is the built app document');
    assert.doesNotMatch(body, /id="loginForm"/, 'the classic login form must not be at /');

    // Deep links are the shell too, because the client router resolves them.
    for (const route of ['/browse', '/ranking', '/me', '/title/abc123', '/watch/abc123']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.match(await response.text(), /data-tsr-stream-part/, route);
    }

    const classic = await fetch(base + '/classic/');
    assert.equal(classic.status, 200);
    assert.match(await classic.text(), /id="loginForm"/, 'the old UI is still reachable');
    assert.equal((await fetch(base + '/classic/app.js')).status, 200);

    assert.equal((await fetch(base + '/nope')).status, 404, 'a typo must not render the app');
    assert.equal((await fetch(base + '/title/')).status, 404);
    assert.equal((await fetch(base + '/watch/a/b')).status, 404);
  });
});

test('every inline script in the shell is allowed by hash, not by weakening script-src', async () => {
  if (!hasShell) {
    assert.ok(true, 'no published shell; run `npm run build` in reelbox-src first');
    return;
  }
  const shell = fs.readFileSync(SHELL, 'utf8');
  const inline = [...shell.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter(Boolean);
  assert.ok(inline.length > 0, 'the shell is expected to carry inline scripts');
  const expected = inline.map((body) => `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);

  await withServer(async (base) => {
    const response = await fetch(base + '/');
    const csp = response.headers.get('content-security-policy');
    const scriptSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
    for (const hash of expected) assert.ok(scriptSrc.includes(hash), `missing ${hash}`);
    // The hashes only work if inline script is otherwise forbidden.
    assert.doesNotMatch(scriptSrc, /unsafe-inline/, 'inline script must not be blanket-allowed');
    assert.doesNotMatch(scriptSrc, /unsafe-eval/);
    assert.match(scriptSrc, /'self'/);
    // The other directives the app depends on, each for a stated reason.
    assert.match(csp, /img-src[^;]*https:\/\/wsrv\.nl/);
    assert.match(csp, /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
    assert.match(csp, /style-src-elem[^;]*https:\/\/fonts\.googleapis\.com/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});

test('a stale shell hash fails closed: an unknown inline script is still blocked', async () => {
  if (!hasShell) {
    assert.ok(true, 'no published shell');
    return;
  }
  // The hashes are derived from the file at startup, so a rebuilt shell gets new
  // hashes on the next start. What must never happen is a policy that allows
  // *any* inline script as a fallback.
  await withServer(async (base) => {
    const csp = (await fetch(base + '/')).headers.get('content-security-policy');
    assert.doesNotMatch(csp, /sha256-[^']*'?\s*'strict-dynamic'/, 'no strict-dynamic escape hatch');
    assert.equal((csp.match(/sha256-/g) || []).length, 2, 'exactly the two known scripts');
  });
});
