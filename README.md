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

Browser-to-browser file transfer for devices on the same WiFi, in the spirit of
AirDrop/Snapdrop. Two files, no packages, no build step:

| File | What it is |
| --- | --- |
| `share/src/index.js` | Worker + one Durable Object class. Signaling only: it relays WebRTC handshake messages and never sees file bytes. |
| `share/public/index.html` | The whole app: markup, CSS and ES5 JavaScript in one request. |

How it works:

1. Each device opens a WebSocket to `/ws`. The Worker routes it to a Durable
   Object keyed by the caller's public IP, so devices on the same WiFi land in
   the same room with no codes, no QR and no accounts. `?r=CODE` joins an
   explicit room instead (for VPN/Private Relay cases).
2. The room relays SDP and ICE candidates between peers. That is a few KB per
   transfer. Peer names live on the socket attachment, so no storage API is
   used and no rows are written.
3. File bytes travel over a WebRTC data channel, device to device. Cloudflare
   never carries them. The receiver confirms each file, and both sides show
   progress, bytes and live speed.

Hotspots, VPNs and iCloud Private Relay can give two devices different public
IPs, so IP-based discovery cannot match them. In that case both devices tap
"Not seeing each other?" and enter the same short code, which puts them in an
explicit room instead of a network room. The footer shows `network ab12cd` or
`room CODE` so you can see which mode a device is in.

Local development and testing:

```sh
npx wrangler dev -c share/wrangler.toml --port 8787
node tools/e2e-share.mjs http://127.0.0.1:8787/
```

The end-to-end test opens two real browser peers, sends two files through the
actual UI, verifies the received bytes by SHA-256, and reports which ICE path
the file took along with how many bytes the signaling server carried.

Deploy:

```sh
npx wrangler deploy -c share/wrangler.toml
```

Limits worth knowing: devices must share a public IP (so VPN, iCloud Private
Relay or one device on cellular can hide a peer - use a room code then), WiFi
networks with client isolation block peer-to-peer traffic, and received files
are held in memory until saved, so very large files depend on available RAM.
