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
- `/order.html` — order editor with live landed-cost build-up and the planner's reasons (`?id=` opens a saved one). `/order-tool.html` stays as the standalone public intake page.
- First run: the old demo scenarios (HR coil, galvanised sheet…) are archived on startup and replaced with draft orders for the products that need restocking, priced from your own suppliers: the planner's pick ("Recommended") and the runner-up ("Alternative"). `POST /api/orders/starter` does the same on demand.
- `/plan.html` — plan an order; a one-line strip shows the assumptions in use.
- `/assumptions.html` — Orders › Assumptions: every number the planner runs on (buy-ahead and hold-off triggers, costs, quota-risk weighting, UK CBAM placeholders, warning levels). Saved to Settings and used by every plan.
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

**Cost breakdown** (supplier profile tab): runs the supplier's latest quote through the landed-cost engine for a chosen product, tonnage and arrival date (live HMRC duty and quota), then adds payment-terms credit, MOQ carrying cost and a reliability buffer at your cost of capital (Settings). Shows three scenarios — if the quota holds, expected cost (quota risk priced in as probability × 50% duty × customs value) and if the quota is missed — plus the cost of missing it per tonne and on the order. Underneath, the full cost model lists every variable (price, freight, insurance, haulage, brokerage, customs value, duty, trade remedies, CBAM, VAT, expected steel duty, quota-miss cost, currency buffer, terms, MOQ, reliability) with its status and an equation showing each data point and where it came from. It also shows ten "what to weigh up" checks (price vs others, against the market, duty & quota, proof of origin, terms, lead time, MOQ, reliability, currency, quote freshness) and the same order priced from every supplier. API: `POST /api/suppliers/:id/breakdown`, `POST /api/suppliers/compare`.

**UK CBAM toggle** (Suppliers list and cost breakdown): adds the UK Carbon Border Adjustment Mechanism, which starts on 1 January 2027 for imported iron and steel (Finance Act 2026, Schedule 16: chapter 72 except listed ferro-alloys and scrap, and chapter 73 headings 7301–7311, 7318 and 7326). The charge is embodied emissions × (UK CBAM rate − carbon price already paid abroad), paid by the importer of record. HMRC hasn't published the steel rate or default values yet, so Settings → UK CBAM holds the assumptions: the rate (default £62/t CO₂e, about the UK ETS allowance price in late September 2026) and emissions per tonne for electric-arc (0.5), blast-furnace (2.0) and unknown-route (2.0) mills. Each supplier profile can record the mill's route, verified emissions and carbon price paid (relief needs a CarbonVP1 report). The toggle is remembered per browser; the API takes `cbam: true` on breakdown and compare.

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

## Market news & regulation (`news.html`)

- **Coming up**: the next regulatory dates (quota periods, UK CBAM start, registration and return deadlines).
- **Regulation tracker** (`lib/news.mjs`, `REGULATION`): UK steel trade measure (from 1 July 2026), UK CBAM (from 1 January 2027), EU steel measure, UK–EU origin rules. Each entry has what it means for you, where the tool already models it, and a source link. Update the list as rules change.
- **Latest from GOV.UK**: free Atom search feeds, checked every 6 hours and filtered to steel, trade and carbon items. API: `GET /api/news`, `POST /api/news/refresh`.
- **Team insight**: notes on what mills, traders and customers are saying, each marked up, down or neutral, with a strength and time horizon. Stored in `var/news-notes.json`. API: `POST /api/news/notes`, `POST /api/news/notes/:id/archive`.

## Steel forecast (`forecast.html`)

An in-house, transparent model (`lib/forecast.mjs`, v0.1) built from the ONS UK steel producer price index (GHAV):
- the drift is the average of the 12-month log-linear trend and 3-month momentum, damped 15% a month going forward;
- an 80% band of ±1.28 × monthly volatility × √months;
- drivers: UK CBAM from January 2027 (rate × emissions ÷ price × pass-through %) and every live team insight (up or down 1%, 3% or 5%, built in over its horizon);
- a backtest from the last 12 months against what actually happened, alongside a "no change" guess.

**Stock-up opportunities** price each product at today's best landed cost (with optional UK CBAM) and work out whether buying 1–6 months of usage now beats buying month by month, after cost of capital and storage. Assumptions: Settings → `forecastCbamPassThroughPct` (30%), `forecastStoragePerTMonth` (£2/t a month). API: `POST /api/forecast {months, cbam}`.


## Competition (`competition.html`)

Public data only (`lib/competition.mjs`):
- **HMRC importer details** (uktradeinfo.com, monthly): every company importing from outside the UK and the 8-digit codes it used, for chapters 72 and 73. Click **Load HMRC history** to pull the last 24 months; after that the server checks daily for new months. HMRC does not publish tonnage per company, so the page shows import *activity* (which months, which products) and flags patterns: stepping up, widening range, slowing, gone quiet.
- **HMRC overseas trade bulk data** (BDSimp): UK import tonnes and value by code and origin each month. The "Is the market stocking up?" chart totals your products' codes and flags months 25% or more above the previous 12-month average.
- **Companies House accounts** (needs a free REST key in Settings → Connections): stock (inventories) and turnover from the latest digital (iXBRL) accounts, year on year.
- Before any download, matching and suggestions use the pipeline summary in `output/company_activity.csv` (2024–2026). Company ids match the Python pipeline.

Data: `var/competition-data.json` (HMRC), `var/competitors.json` (who you follow). API: `GET /api/competition`, `GET /api/competition/search?q=`, `GET /api/competition/ch-search?q=`, `POST /api/competition/sync {months}`, `POST /api/competition/competitors`, `PUT …/:id`, `POST …/:id/archive`, `POST …/:id/accounts`.

## Arrivals (`arrivals.html`)

- **Live ships** (`lib/arrivals.mjs`): the server keeps a WebSocket open to aisstream.io (free key in Settings → Connections; needs Node 22+). It watches UK steel-port approaches (Humber & Wash, Tees, Thames, Bristol Channel, Mersey, Forth) and steel-export ports (Iskenderun, Marmara, Aliağa, Bilbao, Gijón/Avilés, Ravenna, Taranto, Gdańsk). Cargo ships (AIS type 70–79) are scored: **likely steel** if seen at a steel-export port with a UK steel-port destination, **possible** if a general cargo ship is bound for one. AIS never carries cargo details, so this is inference. State is kept in `var/arrivals.json` (30 days).
- **Your shipments**: add ship name plus MMSI or IMO. MMSIs are followed worldwide over a second connection. Shows position, speed, distance to port, the ship's own ETA, and how it compares with the expected date. Stored in `var/shipments.json`.
- **Where your steel comes in**: from the HMRC BDSimp files (Competition → Load HMRC history), tonnes for your codes by UK port code and route (sea, road/Ro-Ro, rail). Volumes saved before ports were recorded are fetched again on the next sync.

API: `GET /api/arrivals`, `POST /api/arrivals/shipments`, `PUT …/:id`, `POST …/:id/arrived`, `POST …/:id/archive`.

## Stockpiling ranking (Products page and each product's Market prices tab)

`lib/stockpile.mjs` scores each product 0–100 for how safe extra stock is. Weights: multi-purpose 25%, UK buyers 20%, UK demand 15%, price steadiness 20%, your turnover 20%.
- **Multi-purpose**: 1–5 from the catalogue family (e.g. flat bar, equal angle and SHS are 5). Click the dots to set your own.
- **UK buyers**: companies importing that commodity code (HMRC importer lists; before download, the 2024–26 summary).
- **UK demand**: UK import tonnes over 12 months and how steady they are (HMRC trade data).
- **Price volatility**: monthly swings in HMRC's import unit value (£/t) for the code, or the ONS index when there's no code-level data. Also ranked on its own.
- **Your turnover**: monthly usage and months of stock.
API: `GET /api/products/stockpile`, `POST /api/products/:id/versatility {score}`.

## Market intel (word of mouth)

**Log market intel** in the sidebar (and buttons on suppliers, products, news and forecast) opens one form: what you heard, who it affects (whole market, product group, one product, one supplier), the change in £/t or %, from when and for how long. Notes with a number:
- appear as **Market intel** lines in each affected supplier's cost model, with the working, so expected costs, rankings and product prices move. Market-wide and group news doesn't change a quote that's fixed beyond the arrival date;
- move the steel forecast (whole market and product-group notes);
- are listed on Market news and on the product's Market prices tab.
Stored with team insight in `var/news-notes.json`.

## Orders: plan an order (`plan.html`)

The page that ties everything together. Pick a product (the Orders page lists what needs ordering, most urgent first), how much, when you need it, and an approach:
- **Every supplier** is priced for that exact product, tonnage and their own lead time through the full cost model: duty, expected quota duty, terms, MOQ, reliability, market intel, and optionally UK CBAM.
- **Recommendation** (`lib/orderplan.mjs`): risk-adjusted cost = expected cost + appetite × quota-miss cost (cautious 60%, balanced 25%, price first 0%). Options arriving after you run out rank below those that arrive in time, with a stock-out penalty. Best overall, cheapest, lowest-risk and fastest are tagged.
- **Timing**: buy ahead if the forecast shows more than a 1.5% rise over 3 months, buying ahead pays after holding costs, and the product is safe to hold (stockpile score); hold off if prices look to fall by more than 1.5% and stock covers the lead time; otherwise order now.
- **Context cards**: your stock, price outlook (best landed, your cost, market price, 3-month forecast, buy-ahead maths), competition (UK imports of the code, number of importers, followed competitors), quota line, stockpile score, market intel.
- **Save order** creates a draft order scenario (with the plan's reasons) for the usual approval flow.
API: `GET /api/orders/needs`, `POST /api/orders/plan {productId, tonnage, needBy, appetite, cbam}`, `POST /api/orders/plan/save {productId, supplierId, tonnage, cbam}`.
