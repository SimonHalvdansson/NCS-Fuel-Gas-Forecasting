"""Field contexts, feature engineering, and rolling training samples."""

from dataclasses import dataclass
import math

import numpy as np
import pandas as pd

from .common import safe_divide
from .config import HORIZON, LOOKBACK
from .data_io import (
    FUEL_GAS_COL,
    PRODUCTION_COL,
    RESERVES_COL,
    FieldMeta,
    InputData,
    fuel_gas_msm3,
    slugify,
)

@dataclass
class FieldContext:
    key: str
    field: str
    slug: str
    meta: FieldMeta
    panel: pd.DataFrame
    reserves: pd.DataFrame
    status: str
    area: str
    latest_observed_production: pd.Timestamp
    global_cutoff: pd.Timestamp

    @property
    def is_shut_down(self) -> bool:
        return "shut" in self.status.casefold()

    @property
    def has_fuel_history(self) -> bool:
        return bool(self.panel["has_fuel"].any())

@dataclass
class BlockSamples:
    X: np.ndarray
    y_norm: np.ndarray
    scale: np.ndarray
    remaining_start: np.ndarray
    has_remaining: np.ndarray
    meta: pd.DataFrame
    feature_names: list[str]
    target_name: str

def estimate_remaining_series(panel: pd.DataFrame, reserves: pd.DataFrame) -> pd.Series:
    samples = (
        reserves.dropna(subset=["date", RESERVES_COL])
        .sort_values("date")
        .drop_duplicates("date", keep="last")
    )
    output: list[float] = []
    for index, date in enumerate(pd.to_datetime(panel["date"])):
        prior = samples[samples["date"] <= date]
        if prior.empty:
            output.append(float("nan"))
            continue
        latest = prior.iloc[-1]
        reserve_date = pd.Timestamp(latest["date"])
        produced = float(
            panel.loc[
                (panel["date"] > reserve_date) & (panel["date"] <= date),
                "production",
            ].sum()
        )
        output.append(max(float(latest[RESERVES_COL]) - produced, 0.0))
    return pd.Series(output, index=panel.index, dtype=float)

def build_contexts(data: InputData) -> dict[str, FieldContext]:
    global_cutoff = pd.Timestamp(data.production["date"].max())
    contexts: dict[str, FieldContext] = {}
    for key in data.production_field_order:
        meta = data.meta.get(key)
        if meta is None or not any([meta.operator, meta.status, meta.main_area]):
            continue
        source = data.combined[data.combined["field_key"] == key].sort_values("date")
        production_rows = source[source[PRODUCTION_COL].notna()]
        if production_rows.empty:
            continue
        start = pd.Timestamp(production_rows["date"].min())
        dates = pd.date_range(start, global_cutoff, freq="MS")
        grouped = source.groupby("date", sort=True)
        observed = pd.DataFrame({"date": sorted(source["date"].dropna().unique())})
        observed["production_raw"] = grouped[PRODUCTION_COL].sum(min_count=1).reindex(observed["date"]).to_numpy()
        observed["fuel_raw"] = grouped[FUEL_GAS_COL].sum(min_count=1).reindex(observed["date"]).to_numpy()
        panel = pd.DataFrame({"date": dates}).merge(observed, on="date", how="left")
        panel["has_production"] = panel["production_raw"].notna()
        panel["has_fuel"] = panel["fuel_raw"].notna()
        panel["production"] = panel["production_raw"].fillna(0.0).clip(lower=0.0)
        panel["fuel"] = fuel_gas_msm3(panel["fuel_raw"]).fillna(0.0).clip(lower=0.0)
        reserve_rows = data.reserves[data.reserves["field_key"] == key].copy()
        panel["remaining"] = estimate_remaining_series(panel, reserve_rows)
        panel["has_remaining"] = panel["remaining"].notna()
        contexts[key] = FieldContext(
            key=key,
            field=meta.display_name,
            slug=slugify(meta.display_name),
            meta=meta,
            panel=panel,
            reserves=reserve_rows,
            status=(meta.status or "Unknown").strip(),
            area=(meta.main_area or "Unknown").strip(),
            latest_observed_production=pd.Timestamp(production_rows["date"].max()),
            global_cutoff=global_cutoff,
        )
    return dict(sorted(contexts.items(), key=lambda item: item[1].field))

def areas_for(contexts: dict[str, FieldContext]) -> list[str]:
    return sorted({context.area for context in contexts.values()})

def production_feature_names(areas: list[str]) -> list[str]:
    names = [
        "month_sin",
        "month_cos",
        "age_years",
        "log_production_scale",
        "log_reserve_scale",
        "remaining_fraction",
        "depletion_fraction",
        "has_remaining",
        "prod_roll_3",
        "prod_roll_6",
        "prod_roll_12",
        "prod_trend_3",
        "prod_trend_12",
    ]
    for lag in (0, 1, 2, 3, 6, 12):
        names.extend([f"prod_lag_{lag}", f"prod_lag_{lag}_observed"])
    names.extend(f"area_{slugify(area)}" for area in areas)
    return names

def fuel_feature_names(areas: list[str]) -> list[str]:
    names = [
        "month_sin",
        "month_cos",
        "age_years",
        "log_production_scale",
        "log_fuel_scale",
        "prod_roll_3",
        "prod_roll_6",
        "prod_roll_12",
        "fuel_roll_3",
        "fuel_roll_6",
        "fuel_roll_12",
        "prod_trend_3",
        "prod_trend_12",
        "fuel_trend_3",
        "fuel_trend_12",
    ]
    for lag in (0, 1, 2, 3, 6, 12):
        names.extend([f"prod_lag_{lag}", f"fuel_lag_{lag}"])
    names.extend(f"future_prod_{month + 1}" for month in range(HORIZON))
    names.extend(f"area_{slugify(area)}" for area in areas)
    return names

def history_scale(values: np.ndarray, flags: np.ndarray, floor: float = 0.05) -> float:
    eligible = values[flags]
    return max(float(np.max(eligible)) if len(eligible) else 0.0, floor)

def rolling(values: np.ndarray, index: int, window: int) -> float:
    return float(np.mean(values[max(0, index - window + 1) : index + 1]))

def lag(values: np.ndarray, index: int, months: int) -> float:
    return float(values[index - months]) if index - months >= 0 else 0.0

def production_feature_row(
    context: FieldContext,
    panel: pd.DataFrame,
    origin_index: int,
    areas: list[str],
) -> tuple[np.ndarray, float]:
    production = panel["production"].to_numpy(dtype=float)
    flags = panel["has_production"].to_numpy(dtype=bool)
    scale = history_scale(production[: origin_index + 1], flags[: origin_index + 1])
    remaining_raw = float(panel.loc[origin_index, "remaining"])
    remaining = remaining_raw if np.isfinite(remaining_raw) else 0.0
    cumulative = float(np.sum(production[: origin_index + 1]))
    reserve_scale = max(remaining + cumulative, scale * 24.0, 1.0)
    date = pd.Timestamp(panel.loc[origin_index, "date"])
    values: dict[str, float] = {
        "month_sin": math.sin(2 * math.pi * date.month / 12),
        "month_cos": math.cos(2 * math.pi * date.month / 12),
        "age_years": origin_index / 12.0,
        "log_production_scale": math.log1p(scale),
        "log_reserve_scale": math.log1p(reserve_scale),
        "remaining_fraction": safe_divide(remaining, reserve_scale),
        "depletion_fraction": safe_divide(cumulative, cumulative + remaining),
        "has_remaining": float(np.isfinite(remaining_raw)),
        "prod_roll_3": rolling(production, origin_index, 3) / scale,
        "prod_roll_6": rolling(production, origin_index, 6) / scale,
        "prod_roll_12": rolling(production, origin_index, 12) / scale,
        "prod_trend_3": (lag(production, origin_index, 0) - lag(production, origin_index, 3)) / scale,
        "prod_trend_12": (lag(production, origin_index, 0) - lag(production, origin_index, 12)) / scale,
    }
    for months in (0, 1, 2, 3, 6, 12):
        values[f"prod_lag_{months}"] = lag(production, origin_index, months) / scale
        flag_index = origin_index - months
        values[f"prod_lag_{months}_observed"] = float(flag_index >= 0 and flags[flag_index])
    for area in areas:
        values[f"area_{slugify(area)}"] = float(context.area == area)
    names = production_feature_names(areas)
    return np.array([values[name] for name in names], dtype=np.float32), scale

def fuel_feature_row(
    context: FieldContext,
    panel: pd.DataFrame,
    origin_index: int,
    future_production: np.ndarray,
    areas: list[str],
) -> tuple[np.ndarray, float]:
    production = panel.get("fuel_driver_production", panel["production"]).to_numpy(dtype=float)
    fuel = panel["fuel"].to_numpy(dtype=float)
    production_flags = panel.get(
        "has_fuel_driver_production", panel["has_production"]
    ).to_numpy(dtype=bool)
    fuel_flags = panel["has_fuel"].to_numpy(dtype=bool)
    production_scale = history_scale(
        production[: origin_index + 1], production_flags[: origin_index + 1]
    )
    fuel_scale = history_scale(fuel[: origin_index + 1], fuel_flags[: origin_index + 1])
    date = pd.Timestamp(panel.loc[origin_index, "date"])
    values: dict[str, float] = {
        "month_sin": math.sin(2 * math.pi * date.month / 12),
        "month_cos": math.cos(2 * math.pi * date.month / 12),
        "age_years": origin_index / 12.0,
        "log_production_scale": math.log1p(production_scale),
        "log_fuel_scale": math.log1p(fuel_scale),
        "prod_roll_3": rolling(production, origin_index, 3) / production_scale,
        "prod_roll_6": rolling(production, origin_index, 6) / production_scale,
        "prod_roll_12": rolling(production, origin_index, 12) / production_scale,
        "fuel_roll_3": rolling(fuel, origin_index, 3) / fuel_scale,
        "fuel_roll_6": rolling(fuel, origin_index, 6) / fuel_scale,
        "fuel_roll_12": rolling(fuel, origin_index, 12) / fuel_scale,
        "prod_trend_3": (lag(production, origin_index, 0) - lag(production, origin_index, 3)) / production_scale,
        "prod_trend_12": (lag(production, origin_index, 0) - lag(production, origin_index, 12)) / production_scale,
        "fuel_trend_3": (lag(fuel, origin_index, 0) - lag(fuel, origin_index, 3)) / fuel_scale,
        "fuel_trend_12": (lag(fuel, origin_index, 0) - lag(fuel, origin_index, 12)) / fuel_scale,
    }
    for months in (0, 1, 2, 3, 6, 12):
        values[f"prod_lag_{months}"] = lag(production, origin_index, months) / production_scale
        values[f"fuel_lag_{months}"] = lag(fuel, origin_index, months) / fuel_scale
    for month, value in enumerate(np.asarray(future_production, dtype=float)):
        values[f"future_prod_{month + 1}"] = float(value) / production_scale
    for area in areas:
        values[f"area_{slugify(area)}"] = float(context.area == area)
    names = fuel_feature_names(areas)
    return np.array([values[name] for name in names], dtype=np.float32), fuel_scale

def empty_samples(feature_names: list[str], target_name: str) -> BlockSamples:
    return BlockSamples(
        X=np.zeros((0, len(feature_names)), dtype=np.float32),
        y_norm=np.zeros((0, HORIZON), dtype=np.float32),
        scale=np.zeros(0, dtype=np.float32),
        remaining_start=np.zeros(0, dtype=np.float32),
        has_remaining=np.zeros(0, dtype=np.float32),
        meta=pd.DataFrame(),
        feature_names=feature_names,
        target_name=target_name,
    )

def build_production_samples(
    contexts: dict[str, FieldContext], areas: list[str]
) -> BlockSamples:
    feature_names = production_feature_names(areas)
    X_rows: list[np.ndarray] = []
    y_rows: list[np.ndarray] = []
    scales: list[float] = []
    remaining: list[float] = []
    has_remaining: list[float] = []
    meta_rows: list[dict[str, object]] = []
    for context in contexts.values():
        panel = context.panel
        for origin in range(LOOKBACK - 1, len(panel) - HORIZON):
            target = panel.iloc[origin + 1 : origin + 1 + HORIZON]
            if len(target) != HORIZON or not target["has_production"].all():
                continue
            X, scale = production_feature_row(context, panel, origin, areas)
            X_rows.append(X)
            y_rows.append((target["production"].to_numpy(dtype=float) / scale).astype(np.float32))
            scales.append(scale)
            value = float(panel.loc[origin, "remaining"])
            remaining.append(value if np.isfinite(value) else 0.0)
            has_remaining.append(float(np.isfinite(value)))
            meta_rows.append(
                {
                    "field_key": context.key,
                    "field": context.field,
                    "origin_date": panel.loc[origin, "date"],
                    "origin_index": origin,
                    "target_start": target["date"].iloc[0],
                    "target_end": target["date"].iloc[-1],
                }
            )
    if not X_rows:
        return empty_samples(feature_names, "production")
    return BlockSamples(
        X=np.vstack(X_rows).astype(np.float32),
        y_norm=np.stack(y_rows).astype(np.float32),
        scale=np.asarray(scales, dtype=np.float32),
        remaining_start=np.asarray(remaining, dtype=np.float32),
        has_remaining=np.asarray(has_remaining, dtype=np.float32),
        meta=pd.DataFrame(meta_rows),
        feature_names=feature_names,
        target_name="production",
    )

def build_fuel_samples(
    contexts: dict[str, FieldContext],
    areas: list[str],
    eligible_field_keys: set[str] | None = None,
) -> BlockSamples:
    feature_names = fuel_feature_names(areas)
    X_rows: list[np.ndarray] = []
    y_rows: list[np.ndarray] = []
    scales: list[float] = []
    meta_rows: list[dict[str, object]] = []
    for context in contexts.values():
        if not context.has_fuel_history or (
            eligible_field_keys is not None and context.key not in eligible_field_keys
        ):
            continue
        panel = context.panel
        for origin in range(LOOKBACK - 1, len(panel) - HORIZON):
            target = panel.iloc[origin + 1 : origin + 1 + HORIZON]
            if len(target) != HORIZON:
                continue
            if not target["has_fuel"].all():
                continue
            future_production = target.get(
                "fuel_driver_production", target["production"]
            ).to_numpy(dtype=float)
            X, scale = fuel_feature_row(context, panel, origin, future_production, areas)
            X_rows.append(X)
            y_rows.append((target["fuel"].to_numpy(dtype=float) / scale).astype(np.float32))
            scales.append(scale)
            meta_rows.append(
                {
                    "field_key": context.key,
                    "field": context.field,
                    "origin_date": panel.loc[origin, "date"],
                    "origin_index": origin,
                    "target_start": target["date"].iloc[0],
                    "target_end": target["date"].iloc[-1],
                }
            )
    if not X_rows:
        return empty_samples(feature_names, "fuel")
    length = len(X_rows)
    return BlockSamples(
        X=np.vstack(X_rows).astype(np.float32),
        y_norm=np.stack(y_rows).astype(np.float32),
        scale=np.asarray(scales, dtype=np.float32),
        remaining_start=np.zeros(length, dtype=np.float32),
        has_remaining=np.zeros(length, dtype=np.float32),
        meta=pd.DataFrame(meta_rows),
        feature_names=feature_names,
        target_name="fuel",
    )

