"""High-level orchestration for the regional NCS forecast run."""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from tqdm import tqdm

from .common import add_months, set_reproducible
from .config import (
    DATA_DIR,
    FORECAST_FUEL_COL,
    FORECAST_PRODUCTION_COL,
    HORIZON,
    LOOKBACK,
    OUTPUT_DIR,
)
from .data_io import load_inputs
from .features import areas_for, build_contexts, build_fuel_samples, build_production_samples
from .fuel_accounting import (
    attach_fuel_driver_production,
    build_power_registry,
    registry_text,
)
from .models import ModelConfig, train_bundle
from .outputs import create_manifest, write_validation_metrics
from .rollout import (
    forecast_frame,
    quantile_columns,
    rollout_production_paths,
    rollout_reported_fuel_paths,
)
from .validation import build_residual_library, validation_metrics

def select_device(choice: str) -> torch.device:
    if choice in {"mps", "auto"} and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Regional NCS production and fuel-gas forecasting pipeline")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    parser.add_argument("--forecast-years", type=int, default=25)
    parser.add_argument("--quantile-samples", type=int, default=400)
    parser.add_argument("--inference-batch-size", type=int, default=4096)
    parser.add_argument("--production-epochs", type=int, default=220)
    parser.add_argument("--fuel-epochs", type=int, default=220)
    parser.add_argument("--validation-share", type=float, default=0.18)
    parser.add_argument("--device", choices=["cpu", "mps", "auto"], default="cpu")
    parser.add_argument("--seed", type=int, default=20260804)
    parser.add_argument("--max-fields", type=int, default=None)
    return parser.parse_args()

def main() -> None:
    args = parse_args()
    if args.quantile_samples < 1:
        raise SystemExit("--quantile-samples must be at least 1")
    if args.forecast_years < 1:
        raise SystemExit("--forecast-years must be at least 1")
    started = time.perf_counter()
    set_reproducible(args.seed)
    device = select_device(args.device)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    fields_dir = args.output_dir / "fields"
    aggregate_dir = args.output_dir / "aggregate"
    diagnostics_dir = args.output_dir / "diagnostics"
    for directory in (fields_dir, aggregate_dir, diagnostics_dir):
        directory.mkdir(parents=True, exist_ok=True)

    data = load_inputs(args.data_dir)
    contexts = build_contexts(data)
    if args.max_fields is not None:
        selected = list(contexts)[: args.max_fields]
        contexts = {key: contexts[key] for key in selected}
    areas = areas_for(contexts)
    registry = build_power_registry(data, contexts, args.output_dir)
    active_missing = registry[
        registry["series_scope"].eq("field")
        & registry["activity_status"].isin(["Producing", "Approved for production"])
        & ~registry["has_numeric_fuel_history"]
    ]
    unresolved = active_missing[
        ~active_missing["fuel_forecast_method"].isin(["external_power_zero"])
    ]
    if not unresolved.empty:
        fields = ", ".join(unresolved["field"].astype(str))
        raise SystemExit(f"Active missing-fuel fields lack a resolved accounting treatment: {fields}")

    served_fields = attach_fuel_driver_production(contexts, registry)
    registry["fuel_driver_fields"] = ""
    for host_key, field_keys in served_fields.items():
        registry.loc[
            registry["field_key"].eq(host_key), "fuel_driver_fields"
        ] = " | ".join(contexts[key].field for key in field_keys)
    registry.to_csv(args.output_dir / "fuel_power_classification.csv", index=False)
    production_samples = build_production_samples(contexts, areas)
    fuel_model_fields = set(
        registry.loc[
            registry["fuel_forecast_method"].eq("reported_conditioned_mlp"),
            "field_key",
        ].astype(str)
    )
    fuel_samples = build_fuel_samples(contexts, areas, fuel_model_fields)
    if not len(production_samples.X) or not len(fuel_samples.X):
        raise SystemExit("Insufficient production or fuel training windows")

    production_config = ModelConfig(
        hidden_sizes=(160, 96, 48),
        dropout=0.08,
        lr=8e-4,
        weight_decay=2e-4,
        max_epochs=args.production_epochs,
        patience=34,
        batch_size=256,
        reserve_penalty_weight=0.015,
    )
    fuel_config = ModelConfig(
        hidden_sizes=(128, 72, 36),
        dropout=0.06,
        lr=9e-4,
        weight_decay=2e-4,
        max_epochs=args.fuel_epochs,
        patience=32,
        batch_size=256,
    )
    print(
        f"Training production MLP on {len(production_samples.X):,} windows from "
        f"{production_samples.meta['field_key'].nunique()} fields ({device})."
    )
    production_started = time.perf_counter()
    production_bundle, production_train, production_validation = train_bundle(
        production_samples,
        production_config,
        args.validation_share,
        args.seed,
        device,
        "global_production_mlp",
    )
    production_seconds = time.perf_counter() - production_started
    print(
        f"Training conditioned fuel MLP on {len(fuel_samples.X):,} windows from "
        f"{fuel_samples.meta['field_key'].nunique()} fields."
    )
    fuel_started = time.perf_counter()
    fuel_bundle, fuel_train, fuel_validation = train_bundle(
        fuel_samples,
        fuel_config,
        args.validation_share,
        args.seed + 100,
        device,
        "conditioned_fuel_mlp",
    )
    fuel_seconds = time.perf_counter() - fuel_started

    production_metrics, production_prediction_norm = validation_metrics(
        production_samples, production_validation, production_bundle, device
    )
    fuel_metrics, fuel_prediction_norm = validation_metrics(
        fuel_samples, fuel_validation, fuel_bundle, device
    )
    write_validation_metrics(
        production_metrics, fuel_metrics, diagnostics_dir
    )
    production_residuals = build_residual_library(
        production_samples, production_validation, production_prediction_norm
    )
    fuel_residuals = build_residual_library(
        fuel_samples, fuel_validation, fuel_prediction_norm
    )
    production_bundle.log.to_csv(diagnostics_dir / "production_training_log.csv", index=False)
    fuel_bundle.log.to_csv(diagnostics_dir / "fuel_training_log.csv", index=False)

    forecast_months = args.forecast_years * 12
    blocks = math.ceil(forecast_months / HORIZON)
    common_rng = np.random.default_rng(args.seed + 1000)
    production_common = production_residuals.common_blocks[
        common_rng.integers(
            0,
            len(production_residuals.common_blocks),
            size=(args.quantile_samples, blocks),
        )
    ]
    fuel_common = fuel_residuals.common_blocks[
        common_rng.integers(
            0,
            len(fuel_residuals.common_blocks),
            size=(args.quantile_samples, blocks),
        )
    ]
    registry_by_key = registry.set_index("field_key").to_dict("index")
    forecasts: dict[str, pd.DataFrame] = {}
    aggregate_production = np.zeros(
        (args.quantile_samples, forecast_months), dtype=np.float32
    )
    aggregate_fuel = np.zeros_like(aggregate_production)
    production_paths_by_field: dict[str, np.ndarray] = {}
    remaining_paths_by_field: dict[str, np.ndarray] = {}
    rollout_started = time.perf_counter()
    for index, context in enumerate(tqdm(contexts.values(), desc="Forecasting production")):
        field_dir = fields_dir / context.slug
        field_dir.mkdir(parents=True, exist_ok=True)
        if context.is_shut_down:
            continue
        production_paths, remaining_paths = rollout_production_paths(
            context,
            production_bundle,
            production_residuals,
            production_common,
            forecast_months,
            areas,
            args.quantile_samples,
            args.inference_batch_size,
            device,
            args.seed + 2000 + index,
        )
        production_paths_by_field[context.key] = production_paths
        remaining_paths_by_field[context.key] = remaining_paths
        aggregate_production += production_paths

    for index, context in enumerate(tqdm(contexts.values(), desc="Forecasting fuel")):
        if context.is_shut_down:
            continue
        field_dir = fields_dir / context.slug
        production_paths = production_paths_by_field[context.key]
        remaining_paths = remaining_paths_by_field[context.key]
        power = registry_by_key[context.key]
        method = str(power["fuel_forecast_method"])
        if method == "reported_conditioned_mlp":
            driver_paths = np.zeros_like(production_paths)
            for served_key in served_fields.get(context.key, [context.key]):
                served_paths = production_paths_by_field.get(served_key)
                if served_paths is not None:
                    driver_paths += served_paths
            fuel_paths = rollout_reported_fuel_paths(
                context,
                fuel_bundle,
                fuel_residuals,
                fuel_common,
                driver_paths,
                forecast_months,
                areas,
                args.quantile_samples,
                args.inference_batch_size,
                device,
                args.seed + 4000 + index,
            )
        else:
            fuel_paths = np.zeros_like(production_paths)
        fuel_zero_from_month = registry_text(power.get("fuel_zero_from_month"))
        if fuel_zero_from_month:
            forecast_dates = pd.date_range(
                add_months(context.global_cutoff, 1), periods=forecast_months, freq="MS"
            )
            fuel_paths[:, forecast_dates >= pd.Timestamp(fuel_zero_from_month)] = 0.0
        forecast = forecast_frame(
            context,
            production_paths,
            fuel_paths,
            remaining_paths,
            method,
            str(power["host_or_source_field"] or ""),
            fuel_zero_from_month,
        )
        forecast.to_csv(field_dir / "forecast_global_mlp.csv", index=False)
        forecasts[context.key] = forecast
        aggregate_fuel += fuel_paths
    rollout_seconds = time.perf_counter() - rollout_started

    dates = pd.date_range(
        add_months(next(iter(contexts.values())).global_cutoff, 1),
        periods=forecast_months,
        freq="MS",
    )
    aggregate = pd.DataFrame({"month": dates.strftime("%Y-%m"), "date": dates})
    for key, value in {
        **quantile_columns(FORECAST_PRODUCTION_COL, aggregate_production),
        **quantile_columns(FORECAST_FUEL_COL, aggregate_fuel),
    }.items():
        aggregate[key] = value
    aggregate.to_csv(aggregate_dir / "aggregate_forecast_quantiles.csv", index=False)

    manifest = create_manifest(contexts, forecasts, registry, args.output_dir)
    run_summary = {
        "model": "separated_global_mlp",
        "fields": len(contexts),
        "forecast_fields": int(manifest["global_mlp_forecast_months"].gt(0).sum()),
        "production_training_fields": int(production_samples.meta["field_key"].nunique()),
        "fuel_training_fields": int(fuel_samples.meta["field_key"].nunique()),
        "reported_fuel_fields": int(
            registry["fuel_forecast_method"].eq("reported_conditioned_mlp").sum()
        ),
        "external_power_zero_fields": int(
            registry["fuel_forecast_method"].eq("external_power_zero").sum()
        ),
        "future_fuel_zero_override_fields": int(registry["fuel_zero_from_month"].ne("").sum()),
        "inferred_fuel_fields": 0,
        "training_windows": int(len(production_samples.X)),
        "production_training_windows": int(len(production_samples.X)),
        "fuel_training_windows": int(len(fuel_samples.X)),
        "validation_windows": int(len(production_validation)),
        "production_validation_windows": int(len(production_validation)),
        "fuel_validation_windows": int(len(fuel_validation)),
        "validation_training_windows": int(len(production_train)),
        "validation_purge_months": HORIZON,
        "horizon": HORIZON,
        "lookback": LOOKBACK,
        "forecast_years": args.forecast_years,
        "device": str(device),
        "global_best_epoch": production_bundle.best_epoch,
        "production_best_epoch": production_bundle.best_epoch,
        "fuel_best_epoch": fuel_bundle.best_epoch,
        "feature_count": len(production_samples.feature_names) + len(fuel_samples.feature_names),
        "production_feature_names": production_samples.feature_names,
        "fuel_feature_names": fuel_samples.feature_names,
        "quantile_samples": args.quantile_samples,
        "inference_batch_size": args.inference_batch_size,
        "timing_seconds": {
            "production_training": production_seconds,
            "fuel_training": fuel_seconds,
            "quantile_rollout": rollout_seconds,
            "total": time.perf_counter() - started,
        },
    }
    (diagnostics_dir / "run_summary.json").write_text(
        json.dumps(run_summary, indent=2), encoding="utf-8"
    )
    print(
        f"Wrote {len(forecasts)} active field forecasts; production training {production_seconds:.2f}s, "
        f"fuel training {fuel_seconds:.2f}s, rollout {rollout_seconds:.2f}s."
    )


