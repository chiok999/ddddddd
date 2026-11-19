# Relay performance: what the tuning sheet gets right

A performance sheet was proposed for the botkeep relay. This is the assessment
against the code that actually runs, with the measurements it was missing.

The headline: **the sheet's stated diagnosis is wrong for this deployment, and
its biggest recommended change would have made things worse.** Two items were
worth taking, and one real risk was addressed while checking.

Everything below was measured on Node v22.22.3, which is the version the relay
already requires (`reusePort` needs 22.12+, and the relay refuses to start
without a key rather than run unsafely).

## The central claim is false here

> "Right now every request is a fresh TCP + TLS handshake to the CDN, because the
> default global agent has no keep-alive on Node 18 and a tight socket cap
> elsewhere. Fix that first; it's worth more than everything below combined."

Measured on this Node:

```
http.globalAgent.keepAlive = true      maxSockets = Infinity
maxFreeSockets = 256                   scheduling = lifo
5 sequential upstream requests  ->  1 TCP connection
50 concurrent upstream requests ->  49 TCP connections (no cap)
```

Keep-alive has been the default since **Node 19**, `maxSockets` is `Infinity`,
and `scheduling` is already `lifo`. There is no handshake to stop. The sheet's
own numbers — 512/1024 sockets, `lifo` scheduling — are *lower* than the
defaults it replaces. Adopting that block as written would have capped the relay
at 128 sockets per origin where it currently has none, which is the exact
mistake the sheet warns about two sections later ("Don't lower `maxSockets` to
be safe").

The relay now sets an explicit pool anyway, but for the opposite reason: to
*bound* memory on a small container (`maxSockets: 128`, `maxTotalSockets: 256`),
not to raise a limit that was never there.

## Nagle is already off

> "Turn Nagle off, both directions … 40ms of Nagle delay on a chunked media
> stream."

libuv sets `TCP_NODELAY` on every TCP socket it creates, and `http.Server`
already defaults `noDelay: true`. Measured signature (two small writes 5 ms
apart, watching for Nagle's 40 ms hold):

```
gap between the two small writes: 4.3 ms   => no 40 ms delay
```

`server.on('connection', s => s.setNoDelay(true))` is a no-op here. Harmless,
but it is not free performance — it is an already-set flag.

## Raising the highWaterMark: no effect on media

The sheet claims the default is 16 KB and a syscall per 16 KB. The default for
HTTP streams on this Node is **64 KB**, not 16 KB.

Benchmarked end to end, 2 MB body through a real socket:

```
hwm=  16384   3.2–5.8 ms   ~128 read() calls
hwm=  65536   4.4 ms        ~32 read() calls
hwm= 262144   3.2 ms         ~8 read() calls
```

So it does reduce `read()` calls. But that is a loopback measurement with a fast
reader. Re-run with a **slow reader** — which is what a video player is, draining
at its decode rate — and the difference disappears:

```
slow reader, 8 MB:   16 KB -> 288 ms    64 KB -> 277 ms    256 KB -> 281 ms
```

When the reader is the bottleneck, buffer size stops mattering; backpressure is
doing its job. And that loopback case is not this relay's traffic at all: the
bytes here come from a remote CDN across the internet. A 256 KB buffer buys
nothing and costs `hwm × sockets` of memory.

Not applied. The 64 KB default stays.

## The DNS cache: would have removed the SSRF protection

This is the one item that is actively dangerous.

> "Cache name resolution … Cache the resolved list too — you already have
> `pinnedLookup`, so the vetted array is what you hand the socket."

There is no `pinnedLookup` in `troy-relay-server.js`, and no `dns` call at all:
the relay never resolves hostnames, it hands the name to Node and lets the
socket resolve. What it validates is the *hostname*, and it is strict about the
rest of the URL:

```
refused  https://127.0.0.1/x.mp4              (IP address sources are not allowed)
refused  https://[::1]/x.mp4                  (IP address sources are not allowed)
refused  https://169.254.169.254/latest/…     (IP address sources are not allowed)
```

Adding a 30-second DNS cache that resolves *once* and reuses the answer would
introduce a DNS-rebinding window this code currently does not have: a name that
resolves to a public address when cached and an internal one 31 seconds later
would be fetched from the cached address either way — but the cache also creates
the *only* place an address could be substituted. The correct shape is
resolve-and-pin **per connection**, which the sheet describes but the snippet
does not implement (it caches the list and never re-vets).

Not applied. The pinned-lookup pattern is worth doing deliberately — validating
every connection against a private-range check — but not as a cache bolted on to
a file that does not resolve at all. That is a separate change with its own
tests, and it should be made before, not after, a relay is exposed.

## Cluster sharding: real, but not the bottleneck

`so_reuseport` works on this Node (`listen({reusePort:true})` accepts the
option). But:

- the relay is **one viewer at a time** by design — `transcode.js` returns
  `409 Another session is watching`. It does not serve a crowd.
- the work is I/O-bound waiting on a CDN, not CPU-bound. `availableParallelism`
  on a botkeep-class box is 2.
- each worker would hold its own copy of the agent pool and any state.

Not applied. If the relay ever needs it, `reusePort` is available and the change
is small — but sharding a process that serves one stream is a complication with
no measured benefit.

## Where the sheet is right, and it matters

**Keep the kernel tuning.** `tcp_slow_start_after_idle=0`, BBR, the larger
socket buffers and `LimitNOFILE` are sensible for any media proxy and cost
nothing. They belong in the panel's unit, not in the code. Note `somaxconn` and
`tcp_max_syn_backlog` only matter at high connection rates, which a
one-viewer relay will not see.

**Don't compress, don't add a Cloudflare hop, don't buffer whole artifacts.**
All correct, and all already true here.

**`cache-control: no-store` on signed URLs is genuinely wasteful.** The sheet is
right. It was left as-is because the signature covers a target that can expire
within the hour, so `private, max-age=${exp - now}` needs the expiry to travel
with it — a change worth doing deliberately rather than by loosening a header.
Recorded here rather than done.

**"Get a baseline before and after."** The single best line in the sheet. Every
correction above comes from running it.

## What was actually changed

Two things the sheet got wrong in a way that costs real reliability, found while
checking its claims:

### 1. A 30-second upstream deadline on a film-length read

`requestOnce` set `timeout: 30000` on **every** upstream request, including the
transcoder's input. That is not a request for one object; it is one body read
from the first byte of a film to the last, and most of it is spent waiting on the
CDN. A quiet stretch longer than 30 seconds kills the socket mid-film and the
encoder reports a truncated source.

The relay cannot distinguish the two from the signed target, so the caller now
says which it is:

- `source-opener.js` passes a long-read flag when opening transcoder input
- `relay.js` forwards it as `x-troy-upstream-timeout`
- the relay clamps it (5 s … 15 min) and defaults to 30 s without it

A hint on an unsigned request cannot be trusted to extend a socket, so the
clamp is the whole point: it bounds what a request can ask for.

### 2. A dead pooled socket was reported as a CDN failure

With keep-alive on, an idle CDN can drop a socket that stays in the pool. The
next segment then fails `ECONNRESET` even though the request never reached the
origin — previously surfaced as a 502 and a lost segment. It is now retried once
on a fresh socket, but only on a reused socket and only once, so a genuine reset
mid-transfer is not masked.

Both are covered by tests that were mutation-checked: removing the retry, or
ignoring the hint, makes the corresponding test fail and nothing else.

## Numbers

```
solo-cinema  npm test    129/129
```

`troy-relay-server.js` remains a single file with no dependencies, which is what
makes it deployable by itself on botkeep.
