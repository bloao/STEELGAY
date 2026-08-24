from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd

from .utils import current_ytd_months


def load_product_groups(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, dtype=str).fillna("")


def enrich_flows(flows: pd.DataFrame, controls: pd.DataFrame, product_groups: pd.DataFrame) -> pd.DataFrame:
    if flows.empty:
        return flows
    enriched = flows.merge(
        controls,
        how="left",
        on=["period", "commodity_code"],
    )
    enriched = enriched.rename(
        columns={
            "description": "commodity_description",
            "quantity_unit": "quantity_unit",
            "supplementary_unit": "supplementary_unit_name",
        }
    )
    product_groups = product_groups.sort_values("commodity_prefix", key=lambda s: s.str.len(), ascending=False)
    enriched["steel_product_group"] = "Other"
    for row in product_groups.itertuples(index=False):
        prefix = row.commodity_prefix
        mask = enriched["commodity_code"].str.startswith(prefix)
        enriched.loc[mask, "steel_product_group"] = row.product_group
    enriched["commodity_description"] = enriched["commodity_description"].fillna("Unknown commodity description")
    enriched["quantity_unit"] = enriched["quantity_unit"].fillna("")
    enriched["supplementary_unit_name"] = enriched["supplementary_unit_name"].fillna("")
    return estimate_transport_modes(enriched)


def estimate_transport_modes(flows: pd.DataFrame) -> pd.DataFrame:
    reliable = flows[flows["transport_mode_reliable"]].copy()
    if reliable.empty:
        flows["estimated_transport_mode"] = "Unknown"
        flows["transport_confidence"] = "Low"
        flows["transport_confidence_pct"] = 0.0
        flows["transport_inference_level"] = "none"
        flows["supporting_tonnes"] = 0.0
        flows["supporting_records"] = 0
        return flows

    reliable["supporting_records"] = 1
    reliable["supporting_tonnes"] = reliable["tonnes"].fillna(0.0)
    level_specs = [
        ("origin_dispatch_commodity", ["origin_country_code", "dispatch_country_code", "commodity_code"]),
        ("origin_commodity", ["origin_country_code", "commodity_code"]),
        ("origin_product", ["origin_country_code", "steel_product_group"]),
        ("dispatch_product", ["dispatch_country_code", "steel_product_group"]),
    ]
    best_matches = {}
    for level_name, keys in level_specs:
        grouped = (
            reliable.groupby(keys + ["transport_mode"], dropna=False)
            .agg(supporting_tonnes=("tonnes", "sum"), supporting_records=("supporting_records", "sum"))
            .reset_index()
        )
        totals = grouped.groupby(keys, dropna=False).agg(
            total_tonnes=("supporting_tonnes", "sum"),
            total_records=("supporting_records", "sum"),
        )
        merged = grouped.merge(totals, on=keys, how="left")
        denominator = merged["total_tonnes"].where(merged["total_tonnes"] > 0, merged["total_records"])
        merged["share"] = merged["supporting_tonnes"] / denominator.where(denominator > 0, 1)
        merged = merged.sort_values(keys + ["share"], ascending=[True] * len(keys) + [False])
        best_matches[level_name] = {
            tuple(record[key] for key in keys): {
                "transport_mode": record["transport_mode"],
                "share": float(record["share"]),
                "supporting_tonnes": float(record["supporting_tonnes"]),
                "supporting_records": int(record["supporting_records"]),
            }
            for record in merged.drop_duplicates(subset=keys).to_dict(orient="records")
        }

    estimates = []
    for row in flows.itertuples(index=False):
        if row.transport_mode_reliable:
            estimates.append(
                {
                    "estimated_transport_mode": row.transport_mode,
                    "transport_confidence": "Reported",
                    "transport_confidence_pct": 1.0,
                    "transport_inference_level": "reported",
                    "supporting_tonnes": row.tonnes or 0.0,
                    "supporting_records": 1,
                }
            )
            continue

        estimate = {
            "estimated_transport_mode": "Unknown",
            "transport_confidence": "Low",
            "transport_confidence_pct": 0.0,
            "transport_inference_level": "none",
            "supporting_tonnes": 0.0,
            "supporting_records": 0,
        }
        for level_name, keys in level_specs:
            lookup_key = tuple(getattr(row, key) for key in keys)
            top = best_matches[level_name].get(lookup_key)
            if not top:
                continue
            if top["share"] < 0.60:
                continue
            estimate = {
                "estimated_transport_mode": top["transport_mode"],
                "transport_confidence": confidence_band(top["share"]),
                "transport_confidence_pct": round(float(top["share"]), 3),
                "transport_inference_level": level_name,
                "supporting_tonnes": round(float(top["supporting_tonnes"]), 3),
                "supporting_records": int(top["supporting_records"]),
            }
            break
        estimates.append(estimate)

    estimate_df = pd.DataFrame(estimates)
    return pd.concat([flows.reset_index(drop=True), estimate_df], axis=1)


def confidence_band(score: float) -> str:
    if score >= 0.90:
        return "Very High"
    if score >= 0.75:
        return "High"
    if score >= 0.60:
        return "Moderate"
    return "Low"


def build_country_summary(flows: pd.DataFrame) -> pd.DataFrame:
    ytd_months_2026 = current_ytd_months(flows, 2026)
    base = flows.copy()
    base["active_month"] = base["period"]
    grouped = base.groupby(["origin_country_code", "origin_country_name"], dropna=False)
    records = []
    for (code, name), frame in grouped:
        summary = {
            "origin_country_code": code,
            "origin_country": name,
            "2024_tonnes": frame.loc[frame["year"] == 2024, "tonnes"].sum(),
            "2025_tonnes": frame.loc[frame["year"] == 2025, "tonnes"].sum(),
            "2026_ytd_tonnes": frame.loc[frame["year"] == 2026, "tonnes"].sum(),
            "2024_value": frame.loc[frame["year"] == 2024, "statistical_value_gbp"].sum(),
            "2025_value": frame.loc[frame["year"] == 2025, "statistical_value_gbp"].sum(),
            "2026_ytd_value": frame.loc[frame["year"] == 2026, "statistical_value_gbp"].sum(),
            "total_tonnes": frame["tonnes"].sum(),
            "total_value": frame["statistical_value_gbp"].sum(),
            "number_of_commodity_codes": frame["commodity_code"].nunique(),
            "number_of_active_months": frame["period"].nunique(),
            "first_seen": frame["period"].min(),
            "last_seen": frame["period"].max(),
            "main_product_group": dominant_value(frame, "steel_product_group", "tonnes"),
            "main_dispatch_country": dominant_value(frame, "dispatch_country_name", "tonnes"),
            "main_transport_mode": dominant_value(frame, "estimated_transport_mode", "tonnes"),
        }
        ytd_2025 = frame.loc[(frame["year"] == 2025) & (frame["month"].isin(ytd_months_2026))]
        summary["2025_equivalent_ytd_tonnes"] = ytd_2025["tonnes"].sum()
        summary["2025_equivalent_ytd_value"] = ytd_2025["statistical_value_gbp"].sum()
        summary["2026_ytd_vs_2025_ytd_tonnes_pct"] = pct_change(
            summary["2025_equivalent_ytd_tonnes"], summary["2026_ytd_tonnes"]
        )
        summary["2026_ytd_vs_2025_ytd_value_pct"] = pct_change(
            summary["2025_equivalent_ytd_value"], summary["2026_ytd_value"]
        )
        records.append(summary)

    result = pd.DataFrame(records)
    total_tonnes = result["total_tonnes"].sum() or 0
    total_value = result["total_value"].sum() or 0
    result["share_of_uk_steel_import_tonnes"] = result["total_tonnes"] / total_tonnes if total_tonnes else 0
    result["share_of_uk_steel_import_value"] = result["total_value"] / total_value if total_value else 0
    return result.sort_values("total_tonnes", ascending=False)


def build_origin_dispatch_routes(flows: pd.DataFrame) -> pd.DataFrame:
    routes = (
        flows.groupby(
            ["origin_country_name", "dispatch_country_name", "commodity_code", "steel_product_group"],
            dropna=False,
        )
        .agg(
            tonnes=("tonnes", "sum"),
            value=("statistical_value_gbp", "sum"),
            active_months=("period", "nunique"),
        )
        .reset_index()
        .sort_values("tonnes", ascending=False)
    )
    routes["origin_dispatch_different"] = routes["origin_country_name"] != routes["dispatch_country_name"]
    return routes


def build_transport_summary(flows: pd.DataFrame) -> pd.DataFrame:
    summary = (
        flows.groupby(
            [
                "origin_country_name",
                "dispatch_country_name",
                "commodity_code",
                "steel_product_group",
                "year",
                "estimated_transport_mode",
            ],
            dropna=False,
        )
        .agg(
            tonnes=("tonnes", "sum"),
            value=("statistical_value_gbp", "sum"),
        )
        .reset_index()
    )
    totals = summary.groupby(["origin_country_name", "year"], dropna=False)["tonnes"].transform("sum")
    summary["share_of_tonnes"] = summary["tonnes"] / totals.where(totals > 0, 1)
    return summary.sort_values(["year", "tonnes"], ascending=[True, False])


def build_company_tables(importers: pd.DataFrame, controls: pd.DataFrame, flows: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    if importers.empty:
        empty = pd.DataFrame()
        return empty, empty, empty

    importer_enriched = importers.merge(
        controls[["period", "commodity_code", "description"]],
        how="left",
        on=["period", "commodity_code"],
    ).rename(columns={"description": "commodity_description"})
    importer_enriched["commodity_description"] = importer_enriched["commodity_description"].fillna("Unknown commodity description")

    company_summary = (
        importer_enriched.groupby(
            ["company_id", "company_name_raw", "company_name_normalized", "postcode", "postcode_normalized"],
            dropna=False,
        )
        .agg(
            first_seen=("period", "min"),
            last_seen=("period", "max"),
            active_months_total=("period", "nunique"),
            commodity_codes=("commodity_code", lambda s: "|".join(sorted(set(s)))),
            number_of_steel_commodity_codes=("commodity_code", "nunique"),
        )
        .reset_index()
    )

    for year in (2024, 2025, 2026):
        year_rows = importer_enriched.loc[importer_enriched["year"] == year]
        month_counts = year_rows.groupby("company_id")["period"].nunique()
        company_summary[f"seen_{year}"] = company_summary["company_id"].isin(month_counts.index)
        company_summary[f"active_months_{year}"] = company_summary["company_id"].map(month_counts).fillna(0).astype(int)

    company_summary["company_status"] = company_summary.apply(classify_company_status, axis=1)

    product_lookup = flows[["commodity_code", "steel_product_group"]].drop_duplicates()
    company_commodity = (
        importer_enriched.merge(product_lookup, how="left", on="commodity_code")
        .groupby(
            ["company_id", "company_name_raw", "postcode", "commodity_code", "commodity_description", "steel_product_group"],
            dropna=False,
        )
        .agg(
            first_seen=("period", "min"),
            last_seen=("period", "max"),
            active_months=("period", "nunique"),
        )
        .reset_index()
    )
    for year in (2024, 2025, 2026):
        seen = (
            importer_enriched.loc[importer_enriched["year"] == year]
            .groupby(["company_id", "commodity_code"])
            .size()
            .rename(f"seen_{year}")
        )
        company_commodity = company_commodity.merge(seen, how="left", on=["company_id", "commodity_code"])
        company_commodity[f"seen_{year}"] = company_commodity[f"seen_{year}"].fillna(0).gt(0)

    company_commodity = company_commodity.merge(
        company_summary[["company_id", "company_status"]],
        how="left",
        on="company_id",
    )

    market_context = build_company_market_context(company_commodity, flows, company_summary)
    return company_summary.sort_values("active_months_total", ascending=False), company_commodity, market_context


def classify_company_status(row: pd.Series) -> str:
    seen_2024 = bool(row["seen_2024"])
    seen_2025 = bool(row["seen_2025"])
    seen_2026 = bool(row["seen_2026"])
    if seen_2024 and seen_2025 and seen_2026:
        return "Persistent"
    if not seen_2024 and seen_2025 and seen_2026:
        return "Current"
    if row["first_seen"].startswith("2026"):
        return "New 2026"
    if seen_2024 and not seen_2025 and not seen_2026:
        return "Historical / possibly inactive"
    if seen_2025 and not seen_2026:
        return "Recently inactive / uncertain"
    if seen_2024 and not seen_2025 and seen_2026:
        return "Intermittent"
    return "Intermittent"


def build_company_market_context(
    company_commodity: pd.DataFrame,
    flows: pd.DataFrame,
    company_summary: pd.DataFrame,
) -> pd.DataFrame:
    market_context_rows = []
    grouped = flows.groupby("commodity_code", dropna=False)
    company_status = company_summary.set_index("company_id")
    for row in company_commodity.itertuples(index=False):
        if row.commodity_code not in grouped.groups:
            continue
        frame = grouped.get_group(row.commodity_code)
        origin_mix = (
            frame.groupby("origin_country_name")["tonnes"]
            .sum()
            .sort_values(ascending=False)
        )
        market_context_rows.append(
            {
                "company_id": row.company_id,
                "company_name": row.company_name_raw,
                "postcode": row.postcode,
                "commodity_code": row.commodity_code,
                "commodity_description": row.commodity_description,
                "steel_product_group": row.steel_product_group,
                "uk_origin_countries_for_this_commodity": " | ".join(origin_mix.index.tolist()),
                "top_uk_origin_country": origin_mix.index[0] if not origin_mix.empty else "",
                "top_5_origin_countries": " | ".join(origin_mix.head(5).index.tolist()),
                "uk_tonnes_for_commodity": frame["tonnes"].sum(),
                "uk_market_value_for_commodity": frame["statistical_value_gbp"].sum(),
                "dominant_reported_transport_mode": dominant_value(frame, "estimated_transport_mode", "tonnes"),
                "company_active_months": int(
                    company_commodity.loc[
                        (company_commodity["company_id"] == row.company_id)
                        & (company_commodity["commodity_code"] == row.commodity_code),
                        "active_months",
                    ].iloc[0]
                ),
                "company_first_seen": company_commodity.loc[
                    (company_commodity["company_id"] == row.company_id)
                    & (company_commodity["commodity_code"] == row.commodity_code),
                    "first_seen",
                ].iloc[0],
                "company_last_seen": company_commodity.loc[
                    (company_commodity["company_id"] == row.company_id)
                    & (company_commodity["commodity_code"] == row.commodity_code),
                    "last_seen",
                ].iloc[0],
                "company_status": company_status.loc[row.company_id, "company_status"],
                "market_probability_note": "Market probability / context only - NOT confirmed company origin",
            }
        )
    return pd.DataFrame(market_context_rows)


def dominant_value(frame: pd.DataFrame, dimension: str, measure: str) -> str:
    if frame.empty:
        return ""
    grouped = frame.groupby(dimension, dropna=False)[measure].sum().sort_values(ascending=False)
    return str(grouped.index[0]) if not grouped.empty else ""


def pct_change(base: float, new: float) -> float | None:
    if base in (None, 0):
        return None
    return (new - base) / base


def build_monthly_importer_counts(company_summary: pd.DataFrame, importers: pd.DataFrame) -> pd.DataFrame:
    counts = (
        importers.groupby("period")["company_id"]
        .nunique()
        .rename("active_importers")
        .reset_index()
        .sort_values("period")
    )
    counts["company_status_mix_label"] = counts["period"]
    return counts
