# Steel ARB

Prototype steel import landed-cost tool.

## Run Locally

```bash
node server.mjs
```

Then open:

```text
http://127.0.0.1:3000
```

## Current Features

- Search/select steel commodity codes.
- Map commodity codes to UK steel trade-measure categories.
- Check live UK trade quota balances.
- Show quota order number and remaining balance.
- Estimate 50% out-of-quota exposure.
- Pull live import-duty measures from the GOV.UK Trade Tariff API.

## Data Sources

- GOV.UK Trade Tariff API
- UK Trade Quotas API
- GOV.UK UK steel trade measure from 1 July 2026

## Refresh Local Fallback Data

```bash
node scripts/fetch-steel-commodities.mjs
node scripts/fetch-steel-quotas.mjs
```
