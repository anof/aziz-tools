# aziz.tools

Static landing page for aziz.tools. Pure HTML + CSS, no JavaScript, no build
step. Two builds of the same page live here:

| Build | Entry point | Look | Compatibility |
| --- | --- | --- | --- |
| Modern | `index.html` + `styles.css` | Gradient glow, glass tiles, dark/light mode | Any browser from ~2019 on |
| Classic | `classic/index.html` | Flat squares, same layout | Android 2.x/4.x stock browsers, old iOS Safari, Opera Mini, IE8+ |

### Modern build files

- `index.html` - the page and its inline SVG icons
- `styles.css` - layout, tiles, dark/light theme, responsive rules
- `favicon.svg` - browser tab icon

### Classic build

`classic/index.html` is one self-contained file: no JavaScript, no images, no
SVG, no web fonts, no external requests, and the source is 7-bit ASCII so a
wrong charset cannot break it. Icons are plain text characters. The layout is
CSS 2.1 (inline-block cells, percentage widths, the padding-bottom square
trick); every CSS3 touch is prefix-duplicated and safe to ignore, so a browser
that understands nothing still shows a readable, tappable link list.

If a browser is too old for media queries it keeps the two-column layout, and
if it has no CSS at all the page is still a usable list of links.

## Preview locally

```sh
cd ~/aziz.tools
python3 -m http.server 4321
```

- Modern: <http://localhost:4321>
- Classic: <http://localhost:4321/classic/>

## Adding a new tool

Copy the live tile block in `classic/index.html` (the deployed build) and in
`index.html` (the modern build), then change:

- `href` to the new subdomain, for example `https://files.aziz.tools`
- the badge contents: a text character in the classic build, the SVG symbol in the modern one
- the name and host text in both

Then redeploy:

```sh
cd ~/aziz.tools && npx wrangler deploy
```

## Deployment

The site runs on a Cloudflare **Worker with static assets**, which serves the
classic build and owns the `aziz.tools` hostname. All of it is declared in
`wrangler.toml`:

```toml
name = "aziz-tools"
routes = [{ pattern = "aziz.tools", custom_domain = true }]
[assets]
directory = "./classic"
```

- `npx wrangler deploy` - publish changes (also creates DNS + certificate for the hostname)
- `npx wrangler login` - one-time auth on a new machine
- `npx wrangler deployments list` - deployment history and rollback targets

Why not Pages: attaching a custom domain to a Pages project is dashboard-only,
while a Worker's `custom_domain` route is fully configurable from the CLI.
The deploy output is plain static files either way.

Later options:

- Add `{ pattern = "www.aziz.tools", custom_domain = true }` to `routes` for www.
- Give each future tool its own Worker and add its route here.
- Auto-deploy on `git push`: connect Workers Builds in the dashboard, or add a
  GitHub Actions workflow that runs `wrangler deploy` with a scoped API token.
- To make the modern build live at the root, move it into a `modern/` folder
  and point `assets.directory` at it.

## share.aziz.tools

Browser-to-browser file transfer in the spirit of AirDrop/Snapdrop. Two files,
no packages, no build step. Direct peer-to-peer by default, with an automatic
relay fallback when the network blocks a direct path:

| File | What it is |
| --- | --- |
| `share/src/index.js` | Worker + one Durable Object class. Relays WebRTC signaling, and (only when direct fails) binary chunks. |
| `share/public/index.html` | The whole app: markup, CSS and ES5 JavaScript in one request. |

How it works:

1. Each device opens a WebSocket to `/ws`. The Worker routes it to a Durable
   Object keyed by the caller's public IP, so devices on the same WiFi land in
   the same room with no codes, no QR and no accounts. `?r=CODE` joins an
   explicit room instead (for VPN/Private Relay or different networks).
2. The room relays SDP and ICE candidates between peers (a few KB per
   transfer). Peer names live on the socket attachment, so no storage API is
   used and no rows are written.
3. File bytes prefer a direct WebRTC data channel. If the direct connection
   cannot open (for example a router with client isolation, which blocks
   device-to-device traffic), the transfer automatically switches to a relay
   through the Durable Object after roughly 12 seconds. Relay chunks are
   32 KB binary WebSocket frames over TLS: they are forwarded and never stored,
   but they do pass through Cloudflare's Worker. Direct transfers remain
   WebRTC/DTLS and never carry file bytes through the Worker.
   Sending is chunked at 64 KB with flow control: the sender pauses once 4 MB
   is buffered, resumes on the data channel's low-water event with a timer as a
   safety net, and backs off if the channel reports a full buffer. Chunks are
   kept as Blob parts on the receiving side so large files can be paged out.
   Verified end to end with a 100 MB file (SHA-256 matched, local and live).
   Relay is capped at 200 MB per file and observed at around 2.6 MB/s. The
   sender's tab must stay open, and multi-gigabyte files depend on the receiving
   device's memory.
4. Text uses the same channel: paste into "Send text", tap a device, and it
   appears on the other side with a Copy button (32,000 character limit, and
   the same delivery confirmation as files).

The room control is a large card near the top of the page, not a footer link.
Tap it to join with a code, create a new room, or leave the current one. Use a
room when devices are on different networks (hotspot, VPN, iCloud Private
Relay) or when a router isolates clients. The card shows `Room CODE` while
connected; the footer still shows the network hash for diagnostics.

Same-WiFi caveat: many routers (especially guest networks) allow both devices
online but block packets between them. That is what makes devices visible but
unreachable. The relay fallback fixes this because both devices only need
outbound access to Cloudflare.

Local development and testing:

```sh
npx wrangler dev -c share/wrangler.toml --port 8787
node tools/e2e-share.mjs http://127.0.0.1:8787/
SHARE_RELAY=1 node tools/e2e-share.mjs http://127.0.0.1:8787/
```

The end-to-end test opens two real browser peers, sends two files and a piece of
text through the actual UI, verifies the received bytes by SHA-256, checks the
text arrives unchanged (including unicode), checks the large room control, and
reports which ICE path the file took. `SHARE_RELAY=1` forces the relay path so
the same test exercises the server fallback.

Deploy:

```sh
npx wrangler deploy -c share/wrangler.toml
```

Limits worth knowing: automatic discovery still groups by public IP, so use a
room when devices are on different networks. The relay needs internet access
and consumes Durable Object requests/compute; on the Workers Free plan, relaying
large files repeatedly can hit daily quotas. Direct transfers are faster and
avoid the relay. Received files are held in memory until saved, so very large
files depend on available RAM.

## shade.aziz.tools

Which side of the bus is in shade. One static file, no server-side code - the
Worker only serves it.

| File | What it is |
| --- | --- |
| `shade/public/index.html` | The whole app: markup, CSS, sun maths and UI in one request |
| `shade/wrangler.toml` | Worker + `shade.aziz.tools` custom domain |

How it works:

1. Sun position is computed in the browser with the standard low-precision
   solar equations (the same maths SunCalc uses) for the boarding point and the
   current time.
2. Bus heading comes from the public OSRM demo server: the heading roughly
   400 m after the boarding point, because the side you sit on is decided where
   you get on, not at the end of the route. If OSRM cannot be reached it falls
   back to the straight-line bearing and says so.
3. Shade is the side opposite the sun. Sun overhead (`>70`), sun below the
   horizon, or sun straight ahead/behind all give "either side" with the reason.
4. Address search is Photon, "use my location" is the browser geolocation API,
   and home/work trips are saved in this browser's localStorage.

Deploy and test:

```sh
npx wrangler deploy -c shade/wrangler.toml
node tools/shade-test.mjs https://shade.aziz.tools/
```

The test drives the real UI: it uses a simulated GPS fix, searches two real
addresses, checks the verdict and the facts line, then saves a trip and reloads
the page to confirm it comes back.

## canvas.aziz.tools

Infinite canvas built from `infinite-canvas-project.zip` (Next.js 15), exported
as static files and served by a Cloudflare Worker. No server or database.

| Path | What it is |
| --- | --- |
| `canvas/app/page.tsx` | Canvas, sessions, touch/mouse/pen handling |
| `canvas/app/layout.tsx` | Metadata, icons, viewport |
| `canvas/public/` | Icons and static assets |
| `canvas/out/` | Generated static export (gitignored) |
| `canvas/wrangler.toml` | Worker + `canvas.aziz.tools`, assets from `./out` |

Features kept from the project:

- **Sessions** in localStorage: create, rename, delete, switch, autosave,
  in-browser persistence. The active session id is stored separately
  (`infinite-canvas-active`) so a reload opens the right canvas, and switching
  flushes the current drawing first so nothing in the last 500ms is lost.
- **Infinite canvas**: unbounded panning and multiplicative zoom with a
  practical 1e-6x-1e6x range; the zoom level is shown in the session chip.
- **Eraser** deletes the connected lines under a 20px screen-space radius.
- **Touch**: one finger draws or erases; two fingers move and pinch; a second
  finger arriving mid-stroke discards the accidental stroke and takes over;
  a leftover finger cannot draw after a pinch until all fingers lift.
- **Mouse**: drag draws, plain wheel pans, Ctrl/Command + wheel zooms at the
  pointer. A native non-passive wheel listener prevents the browser itself
  from zooming.
- Page scrolling and browser pinch-zoom are disabled over the canvas.

Build and deploy:

```sh
cd ~/aziz.tools/canvas
npm install --legacy-peer-deps
npm run build
cd ..
npx wrangler dev -c canvas/wrangler.toml --port 8790
node tools/canvas-test.mjs http://127.0.0.1:8790/
npx wrangler deploy -c canvas/wrangler.toml
```

The test emulates a phone with CDP touch events and a desktop with mouse events:
one-finger strokes, pinch past 10x and below 0.1x, pan, a second finger
mid-stroke, touch eraser, session rename/new/switch/reload/delete, mouse draw,
Ctrl-wheel zoom and wheel pan.
