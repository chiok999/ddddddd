# Cloudflare relay

One idea: **Troy stops fetching media itself.** A Cloudflare Worker fetches it, and
Troy reads the Worker. The worker's address is not the address the CDN is refusing.

This is for the case that cannot be fixed by a header: when a provider CDN answers
`426` (or `403`) to every request from your server -- HTTP/1.1, HTTP/2, browser
User-Agent, all of them -- the refusal belongs to your server's address. `troy-426.js`
prints the four-way comparison if you want to confirm it again.

Cloudflare's free plan has **no charge for egress** and **no limit on a response
body**, so relaying a full-length film costs nothing and is not clamped. (Request
bodies are limited to 100 MB. This only downloads.)

```
browser ──> Troy (your VPS) ──> Worker (Cloudflare) ──> provider CDN
                 │                     ▲
                 └──── same bytes ─────┘
```

Troy still does everything else: the player, the session, the provider resolution,
four-byte-range probing, FFmpeg. Only the address the bytes come from changes.

## 1. Create the worker

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Worker**.
2. Name it anything (`troy-relay`), **Deploy** the starter.
3. **Edit code**, select everything, paste all of [`troy-relay-paste.js`](./troy-relay-paste.js), **Deploy**.
   (`troy-relay-paste.js` is the same program as `troy-relay.mjs` with the
   deployment steps written at the top, because the dashboard editor has no
   comment-free copy. Keep the two in step.)
4. **Settings → Variables and Secrets → Add**:
   - Type **Secret**, name `RELAY_KEY`, value: a long random string. Make one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - Do not add it as a plain text variable; a secret is not readable back.

Open `https://<worker-name>.<your-subdomain>.workers.dev/health`. It should answer:

```json
{"ok":true,"relay":"troy","version":"1","signed":true}
```

`signed:false` means `RELAY_KEY` is missing. Nothing works until it is set.

## 2. Point Troy at it

Two variables. The panel's env editor is fine, or `.env` beside `server.js`:

```
CINEMA_RELAY_URL=https://troy-relay.your-subdomain.workers.dev
CINEMA_RELAY_KEY=<the same secret you set on the worker>
```

Then restart. The startup banner is the check:

```
Troy is listening
  outbound: IPv4 preferred
  relay:    on  https://troy-relay.your-subdomain.workers.dev/  (source bytes fetched by Cloudflare)
  temp:     /home/container/.troy-media  [disk (system temp is tmpfs)]  14.2 GB free
  ffmpeg:   ok  /home/container/.troy-media/ffmpeg
```

`relay: off` means `CINEMA_RELAY_URL` is not set. `relay: NOT USABLE` prints the
reason -- a key under 16 characters, or a URL that is not `https`.

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `CINEMA_RELAY_FALLBACK` | off | `1` lets a source fall back to the direct fetch when the *worker itself* fails (it is missing, renamed, or over quota). It never retries a 426 directly -- that path is what is being avoided. |

## 3. Prove it before you trust it

From `solo-cinema/`:

```sh
node troy-relay.js --test
```

Runs the **real worker file** on this machine against a fixture CDN that answers
`426` to a plain request and bytes to a browser-shaped one -- the same symptom, in
miniature. 25 checks: byte-identical bodies, `Range`/`206`, `If-Range`, redirects
followed inside the worker, forwarded `Referer`/`Origin`/`User-Agent`, dropped-socket
resume, signature and private-address refusal.

Then check the deployed one:

```sh
node troy-relay.js --worker-url https://troy-relay.your-subdomain.workers.dev --test
```

## What a request looks like

```
GET https://troy-relay.…workers.dev/?url=<source>&sig=<hmac-sha256>&art=1
    [&range=bytes=0-] [&ifrange=<etag>]
    [&r=<referer>] [&o=<origin>] [&u=<user-agent>]
```

Only what cannot travel any other way is in the query string: the target, its
signature, the provider headers a browser cannot set, and the range. The signature
is `HMAC-SHA256(RELAY_KEY, url)`; without it the worker refuses the request, so this
is not an open proxy even if the URL leaks.

`427`/`429` are waited out inside the worker (up to four attempts, twelve seconds,
`Retry-After` honoured). A Worker's egress address is shared with every other
Worker on Cloudflare, so these CDNs see it as an extremely busy client; the answer
is to ask again shortly, not to give up. A status that survives every retry is
marked `x-troy-retried: exhausted`.

`art=1` is artifact mode. The worker answers `200` and puts the CDN's real status in
`x-troy-status` (plus type, length, content-range, etag, last-modified,
content-encoding). That matters because Troy's resume logic has to tell "the CDN
said 426" from "the worker is broken", and has to see a `206` as a `206`. Without
`art=1` the response is passed through unchanged, which is handy for checking a link
in a browser.

## What it refuses

Unsigned requests, plain HTTP, IP-literal targets, `localhost` and private suffixes
(`.local`, `.internal`, `.lan`, …), non-standard ports, and URLs with credentials.
That last one is deliberate: this worker will sit on the public internet, and a
signed-but-open proxy is a bandwidth bill waiting to happen. You are the only user,
so the allow-list is unnecessary -- signed is enough.

## Limits worth knowing

- **Free plan:** 100,000 requests/day, 10 ms CPU per request. Streaming a body
  costs wall-clock time, not CPU, so a two-hour film is a handful of requests, not
  thousands. This is nowhere near the limit.
- **No response size limit**, no egress charge. A 4 GB file costs nothing.
- **Cloudflare's terms** discourage using Workers as a general video CDN for other
  people. For one person watching their own library this is not what that rule is
  about, and it is not a public service.
- **The worker is a dependency.** If Cloudflare is down or you delete the worker,
  playback stops; the startup banner and the error text say so plainly rather than
  falling back to the address that is blocked.

## Files

| File | What it is |
|---|---|
| `troy-relay.mjs` | the worker. This is the whole thing; nothing to install. |
| `troy-relay-paste.js` | the same program plus the deployment steps at the top, for pasting into the dashboard editor. |
| `../relay.js` | the Troy-side client: signs URLs, turns the artifact back into a normal-looking response. |
| `../troy-relay.js` | the harness: runs that same worker locally against a 426 fixture. |
| `../test-relay.js` | 11 tests covering the client and the worker contract. |
