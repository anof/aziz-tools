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

## Deploying with Cloudflare Pages

The repo holds both builds, so one setting picks the live site: the Pages
**build output directory**.

- `classic` -> the classic build is live at aziz.tools (maximum compatibility)
- `/` -> the modern build is live at aziz.tools, with the classic one at aziz.tools/classic/

Steps:

1. Cloudflare dashboard: **Workers & Pages -> Create -> Pages -> Connect to Git**, pick `anof/aziz-tools`.
2. Build settings: framework preset **None**, build command **empty**, build output directory **classic**.
3. Deploy, then open **Custom domains -> Set up a custom domain -> aziz.tools**. The zone already uses Cloudflare nameservers, so it will provision automatically.
4. For the future Share tool: give it its own Pages project, then add a proxied DNS record `CNAME share -> <project>.pages.dev`.

Switching is one setting, nothing else breaks: with the output directory set
to `/`, the modern page is live at the root and the classic one is still
reachable at aziz.tools/classic/.
