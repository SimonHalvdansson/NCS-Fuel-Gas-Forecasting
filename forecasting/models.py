"""MLP architecture, scaling, fitting, and deterministic block prediction."""

import copy
from dataclasses import dataclass
import math

import numpy as np
import pandas as pd
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from .common import set_reproducible
from .config import HORIZON
from .features import BlockSamples

@dataclass
class Standardizer:
    mean: np.ndarray
    scale: np.ndarray

    @classmethod
    def fit(cls, X: np.ndarray) -> "Standardizer":
        mean = np.nanmean(X, axis=0)
        scale = np.nanstd(X, axis=0)
        mean = np.where(np.isfinite(mean), mean, 0.0)
        scale = np.where(np.isfinite(scale) & (scale > 1e-6), scale, 1.0)
        return cls(mean.astype(np.float32), scale.astype(np.float32))

    def transform(self, X: np.ndarray) -> np.ndarray:
        clean = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
        return ((clean - self.mean) / self.scale).astype(np.float32)

@dataclass
class ModelConfig:
    hidden_sizes: tuple[int, ...]
    dropout: float
    lr: float
    weight_decay: float
    max_epochs: int
    patience: int
    batch_size: int
    reserve_penalty_weight: float = 0.0

@dataclass
class ModelBundle:
    name: str
    model: nn.Module
    scaler: Standardizer
    validation_model: nn.Module
    validation_scaler: Standardizer
    best_epoch: int
    config: ModelConfig
    log: pd.DataFrame

class BlockMLP(nn.Module):
    def __init__(
        self,
        input_dim: int,
        hidden_sizes: tuple[int, ...],
        dropout: float,
        horizon: int = HORIZON,
    ) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        previous = input_dim
        for hidden in hidden_sizes:
            layers.extend([nn.Linear(previous, hidden), nn.ReLU(), nn.LayerNorm(hidden)])
            if dropout:
                layers.append(nn.Dropout(dropout))
            previous = hidden
        layers.append(nn.Linear(previous, horizon))
        self.net = nn.Sequential(*layers)
        self.softplus = nn.Softplus()

    def forward(self, X: torch.Tensor) -> torch.Tensor:
        return self.softplus(self.net(X))

def time_split_indices(
    samples: BlockSamples, validation_share: float
) -> tuple[np.ndarray, np.ndarray]:
    train: list[int] = []
    validation: list[int] = []
    for _, group in samples.meta.groupby("field_key", sort=False):
        ordered = group.sort_values("origin_date")
        indices = ordered.index.to_numpy(dtype=int)
        if len(indices) < 4:
            train.extend(indices.tolist())
            continue
        validation_count = max(1, min(int(math.ceil(len(indices) * validation_share)), len(indices) // 3))
        validation_indices = indices[-validation_count:]
        first_validation_origin = pd.Timestamp(samples.meta.loc[validation_indices[0], "origin_date"])
        train_cutoff = first_validation_origin - pd.DateOffset(months=HORIZON)
        training_indices = ordered.loc[
            pd.to_datetime(ordered["origin_date"]) < train_cutoff
        ].index.to_numpy(dtype=int)
        if len(training_indices) < 2:
            train.extend(indices.tolist())
            continue
        train.extend(training_indices.tolist())
        validation.extend(validation_indices.tolist())
    return np.asarray(train, dtype=int), np.asarray(validation, dtype=int)

def tensor_dataset(
    samples: BlockSamples, indices: np.ndarray, scaler: Standardizer
) -> TensorDataset:
    return TensorDataset(
        torch.from_numpy(scaler.transform(samples.X[indices])),
        torch.from_numpy(samples.y_norm[indices].astype(np.float32)),
        torch.from_numpy(samples.scale[indices].astype(np.float32)),
        torch.from_numpy(samples.remaining_start[indices].astype(np.float32)),
        torch.from_numpy(samples.has_remaining[indices].astype(np.float32)),
    )

def forecast_loss(
    prediction: torch.Tensor,
    target: torch.Tensor,
    scale: torch.Tensor,
    remaining: torch.Tensor,
    has_remaining: torch.Tensor,
    reserve_penalty_weight: float,
) -> torch.Tensor:
    main = torch.mean(
        (torch.log1p(10.0 * prediction) - torch.log1p(10.0 * target)) ** 2
    )
    if reserve_penalty_weight <= 0:
        return main
    cumulative = torch.cumsum(prediction * scale[:, None], dim=1)
    overflow = torch.relu(cumulative - remaining[:, None])
    penalty = torch.mean(
        ((overflow / torch.clamp(remaining[:, None], min=1.0)) ** 2)
        * has_remaining[:, None]
    )
    return main + reserve_penalty_weight * penalty

def evaluate_model_loss(
    model: nn.Module,
    loader: DataLoader | None,
    config: ModelConfig,
    device: torch.device,
) -> float:
    if loader is None:
        return float("nan")
    model.eval()
    losses: list[float] = []
    with torch.inference_mode():
        for X, y, scale, remaining, has_remaining in loader:
            prediction = model(X.to(device))
            loss = forecast_loss(
                prediction,
                y.to(device),
                scale.to(device),
                remaining.to(device),
                has_remaining.to(device),
                config.reserve_penalty_weight,
            )
            losses.append(float(loss.detach().cpu()))
    return float(np.mean(losses)) if losses else float("nan")

def fit_early_stopping_model(
    samples: BlockSamples,
    train_indices: np.ndarray,
    validation_indices: np.ndarray,
    config: ModelConfig,
    seed: int,
    device: torch.device,
    name: str,
) -> tuple[nn.Module, Standardizer, pd.DataFrame, int]:
    set_reproducible(seed)
    scaler = Standardizer.fit(samples.X[train_indices])
    model = BlockMLP(
        samples.X.shape[1], config.hidden_sizes, config.dropout
    ).to(device)
    train_dataset = tensor_dataset(samples, train_indices, scaler)
    train_loader = DataLoader(
        train_dataset,
        batch_size=min(config.batch_size, len(train_dataset)),
        shuffle=True,
    )
    validation_loader = None
    if len(validation_indices):
        validation_dataset = tensor_dataset(samples, validation_indices, scaler)
        validation_loader = DataLoader(
            validation_dataset,
            batch_size=min(config.batch_size, len(validation_dataset)),
        )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=config.lr, weight_decay=config.weight_decay
    )
    best_state = copy.deepcopy(model.state_dict())
    best_loss = float("inf")
    best_epoch = 1
    stale = 0
    rows: list[dict[str, object]] = []
    for epoch in range(1, config.max_epochs + 1):
        model.train()
        batch_losses: list[float] = []
        for X, y, scale, remaining, has_remaining in train_loader:
            optimizer.zero_grad(set_to_none=True)
            prediction = model(X.to(device))
            loss = forecast_loss(
                prediction,
                y.to(device),
                scale.to(device),
                remaining.to(device),
                has_remaining.to(device),
                config.reserve_penalty_weight,
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            batch_losses.append(float(loss.detach().cpu()))
        train_loss = float(np.mean(batch_losses))
        validation_loss = evaluate_model_loss(model, validation_loader, config, device)
        score = validation_loss if np.isfinite(validation_loss) else train_loss
        rows.append(
            {
                "model": name,
                "epoch": epoch,
                "train_loss": train_loss,
                "val_loss": validation_loss,
            }
        )
        if score < best_loss - 1e-7:
            best_loss = score
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())
            stale = 0
        else:
            stale += 1
        if stale >= config.patience:
            break
    model.load_state_dict(best_state)
    return model, scaler, pd.DataFrame(rows), best_epoch

def refit_model(
    samples: BlockSamples,
    config: ModelConfig,
    seed: int,
    device: torch.device,
    epochs: int,
) -> tuple[nn.Module, Standardizer, pd.DataFrame]:
    indices = np.arange(len(samples.X), dtype=int)
    set_reproducible(seed)
    scaler = Standardizer.fit(samples.X)
    model = BlockMLP(
        samples.X.shape[1], config.hidden_sizes, config.dropout
    ).to(device)
    dataset = tensor_dataset(samples, indices, scaler)
    loader = DataLoader(
        dataset,
        batch_size=min(config.batch_size, len(dataset)),
        shuffle=True,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=config.lr, weight_decay=config.weight_decay
    )
    rows: list[dict[str, object]] = []
    for epoch in range(1, max(1, epochs) + 1):
        model.train()
        batch_losses: list[float] = []
        for X, y, scale, remaining, has_remaining in loader:
            optimizer.zero_grad(set_to_none=True)
            prediction = model(X.to(device))
            loss = forecast_loss(
                prediction,
                y.to(device),
                scale.to(device),
                remaining.to(device),
                has_remaining.to(device),
                config.reserve_penalty_weight,
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            batch_losses.append(float(loss.detach().cpu()))
        rows.append(
            {
                "model": "refit",
                "epoch": epoch,
                "train_loss": float(np.mean(batch_losses)),
                "val_loss": float("nan"),
            }
        )
    return model, scaler, pd.DataFrame(rows)

def train_bundle(
    samples: BlockSamples,
    config: ModelConfig,
    validation_share: float,
    seed: int,
    device: torch.device,
    name: str,
) -> tuple[ModelBundle, np.ndarray, np.ndarray]:
    train_indices, validation_indices = time_split_indices(samples, validation_share)
    validation_model, validation_scaler, validation_log, best_epoch = fit_early_stopping_model(
        samples,
        train_indices,
        validation_indices,
        config,
        seed,
        device,
        name,
    )
    final_model, final_scaler, refit_log = refit_model(
        samples, config, seed + 1, device, best_epoch
    )
    log = pd.concat(
        [validation_log.assign(stage="selection"), refit_log.assign(stage="refit")],
        ignore_index=True,
    )
    return (
        ModelBundle(
            name=name,
            model=final_model,
            scaler=final_scaler,
            validation_model=validation_model,
            validation_scaler=validation_scaler,
            best_epoch=best_epoch,
            config=config,
            log=log,
        ),
        train_indices,
        validation_indices,
    )

def predict_blocks(
    model: nn.Module,
    scaler: Standardizer,
    X: np.ndarray,
    device: torch.device,
    batch_size: int,
) -> np.ndarray:
    if not len(X):
        return np.zeros((0, HORIZON), dtype=np.float32)
    scaled = scaler.transform(X)
    output: list[np.ndarray] = []
    model.eval()
    with torch.inference_mode():
        for start in range(0, len(scaled), batch_size):
            batch = torch.from_numpy(scaled[start : start + batch_size]).to(device)
            output.append(model(batch).detach().cpu().numpy())
    return np.concatenate(output, axis=0).astype(np.float32)

