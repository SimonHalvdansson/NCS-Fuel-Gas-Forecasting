#!/usr/bin/env python3
"""Build the compact history artifact used by the static MLP explorer."""

from __future__ import annotations

import csv
import json
import math
import unicodedata
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "history.json"


def field_key(value: object) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).strip().upper().split())


def numeric(value: object) -> float | None:
    try:
        result = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def month_key(row: dict[str, str]) -> str | None:
    year = numeric(row.get("year"))
    month = numeric(row.get("month"))
    if year is None or month is None:
        return None
    return f"{int(year):04d}-{int(month):02d}"


def load_modeled_fields() -> set[str]:
    with (ROOT / "forecasting" / "manifest.csv").open(newline="", encoding="utf-8") as handle:
        return {field_key(row["field"]) for row in csv.DictReader(handle)}


def grouped_values(path: Path, value_column: str, scale: float, modeled: set[str]) -> dict[str, dict[str, float]]:
    grouped: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            key = field_key(row.get("name"))
            month = month_key(row)
            value = numeric(row.get(value_column))
            if key not in modeled or month is None or value is None:
                continue
            grouped[key][month] += max(value, 0.0) / scale
    return grouped


def main() -> None:
    modeled = load_modeled_fields()
    production = grouped_values(ROOT / "data" / "saleable_production.csv", "oilEquivalent", 1_000_000.0, modeled)
    fuel = grouped_values(ROOT / "data" / "consumption.csv", "fuelGas", 1_000_000.0, modeled)
    history: dict[str, list[dict[str, object]]] = {}
    for key in sorted(modeled):
        months = sorted(set(production.get(key, {})) | set(fuel.get(key, {})))
        history[key] = [
            {
                "month": month,
                "production": round(production[key][month], 9) if month in production.get(key, {}) else None,
                "fuel": round(fuel[key][month], 9) if month in fuel.get(key, {}) else None,
            }
            for month in months
        ]
    OUTPUT.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {sum(map(len, history.values())):,} monthly rows for {len(history)} fields to {OUTPUT}")


if __name__ == "__main__":
    main()
