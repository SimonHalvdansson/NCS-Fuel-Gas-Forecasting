#!/usr/bin/env python3
"""Build compact annual remaining-reserve history for modeled MLP fields."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from forecasting.data_io import (
    DATA_DIR,
    REMAINING_RESERVES_FILE,
    RESERVES_COL,
    field_key,
    load_remaining_reserves,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "reserves_history.json"


def build_reserves_history(data_dir: Path, modeled: set[str]) -> dict:
    source = data_dir / REMAINING_RESERVES_FILE
    if not source.is_file():
        raise FileNotFoundError(f"Missing reserve-history input: {source}")
    reserves = load_remaining_reserves(data_dir)
    if reserves.empty:
        raise ValueError(f"No usable reserve history in {source}")
    history = {key: [] for key in sorted(modeled)}
    for key, rows in reserves.groupby("field_key", sort=True):
        if key in history:
            # The shared loader already returns millions of Sm3 oil equivalent.
            history[key] = [
                {"month": row.date.strftime("%Y-%m"), "reserves": round(getattr(row, RESERVES_COL), 9)}
                for row in rows.itertuples()
            ]
    return history


def main() -> None:
    with (ROOT / "forecasting" / "manifest.csv").open(newline="", encoding="utf-8") as handle:
        modeled = {field_key(row["field"]) for row in csv.DictReader(handle)}

    history = build_reserves_history(DATA_DIR, modeled)

    OUTPUT.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote {sum(map(len, history.values())):,} annual reserve points for {len(history)} fields to {OUTPUT}")


if __name__ == "__main__":
    main()
