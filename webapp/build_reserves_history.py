#!/usr/bin/env python3
"""Build compact annual remaining-reserve history for modeled MLP fields."""

from __future__ import annotations

import csv
import json
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "research" / "forecasts" / "field_forecasts.json"
OUTPUT = Path(__file__).with_name("reserves_history.json")


def field_key(value: object) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).strip().upper().split())


def main() -> None:
    with (ROOT / "forecasting" / "manifest.csv").open(newline="", encoding="utf-8") as handle:
        modeled = {field_key(row["field"]) for row in csv.DictReader(handle)}

    rows = json.loads(SOURCE.read_text(encoding="utf-8"))
    history: dict[str, list[dict[str, object]]] = {}
    for field in rows:
        key = field_key(field.get("name"))
        if key not in modeled:
            continue
        points = field.get("remainingReserves", {}).get("history", [])
        history[key] = [
            {"month": str(date)[:7], "reserves": round(max(float(value), 0.0) / 1_000_000.0, 9)}
            for date, value in points
            if value is not None
        ]

    OUTPUT.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {sum(map(len, history.values())):,} annual reserve points for {len(history)} fields to {OUTPUT}")


if __name__ == "__main__":
    main()
