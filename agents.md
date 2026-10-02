# Agent Notes

This repository's current workflow is the global MLP forecast and its web app.

- `forecasting/run_forecast.py` is the sole forecast entry point; `forecasting/pipeline.py` owns high-level orchestration.
- `forecasting/data_io.py` owns the current input-loading contract for files under `data/`.
- Feature construction, model training, validation, rollout, fuel accounting, and output writing live in their correspondingly named modules under `forecasting/`.
- Generated field artifacts live under `forecasting/fields/`, aggregate artifacts under `forecasting/aggregate/`, and logs/diagnostics under `forecasting/diagnostics/`.
- `webapp/` is the static frontend that consumes those generated artifacts.
- `scripts/build_pages.py` packages the static app and its required generated inputs into `_site/` for GitHub Pages; `.github/workflows/pages.yml` validates pull requests and deploys `main`.
- After changing `webapp/` or its generated `forecasting/` inputs, restart the local web server from the repository root with `python3 server.py`; the app is served at `http://127.0.0.1:8765/`.
