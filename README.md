# Regional NCS Forecasting

Global MLP forecasting workflow for production and fuel gas on the Norwegian
Continental Shelf.

The current repository surface is:

- `data/`: source production, consumption, field, and reserve data.
- `forecasting/`: forecasting package plus generated field, aggregate, and diagnostic artifacts.
- `index.html`, `app.js`, and `styles.css`: dependency-free web interface at the repository root.
- `scripts/`: generators for the web app's history and aggregate contribution inputs.

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
`python3 scripts/build_history.py` and `python3 scripts/build_reserves_history.py`.

## Web app

Serve the web app from the repository root:

```bash
python3 server.py
```

Open `http://127.0.0.1:8765/`. The server generates the aggregate contribution
summary on startup and serves the repository root directly. Restart it after
changing the app or its generated inputs. There is no separate site bundle.

## GitHub Pages

In the public repository, select **Settings → Pages → Build and deployment →
Source → GitHub Actions**. The Pages workflow generates the aggregate contribution
summary on pull requests, and deploys the repository root on pushes to `main`.
You can also run it manually from the Actions tab on `main`. It does not retrain
the models or copy the web assets and forecast outputs into another directory.

The live app is at
[simonhalvdansson.github.io/NCS-Fuel-Gas-Forecasting](https://simonhalvdansson.github.io/NCS-Fuel-Gas-Forecasting/).
The root `index.html` is the site entry point. All app asset URLs are relative,
so they also work under the repository's GitHub Pages URL. The root `.nojekyll`
keeps the site static without Jekyll processing.

## License

Project code is available under the [MIT License](LICENSE). Third-party data
and map assets remain subject to their upstream terms; see the app's data-source
links for provenance.
