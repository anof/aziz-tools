# aziz.tools

Static landing page for aziz.tools. Pure HTML + CSS, no JavaScript, no build step.

## Files

- `index.html` - the page and its inline SVG icons
- `styles.css` - layout, tiles, dark/light theme, responsive rules
- `favicon.svg` - browser tab icon

## Preview locally

```sh
cd ~/aziz.tools
python3 -m http.server 4321
```

Then open <http://localhost:4321>.

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
