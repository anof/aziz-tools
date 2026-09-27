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

Copy the live tile block in `index.html` and change:

- `href` to the new subdomain, for example `https://files.aziz.tools`
- the SVG symbol inside `.tile__badge`
- `.tile__name` and `.tile__host` text

## Deploying with Cloudflare Pages (later)

1. Push this folder to a GitHub repo (for example `anof/aziz-tools`).
2. In the Cloudflare dashboard: **Workers & Pages -> Create -> Pages -> Connect to Git**, pick the repo.
3. Build settings: framework preset **None**, build command empty, output directory `/` (repo root).
4. After the first deploy, open the project's **Custom domains** tab and add `aziz.tools` (and optionally `www.aziz.tools`).
5. For the future tool, add a DNS record for `share` pointing at the tool's own Pages project, for example a `CNAME share -> <project>.pages.dev`.
