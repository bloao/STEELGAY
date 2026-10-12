# Steel ARB

Steel market analysis website plus a Node-backed steel quota and duty scenario tool.

## Run Locally

This repo is not just a single HTML file. The order scenario tool calls local API routes exposed by `server.mjs`, so opening the pages directly from disk will not fully work.

### Open the homepage without installing Node.js

If you only need to view the homepage, open PowerShell in the project folder and run:

```powershell
Start-Process .\index.html
```

This requires no installation. The live commodity, quota, and import-duty features will not work in this mode because they require the local server.

### 1. Install Node.js and start the site (Windows)

Open PowerShell in the project folder and copy and paste this entire command. It installs the latest Node.js LTS release, refreshes the current terminal's `PATH`, verifies the installation, and starts the local server:

```powershell
winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements; $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User"); node --version; node server.mjs
```

If Node.js is already installed, start the site from the project root with:

```powershell
node server.mjs
```

You should see:

```text
Steel ARB live app running at http://127.0.0.1:3000
```

### 2. Open the site

Open:

```text
http://127.0.0.1:3000
```

Useful pages:

- `/` for the market analysis homepage
- `/order-tool.html` for the steel quota and import-duty tool
- `/road-freight.html` for the road freight view

## Troubleshooting

### `node` is not recognized

Node.js is not installed or is not on your `PATH`.

### The homepage opens but the tool does not work

Do not open `index.html` or `order-tool.html` directly from the filesystem. Start `node server.mjs` and use `http://127.0.0.1:3000` instead.

### Port 3000 is already in use

Start the server on a different port:

```bash
$env:PORT=3001
node server.mjs
```

Then open:

```text
http://127.0.0.1:3001
```

## Current Features

- Serve the website locally from `server.mjs`
- Search and select steel commodity codes
- Map commodity codes to UK steel trade-measure categories
- Check live UK trade quota balances
- Show quota order number and remaining balance
- Estimate 50% out-of-quota exposure
- Pull live import-duty measures from the GOV.UK Trade Tariff API

## Order tool (v1)

- `/orders.html` — saved order scenarios, filters, CSV export, pick 2–4 to compare
- `/order-tool.html` — scenario editor with live landed-cost build-up (`?id=` opens a saved one)
- `/compare.html?ids=a,b` — side-by-side quotes, lowest expected cost highlighted

All maths runs on the server in `lib/calc.mjs` (versioned; tests in `tests/calc.test.mjs`, run `npm test`).
Each saved scenario stores its inputs, result, engine version and the time the tariff, quota and FX data were fetched.

The steel-measure charge is an expected value: quota burn is projected from usage so far this period,
spread ±50%, and the 50% out-of-quota rate is averaged across that range.

### Live quotas (`/quotas.html`)

All 72 quota lines of the UK steel trade measure from 1 July 2026 (order numbers 058600–058671; see `lib/steel-measure.mjs`, taken from GOV.UK Tables 3–4, updated 1 Oct 2026).

- Balances: HMRC Trade Tariff API `GET /uk/api/quotas/search?order_number=…&year=&month=&day=` for the current and next quarter, cached 10 minutes (`GET /api/steel-quotas/live`, `?refresh=1` to force).
- Any line HMRC does not return is filled from the DBT "UK trade quotas" dataset (daily).
- The order tool prices quota risk from the same data. Residual lines cover every origin not named for a category; Ukraine is excluded; 7217 30 49 / 7217 30 90 are out of scope from 1 Oct 2026.
- The 50% steel duty is added on top of ordinary duty and calculated on the goods value before other duties.

### Products (`/products.html`)

Stock list saved in `var/products.json` (first run seeds the five sample Merchant Bar products). Per product: months of cover, stock-out date, stock value at cost, reorder status, suggested order (enough for the lead time + target cover, default 3 months, plus safety stock), best saved quote vs stock cost, and the live quota lines for its steel category. "Price an order" opens the order tool pre-filled (`order-tool.html?product=<id>`). API: `GET/POST /api/products`, `GET/PUT /api/products/:id`, `POST /api/products/:id/archive`.

### Settings (environment variables)

| Variable | Purpose |
| --- | --- |
| `SITE_USERS` | Named accounts: `george:pass:admin,sam:pass:buyer,jo:pass:approver`. Approvers approve/reject; buyers create, edit and submit. Unset (and no `SITE_PASSWORD`) = open local mode. |
| `SITE_PASSWORD` | Old single shared login (user `team`, admin role) — still supported. |
| `DATA_DIR` | Where scenarios are saved (default `./var`). On Fly/Render this must be a mounted volume. |
| `TARIFF_CLIENT_ID`, `TARIFF_CLIENT_SECRET`, `TARIFF_TOKEN_URL` | Optional HMRC Trade Tariff API credentials from the free Developer Portal (https://hub.trade-tariff.service.gov.uk/). Raises HMRC's rate limit. Or set `TARIFF_ACCESS_TOKEN` directly. Without them the public API is used. |
| `ALLOWED_ORIGIN` | Only set if another site must call the API; otherwise same-origin only. |

FX for EUR/USD quotes uses the ECB reference rate (Frankfurter); a manual rate can be entered per scenario.

## Data Sources

- GOV.UK Trade Tariff API
- UK Trade Quotas API
- GOV.UK UK steel trade measure from 1 July 2026

## Refresh Local Fallback Data

After Node.js is installed, you can refresh supporting local data with:

```bash
node scripts/fetch-steel-commodities.mjs
node scripts/fetch-steel-quotas.mjs
```
