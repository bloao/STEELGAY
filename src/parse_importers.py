from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from .settings import STEEL_CHAPTERS
from .utils import company_id, normalize_company_name, normalize_postcode


IMPORTER_PATTERN = re.compile(r"importers(?P<yy>\d{2})(?P<mm>\d{2})\.txt$", re.IGNORECASE)


@dataclass
class ImporterParseResult:
    importer_activity: pd.DataFrame
    quality: dict


def discover_importer_files(directory: Path) -> list[Path]:
    return sorted(path for path in directory.glob("importers*.txt") if IMPORTER_PATTERN.search(path.name))


def parse_importer_files(paths: list[Path]) -> ImporterParseResult:
    rows: list[dict] = []
    totals = {
        "importer_files_processed": len(paths),
        "importers_parsed": 0,
        "steel_importer_rows": 0,
        "invalid_importer_period_rows": 0,
        "blank_company_rows": 0,
        "invalid_importer_commodity_rows": 0,
    }

    for path in paths:
        logging.info("Loading importer file %s...", path.name)
        company_rows = 0
        steel_rows = 0
        with path.open("r", encoding="latin-1", errors="replace") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                line = raw_line.rstrip("\r\n")
                parts = line.split("\t")
                if len(parts) < 10:
                    continue
                company_rows += 1
                totals["importers_parsed"] += 1
                period = parts[0].strip()
                company_name_raw = parts[2].strip()
                postcode = parts[8].strip()

                if not re.fullmatch(r"\d{6}", period):
                    totals["invalid_importer_period_rows"] += 1
                    continue
                if not company_name_raw:
                    totals["blank_company_rows"] += 1
                    continue

                normalized_name = normalize_company_name(company_name_raw)
                normalized_postcode = normalize_postcode(postcode)
                entity_id = company_id(normalized_name, normalized_postcode)

                commodity_codes = [code.strip() for code in parts[9:] if code.strip()]
                steel_codes = []
                for code in commodity_codes:
                    if not re.fullmatch(r"\d{8}", code):
                        totals["invalid_importer_commodity_rows"] += 1
                        continue
                    if any(code.startswith(chapter) for chapter in STEEL_CHAPTERS):
                        steel_codes.append(code)

                for commodity_code in sorted(set(steel_codes)):
                    steel_rows += 1
                    totals["steel_importer_rows"] += 1
                    rows.append(
                        {
                            "period": period,
                            "year": int(period[:4]),
                            "month": int(period[4:6]),
                            "company_name_raw": company_name_raw,
                            "company_name_normalized": normalized_name,
                            "postcode": postcode,
                            "postcode_normalized": normalized_postcode,
                            "company_id": entity_id,
                            "commodity_code": commodity_code,
                            "address_1": parts[3].strip(),
                            "address_2": parts[4].strip(),
                            "address_3": parts[5].strip(),
                            "address_4": parts[6].strip(),
                            "address_5": parts[7].strip(),
                            "source_file": path.name,
                            "source_line_number": line_number,
                        }
                    )
        logging.info("%s companies read, %s steel importer rows identified", f"{company_rows:,}", f"{steel_rows:,}")

    frame = pd.DataFrame(rows)
    if not frame.empty:
        frame = frame.drop_duplicates(subset=["company_id", "period", "commodity_code"])
    return ImporterParseResult(importer_activity=frame, quality=totals)
