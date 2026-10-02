"""Write the validation metrics and field manifest consumed by the web app."""

from pathlib import Path

import pandas as pd

from .config import FORECAST_FUEL_COL, FORECAST_PRODUCTION_COL
from .features import FieldContext


def write_validation_metrics(
    production_metrics: pd.DataFrame,
    fuel_metrics: pd.DataFrame,
    output_dir: Path,
) -> None:
    production = production_metrics.rename(
        columns={
            "production_rmse": "production_rmse_msm3oe",
            "production_mae": "production_mae_msm3oe",
        }
    )
    fuel = fuel_metrics.rename(
        columns={
            "fuel_rmse": "fuel_rmse_msm3",
            "fuel_mae": "fuel_mae_msm3",
            "validation_samples": "fuel_validation_samples",
        }
    )
    fuel_columns = [
        "field_key",
        "fuel_validation_samples",
        "fuel_rmse_msm3",
        "fuel_mae_msm3",
        "fuel_smape",
        "fuel_rmsle",
    ]
    metrics = production.merge(fuel[fuel_columns], on="field_key", how="left")
    metrics.insert(0, "variant", "global_mlp")
    metrics.to_csv(output_dir / "metrics_by_field.csv", index=False)

def create_manifest(
    contexts: dict[str, FieldContext],
    forecasts: dict[str, pd.DataFrame],
    registry: pd.DataFrame,
    output_dir: Path,
) -> pd.DataFrame:
    registry_by_key = registry.set_index("field_key").to_dict("index")
    rows: list[dict[str, object]] = []
    for index, context in enumerate(contexts.values(), start=1):
        forecast = forecasts.get(context.key, pd.DataFrame())
        power = registry_by_key[context.key]
        remaining = context.panel["remaining"].dropna()
        rows.append(
            {
                "idx": index,
                "field_key": context.key,
                "field": context.field,
                "field_dir": f"forecasting/fields/{context.slug}",
                "latest_data_month": context.global_cutoff.strftime("%Y-%m"),
                "latest_observed_production_month": context.latest_observed_production.strftime("%Y-%m"),
                "months_total": int(len(context.panel)),
                "months_with_production": int(context.panel["has_production"].sum()),
                "months_with_consumption": int(context.panel["has_fuel"].sum()),
                "months_with_remaining_reserves": int(context.panel["has_remaining"].sum()),
                "production_scale_msm3oe": float(context.panel["production"].max()),
                "fuel_scale_msm3": float(context.panel["fuel"].max()),
                "reserve_scale_msm3oe": float(remaining.max()) if len(remaining) else float("nan"),
                "global_mlp_forecast_months": int(len(forecast)),
                "global_mlp_total_forecast_production_msm3oe": float(forecast[FORECAST_PRODUCTION_COL].sum()) if len(forecast) else float("nan"),
                "global_mlp_total_forecast_fuel_gas_msm3": float(forecast[FORECAST_FUEL_COL].sum()) if len(forecast) else float("nan"),
                "global_mlp_final_remaining_reserves_msm3oe": float(forecast["remaining_reserves_end_msm3oe"].iloc[-1]) if len(forecast) else float("nan"),
                "global_mlp_months_clipped": int(forecast["production_was_clipped"].sum()) if len(forecast) else 0,
                "fuel_forecast_method": power["fuel_forecast_method"],
                "fuel_is_inferred": bool(power["fuel_is_inferred"]),
                "field_level_fuel_expected": power["field_level_fuel_expected"],
                "fuel_source_field": power["host_or_source_field"],
                "supplied_by_field_key": power["supplied_by_field_key"],
                "fuel_accounted_field_key": power["fuel_accounted_field_key"],
                "fuel_zero_from_month": power["fuel_zero_from_month"],
                "future_power_source_class": power["future_power_source_class"],
                "future_transition_source_url": power["future_transition_source_url"],
                "power_source_class": power["power_source_class"],
                "power_source_confidence": power["confidence"],
                "power_source_url": power["source_url"],
            }
        )
    manifest = pd.DataFrame(rows)
    manifest.to_csv(output_dir / "manifest.csv", index=False)
    return manifest
