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

Stock list saved in `var/products.json` (first run seeds the five sample Merchant Bar products). Data points follow Stage 01 of the plan: description, category, specification, commodity code (→ steel quota category); current stock with the date it was counted, monthly usage; lead time, MOQ, safety stock, cover after delivery; stock cost price, target buy price.

Calculated per product: estimated stock today (recorded stock less usage since the count), months of cover, stock-out date, reorder point and order-by date (needs a lead time), suggested order (lead time + target cover + safety stock, rounded up to the MOQ), stock value, status. Click a row for the full detail panel; "Add product" shows a live preview; "Import" accepts rows pasted from Excel/Sheets or CSV (matches existing products by description and updates them).

API: `GET/POST /api/products`, `GET/PUT /api/products/:id`, `POST /api/products/:id/archive`, `POST /api/products/preview`, `POST /api/products/import` (`{ text, commit }`).

**Adding a product** is pick-from-a-list: search the steel catalogue (`steel-catalogue.js` — 35 product types across merchant bar, structural sections, hollow sections, plate & sheet, bright bar, reinforcing, wire & rod and stainless, each with its standard sizes, grades and lengths), then choose size / grade / length from dropdowns. The description, specification and 10-digit commodity code are filled in automatically, so the quota category follows. Where the tariff splits a product on something a size can't tell (galvanised and pre-painted sheet, rebar) the form lists the tariff lines to choose from. "Other steel product" keeps the manual route. `tests/catalogue.test.mjs` checks every combination resolves to a real code in `steel-commodities.js`. Lead time, MOQ, safety stock and cover are dropdowns too ("Other…" for anything else).

### Suppliers (`/suppliers.html`)

Saved in `var/suppliers.json` (first run seeds Tata Steel UK, 7 Steel, LME, Megasa and Olifer from the supplier list, plus Venete from the Hall and Pickles workbook). Comparison table sorted by worst-case price: imports quoted "all except duty" show what they'd cost with the 50% steel duty if the origin's quota line runs out, alongside the live HMRC status of that line (EU members share the European Union line; others use their named line or Residual; UK has no quota).

Supplier profile: Overview (commercial terms, quota & duty exposure, pricing benchmarks with links to MEPS/Kallanish/Fastmarkets/Argus, your products they supply), Quotes (history with price chart; the latest quote is the supplier's current price), Contacts, Audit trail. **Request quotes** writes one email per supplier (products, tonnage, tariff codes, delivery date, what to include) that opens in your own mail app or copies to the clipboard; each send is logged and the supplier shows "Awaiting reply" until you log their quote. Product profiles list the suppliers for that product group. The Assistant can compare suppliers (`list_suppliers` tool).

API: `GET/POST /api/suppliers`, `GET/PUT /api/suppliers/:id`, `POST /api/suppliers/:id/archive`, `POST /api/suppliers/:id/quotes`, `DELETE /api/suppliers/:id/quotes/:quoteId`, `POST|PUT|DELETE /api/suppliers/:id/contacts[/:contactId]`, `POST /api/suppliers/:id/rfqs`.

**Cost breakdown** (supplier profile tab): runs the supplier's latest quote through the landed-cost engine for a chosen product, tonnage and arrival date (live HMRC duty and quota), then adds payment-terms credit, MOQ carrying cost and a reliability buffer at your cost of capital (Settings). Shows effective / best / worst case, ten "what to weigh up" checks (price vs others, against the market, duty & quota, proof of origin, terms, lead time, MOQ, reliability, currency, quote freshness) and the same order priced from every supplier. API: `POST /api/suppliers/:id/breakdown`, `POST /api/suppliers/compare`.

### Market prices (Suppliers → Market prices, `/suppliers.html#market`)

Benchmark price series saved in `var/benchmarks.json`, compared with every supplier's latest quote (matrix + price-history chart).

Live feeds (automatic, pushed to open pages via Server-Sent Events at `/api/benchmarks/events`):
- **ONS producer price indices** for steel (GHAV domestic, GHCZ imported, EZWP import prices; 2015 = 100) — free, no key, checked daily. Shown in **Market pulse** (1/3/12-month change) and as "Market since quote" against each supplier's quote date.
- **LME steel via Metals-API** (`STEEL-RE` rebar FOB Turkey, `STEEL-SC` scrap; set `METALS_API_SYMBOLS` to change) — paste a metals-api.com key in Settings → Connections (or `METALS_API_KEY` in `.env`); refreshed every 12 hours. Feed state is kept in `var/feeds.json`.

Ingestion:
- **Upload / paste** an export — Kallanish Price Analyser → Export to Excel, a MEPS price table, or any CSV. One row per price (Date, Series, Price, Currency) or one column per series both work; title rows, UK dates, month names, Excel date numbers, `1,020` / `£760` are handled. You map each series in the file to a saved series once; later imports match by name.
- **Market intel**: add a price by hand.
- **Competition – UK / imports**: built automatically from logged supplier quotes.
- **API feed** (for when you have a data licence): set `MEPS_FEED_URL` (+ `MEPS_FEED_TOKEN`), `KALLANISH_FEED_URL`, `FASTMARKETS_FEED_URL` or `ARGUS_FEED_URL` in `.env`. The server fetches every 6 hours (and on "Fetch now"); the URL may return JSON (`[{date, series, price, currency}]`) or CSV. New series land in the default product group.

API: `GET/POST /api/benchmarks`, `PUT /api/benchmarks/:id`, `POST /api/benchmarks/:id/archive`, `POST /api/benchmarks/:id/points`, `DELETE /api/benchmarks/:id/points/:date`, `POST /api/benchmarks/import` (`{text|rows, commit, mapping}`), `POST /api/benchmarks/feeds/:source/run`.

### Workspace settings (`/settings.html`)

Saved in `var/settings.json`: defaults for new products (category, lead time, MOQ, safety stock, cover), which product groups appear in the Add product search, company name, plus connection status (HMRC, Claude) and a one-click JSON backup of products, quotes and settings. API: `GET/PUT /api/settings`, `GET /api/backup`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `SITE_USERS` | Named accounts: `george:pass:admin,sam:pass:buyer,jo:pass:approver`. Approvers approve/reject; buyers create, edit and submit. Unset (and no `SITE_PASSWORD`) = open local mode. |
| `SITE_PASSWORD` | Old single shared login (user `team`, admin role) — still supported. |
| `DATA_DIR` | Where scenarios are saved (default `./var`). On Fly/Render this must be a mounted volume. |
| `TARIFF_CLIENT_ID`, `TARIFF_CLIENT_SECRET`, `TARIFF_TOKEN_URL` | Optional HMRC Trade Tariff API credentials from the free Developer Portal (https://hub.trade-tariff.service.gov.uk/). Raises HMRC's rate limit. Or set `TARIFF_ACCESS_TOKEN` directly. Without them the public API is used. |
| `ANTHROPIC_API_KEY` | Enables the Assistant tab (Claude, server-side; read-only tools over products, scenarios, live quotas and the pricing engine). Optional `ASSISTANT_MODEL` (default `claude-sonnet-5-5`). |
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
