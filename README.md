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
