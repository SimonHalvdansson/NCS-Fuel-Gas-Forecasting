#!/usr/bin/env python3
"""Run the regional NCS production and fuel-gas forecast."""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in {None, ""}:
    repository_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repository_root))

from forecasting.pipeline import main


if __name__ == "__main__":
    main()

