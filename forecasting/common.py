"""Small numerical and reproducibility helpers shared across forecasting modules."""

import random

import numpy as np
import pandas as pd
import torch

from .config import EPS

def set_reproducible(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)

def add_months(date: pd.Timestamp, months: int) -> pd.Timestamp:
    return pd.Timestamp(date) + pd.offsets.MonthBegin(months)

def safe_divide(numerator: float, denominator: float, fallback: float = 0.0) -> float:
    if not np.isfinite(numerator) or not np.isfinite(denominator) or abs(denominator) <= EPS:
        return fallback
    return float(numerator / denominator)

def smape(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    denominator = np.abs(y_true) + np.abs(y_pred) + EPS
    return float(np.mean(2.0 * np.abs(y_pred - y_true) / denominator))

def rmsle(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(
        np.sqrt(
            np.mean(
                (
                    np.log1p(np.maximum(np.asarray(y_pred, dtype=float), 0.0))
                    - np.log1p(np.maximum(np.asarray(y_true, dtype=float), 0.0))
                )
                ** 2
            )
        )
    )

