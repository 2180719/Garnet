# Ruby website

Plain static HTML, CSS and a little vanilla JS. No build step, no dependencies, no third-party requests.

Files: `index.html`, `styles.css`, `main.js`, `favicon.svg`, `404.html`, `robots.txt`.

## Preview

    cd site && python3 -m http.server 8080

Opening `index.html` directly from disk also works.

## Deploy

Upload the contents of `site/` to any static host and serve it from the site root.

- **GitHub Pages:** publish the `site/` folder from a workflow or a `gh-pages` branch. `404.html` is picked up automatically.
- **Cloudflare Pages / Netlify:** build command none, output directory `site`. Both serve `404.html` for unknown paths.
- **Any web server (nginx, Caddy, S3 + CDN):** serve the folder and point your 404 handler at `404.html`.

`404.html` references `/styles.css`, `/main.js` and `/favicon.svg` with absolute paths. If you host under a sub-path, change those to include the prefix.

## Optional "Talk to Ruby" demo

The demo section is hidden unless `<body data-demo-endpoint="...">` is non-empty. To enable it:

1. Run a Ruby gateway with a bounded `demo` key profile (cheap model, no tools, no memory, daily budgets).
2. Set `data-demo-endpoint` to its base URL without a trailing slash, for example `https://demo.example.com`, and `data-demo-key` to the demo key.
3. Allow CORS from the website's origin on the gateway.

The page POSTs `{model: "ruby-demo", messages: [...]}` (non-streaming) to `{endpoint}/v1/chat/completions` with `Authorization: Bearer <key>`. Input is capped at 500 characters and replies are rendered with `textContent`. The key is visible to every visitor, so it must be low-privilege and rate-limited.

## Privacy

No analytics, cookies or external fonts. `localStorage` holds only the theme choice (`ruby-theme`).
