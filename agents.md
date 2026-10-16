# Agent Notes

This repository's current workflow is the global MLP forecast and its web app.

- `forecasting/run_forecast.py` is the sole forecast entry point; `forecasting/pipeline.py` owns high-level orchestration.
- `forecasting/data_io.py` owns the current input-loading contract for files under `data/`.
- Feature construction, model training, validation, rollout, fuel accounting, and output writing live in their correspondingly named modules under `forecasting/`.
- Generated field artifacts live under `forecasting/fields/`, aggregate artifacts under `forecasting/aggregate/`, and logs/diagnostics under `forecasting/diagnostics/`.
- `index.html`, `app.js`, and `styles.css` at the repository root are the static frontend that consumes those generated artifacts.
- `scripts/build_reserves_history.py` uses the shared input loader and `data/remaining_reserves.xlsx` to rebuild the app's reserve history.
- `scripts/build_aggregate_contributors.py` generates the app's aggregate contribution summary directly under `forecasting/aggregate/`; `scripts/build_site.py` packages the required web assets and data into `_site/`.
- `.github/workflows/pages.yml` runs tests and JavaScript syntax checks, rebuilds app history and contributions, and builds `_site/` on pull requests; it deploys that bundle from `main`.
- After changing the frontend or its generated `forecasting/` inputs, restart the local web server from the repository root with `python3 server.py`; the app is served at `http://127.0.0.1:8765/`.
