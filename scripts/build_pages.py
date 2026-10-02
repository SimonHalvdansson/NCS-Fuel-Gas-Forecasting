#!/usr/bin/env python3
"""Package the static app and its precomputed inputs into _site/ for Pages."""

from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "_site"
WEB_ASSETS = (
    "index.html",
    "app.js",
    "styles.css",
    "icon.svg",
    "history.json",
    "reserves_history.json",
    "power_sources.json",
    "data/field_locations.json",
    "data/ncs_land_polygons.json",
)
FORECAST_ASSETS = (
    "forecasting/manifest.csv",
    "forecasting/fuel_power_classification.csv",
    "forecasting/diagnostics/metrics_by_field.csv",
    "forecasting/diagnostics/run_summary.json",
    "forecasting/aggregate/aggregate_forecast_quantiles.csv",
)


def build_aggregate_contributors(forecasts: list[tuple[str, Path]]) -> dict:
    """Package only the top ten monthly and first-year field contributions."""
    columns = {"production": "production_forecast_msm3oe_q50", "fuel": "fuel_gas_forecast_msm3_q50"}
    first_year = {metric: [] for metric in columns}
    months = {}
    for field, path in forecasts:
        totals = {metric: 0.0 for metric in columns}
        with path.open(newline="", encoding="utf-8") as file:
            rows = sorted(csv.DictReader(file), key=lambda row: row["month"])
        for index, row in enumerate(rows):
            month = months.setdefault(row["month"], {metric: [] for metric in columns})
            for metric, column in columns.items():
                value = float(row[column])
                month[metric].append({"field": field, "value": value})
                if index < 12:
                    totals[metric] += value
        for metric, value in totals.items():
            first_year[metric].append({"field": field, "value": value})
    for period in [first_year, *months.values()]:
        for metric, rows in period.items():
            period[metric] = sorted(
                (row for row in rows if row["value"] > 0),
                key=lambda row: (-row["value"], row["field"]),
            )[:10]
    return {"firstYear": first_year, "months": months}


def main() -> None:
    assets = [(ROOT / "webapp" / name, Path(name)) for name in WEB_ASSETS]
    assets.extend((ROOT / name, Path(name)) for name in FORECAST_ASSETS)
    forecasts = []

    with (ROOT / "forecasting/manifest.csv").open(newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            if int(row["global_mlp_forecast_months"] or 0) <= 0:
                continue
            directory = PurePosixPath(row["field_dir"])
            if directory.parts[:2] != ("forecasting", "fields") or ".." in directory.parts:
                raise SystemExit(f"Invalid forecast directory: {directory}")
            relative = Path(directory) / "forecast_global_mlp.csv"
            assets.append((ROOT / relative, relative))
            forecasts.append((row["field"], ROOT / relative))

    missing = [str(source.relative_to(ROOT)) for source, _ in assets if not source.is_file()]
    if missing:
        raise SystemExit("Missing site inputs:\n" + "\n".join(missing))

    if SITE.exists():
        shutil.rmtree(SITE)
    for source, relative in assets:
        target = SITE / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    contributors = SITE / "forecasting/aggregate/aggregate_contributors.json"
    contributors.write_text(json.dumps(build_aggregate_contributors(forecasts), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    (SITE / ".nojekyll").touch()
    print(f"Packaged {len(assets) + 2} files into {SITE}")


if __name__ == "__main__":
    main()
