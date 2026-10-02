"""Repository paths and shared forecast constants."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
OUTPUT_DIR = ROOT / "forecasting"
POWER_REGISTRY = OUTPUT_DIR / "fuel_power_classification.csv"
FUTURE_FUEL_OVERRIDES = OUTPUT_DIR / "future_fuel_zero_overrides.csv"

HORIZON = 12
LOOKBACK = 12
EPS = 1e-8
FORECAST_PRODUCTION_COL = "production_forecast_msm3oe"
FORECAST_FUEL_COL = "fuel_gas_forecast_msm3"
QUANTILES = (0.10, 0.30, 0.50, 0.70, 0.90)
Q_LABELS = ("q10", "q30", "q50", "q70", "q90")

