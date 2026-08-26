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
