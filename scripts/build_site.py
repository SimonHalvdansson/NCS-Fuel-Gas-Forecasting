#!/usr/bin/env python3
"""Build the GitHub Pages bundle using only the files consumed by the app."""

from __future__ import annotations

import csv
import shutil
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
STATIC_FILES = (
    ".nojekyll",
    "index.html",
    "app.js",
    "styles.css",
    "icon.svg",
    "history.json",
    "reserves_history.json",
    "power_sources.json",
    "data/field_locations.json",
    "data/ncs_land_polygons.json",
    "forecasting/manifest.csv",
    "forecasting/fuel_power_classification.csv",
    "forecasting/diagnostics/metrics_by_field.csv",
    "forecasting/diagnostics/run_summary.json",
    "forecasting/aggregate/aggregate_forecast_quantiles.csv",
    "forecasting/aggregate/aggregate_contributors.json",
)


def build_site(root: Path) -> Path:
    root = root.resolve()
    files = {Path(name) for name in STATIC_FILES}
    with (root / "forecasting/manifest.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if int(row["global_mlp_forecast_months"] or 0) <= 0:
                continue
            directory = PurePosixPath(row["field_dir"])
            if directory.parts[:2] != ("forecasting", "fields") or ".." in directory.parts:
                raise ValueError(f"Invalid forecast directory: {directory}")
            files.add(Path(directory) / "forecast_global_mlp.csv")

    # Validate every required input before replacing the previous bundle.
    for relative in sorted(files):
        source = root / relative
        source.resolve().relative_to(root)
        if not source.is_file():
            raise FileNotFoundError(f"Missing site input: {relative}")

    output = root / "_site"
    if output.is_symlink():
        raise ValueError("Refusing to replace a symlink at _site")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir()
    for relative in sorted(files):
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / relative, destination)
    return output


if __name__ == "__main__":
    output = build_site(ROOT)
    print(f"Built website bundle at {output}")
