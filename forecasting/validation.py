"""Held-out metrics and empirical residual libraries for uncertainty."""

from dataclasses import dataclass

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import mean_absolute_error, mean_squared_error

from .common import rmsle, smape
from .config import HORIZON
from .features import BlockSamples
from .models import ModelBundle, predict_blocks

@dataclass
class ResidualLibrary:
    common_blocks: np.ndarray
    idiosyncratic_blocks: np.ndarray
    field_blocks: dict[str, np.ndarray]

def validation_metrics(
    samples: BlockSamples,
    validation_indices: np.ndarray,
    bundle: ModelBundle,
    device: torch.device,
) -> tuple[pd.DataFrame, np.ndarray]:
    prediction_norm = predict_blocks(
        bundle.validation_model,
        bundle.validation_scaler,
        samples.X[validation_indices],
        device,
        bundle.config.batch_size,
    )
    prediction = prediction_norm * samples.scale[validation_indices, None]
    actual = samples.y_norm[validation_indices] * samples.scale[validation_indices, None]
    metadata = samples.meta.iloc[validation_indices].reset_index(drop=True)
    rows: list[dict[str, object]] = []
    for field_key, group in metadata.groupby("field_key", sort=False):
        local = group.index.to_numpy(dtype=int)
        truth = actual[local].reshape(-1)
        forecast = prediction[local].reshape(-1)
        rows.append(
            {
                "field_key": field_key,
                "field": group["field"].iloc[0],
                "validation_samples": len(local),
                f"{samples.target_name}_rmse": float(np.sqrt(mean_squared_error(truth, forecast))),
                f"{samples.target_name}_mae": float(mean_absolute_error(truth, forecast)),
                f"{samples.target_name}_smape": smape(truth, forecast),
                f"{samples.target_name}_rmsle": rmsle(truth, forecast),
            }
        )
    return pd.DataFrame(rows), prediction_norm

def build_residual_library(
    samples: BlockSamples,
    validation_indices: np.ndarray,
    prediction_norm: np.ndarray,
) -> ResidualLibrary:
    actual_transformed = np.log1p(10.0 * np.maximum(samples.y_norm[validation_indices], 0.0))
    prediction_transformed = np.log1p(10.0 * np.maximum(prediction_norm, 0.0))
    residuals = (actual_transformed - prediction_transformed).astype(np.float32)
    metadata = samples.meta.iloc[validation_indices].reset_index(drop=True)
    common_by_origin: dict[pd.Timestamp, np.ndarray] = {}
    for origin_date, group in metadata.groupby("origin_date", sort=True):
        common_by_origin[pd.Timestamp(origin_date)] = residuals[
            group.index.to_numpy(dtype=int)
        ].mean(axis=0)
    if common_by_origin:
        common = np.stack(list(common_by_origin.values())).astype(np.float32)
        common_for_row = np.stack(
            [common_by_origin[pd.Timestamp(date)] for date in metadata["origin_date"]]
        )
        idiosyncratic = residuals - common_for_row
    else:
        common = np.zeros((1, HORIZON), dtype=np.float32)
        idiosyncratic = residuals
    field_blocks = {
        str(key): idiosyncratic[group.index.to_numpy(dtype=int)]
        for key, group in metadata.groupby("field_key", sort=False)
    }
    return ResidualLibrary(common, idiosyncratic.astype(np.float32), field_blocks)


