'use strict';
// Keeps ARCHITECTURE.md from drifting away from the code.
//
// The notes this file replaced were not wrong when written — they were corrected
// in place until "current policy" contradicted the body beneath it and the code
// beneath that. Nothing caught it, because prose is not a test. These are the
// claims that cost the most when they go stale.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DOC = fs.readFileSync(path.join(__dirname, 'ARCHITECTURE.md'), 'utf8');
const config = require('./config');

test('the documented limits are the configured ones', () => {
  // Each pair is [what the document claims, where the truth comes from].
  const claims = [
    [/`leadSeconds` is (\d+)/, config.leadSeconds()],
    [/\| segment length \| (\d+) s \|/, 4],
    [/\| startup deadline \| (\d+) s \|/, Math.round(config.startupMs() / 1000)],
    [/\| idle expiry \| (\d+) min \|/, Math.round(config.idleMs() / 60000)],
    [/\| concurrent jobs \| (\d+), server-wide \|/, 1],
  ];
  for (const [pattern, actual] of claims) {
    const found = DOC.match(pattern);
    assert.ok(found, `the document no longer states ${pattern}`);
    assert.equal(Number(found[1]), actual, `${found[0]} but the code says ${actual}`);
  }
  // The rungs, as a list rather than a number.
  assert.deepEqual(config.ladder(), ['240', '360']);
  assert.match(DOC, /240p and 360p/);
});

test('the document does not resurrect limits that were removed', () => {
  // A 128 MiB output cap and a free-space reserve were removed on request. Both
  // survived in three earlier documents for weeks after the code changed. The
  // document may *mention* them (it explains that they are gone); what it must
  // not do is state them as current. So the assertions are about the table rows
  // and the code, not about the words appearing at all.
  assert.match(DOC, /output size cap \| \*\*none\*\*/, 'the table says there is no cap');
  assert.match(DOC, /free-space reserve \| \*\*none\*\*/, 'the table says there is no reserve');
  assert.doesNotMatch(DOC, /\| output size cap \| \d+/, 'no numeric cap in the table');
  // The code must agree: no size cap exists to document either way.
  const transcode = fs.readFileSync(path.join(__dirname, 'transcode.js'), 'utf8');
  assert.doesNotMatch(transcode, /output above \d+ MiB/);
});

test('seeking past the conversion is documented as restarting it, not failing', () => {
  // This single behaviour was wrong in three separate notes at once. The engine
  // test 'seeking past the converted window restarts the conversion there' is the
  // proof; this keeps the prose pointing at it.
  assert.match(DOC, /Seeking past what has been converted starts a new conversion/);
  // And it must not repeat the old claim anywhere, in any wording that says the
  // window is a hard boundary -- that phrasing is what shipped wrong three times.
  assert.doesNotMatch(DOC, /seek(ing)? (is|are) limited to/i);
  assert.doesNotMatch(DOC, /only .{0,20}already-converted/i);
  assert.doesNotMatch(DOC, /cannot seek (past|beyond)/i);
});

test('the document names the real files it describes', () => {
  for (const file of ['troy-relay-server.js', 'transcode.js', 'config.js', 'UI.md', 'RELAY-PERF.md']) {
    assert.ok(fs.existsSync(path.join(__dirname, file)), `${file} is referenced but missing`);
    assert.ok(DOC.includes(file), `the document should mention ${file}`);
  }
});

test('no removed audit document is still referenced', () => {
  const gone = ['TRANSCODING-AUDIT.md', 'VOD-SEEK-INVESTIGATION.md', 'CONTROL-AUDIT.md',
    'PLAYER-AUDIT.md', 'PROVIDER-AUDIT.md', 'REDESIGN-NOTES.md', 'MOVY-UPSTREAM.md', 'INVESTIGATION.md'];
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.md'));
  for (const doc of files) {
    const text = fs.readFileSync(path.join(__dirname, doc), 'utf8');
    for (const removed of gone) {
      assert.ok(!text.includes(removed), `${doc} still points at the removed ${removed}`);
    }
  }
});

test('the documented test count is not a lie', () => {
  // Deliberately soft: it checks the claim exists and is a plausible number for
  // this suite. A hard count would fail on every unrelated addition and teach
  // everyone to edit the number without reading it.
  const found = DOC.match(/npm test\s+# (\d+) tests/);
  assert.ok(found, 'the document states the suite size');
  const claimed = Number(found[1]);
  assert.ok(claimed >= 100 && claimed <= 400, `claimed ${claimed}, which is not this suite`);
});
