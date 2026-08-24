from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from .settings import IMPORT_RECORD_SLICES, STEEL_CHAPTERS, VALID_TRANSPORT_MODES
from .utils import country_name, safe_int


IMPORT_PATTERN = re.compile(r"BDSimp(?P<yy>\d{2})(?P<mm>\d{2})\.txt$", re.IGNORECASE)


@dataclass
class ImportParseResult:
    flows: pd.DataFrame
    malformed: pd.DataFrame
    quality: dict


def discover_import_files(directory: Path) -> list[Path]:
    return sorted(path for path in directory.glob("BDSimp*.txt") if IMPORT_PATTERN.search(path.name))


def parse_import_files(paths: list[Path]) -> ImportParseResult:
    rows: list[dict] = []
    malformed_rows: list[dict] = []
    totals = {
        "import_files_processed": len(paths),
        "import_rows_processed": 0,
        "steel_rows": 0,
        "rows_rejected": 0,
        "missing_origin_rows": 0,
        "missing_transport_rows": 0,
        "suppressed_rows": 0,
        "estimated_rows": 0,
        "invalid_flow_rows": 0,
        "invalid_commodity_rows": 0,
    }

    for path in paths:
        logging.info("Loading import file %s...", path.name)
        file_rows = 0
        file_steel_rows = 0
        with path.open("r", encoding="latin-1", errors="replace") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                line = raw_line.rstrip("\r\n")
                file_rows += 1
                totals["import_rows_processed"] += 1
                if len(line) < 85:
                    malformed_rows.append(
                        {
                            "file_name": path.name,
                            "line_number": line_number,
                            "record_length": len(line),
                            "raw_record": line,
                            "issue": "Record shorter than 85 characters",
                        }
                    )
                    totals["rows_rejected"] += 1
                    continue

                flow = line[IMPORT_RECORD_SLICES["FLOW"]].strip().lower()
                if flow != "imp":
                    totals["invalid_flow_rows"] += 1

                comcode = line[IMPORT_RECORD_SLICES["COMCODE"]].strip()
                if not any(comcode.startswith(chapter) for chapter in STEEL_CHAPTERS):
                    continue
                if not re.fullmatch(r"\d{8}", comcode):
                    totals["invalid_commodity_rows"] += 1
                    if line[IMPORT_RECORD_SLICES["TYPE"]].strip() != "1":
                        totals["estimated_rows"] += 1
                    continue

                perref = line[IMPORT_RECORD_SLICES["PERREF"]].strip()
                monthac = line[IMPORT_RECORD_SLICES["MONTHAC"]].strip()
                record_type = line[IMPORT_RECORD_SLICES["TYPE"]].strip()
                dispatch_country_code = line[IMPORT_RECORD_SLICES["COD_ALPHA"]].strip()
                origin_country_code = line[IMPORT_RECORD_SLICES["COO_ALPHA"]].strip()
                transport_mode_code = line[IMPORT_RECORD_SLICES["MODE_OF_TRANSPORT"]].strip()
                statistical_value_gbp = safe_int(line[IMPORT_RECORD_SLICES["STAT_VALUE"]])
                net_mass_kg = safe_int(line[IMPORT_RECORD_SLICES["NET_MASS"]])
                supplementary_quantity = safe_int(line[IMPORT_RECORD_SLICES["SUPP_UNIT"]])
                suppression_indicator = line[IMPORT_RECORD_SLICES["SUPPRESSION"]].strip()
                port_code_raw = line[IMPORT_RECORD_SLICES["PORT_CODE"]].strip()

                transport_mode, transport_source, transport_reliable = classify_transport(
                    record_type=record_type,
                    transport_mode_code=transport_mode_code,
                )

                if not origin_country_code:
                    totals["missing_origin_rows"] += 1
                if not transport_reliable:
                    totals["missing_transport_rows"] += 1
                if suppression_indicator and suppression_indicator != "0":
                    totals["suppressed_rows"] += 1
                if record_type != "1":
                    totals["estimated_rows"] += 1

                tonnes = (net_mass_kg or 0) / 1000 if net_mass_kg is not None else None
                gbp_per_tonne = (
                    round(statistical_value_gbp / tonnes, 2)
                    if statistical_value_gbp is not None and tonnes not in (None, 0)
                    else None
                )
                file_steel_rows += 1
                totals["steel_rows"] += 1
                rows.append(
                    {
                        "period": perref,
                        "year": int(perref[:4]) if perref.isdigit() else None,
                        "month": int(perref[4:6]) if perref.isdigit() else None,
                        "month_accounted": monthac,
                        "commodity_code": comcode,
                        "dispatch_country_code": dispatch_country_code,
                        "dispatch_country_name": country_name(dispatch_country_code),
                        "origin_country_code": origin_country_code,
                        "origin_country_name": country_name(origin_country_code),
                        "port_code_raw": port_code_raw,
                        "port_valid": bool(port_code_raw and port_code_raw not in {"ZZZ", "---"}),
                        "port_code": port_code_raw if port_code_raw and port_code_raw not in {"ZZZ", "---"} else "",
                        "port_name_if_available": "",
                        "transport_mode_code": transport_mode_code,
                        "transport_mode": transport_mode,
                        "transport_mode_source": transport_source,
                        "transport_mode_reliable": transport_reliable,
                        "statistical_value_gbp": statistical_value_gbp,
                        "net_mass_kg": net_mass_kg,
                        "tonnes": tonnes,
                        "supplementary_quantity": supplementary_quantity,
                        "gbp_per_tonne": gbp_per_tonne,
                        "record_type": "Declared" if record_type == "1" else "Estimated / non-response",
                        "record_type_code": record_type,
                        "suppression_indicator": suppression_indicator,
                        "flow": flow,
                        "rec_type": line[IMPORT_RECORD_SLICES["REC_TYPE"]].strip(),
                        "raw_mode_code": transport_mode_code,
                    }
                )
        logging.info("%s records read, %s Chapter 72 records retained", f"{file_rows:,}", f"{file_steel_rows:,}")

    flows = pd.DataFrame(rows)
    malformed = pd.DataFrame(malformed_rows)
    if not flows.empty:
        totals["duplicate_rows"] = int(flows.duplicated().sum())
        flows = flows.drop_duplicates()
        totals["extreme_gbp_per_tonne_rows"] = int((flows["gbp_per_tonne"].fillna(0) > 10000).sum())
        valid_periods = flows["period"].astype(str).str.fullmatch(r"\d{6}").fillna(False)
        totals["invalid_period_rows"] = int((~valid_periods).sum())
    else:
        totals["duplicate_rows"] = 0
        totals["extreme_gbp_per_tonne_rows"] = 0
        totals["invalid_period_rows"] = 0
    return ImportParseResult(flows=flows, malformed=malformed, quality=totals)


def classify_transport(record_type: str, transport_mode_code: str) -> tuple[str, str, bool]:
    mode = VALID_TRANSPORT_MODES.get(transport_mode_code, "")
    if record_type != "1":
        return ("Unknown/estimated", "HMRC non-response estimate", False)
    if not transport_mode_code or transport_mode_code not in VALID_TRANSPORT_MODES:
        return ("Unknown", "Missing HMRC mode", False)
    if transport_mode_code == "90":
        return ("Unknown/estimated", "Mode 90 requires caution", False)
    return (mode, "HMRC declared", True)
