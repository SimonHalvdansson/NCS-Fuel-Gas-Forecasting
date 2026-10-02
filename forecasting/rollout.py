"""Autoregressive production/fuel rollout and forecast-frame construction."""

import math

import numpy as np
import pandas as pd
import torch

from .common import add_months
from .config import (
    EPS,
    FORECAST_FUEL_COL,
    FORECAST_PRODUCTION_COL,
    HORIZON,
    Q_LABELS,
    QUANTILES,
)
from .features import FieldContext, fuel_feature_names, production_feature_names
from .data_io import slugify
from .models import ModelBundle, predict_blocks
from .validation import ResidualLibrary

def production_feature_matrix(
    context: FieldContext,
    production_history: np.ndarray,
    remaining: np.ndarray,
    origin_date: pd.Timestamp,
    areas: list[str],
) -> tuple[np.ndarray, np.ndarray]:
    paths, length = production_history.shape
    scale = np.maximum(np.max(production_history, axis=1), 0.05)
    cumulative = np.sum(production_history, axis=1, dtype=np.float64)
    has_remaining = np.isfinite(remaining)
    remaining_clean = np.where(has_remaining, remaining, 0.0)
    reserve_scale = np.maximum.reduce(
        [remaining_clean + cumulative, scale * 24.0, np.ones(paths)]
    )
    values: dict[str, np.ndarray | float] = {
        "month_sin": math.sin(2 * math.pi * origin_date.month / 12),
        "month_cos": math.cos(2 * math.pi * origin_date.month / 12),
        "age_years": (length - 1) / 12.0,
        "log_production_scale": np.log1p(scale),
        "log_reserve_scale": np.log1p(reserve_scale),
        "remaining_fraction": np.divide(
            remaining_clean,
            reserve_scale,
            out=np.zeros(paths),
            where=reserve_scale > EPS,
        ),
        "depletion_fraction": np.divide(
            cumulative,
            cumulative + remaining_clean,
            out=np.zeros(paths),
            where=(cumulative + remaining_clean) > EPS,
        ),
        "has_remaining": has_remaining.astype(float),
    }
    for window in (3, 6, 12):
        values[f"prod_roll_{window}"] = (
            np.mean(production_history[:, -min(window, length) :], axis=1) / scale
        )
    values["prod_trend_3"] = (
        production_history[:, -1] - production_history[:, -min(4, length)]
    ) / scale
    values["prod_trend_12"] = (
        production_history[:, -1] - production_history[:, -min(13, length)]
    ) / scale
    for months in (0, 1, 2, 3, 6, 12):
        index = length - 1 - months
        values[f"prod_lag_{months}"] = (
            production_history[:, index] / scale if index >= 0 else np.zeros(paths)
        )
        values[f"prod_lag_{months}_observed"] = float(index >= 0)
    for area in areas:
        values[f"area_{slugify(area)}"] = float(context.area == area)
    columns = []
    for name in production_feature_names(areas):
        value = values[name]
        columns.append(
            np.full(paths, float(value), dtype=float)
            if np.isscalar(value)
            else np.asarray(value, dtype=float)
        )
    return np.nan_to_num(np.column_stack(columns)).astype(np.float32), scale.astype(np.float32)

def fuel_feature_matrix(
    context: FieldContext,
    production_history: np.ndarray,
    fuel_history: np.ndarray,
    future_production: np.ndarray,
    origin_date: pd.Timestamp,
    areas: list[str],
    fixed_fuel_scale: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    paths, length = production_history.shape
    production_scale = np.maximum(np.max(production_history, axis=1), 0.05)
    fuel_scale = np.maximum(np.asarray(fixed_fuel_scale, dtype=float), 0.05)
    values: dict[str, np.ndarray | float] = {
        "month_sin": math.sin(2 * math.pi * origin_date.month / 12),
        "month_cos": math.cos(2 * math.pi * origin_date.month / 12),
        "age_years": (length - 1) / 12.0,
        "log_production_scale": np.log1p(production_scale),
        "log_fuel_scale": np.log1p(fuel_scale),
    }
    for window in (3, 6, 12):
        window_length = min(window, length)
        values[f"prod_roll_{window}"] = (
            np.mean(production_history[:, -window_length:], axis=1) / production_scale
        )
        values[f"fuel_roll_{window}"] = (
            np.mean(fuel_history[:, -window_length:], axis=1) / fuel_scale
        )
    values["prod_trend_3"] = (
        production_history[:, -1] - production_history[:, -min(4, length)]
    ) / production_scale
    values["prod_trend_12"] = (
        production_history[:, -1] - production_history[:, -min(13, length)]
    ) / production_scale
    values["fuel_trend_3"] = (
        fuel_history[:, -1] - fuel_history[:, -min(4, length)]
    ) / fuel_scale
    values["fuel_trend_12"] = (
        fuel_history[:, -1] - fuel_history[:, -min(13, length)]
    ) / fuel_scale
    for months in (0, 1, 2, 3, 6, 12):
        index = length - 1 - months
        values[f"prod_lag_{months}"] = (
            production_history[:, index] / production_scale if index >= 0 else np.zeros(paths)
        )
        values[f"fuel_lag_{months}"] = (
            fuel_history[:, index] / fuel_scale if index >= 0 else np.zeros(paths)
        )
    for month in range(HORIZON):
        values[f"future_prod_{month + 1}"] = future_production[:, month] / production_scale
    for area in areas:
        values[f"area_{slugify(area)}"] = float(context.area == area)
    columns = []
    for name in fuel_feature_names(areas):
        value = values[name]
        columns.append(
            np.full(paths, float(value), dtype=float)
            if np.isscalar(value)
            else np.asarray(value, dtype=float)
        )
    return np.nan_to_num(np.column_stack(columns)).astype(np.float32), fuel_scale.astype(np.float32)

def draw_field_residuals(
    library: ResidualLibrary,
    field_key: str,
    paths: int,
    rng: np.random.Generator,
    shrinkage: float = 24.0,
) -> np.ndarray:
    pooled = library.idiosyncratic_blocks
    field = library.field_blocks.get(field_key)
    if field is None or not len(field):
        return pooled[rng.integers(0, len(pooled), size=paths)]
    field_weight = len(field) / (len(field) + shrinkage)
    use_field = rng.random(paths) < field_weight
    output = pooled[rng.integers(0, len(pooled), size=paths)].copy()
    if use_field.any():
        output[use_field] = field[
            rng.integers(0, len(field), size=int(use_field.sum()))
        ]
    return output

def apply_residuals(prediction_norm: np.ndarray, residuals: np.ndarray) -> np.ndarray:
    transformed = np.log1p(10.0 * np.maximum(prediction_norm, 0.0)) + residuals
    return np.maximum(np.expm1(np.clip(transformed, -10.0, 12.0)) / 10.0, 0.0)

def rollout_production_paths(
    context: FieldContext,
    bundle: ModelBundle,
    residual_library: ResidualLibrary,
    common_draws: np.ndarray,
    forecast_months: int,
    areas: list[str],
    paths: int,
    inference_batch_size: int,
    device: torch.device,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    history = np.repeat(
        context.panel["production"].to_numpy(dtype=np.float32)[None, :], paths, axis=0
    )
    start_remaining = float(context.panel["remaining"].iloc[-1])
    remaining = np.full(
        paths, start_remaining if np.isfinite(start_remaining) else np.nan, dtype=np.float32
    )
    production_output = np.zeros((paths, forecast_months), dtype=np.float32)
    remaining_output = np.full((paths, forecast_months), np.nan, dtype=np.float32)
    rng = np.random.default_rng(seed)
    blocks = math.ceil(forecast_months / HORIZON)
    for block in range(blocks):
        origin_date = add_months(context.global_cutoff, block * HORIZON)
        X, scale = production_feature_matrix(context, history, remaining, origin_date, areas)
        prediction_norm = predict_blocks(
            bundle.model, bundle.scaler, X, device, inference_batch_size
        )
        residual = common_draws[:, block] + draw_field_residuals(
            residual_library, context.key, paths, rng
        )
        prediction = apply_residuals(prediction_norm, residual) * scale[:, None]
        block_length = min(HORIZON, forecast_months - block * HORIZON)
        clipped = np.zeros((paths, block_length), dtype=np.float32)
        for month in range(block_length):
            values = prediction[:, month].astype(np.float32)
            finite_remaining = np.isfinite(remaining)
            values[finite_remaining] = np.minimum(
                values[finite_remaining], remaining[finite_remaining]
            )
            values = np.maximum(values, 0.0)
            remaining[finite_remaining] = np.maximum(
                remaining[finite_remaining] - values[finite_remaining], 0.0
            )
            clipped[:, month] = values
            remaining_output[:, block * HORIZON + month] = remaining
        production_output[:, block * HORIZON : block * HORIZON + block_length] = clipped
        history = np.concatenate([history, clipped], axis=1)
    return production_output, remaining_output

def rollout_reported_fuel_paths(
    context: FieldContext,
    bundle: ModelBundle,
    residual_library: ResidualLibrary,
    common_draws: np.ndarray,
    driver_production_paths: np.ndarray,
    forecast_months: int,
    areas: list[str],
    paths: int,
    inference_batch_size: int,
    device: torch.device,
    seed: int,
) -> np.ndarray:
    production_history = np.repeat(
        context.panel.get(
            "fuel_driver_production", context.panel["production"]
        ).to_numpy(dtype=np.float32)[None, :],
        paths,
        axis=0,
    )
    fuel_history = np.repeat(
        context.panel["fuel"].to_numpy(dtype=np.float32)[None, :], paths, axis=0
    )
    observed_fuel = context.panel.loc[context.panel["has_fuel"], "fuel"].to_numpy(dtype=float)
    historical_fuel_scale = max(float(np.max(observed_fuel)) if len(observed_fuel) else 0.0, 0.05)
    historical_fuel_cap = max(
        float(np.quantile(observed_fuel, 0.995)) * 1.25 if len(observed_fuel) else 0.0,
        historical_fuel_scale,
    )
    historical_driver_peak = max(
        float(np.max(production_history[0])) if production_history.shape[1] else 0.0,
        0.001,
    )
    operating_threshold = historical_driver_peak * 0.01
    fixed_fuel_scale = np.full(paths, historical_fuel_scale, dtype=np.float32)
    output = np.zeros((paths, forecast_months), dtype=np.float32)
    rng = np.random.default_rng(seed)
    blocks = math.ceil(forecast_months / HORIZON)
    for block in range(blocks):
        block_start = block * HORIZON
        block_length = min(HORIZON, forecast_months - block_start)
        future_production = np.zeros((paths, HORIZON), dtype=np.float32)
        future_production[:, :block_length] = driver_production_paths[
            :, block_start : block_start + block_length
        ]
        if block_length < HORIZON:
            future_production[:, block_length:] = future_production[:, block_length - 1 : block_length]
        origin_date = add_months(context.global_cutoff, block_start)
        X, fuel_scale = fuel_feature_matrix(
            context,
            production_history,
            fuel_history,
            future_production,
            origin_date,
            areas,
            fixed_fuel_scale,
        )
        prediction_norm = predict_blocks(
            bundle.model, bundle.scaler, X, device, inference_batch_size
        )
        residual = common_draws[:, block] + draw_field_residuals(
            residual_library, context.key, paths, rng
        )
        prediction = apply_residuals(prediction_norm, residual) * fuel_scale[:, None]
        block_values = np.clip(
            prediction[:, :block_length], 0.0, historical_fuel_cap
        ).astype(np.float32)
        block_values[
            future_production[:, :block_length] <= operating_threshold
        ] = 0.0
        output[:, block_start : block_start + block_length] = block_values
        production_history = np.concatenate(
            [production_history, future_production[:, :block_length]], axis=1
        )
        fuel_history = np.concatenate([fuel_history, block_values], axis=1)
    return output

def quantile_columns(base: str, paths: np.ndarray) -> dict[str, np.ndarray]:
    quantiles = np.quantile(paths, QUANTILES, axis=0)
    return {
        f"{base}_{label}": quantiles[index]
        for index, label in enumerate(Q_LABELS)
    }

def forecast_frame(
    context: FieldContext,
    production_paths: np.ndarray,
    fuel_paths: np.ndarray,
    remaining_paths: np.ndarray,
    fuel_method: str,
    fuel_source_field: str,
    fuel_zero_from_month: str,
) -> pd.DataFrame:
    months = production_paths.shape[1]
    dates = pd.date_range(add_months(context.global_cutoff, 1), periods=months, freq="MS")
    production_quantiles = quantile_columns(FORECAST_PRODUCTION_COL, production_paths)
    fuel_quantiles = quantile_columns(FORECAST_FUEL_COL, fuel_paths)
    remaining_quantiles = quantile_columns("remaining_reserves_end_msm3oe", remaining_paths)
    frame = pd.DataFrame(
        {
            "month": dates.strftime("%Y-%m"),
            "date": dates,
            "variant": "global_mlp",
            "cutoff_month": context.global_cutoff.strftime("%Y-%m"),
            "remaining_reserves_start_msm3oe": float(context.panel["remaining"].iloc[-1]),
            FORECAST_PRODUCTION_COL: production_quantiles[f"{FORECAST_PRODUCTION_COL}_q50"],
            "remaining_reserves_end_msm3oe": remaining_quantiles[
                "remaining_reserves_end_msm3oe_q50"
            ],
            "production_was_clipped": False,
            FORECAST_FUEL_COL: fuel_quantiles[f"{FORECAST_FUEL_COL}_q50"],
            "fuel_gas_forecast_sm3": fuel_quantiles[f"{FORECAST_FUEL_COL}_q50"] * 1_000_000.0,
            "fuel_forecast_method": fuel_method,
            "fuel_source_field": fuel_source_field,
            "fuel_zero_from_month": fuel_zero_from_month,
            "fuel_zero_override_applied": (
                dates >= pd.Timestamp(fuel_zero_from_month)
                if fuel_zero_from_month
                else np.zeros(months, dtype=bool)
            ),
            **production_quantiles,
            **fuel_quantiles,
            **remaining_quantiles,
        }
    )
    return frame

