# Garnet website

Plain static HTML, CSS and a little vanilla JS. No build step, no dependencies, no third-party requests.

Files: `index.html`, `styles.css`, `main.js`, `favicon.svg`, `404.html`, `robots.txt`.

## Keeping the copy true

The page quotes real details from the code: the line count in the hero (about 22,000 lines of non-test TypeScript in `src/`), config defaults (`src/config/schema.ts`), the CLI output in the transcripts (`src/cli/`, `src/gateway/gateway.ts`), the `src/` layout and the Status section (from `PLAN.md`). When any of those change, update the page. Anything not built yet should read as planned.

## Preview

    cd site && python3 -m http.server 8080

Opening `index.html` directly from disk also works.

## Deploy

Upload the contents of `site/` to any static host and serve it from the site root.

- **GitHub Pages:** publish the `site/` folder from a workflow or a `gh-pages` branch. `404.html` is picked up automatically.
- **Cloudflare Pages / Netlify:** build command none, output directory `site`. Both serve `404.html` for unknown paths.
- **Any web server (nginx, Caddy, S3 + CDN):** serve the folder and point your 404 handler at `404.html`.

`404.html` references `/styles.css`, `/main.js` and `/favicon.svg` with absolute paths. If you host under a sub-path, change those to include the prefix.

## Optional "Talk to Garnet" demo

The demo section is hidden unless `<body data-demo-endpoint="...">` is non-empty. To enable it:

1. On a Garnet install reachable from the internet (behind your own HTTPS reverse proxy), set in `config.json`:
   ```json
   "api": {
     "enabled": true,
     "trustProxy": true,
     "demo": { "enabled": true, "allowedOrigins": ["https://your-site.example"] }
   }
   ```
   The demo endpoint needs no API key. It uses a cheap model (`api.demo.model`, default `claude-haiku-4-5`), has no tools, no memory and keeps no history, and is limited per visitor IP (`perIpPerHour`) and by a global daily token budget (`dailyTokenBudget`). Garnet refuses to listen on a public address until at least one API key exists, so create one (`garnet api key create --name admin --scopes admin`) even if only the demo is public.
2. Set `data-demo-endpoint` to that Garnet's base URL without a trailing slash, e.g. `https://demo.example.com`.

The page POSTs `{model: "garnet-demo", messages: [...]}` to `{endpoint}/v1/demo/chat/completions`. Input is capped at 500 characters and replies are rendered with `textContent`.
