"""Load and normalize source data for the forecasting workflow."""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"

PRODUCTION_FILE = "saleable_production.csv"
CONSUMPTION_FILE = "consumption.csv"
FIELDS_META_FILE = "fields_meta.xlsx"
REMAINING_RESERVES_FILE = "remaining_reserves.xlsx"

PRODUCTION_COL = "production_msm3oe"
FUEL_GAS_COL = "fuel_gas_sm3"
FUEL_GAS_DISPLAY_SCALE = 1_000_000.0
RESERVES_COL = "remaining_reserves_msm3oe"


@dataclass(frozen=True)
class FieldMeta:
    display_name: str
    operator: str | None = None
    status: str | None = None
    main_area: str | None = None


@dataclass(frozen=True)
class InputData:
    production: pd.DataFrame
    consumption: pd.DataFrame
    reserves: pd.DataFrame
    combined: pd.DataFrame
    meta: dict[str, FieldMeta]
    field_order: list[str]
    production_field_order: list[str]


def field_key(value: object) -> str:
    text = str(value or "").strip().upper()
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", text)


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = normalized.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9]+", "-", ascii_value).strip("-").lower()
    return cleaned or "field"


def clean_optional(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    text = str(value).strip()
    if not text or text.lower() == "nan":
        return None
    return text


def fuel_gas_msm3(values: pd.Series | np.ndarray) -> pd.Series | np.ndarray:
    return values / FUEL_GAS_DISPLAY_SCALE


def month_start(year: pd.Series, month: pd.Series) -> pd.Series:
    return pd.to_datetime(
        {
            "year": year.astype(int),
            "month": month.astype(int),
            "day": 1,
        }
    )


def read_csv(path: Path, cols: list[str]) -> pd.DataFrame:
    return pd.read_csv(path, usecols=cols, na_values=[" ", ""])


def load_production(data_dir: Path) -> pd.DataFrame:
    df = read_csv(
        data_dir / PRODUCTION_FILE,
        ["name", "npdId", "year", "month", "oilEquivalent"],
    )
    df = df.dropna(subset=["name", "year", "month"]).copy()
    df["field_key"] = df["name"].map(field_key)
    df["display_name"] = df["name"].astype(str).str.strip()
    df["year"] = pd.to_numeric(df["year"], errors="coerce")
    df["month"] = pd.to_numeric(df["month"], errors="coerce")
    df["oilEquivalent"] = pd.to_numeric(df["oilEquivalent"], errors="coerce")
    df = df.dropna(subset=["field_key", "year", "month"]).copy()
    df["year"] = df["year"].astype(int)
    df["month"] = df["month"].astype(int)
    df["date"] = month_start(df["year"], df["month"])
    df[PRODUCTION_COL] = df["oilEquivalent"].clip(lower=0) / 1_000_000.0
    return (
        df.groupby(["field_key", "date", "year", "month"], as_index=False)
        .agg(
            **{
                PRODUCTION_COL: pd.NamedAgg(
                    column=PRODUCTION_COL,
                    aggfunc=lambda values: values.sum(min_count=1),
                ),
                "display_name": pd.NamedAgg(column="display_name", aggfunc="first"),
            }
        )
        .sort_values(["field_key", "date"])
    )


def load_consumption(data_dir: Path) -> pd.DataFrame:
    df = read_csv(
        data_dir / CONSUMPTION_FILE,
        ["name", "npdId", "year", "month", "fuelGas"],
    )
    df = df.dropna(subset=["name", "year", "month"]).copy()
    df["field_key"] = df["name"].map(field_key)
    df["display_name"] = df["name"].astype(str).str.strip()
    df["year"] = pd.to_numeric(df["year"], errors="coerce")
    df["month"] = pd.to_numeric(df["month"], errors="coerce")
    df["fuelGas"] = pd.to_numeric(df["fuelGas"], errors="coerce")
    df = df.dropna(subset=["field_key", "year", "month"]).copy()
    df["year"] = df["year"].astype(int)
    df["month"] = df["month"].astype(int)
    df["date"] = month_start(df["year"], df["month"])
    df[FUEL_GAS_COL] = df["fuelGas"].clip(lower=0)
    return (
        df.groupby(["field_key", "date", "year", "month"], as_index=False)
        .agg(
            **{
                FUEL_GAS_COL: pd.NamedAgg(
                    column=FUEL_GAS_COL,
                    aggfunc=lambda values: values.sum(min_count=1),
                ),
                "display_name": pd.NamedAgg(column="display_name", aggfunc="first"),
            }
        )
        .sort_values(["field_key", "date"])
    )


def load_field_meta(data_dir: Path) -> dict[str, FieldMeta]:
    path = data_dir / FIELDS_META_FILE
    if not path.exists():
        return {}
    df = pd.read_excel(path)
    if "Field name" not in df.columns:
        return {}
    out: dict[str, FieldMeta] = {}
    for row in df.to_dict("records"):
        display_name = clean_optional(row.get("Field name"))
        if not display_name:
            continue
        out[field_key(display_name)] = FieldMeta(
            display_name=display_name,
            operator=clean_optional(row.get("Operator name")),
            status=clean_optional(row.get("Current activity status")),
            main_area=clean_optional(row.get("Main area")),
        )
    return out


def load_remaining_reserves(data_dir: Path) -> pd.DataFrame:
    path = data_dir / REMAINING_RESERVES_FILE
    if not path.exists():
        return pd.DataFrame(columns=["field_key", "date", RESERVES_COL])
    df = pd.read_excel(path)
    required = {"Field name", "Updated date", "Remaining oil eq. [mill Sm3 o.e]"}
    if not required.issubset(df.columns):
        return pd.DataFrame(columns=["field_key", "date", RESERVES_COL])
    df = df.rename(
        columns={
            "Field name": "field",
            "Updated date": "updated_date",
            "Remaining oil eq. [mill Sm3 o.e]": RESERVES_COL,
        }
    )
    df = df.dropna(subset=["field", "updated_date"]).copy()
    df["field_key"] = df["field"].map(field_key)
    df["date"] = pd.to_datetime(df["updated_date"], errors="coerce", utc=True).dt.tz_localize(None)
    df[RESERVES_COL] = pd.to_numeric(df[RESERVES_COL], errors="coerce")
    df = df.dropna(subset=["field_key", "date", RESERVES_COL]).copy()
    df["date"] = df["date"].dt.to_period("M").dt.to_timestamp()
    df[RESERVES_COL] = df[RESERVES_COL].clip(lower=0)
    return (
        df.sort_values(["field_key", "date"])
        .groupby(["field_key", "date"], as_index=False)[RESERVES_COL]
        .last()
    )


def interpolate_reserves_for_dates(
    field_dates: pd.Series,
    field_reserves: pd.DataFrame,
) -> pd.DataFrame:
    dates = pd.DatetimeIndex(field_dates.dropna().sort_values().unique())
    if len(dates) == 0:
        return pd.DataFrame(columns=["date", RESERVES_COL])
    if field_reserves.empty:
        return pd.DataFrame({"date": dates, RESERVES_COL: np.nan})
    samples = (
        field_reserves.dropna(subset=["date", RESERVES_COL])
        .sort_values("date")
        .drop_duplicates("date", keep="last")
        .set_index("date")[RESERVES_COL]
    )
    index = samples.index.union(dates).sort_values()
    interpolated = samples.reindex(index).interpolate(method="time", limit_area="inside")
    return pd.DataFrame(
        {"date": dates, RESERVES_COL: interpolated.reindex(dates).to_numpy()}
    )


def add_interpolated_reserves(
    combined: pd.DataFrame,
    reserves: pd.DataFrame,
) -> pd.DataFrame:
    if combined.empty:
        combined[RESERVES_COL] = np.nan
        return combined
    parts = []
    for key, field_df in combined.groupby("field_key", sort=False):
        field_df = field_df.copy()
        reserve_values = interpolate_reserves_for_dates(
            field_df["date"],
            reserves[reserves["field_key"] == key],
        )
        parts.append(field_df.merge(reserve_values, on="date", how="left"))
    return pd.concat(parts, ignore_index=True).sort_values(["field_key", "date"])


def combine_inputs(
    production: pd.DataFrame,
    consumption: pd.DataFrame,
) -> pd.DataFrame:
    prod = production.drop(columns=["display_name"], errors="ignore")
    cons = consumption.drop(columns=["display_name"], errors="ignore")
    return prod.merge(
        cons,
        on=["field_key", "date", "year", "month"],
        how="outer",
    ).sort_values(["field_key", "date"])


def choose_display_names(
    production: pd.DataFrame,
    consumption: pd.DataFrame,
    meta: dict[str, FieldMeta],
) -> dict[str, str]:
    names: dict[str, str] = {key: value.display_name for key, value in meta.items()}
    for frame in [consumption, production]:
        for key, group in frame.groupby("field_key", sort=False):
            names.setdefault(key, str(group["display_name"].dropna().iloc[0]))
    return names


def load_inputs(data_dir: Path) -> InputData:
    production = load_production(data_dir)
    consumption = load_consumption(data_dir)
    reserves = load_remaining_reserves(data_dir)
    meta = load_field_meta(data_dir)
    combined = add_interpolated_reserves(
        combine_inputs(production, consumption),
        reserves,
    )
    display_names = choose_display_names(production, consumption, meta)
    production_fields = set(production["field_key"].unique())
    field_order = [
        key
        for key in consumption["field_key"].dropna().unique().tolist()
        if key in production_fields
        and combined.loc[
            combined["field_key"] == key,
            [PRODUCTION_COL, FUEL_GAS_COL],
        ]
        .notna()
        .any()
        .all()
    ]
    field_order.sort(key=lambda key: display_names.get(key, key))
    production_field_order = production["field_key"].dropna().unique().tolist()
    production_field_order.sort(key=lambda key: display_names.get(key, key))
    for key, name in display_names.items():
        if key not in meta:
            meta[key] = FieldMeta(display_name=name)
    return InputData(
        production=production,
        consumption=consumption,
        reserves=reserves,
        combined=combined,
        meta=meta,
        field_order=field_order,
        production_field_order=production_field_order,
    )
