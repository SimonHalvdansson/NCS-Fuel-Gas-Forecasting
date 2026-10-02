"""Fuel-boundary registry and host/tieback production accounting."""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .config import FUTURE_FUEL_OVERRIDES, ROOT
from .data_io import InputData
from .features import FieldContext

HOST_FIELD_ALIASES = {
    "EKOFISK CENTRE": "EKOFISK",
    "EKOFISK COMPLEX": "EKOFISK",
    "NORNE FPSO": "NORNE",
    "NJORD A": "NJORD",
    "TROLL C": "TROLL",
    "ALVHEIM FPSO": "ALVHEIM",
    "GULLFAKS A AND C": "GULLFAKS",
    "GULLFAKS C": "GULLFAKS",
    "ÅSGARD A": "ÅSGARD",
    "ÅSGARD B": "ÅSGARD",
    "SLEIPNER A": "SLEIPNER ØST",
    "SLEIPNER T": "SLEIPNER ØST",
    "STATFJORD C": "STATFJORD",
    "SNORRE A": "SNORRE",
    "SKARV FPSO": "SKARV",
    "RINGHORNE AND BALDER AREA": "BALDER",
}

def registry_text(value: object) -> str:
    if value is None or pd.isna(value):
        return ""
    return str(value).strip()

def resolve_host_field_key(
    host: str,
    contexts: dict[str, FieldContext],
    require_fuel_history: bool = True,
) -> str:
    normalized = str(host or "").strip().upper()
    candidate = HOST_FIELD_ALIASES.get(normalized, normalized)
    if candidate not in contexts:
        return ""
    if require_fuel_history and not contexts[candidate].has_fuel_history:
        return ""
    return candidate

def resolve_fuel_accounting_paths(registry: pd.DataFrame) -> pd.DataFrame:
    """Resolve direct supplier chains to the ultimate reported-fuel boundary."""
    registry = registry.copy()
    rows = registry.set_index("field_key").to_dict("index")

    def ultimate_boundary(field_key: str) -> str:
        row = rows.get(field_key, {})
        if registry_text(row.get("fuel_forecast_method")) == "reported_conditioned_mlp":
            return field_key
        current = registry_text(row.get("supplied_by_field_key"))
        visited = {field_key}
        while current:
            if current in visited:
                return ""
            visited.add(current)
            current_row = rows.get(current)
            if current_row is None:
                return ""
            if registry_text(current_row.get("fuel_forecast_method")) == "reported_conditioned_mlp":
                return current
            current = registry_text(current_row.get("supplied_by_field_key"))
        return ""

    registry["fuel_accounted_field_key"] = [
        ultimate_boundary(str(field_key)) for field_key in registry["field_key"]
    ]
    return registry

def build_power_registry(
    data: InputData,
    contexts: dict[str, FieldContext],
    output_dir: Path,
) -> pd.DataFrame:
    overrides = pd.read_csv(ROOT / "forecasting" / "fuel_power_overrides.csv")
    overrides["field_key"] = overrides["field"].astype(str).str.strip().str.upper()
    override_by_field = overrides.set_index("field_key").to_dict("index")
    future_overrides = (
        pd.read_csv(FUTURE_FUEL_OVERRIDES)
        if FUTURE_FUEL_OVERRIDES.exists()
        else pd.DataFrame(columns=["field"])
    )
    future_overrides["field_key"] = future_overrides["field"].astype(str).str.strip().str.upper()
    future_by_field = future_overrides.set_index("field_key").to_dict("index")
    existing_path = ROOT / "webapp" / "power_sources.json"
    existing = json.loads(existing_path.read_text(encoding="utf-8")) if existing_path.exists() else {}
    research_index_path = ROOT / "research" / "index.csv"
    research_index = pd.read_csv(research_index_path) if research_index_path.exists() else pd.DataFrame()
    research_by_field = (
        research_index.assign(field_key=research_index["field"].astype(str).str.strip().str.upper())
        .set_index("field_key")
        .to_dict("index")
        if not research_index.empty
        else {}
    )
    rows: list[dict[str, object]] = []
    for key, context in contexts.items():
        override = override_by_field.get(key, {})
        future_override = future_by_field.get(key, {})
        power = existing.get(key, existing.get(context.field, {}))
        research = research_by_field.get(key, {})
        fact_page = ""
        research_json_path = research.get("research_json")
        if research_json_path:
            path = ROOT / str(research_json_path)
            if path.exists():
                try:
                    fact_page = json.loads(path.read_text(encoding="utf-8")).get("field", {}).get("fact_page", "")
                except (json.JSONDecodeError, OSError):
                    fact_page = ""
        override_method = registry_text(override.get("fuel_treatment"))
        if override and override_method == "external_power_zero":
            method = override_method
            expected = str(override.get("field_level_fuel_expected", "no"))
            host = str(override.get("host", ""))
            classification = str(override.get("power_source_class", "external_power"))
            confidence = str(override.get("confidence", "medium"))
            notes = str(override.get("notes", ""))
        elif context.has_fuel_history:
            method = "reported_conditioned_mlp"
            expected = "yes"
            host = context.field
            classification = power.get("classification", "reported_field_fuel")
            confidence = power.get("confidence", "high")
            notes = "Numeric field fuel history is available; forecast with the conditioned fuel MLP."
        elif override:
            method = override_method or "external_power_zero"
            expected = str(override.get("field_level_fuel_expected", "no"))
            host = str(override.get("host", ""))
            classification = str(override.get("power_source_class", "external_power"))
            confidence = str(override.get("confidence", "medium"))
            notes = str(override.get("notes", ""))
        elif context.is_shut_down:
            method = "excluded_shutdown"
            expected = "unknown"
            host = ""
            classification = power.get("classification", "historical_or_unknown")
            confidence = power.get("confidence", "not_assessed")
            notes = "Shut-down field: retained in the registry but excluded from forward forecasting."
        else:
            method = "unresolved_not_imputed"
            expected = "unknown"
            host = ""
            classification = power.get("classification", "unknown")
            confidence = "low"
            notes = "No defensible field-level fuel boundary was found; no fuel is imputed."
        source_url = power.get("source_url", "") or fact_page
        source_title = power.get("source_title", "") or (
            f"SODIR FactPages — {context.field}" if source_url else ""
        )
        secondary_source = ""
        if classification in {"power_from_shore", "host_supplied_shore_power"}:
            secondary_source = "https://www.sodir.no/en/whats-new/publications/reports/power-from-shore/fields-with-power-to-shore/"
        elif "gas_power" in classification:
            secondary_source = "https://www.sodir.no/en/whats-new/publications/reports/power-from-shore/resource-consequences/"
        rows.append(
            {
                "field_key": key,
                "field": context.field,
                "activity_status": context.status,
                "has_numeric_fuel_history": context.has_fuel_history,
                "field_level_fuel_expected": expected,
                "fuel_forecast_method": method,
                "fuel_is_inferred": False,
                "host_or_source_field": host,
                "supplied_by_field_key": (
                    "" if method == "reported_conditioned_mlp"
                    else resolve_host_field_key(host, contexts, require_fuel_history=False)
                ),
                "fuel_accounted_field_key": "",
                "fuel_zero_from_month": registry_text(future_override.get("fuel_zero_from_month")),
                "future_power_source_class": registry_text(future_override.get("future_power_source_class")),
                "future_transition_source_url": registry_text(future_override.get("source_url")),
                "future_transition_notes": registry_text(future_override.get("notes")),
                "power_source_class": classification,
                "confidence": confidence,
                "source_url": source_url,
                "source_title": source_title,
                "secondary_source_url": secondary_source,
                "evidence_summary": power.get("evidence", "") or notes,
                "verified_on": "2026-08-04",
                "series_scope": "field",
            }
        )
    context_keys = set(contexts)
    for key in data.production_field_order:
        if key in context_keys:
            continue
        production = data.production[data.production["field_key"] == key]
        name = (
            str(production["display_name"].dropna().iloc[0])
            if not production["display_name"].dropna().empty
            else key
        )
        meta = data.meta.get(key)
        official_field = meta is not None and any([meta.operator, meta.status, meta.main_area])
        override = override_by_field.get(key, {})
        future_override = future_by_field.get(key, {})
        research = research_by_field.get(key, {})
        fact_page = ""
        research_json_path = research.get("research_json")
        if research_json_path and (ROOT / str(research_json_path)).exists():
            try:
                fact_page = json.loads(
                    (ROOT / str(research_json_path)).read_text(encoding="utf-8")
                ).get("field", {}).get("fact_page", "")
            except (json.JSONDecodeError, OSError):
                fact_page = ""
        rows.append(
            {
                "field_key": key,
                "field": name,
                "activity_status": (meta.status or "Unknown") if official_field else "Non-field production series",
                "has_numeric_fuel_history": False,
                "field_level_fuel_expected": "not_applicable",
                "fuel_forecast_method": "excluded_no_numeric_production" if official_field else "excluded_non_field_series",
                "fuel_is_inferred": False,
                "host_or_source_field": str(override.get("host", "")),
                "supplied_by_field_key": resolve_host_field_key(
                    str(override.get("host", "")), contexts, require_fuel_history=False
                ),
                "fuel_accounted_field_key": "",
                "fuel_zero_from_month": registry_text(future_override.get("fuel_zero_from_month")),
                "future_power_source_class": registry_text(future_override.get("future_power_source_class")),
                "future_transition_source_url": registry_text(future_override.get("source_url")),
                "future_transition_notes": registry_text(future_override.get("notes")),
                "power_source_class": str(override.get("power_source_class", "not_applicable")),
                "confidence": str(override.get("confidence", "high")),
                "source_url": fact_page,
                "source_title": f"SODIR FactPages — {name}" if fact_page else "",
                "secondary_source_url": "",
                "evidence_summary": (
                    "The source contains no numeric oil-equivalent production history, so a production-conditioned fuel forecast cannot yet be started. "
                    + str(override.get("notes", ""))
                    if official_field
                    else "Production series is not a field in the official field metadata and is excluded from the field forecast universe."
                ),
                "verified_on": "2026-08-04",
                "series_scope": "field_without_numeric_production" if official_field else "discovery_or_test_series",
            }
        )
    registry = pd.DataFrame(rows).sort_values(["series_scope", "field"]).reset_index(drop=True)
    registry = resolve_fuel_accounting_paths(registry)
    registry.to_csv(output_dir / "fuel_power_classification.csv", index=False)
    return registry

def attach_fuel_driver_production(
    contexts: dict[str, FieldContext], registry: pd.DataFrame
) -> dict[str, list[str]]:
    """Attach own plus hosted-satellite production to each reported fuel field."""
    reported_keys = set(
        registry.loc[
            registry["fuel_forecast_method"].eq("reported_conditioned_mlp"),
            "field_key",
        ].astype(str)
    )
    served: dict[str, list[str]] = {
        key: [key] for key in reported_keys if key in contexts
    }
    registry_by_key = registry.set_index("field_key")
    for satellite_key, row in registry_by_key.iterrows():
        host_key = str(row.get("fuel_accounted_field_key", "") or "")
        if host_key and host_key != satellite_key and satellite_key in contexts:
            served.setdefault(host_key, [host_key]).append(satellite_key)
    for host_key, field_keys in served.items():
        host = contexts[host_key]
        dates = pd.DatetimeIndex(host.panel["date"])
        driver = np.zeros(len(dates), dtype=float)
        observed = np.zeros(len(dates), dtype=bool)
        for field_key in field_keys:
            context = contexts[field_key]
            production = context.panel.set_index("date")["production"].reindex(dates, fill_value=0.0)
            flags = context.panel.set_index("date")["has_production"].reindex(dates, fill_value=False)
            driver += production.to_numpy(dtype=float)
            observed |= flags.to_numpy(dtype=bool)
        host.panel["fuel_driver_production"] = driver
        host.panel["has_fuel_driver_production"] = observed
    return served

