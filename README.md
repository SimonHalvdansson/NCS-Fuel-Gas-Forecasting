# Regional NCS Forecasting

Global MLP forecasting workflow for production and fuel gas on the Norwegian
Continental Shelf.

The current repository surface is:

- `data/`: source production, consumption, field, and reserve data.
- `forecasting/`: forecasting package plus generated field, aggregate, and diagnostic artifacts.
- `webapp/`: dependency-free web interface for the generated forecasts.
- `scripts/build_pages.py`: packages the static site for GitHub Pages.

Set up and run the current forecast workflow:

```bash
python3 -m venv forecasting/.venv
forecasting/.venv/bin/pip install -r forecasting/requirements.txt
forecasting/.venv/bin/python forecasting/run_forecast.py
```

## Forecasting

A global production MLP predicts 12-month blocks from production history,
reserve/depletion state, lifecycle/calendar signals, and NCS area. A separate
fuel MLP uses fuel history and the upcoming production block, including mapped
satellite production for host facilities. Forecasts roll forward recursively;
production is capped by remaining reserves. Host/shore-powered fields have zero
field-level fuel to avoid double counting, and configured electrification dates
set future fuel to zero.

Models are selected on field-local time holdouts with a 12-month purge, then
refit on all available windows. Monte Carlo paths use held-out residual blocks
with shared calendar and field-specific shocks; parameter uncertainty is not
included. The default is 400 paths, reporting Q10, Q30, Q50 (median), Q70, and
Q90. Aggregate quantiles come from summed simulation paths. The app's first-year
totals sum monthly medians; smoothing averages monthly values and quantile
boundaries over 12 months.

Runs write field CSVs to `forecasting/fields/`, aggregate quantiles to
`forecasting/aggregate/`, and validation metrics, training logs, and run metadata
to `forecasting/diagnostics/`. `forecasting/manifest.csv` and
`forecasting/fuel_power_classification.csv` record coverage and fuel accounting.
After replacing source data, rebuild the app's history inputs with
`python3 webapp/build_history.py` and `python3 webapp/build_reserves_history.py`.

## Web app

Serve the web app from the repository root:

```bash
python3 server.py
```

Open `http://127.0.0.1:8765/`. The server builds `_site/` on startup and serves
that static bundle, using the same layout as GitHub Pages. Restart it after
changing the app or its generated inputs to rebuild the bundle.

## GitHub Pages

In the public repository, select **Settings → Pages → Build and deployment →
Source → GitHub Actions**. The Pages workflow packages the checked-in app and
forecast outputs on pull requests, and deploys pushes to `main`. You can also
run it manually from the Actions tab on `main`. It does not retrain the models.

Preview the exact deployment bundle locally:

```bash
python3 scripts/build_pages.py
python3 -m http.server 8766 --bind 127.0.0.1 --directory _site
```

Open `http://127.0.0.1:8766/`. The bundle places the app at the site root and
its generated inputs under `forecasting/`. All app asset URLs are relative,
so they also work at `https://<owner>.github.io/<repository>/`.
Only the required web assets and forecast inputs are packaged; source
spreadsheets, Python code, and training logs are omitted.

## License

Project code is available under the [MIT License](LICENSE). Third-party data
and map assets remain subject to their upstream terms; see the app's data-source
links for provenance.
