from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import pandas as pd


CONTROL_PATTERN = re.compile(r"SMKA12(?P<yy>\d{2})(?P<mm>\d{2})\.txt$", re.IGNORECASE)


@dataclass
class ControlParseResult:
    lookup: pd.DataFrame
    quality: dict


def discover_control_files(directory: Path) -> list[Path]:
    return sorted(path for path in directory.glob("SMKA12*.txt") if CONTROL_PATTERN.search(path.name))


def parse_control_files(paths: list[Path]) -> ControlParseResult:
    rows: list[dict] = []
    duplicates_within_period = 0
    rows_processed = 0
    blank_descriptions = 0

    for path in paths:
        match = CONTROL_PATTERN.search(path.name)
        if not match:
            continue
        period = f"20{match.group('yy')}{match.group('mm')}"
        logging.info("Loading control file %s...", path.name)
        seen_codes: set[str] = set()
        with path.open("r", encoding="latin-1", errors="replace") as handle:
            for line_number, raw_line in enumerate(handle):
                if line_number == 0:
                    continue
                parts = raw_line.rstrip("\r\n").split("|")
                if len(parts) < 27:
                    continue
                commodity_code = parts[0][:8]
                description = parts[26].strip()
                if commodity_code in seen_codes:
                    duplicates_within_period += 1
                    continue
                seen_codes.add(commodity_code)
                rows_processed += 1
                if not description:
                    blank_descriptions += 1
                rows.append(
                    {
                        "period": period,
                        "commodity_code": commodity_code,
                        "description": description,
                        "quantity_unit": parts[24].strip(),
                        "supplementary_unit": parts[25].strip(),
                    }
                )

    lookup = pd.DataFrame(rows)
    quality = {
        "control_files_processed": len(paths),
        "control_rows_processed": rows_processed,
        "control_duplicate_code_definitions": duplicates_within_period,
        "control_blank_descriptions": blank_descriptions,
    }
    return ControlParseResult(lookup=lookup, quality=quality)
