from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Iterable

import pandas as pd

from .settings import COUNTRY_NAMES


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )


def ensure_directories(paths: Iterable[Path]) -> None:
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)


def safe_int(value: str) -> int | None:
    value = value.strip()
    return int(value) if value.isdigit() else None


def normalize_postcode(value: str) -> str:
    return re.sub(r"\s+", "", value.upper()).strip()


def normalize_company_name(value: str) -> str:
    text = value.upper().strip()
    replacements = {
        "LIMITED": "LTD",
        "PUBLIC LIMITED COMPANY": "PLC",
        "&": " AND ",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = re.sub(r"[^A-Z0-9 ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def company_id(normalized_name: str, normalized_postcode: str) -> str:
    token = f"{normalized_name}|{normalized_postcode}"
    return hashlib.md5(token.encode("utf-8")).hexdigest()[:12]


def country_name(code: str) -> str:
    code = (code or "").strip().upper()
    return COUNTRY_NAMES.get(code, code or "Unknown / not supplied")


def to_month_label(period: str) -> str:
    return f"{period[:4]}-{period[4:6]}"


def current_ytd_months(flows: pd.DataFrame, year: int) -> list[int]:
    months = (
        flows.loc[flows["year"] == year, "month"]
        .dropna()
        .astype(int)
        .sort_values()
        .unique()
        .tolist()
    )
    return months


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
