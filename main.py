from __future__ import annotations

import logging

from src.analysis import (
    build_company_tables,
    build_country_summary,
    build_origin_dispatch_routes,
    build_transport_summary,
    enrich_flows,
    load_product_groups,
)
from src.parse_controls import discover_control_files, parse_control_files
from src.parse_importers import discover_importer_files, parse_importer_files
from src.parse_imports import discover_import_files, parse_import_files
from src.reporting import write_outputs
from src.settings import (
    CHARTS_DIR,
    CONFIG_DIR,
    CONTROLS_DIR,
    DATA_QUALITY_DIR,
    IMPORTERS_DIR,
    IMPORTS_DIR,
    OUTPUT_DIR,
    WEBSITE_DIR,
)
from src.utils import ensure_directories, setup_logging


def main() -> None:
    setup_logging()
    ensure_directories([OUTPUT_DIR, DATA_QUALITY_DIR, CHARTS_DIR, WEBSITE_DIR])

    import_files = discover_import_files(IMPORTS_DIR)
    importer_files = discover_importer_files(IMPORTERS_DIR)
    control_files = discover_control_files(CONTROLS_DIR)

    logging.info("Discovered %s import files", len(import_files))
    logging.info("Discovered %s importer files", len(importer_files))
    logging.info("Discovered %s control files", len(control_files))

    controls_result = parse_control_files(control_files)
    imports_result = parse_import_files(import_files)
    importers_result = parse_importer_files(importer_files)

    product_groups = load_product_groups(CONFIG_DIR / "steel_product_groups.csv")
    flows = enrich_flows(imports_result.flows, controls_result.lookup, product_groups)
    country_summary = build_country_summary(flows)
    routes = build_origin_dispatch_routes(flows)
    transport_summary = build_transport_summary(flows)
    company_activity, company_commodity, company_market_context = build_company_tables(
        importers_result.importer_activity,
        controls_result.lookup,
        flows,
    )

    quality = {}
    quality.update(controls_result.quality)
    quality.update(imports_result.quality)
    quality.update(importers_result.quality)
    quality["missing_origin_pct"] = round((quality["missing_origin_rows"] / quality["steel_rows"]) if quality["steel_rows"] else 0, 4)
    quality["missing_transport_pct"] = round((quality["missing_transport_rows"] / quality["steel_rows"]) if quality["steel_rows"] else 0, 4)
    quality["suppressed_rows_pct"] = round((quality["suppressed_rows"] / quality["steel_rows"]) if quality["steel_rows"] else 0, 4)
    quality["steel_importers"] = int(company_activity["company_id"].nunique()) if not company_activity.empty else 0

    write_outputs(
        output_dir=OUTPUT_DIR,
        data_quality_dir=DATA_QUALITY_DIR,
        charts_dir=CHARTS_DIR,
        website_dir=WEBSITE_DIR,
        flows=flows,
        country_summary=country_summary,
        routes=routes,
        transport_summary=transport_summary,
        company_activity=company_activity,
        company_commodity=company_commodity,
        company_market_context=company_market_context,
        malformed_imports=imports_result.malformed,
        quality=quality,
    )
    logging.info("Analysis complete. Outputs written to %s", OUTPUT_DIR)


if __name__ == "__main__":
    main()
