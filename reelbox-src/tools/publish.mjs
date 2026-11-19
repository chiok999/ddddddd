// Copy the built app into the server that serves it.
//
// The shell is a static artifact: `solo-cinema` serves it and never builds it.
// Keeping the copy as an explicit step means the deploy stays "the repository",
// and a stale bundle is visible in a diff rather than silent.

import { cp, rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'dist');
const dest = join(here, '..', '..', 'solo-cinema', 'app', 'dist');

if (!existsSync(join(src, 'client', '_shell.html'))) {
  console.error('No shell in dist/client/_shell.html — the build did not produce an SPA shell.');
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

// Only what the browser and the document need. The server bundle would drag a
// second copy of React into the repository for no one to run.
//
// `public/` is the directory the server's static layer reads, so the URLs in the
// shell (`/assets/...`, `/favicon.ico`) resolve without a prefix.
const publicDir = join(dest, 'public');
await cp(join(src, 'client'), publicDir, { recursive: true });

const files = await readdir(publicDir);
console.log(`published ${files.length} entries to solo-cinema/app/dist/public`);
