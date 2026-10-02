const DATA_URLS = {
  manifest: "forecasting/manifest.csv",
  metrics: "forecasting/diagnostics/metrics_by_field.csv",
  summary: "forecasting/diagnostics/run_summary.json",
  fuelRegistry: "forecasting/fuel_power_classification.csv",
  locations: "data/field_locations.json",
  land: "data/ncs_land_polygons.json",
  history: "history.json",
  reservesHistory: "reserves_history.json",
  powerSources: "power_sources.json?v=20260805-accounting-boundaries",
  aggregateQuantiles: "forecasting/aggregate/aggregate_forecast_quantiles.csv",
  aggregateContributors: "forecasting/aggregate/aggregate_contributors.json",
};

const MAP = {
  width: 640,
  height: 680,
  bbox: { minLon: -0.5, maxLon: 24.4, minLat: 55.2, maxLat: 73.1 },
  baseViewBox: { x: 0, y: 0, width: 640, height: 680 },
  minViewBox: { width: 96, height: 102 },
};

const ACCOUNTING_MIN_VIEWBOX = { width: 38.4, height: 40.8 };
const ACCOUNTING_FIELD_FOCUS_VIEWBOX = { width: 240, height: 255 };
const FIELD_DIRECTORY_REGIONS = ["North Sea", "Norwegian Sea", "Barents Sea"];
const VIEW_HASHES = new Set(["fields", "aggregate", "accounting"]);
const OUTSIDE_NCS_POWER_SUPPLIERS = new Set([
  "ALWYN NORTH",
  "ARMADA",
  "BRAE A",
  "HARALD",
]);
const OFF_MAP_SUPPLIER_LABELS = {
  "ALWYN NORTH": "Alwyn North (UK)",
  "ARMADA": "Armada (UK)",
  "BRAE A": "Brae A (UK)",
  "HARALD": "Harald (Denmark)",
  "MELKØYA LNG": "Melkøya LNG (Onshore)",
};
const POWER_SUPPLIER_OVERRIDES = {
  "FRØY": "Frigg",
};

const state = {
  fields: [],
  visibleFields: [],
  selected: null,
  forecasts: new Map(),
  histories: new Map(),
  reservesHistories: new Map(),
  land: null,
  summary: null,
  view: "fields",
  metric: "production",
  range: 72,
  aggregateRange: 300,
  smoothCharts: false,
  scatterRange: "all",
  region: "all",
  status: "Producing",
  electrification: "all",
  directoryOpen: false,
  directorySort: "alphabetical",
  viewBox: { ...MAP.baseViewBox },
  inspectorRenderCount: 0,
  selectionVersion: 0,
  aggregateForecast: null,
  aggregateHistory: null,
  aggregateForecastPromise: null,
  aggregateContributorData: null,
  aggregateContributorPromise: null,
  aggregateContributorError: false,
  aggregateHoverPoint: null,
  mapDrag: null,
  suppressMapClick: false,
  viewAnimationFrame: null,
  directoryFieldSignature: "",
  scatterAnimation: null,
  scatterTransitionVersion: 0,
  hoverHideTimer: null,
  accountingRows: [],
  accountingFilters: new Set(["shore", "shared"]),
  accountingSelected: 0,
  accountingSelection: { kind: "field", key: null },
  accountingViewBox: { ...MAP.baseViewBox },
  accountingViewAnimationFrame: null,
  accountingMapDrag: null,
  accountingListScroll: 0,
  accountingSearch: "",
};

const els = {
  fieldView: document.querySelector("#fieldView"),
  aggregateView: document.querySelector("#aggregateView"),
  accountingView: document.querySelector("#accountingView"),
  search: document.querySelector("#fieldSearch"),
  searchClear: document.querySelector("[data-clear-search]"),
  filterPanel: document.querySelector(".map-filter-panel"),
  browseButton: document.querySelector("[data-toggle-field-browser]"),
  browseLabel: document.querySelector("[data-browse-label]"),
  map: document.querySelector("#fieldMap"),
  mapGrid: document.querySelector("#mapGrid"),
  mapLand: document.querySelector("#mapLand"),
  mapLabels: document.querySelector("#mapLabels"),
  mapMarkers: document.querySelector("#mapMarkers"),
  hoverPopover: document.querySelector("#hoverPopover"),
  mapSummary: document.querySelector("#mapSummary"),
  mapShell: document.querySelector(".map-shell"),
  inspector: document.querySelector("#fieldInspector"),
  directory: document.querySelector("#fieldDirectory"),
  directoryList: document.querySelector("#fieldDirectoryList"),
  toast: document.querySelector("#toast"),
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9ØÆÅøæå]+/g, " ")
    .trim()
    .toUpperCase();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numericOrNaN(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return number(value, NaN);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function titleCaseStatus(status) {
  if (!status) return "Status unavailable";
  return status.toLowerCase().replace(/(^|\s|-)\S/g, (letter) => letter.toUpperCase());
}

function regionFor(lat) {
  if (lat >= 69) return "Barents Sea";
  if (lat >= 62) return "Norwegian Sea";
  return "North Sea";
}

function statusGroup(status) {
  const value = normalize(status);
  if (value.includes("SHUT")) return "Shut down";
  if (value.includes("PRODUC")) return "Producing";
  return "Other";
}

function markerClass(field) {
  if (field.statusGroup === "Producing") return "producing";
  if (field.statusGroup === "Shut down") return "shut";
  return "other";
}

function hostPowerMeta(field, shorePowered = false) {
  const supplier = field.fuelSourceField || POWER_SUPPLIER_OVERRIDES[field.key] || "";
  const category = shorePowered ? "Shore via" : "Host";
  return {
    label: supplier ? `${category}${shorePowered ? " " : " · "}${supplier}` : shorePowered ? "Shore via host" : "Host supplied",
    tone: shorePowered ? "electrified" : "gas",
  };
}

function powerMeta(field) {
  const classification = field.power_source_class || field.powerClass;
  if (classification === "host_supplied_shore_power") return hostPowerMeta(field, true);
  if (["host_supplied_gas_power", "host_gas_turbine", "host_gas_turbines", "subsea_to_host_or_onshore_power_not_field_level"].includes(classification)) {
    return hostPowerMeta(field);
  }
  const classifications = {
    power_from_shore: { label: "From shore", tone: "electrified" },
    partial_power_from_shore: { label: "Shore + field", tone: "electrified" },
    hybrid_shore_power_gas_turbine: { label: "Shore + field", tone: "electrified" },
    power_from_shore_mixed: { label: "Shore + field", tone: "electrified" },
    gas_turbine: { label: "Gas turbine", tone: "gas" },
    diesel_generation: { label: "Diesel generation", tone: "gas" },
    offshore_gas_diesel_generation: { label: "Gas + diesel", tone: "gas" },
    gas_diesel_engine_generation: { label: "Gas + diesel", tone: "gas" },
    gas_turbine_and_diesel: { label: "Gas + diesel", tone: "gas" },
    gas_turbine_combined_cycle: { label: "Gas turbine + waste heat", tone: "gas" },
    hybrid_offshore_wind_gas_turbines: { label: "Wind + gas turbines", tone: "electrified" },
    hybrid_wind_gas: { label: "Wind + gas turbines", tone: "electrified" },
    reported_field_fuel: { label: "Field supplied", tone: "gas" },
    partial_renewable_power: { label: "Renewable + field", tone: "electrified" },
    planned_electrification_or_onshore_power_change: { label: "Electrification planned", tone: "planned" },
    shut_down_no_future_field_energy_unless_redeveloped: { label: "Not operating", tone: "neutral" },
    historical_or_unknown: { label: "Source unknown", tone: "neutral" },
    offshore_generation_or_host_power_unknown: { label: "Source unknown", tone: "neutral" },
  };
  return classifications[classification] || { label: "Source unknown", tone: "neutral" };
}

function powerBadge(field) {
  const power = powerMeta(field);
  return `<span class="field-meta-chip power-status ${power.tone}" title="${escapeHtml(power.label)}">
    <span class="field-meta-icon"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.9 1.4 3.4 8h4.2l-.8 6.6 5.8-7.9H8.4l.5-5.3Z"></path></svg></span>
    <span class="field-meta-copy"><small>Power</small><strong>${escapeHtml(power.label)}</strong></span>
  </span>`;
}

function formatMonthLabel(month) {
  const match = String(month || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return String(month || "");
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

function futurePowerBadge(field) {
  if (!field.fuelZeroFromMonth) return "";
  const label = `Fuel forecast zero from ${formatMonthLabel(field.fuelZeroFromMonth)}`;
  return `<span class="field-meta-chip future-power-chip" title="${escapeHtml(label)}">
    <span class="field-meta-icon"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.9 1.4 3.4 8h4.2l-.8 6.6 5.8-7.9H8.4l.5-5.3Z"></path></svg></span>
    <span class="field-meta-copy"><small>Planned</small><strong>Shore from ${escapeHtml(formatMonthLabel(field.fuelZeroFromMonth))}</strong></span>
  </span>`;
}

function formatHistoryLength(months) {
  const totalMonths = Math.max(0, Math.round(number(months)));
  if (totalMonths > 12) {
    const years = Math.max(1, Math.round(totalMonths / 12));
    return `${years} ${years === 1 ? "year" : "years"}`;
  }
  return `${totalMonths} ${totalMonths === 1 ? "month" : "months"}`;
}

function project(lon, lat) {
  const { minLon, maxLon, minLat, maxLat } = MAP.bbox;
  return {
    x: ((lon - minLon) / (maxLon - minLon)) * MAP.width,
    y: MAP.height - ((lat - minLat) / (maxLat - minLat)) * MAP.height,
  };
}

function icon(name) {
  const icons = {
    rig: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M7 20l3-14h4l3 14M8.2 15h7.6M9.2 10h5.6M12 3v3M5 20v-4h3M19 20v-4h-3"></path></svg>',
    history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-7M3 19h18"></path></svg>',
    reserve: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v13H5zM8 3h8v3M8 10h8M8 14h5"></path></svg>',
    fit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18c4-8 7 0 10-7 2-4 4-4 6-5"></path><path d="M4 4v16h16"></path></svg>',
    trend: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16 5-5 4 3 7-8"></path><path d="M15 6h5v5"></path></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"></rect><path d="M8 3v4M16 3v4M4 10h16"></path></svg>',
    context: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s6-5.5 6-11a6 6 0 1 0-12 0c0 5.5 6 11 6 11Z"></path><circle cx="12" cy="10" r="2"></circle></svg>',
  };
  return icons[name] || icons.history;
}

async function getText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function loadData() {
  const [manifestText, metricsText, summary, registryText, locationsRaw, land, historyRaw, reservesHistoryRaw, powerSources] = await Promise.all([
    getText(DATA_URLS.manifest),
    getText(DATA_URLS.metrics),
    getJson(DATA_URLS.summary),
    getText(DATA_URLS.fuelRegistry),
    getJson(DATA_URLS.locations),
    getJson(DATA_URLS.land),
    getJson(DATA_URLS.history),
    getJson(DATA_URLS.reservesHistory),
    getJson(DATA_URLS.powerSources).catch(() => ({})),
  ]);
  const manifest = parseCsv(manifestText);
  const metricsRows = parseCsv(metricsText).filter((row) => row.variant === "global_mlp");
  const metricsByName = new Map(metricsRows.map((row) => [normalize(row.field), row]));
  const locationsByName = new Map(Object.values(locationsRaw).map((location) => [normalize(location.field), location]));

  state.fields = manifest
    .map((row) => {
      const key = normalize(row.field);
      const location = locationsByName.get(key);
      const power = powerSources[key] || powerSources[row.field] || {};
      if (!location) return null;
      return {
        ...row,
        key,
        hasForecast: number(row.global_mlp_forecast_months) > 0,
        lat: number(location.lat),
        lon: number(location.lon),
        status: titleCaseStatus(location.status),
        statusGroup: statusGroup(location.status),
        region: regionFor(number(location.lat)),
        metrics: metricsByName.get(key) || null,
        fuelForecastMethod: row.fuel_forecast_method || "",
        fuelIsInferred: String(row.fuel_is_inferred).toLowerCase() === "true",
        fuelSourceField: row.fuel_source_field || "",
        suppliedByFieldKey: normalize(row.supplied_by_field_key),
        fuelAccountedFieldKey: normalize(row.fuel_accounted_field_key),
        fuelZeroFromMonth: row.fuel_zero_from_month || "",
        futurePowerClass: row.future_power_source_class || "",
        futureTransitionSourceUrl: row.future_transition_source_url || "",
        fieldLevelFuelExpected: row.field_level_fuel_expected || "",
        powerClass: power.classification || row.power_source_class || "offshore_generation_or_host_power_unknown",
        powerLabel: power.label || "",
        powerTone: power.tone || (/power_from_shore|shore_power|shore_planned/i.test(row.power_source_class || "") ? "electrified" : /gas|consolidated/i.test(row.power_source_class || "") ? "gas" : ""),
        powerSourceUrl: power.source_url || row.power_source_url || "",
        powerConfidence: power.confidence || row.power_source_confidence || "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.field.localeCompare(b.field));

  state.land = land;
  state.accountingRows = parseCsv(registryText).filter((row) => row.series_scope === "field");
  state.summary = summary;
  state.histories = new Map(Object.entries(historyRaw).map(([key, rows]) => [normalize(key), rows]));
  state.reservesHistories = new Map(Object.entries(reservesHistoryRaw).map(([key, rows]) => [normalize(key), rows]));
  state.selected = state.fields.find((field) => normalize(field.field) === "OSEBERG") || state.fields[0];
  state.visibleFields = baseFilteredFields();
}

function renderGrid() {
  const horizontal = [58, 62, 66, 70]
    .map((lat) => {
      const { y } = project(MAP.bbox.minLon, lat);
      return `<line class="map-grid-line" x1="0" y1="${y}" x2="${MAP.width}" y2="${y}"></line><text class="map-grid-label" x="10" y="${y - 7}">${lat}°N</text>`;
    })
    .join("");
  const vertical = [0, 5, 10, 15, 20]
    .map((lon) => {
      const { x } = project(lon, MAP.bbox.minLat);
      return `<line class="map-grid-line" x1="${x}" y1="0" x2="${x}" y2="${MAP.height}"></line><text class="map-grid-label" x="${x + 5}" y="${MAP.height - 10}">${lon}°E</text>`;
    })
    .join("");
  els.mapGrid.innerHTML = horizontal + vertical;
}

function renderLand() {
  const visibleCountries = new Set(["Norway", "Sweden", "Denmark", "United Kingdom", "Finland"]);
  const paths = [];
  for (const country of state.land.countries || []) {
    if (!visibleCountries.has(country.name)) continue;
    for (const polygon of country.polygons || []) {
      const points = polygon
        .filter(([lon, lat]) => lon >= MAP.bbox.minLon - 5 && lon <= MAP.bbox.maxLon + 5 && lat >= MAP.bbox.minLat - 3 && lat <= MAP.bbox.maxLat + 3)
        .map(([lon, lat]) => project(lon, lat));
      if (points.length < 3) continue;
      paths.push(`<path class="land-shape" d="M${points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}Z"></path>`);
    }
  }
  els.mapLand.innerHTML = paths.join("");
  const labels = [
    ["NORTH SEA", 3.9, 57.15],
    ["NORWEGIAN SEA", 1.4, 66.0],
    ["BARENTS SEA", 16.8, 71.2],
  ];
  els.mapLabels.innerHTML = labels
    .map(([label, lon, lat]) => {
      const { x, y } = project(lon, lat);
      return `<text class="sea-label" x="${x}" y="${y}">${label}</text>`;
    })
    .join("");
}

function markerMarkup(field) {
  const selectedKey = state.selected?.key;
  const { x, y } = project(field.lon, field.lat);
  const selected = field.key === selectedKey;
  return `<g class="field-marker ${markerClass(field)}${selected ? " selected" : ""}" data-field-key="${escapeHtml(field.key)}" data-x="${x.toFixed(2)}" data-y="${y.toFixed(2)}" transform="${fieldMarkerTransform(x, y)}" role="button" tabindex="0" aria-label="${escapeHtml(field.field)}, ${escapeHtml(field.status)}">
    <circle class="marker-hit" r="8.7"></circle>
    ${selected ? '<circle class="pulse" r="6.5"></circle>' : ""}
    <circle class="core" r="${selected ? "4.25" : "3"}"></circle>
  </g>`;
}

function fieldMarkerTransform(x, y, view = state.viewBox) {
  const inverseScale = view.width / MAP.width;
  return `matrix(${inverseScale.toFixed(5)} 0 0 ${inverseScale.toFixed(5)} ${Number(x).toFixed(2)} ${Number(y).toFixed(2)})`;
}

function syncFieldMapMarkerScale() {
  els.mapMarkers.querySelectorAll(".field-marker").forEach((marker) => {
    marker.setAttribute("transform", fieldMarkerTransform(marker.dataset.x, marker.dataset.y));
  });
}

function wireMarker(marker, field) {
  marker.addEventListener("click", (event) => {
    event.stopPropagation();
    hideHover();
    void selectField(field);
  });
  marker.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      hideHover();
      void selectField(field);
    }
  });
  marker.addEventListener("mouseenter", (event) => showHover(field, event));
  marker.addEventListener("mousemove", positionHover);
  marker.addEventListener("mouseleave", hideHover);
}

function updateMapFieldCounts() {
  els.mapSummary.textContent = `${state.visibleFields.length} of ${state.fields.length} fields shown`;
  updateBrowseLabel();
}

function renderMarkers() {
  els.mapMarkers.innerHTML = state.visibleFields.map(markerMarkup).join("");
  els.mapMarkers.querySelectorAll(".field-marker").forEach((marker) => {
    const field = state.fields.find((item) => item.key === marker.dataset.fieldKey);
    wireMarker(marker, field);
  });
  updateMapFieldCounts();
  updateFieldNavigation();
}

function updateMarkerSelection() {
  els.mapMarkers.querySelectorAll(".field-marker").forEach((marker) => {
    const selected = marker.dataset.fieldKey === state.selected?.key;
    marker.classList.toggle("selected", selected);
    marker.querySelector(".core")?.setAttribute("r", selected ? "4.25" : "3");
    const pulse = marker.querySelector(".pulse");
    if (selected && !pulse) marker.querySelector(".core")?.insertAdjacentHTML("beforebegin", '<circle class="pulse" r="6.5"></circle>');
    if (!selected) pulse?.remove();
  });
}

function mapEventPosition(event) {
  const rect = els.map.getBoundingClientRect();
  return { left: event.clientX - rect.left, top: event.clientY - rect.top };
}

function showHover(field, event) {
  if (state.mapDrag) return;
  window.clearTimeout(state.hoverHideTimer);
  els.hoverPopover.innerHTML = `<strong>${escapeHtml(field.field)}</strong><br>${escapeHtml(field.region)} · ${escapeHtml(field.status)}`;
  els.hoverPopover.hidden = false;
  positionHover(event);
  window.requestAnimationFrame(() => els.hoverPopover.classList.add("visible"));
}

function positionHover(event) {
  const position = mapEventPosition(event);
  const shell = els.mapShell.getBoundingClientRect();
  els.hoverPopover.style.left = `${Math.max(8, Math.min(position.left + 12, shell.width - 210))}px`;
  els.hoverPopover.style.top = `${Math.max(8, position.top - 50)}px`;
}

function hideHover() {
  els.hoverPopover.classList.remove("visible");
  window.clearTimeout(state.hoverHideTimer);
  state.hoverHideTimer = window.setTimeout(() => {
    if (!els.hoverPopover.classList.contains("visible")) els.hoverPopover.hidden = true;
  }, 75);
}

function baseFilteredFields() {
  return state.fields.filter((field) => {
    const regionMatches = state.region === "all" || field.region === state.region;
    const statusMatches = state.status === "all" || field.statusGroup === state.status;
    const electrificationMatches = state.electrification === "all" || powerMeta(field).tone === "electrified";
    return regionMatches && statusMatches && electrificationMatches;
  });
}

function applyFilters() {
  const query = normalize(els.search.value);
  const nextFields = baseFilteredFields().filter((field) => !query || field.key.includes(query));
  if (query) setFieldDirectoryOpen(true);
  if (state.directoryOpen) transitionFieldDirectory(nextFields);
  else renderFieldDirectory(nextFields);
  transitionMarkers(nextFields);
}

function fieldSetSignature(fields) {
  return fields.map((field) => field.key).join("|");
}

function transitionMarkers(nextFields) {
  if (fieldSetSignature(nextFields) === fieldSetSignature(state.visibleFields)) return;
  state.visibleFields = nextFields;
  renderMarkers();
}

function updateSearchClear() {
  if (els.searchClear) els.searchClear.hidden = !els.search.value;
}

function updateBrowseLabel(count = state.visibleFields.length) {
  if (els.browseLabel) els.browseLabel.textContent = `Browse fields (${count})`;
}

function setFieldDirectoryOpen(open, { focus = false } = {}) {
  if (open && !state.directoryOpen) {
    els.inspector.style.setProperty("--browse-inspector-height", `${els.inspector.getBoundingClientRect().height}px`);
  } else if (!open) {
    els.inspector.style.removeProperty("--browse-inspector-height");
  }
  state.directoryOpen = open;
  els.filterPanel.classList.toggle("browser-open", open);
  els.directory.setAttribute("aria-hidden", String(!open));
  if (open) els.directory.removeAttribute("inert");
  else els.directory.setAttribute("inert", "");
  els.browseButton.setAttribute("aria-expanded", String(open));
  if (open) renderFieldDirectory();
  if (open && focus) window.requestAnimationFrame(() => els.search.focus());
}

function openFieldDirectory(options) {
  setFieldDirectoryOpen(true, options);
}

function closeFieldDirectory() {
  setFieldDirectoryOpen(false);
}

function directoryPowerChip(field) {
  const power = powerMeta(field);
  const bolt = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.9 1.4 3.4 8h4.2l-.8 6.6 5.8-7.9H8.4l.5-5.3Z"></path></svg>';
  if (power.tone === "gas") return "";
  const hasShorePower = /shore/i.test(power.label);
  if (hasShorePower) {
    return `<small class="power-chip ${escapeHtml(power.tone)} icon-only tooltip-chip" data-tooltip="${escapeHtml(power.label)}" aria-label="${escapeHtml(power.label)}">${bolt}</small>`;
  }
  return `<small class="power-chip ${escapeHtml(power.tone)}"><span>${escapeHtml(power.label)}</span></small>`;
}

function directoryShutdownChip() {
  return '<small class="shutdown-chip">Shut down</small>';
}

function directoryMetricChip(kind, value) {
  const formatted = Math.max(0, number(value)).toLocaleString("en", { maximumFractionDigits: 1 });
  const isReserve = kind === "reserve";
  const label = isReserve
    ? `Total forecast production: ${formatted} million Sm³ o.e. over the forecast horizon`
    : `Fuel gas consumption: ${formatted} million Sm³/y`;
  const iconSvg = isReserve
    ? '<svg class="resource-chip-icon droplet-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.4C6.5 3.7 3.6 6.8 3.6 10a4.4 4.4 0 0 0 8.8 0C12.4 6.8 9.5 3.7 8 1.4Z"></path><path class="metric-icon-fill" d="M4.5 9.4h7v.7a3.5 3.5 0 0 1-7 0v-.7Z"></path></svg>'
    : '<svg class="resource-chip-icon flame-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8.3 1.5c.5 2.4-1.4 3.3-1.5 5.2-.9-.7-1.2-1.5-1.1-2.5-1.8 1.8-2.8 3.7-2.5 6A4.8 4.8 0 0 0 8 14.6a4.8 4.8 0 0 0 4.8-4.8c0-2.2-1.3-4.6-4.5-8.3Z"></path><path class="metric-icon-fill" d="M8.1 7.2c.2 1.1-.7 1.6-.8 2.5-.4-.3-.6-.7-.6-1.2-.7.8-1.1 1.7-1 2.5A2.3 2.3 0 0 0 8 13a2.3 2.3 0 0 0 2.3-2.3c0-1.1-.6-2.2-2.2-3.5Z"></path></svg>';
  const visibleValue = `${formatted}M${isReserve ? "" : "/y"}`;
  return `<small class="${kind}-chip directory-metric-chip tooltip-chip" data-tooltip="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${iconSvg}<span aria-hidden="true">${escapeHtml(visibleValue)}</span></small>`;
}

function directoryFuelChip(field, value) {
  if (field.fuelForecastMethod === "external_power_zero") {
    const host = field.fuelSourceField || "host facility";
    const label = `No field-level fuel; power and processing energy are accounted at ${host}`;
    const flame = '<svg class="resource-chip-icon flame-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8.3 1.5c.5 2.4-1.4 3.3-1.5 5.2-.9-.7-1.2-1.5-1.1-2.5-1.8 1.8-2.8 3.7-2.5 6A4.8 4.8 0 0 0 8 14.6a4.8 4.8 0 0 0 4.8-4.8c0-2.2-1.3-4.6-4.5-8.3Z"></path></svg>';
    return `<small class="fuel-chip directory-metric-chip external tooltip-chip" data-tooltip="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${flame}<span aria-hidden="true">Supplied</span></small>`;
  }
  if (field.fuelIsInferred) {
    const label = "Fuel-gas history is unavailable; the forecast is statistically inferred";
    return `<small class="fuel-chip directory-metric-chip inferred tooltip-chip" data-tooltip="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span aria-hidden="true">Inferred</span></small>`;
  }
  return directoryMetricChip("fuel", value);
}

function highlightSearchMatch(value, query = els.search.value) {
  const label = String(value || "");
  const normalizedLabel = normalize(label);
  const normalizedQuery = normalize(query);
  const matchIndex = normalizedQuery ? normalizedLabel.indexOf(normalizedQuery) : -1;
  if (matchIndex < 0) return escapeHtml(label);

  const normalizedToSource = [];
  let searchable = "";
  let pendingSpaceIndex = -1;
  Array.from(label).forEach((character, sourceIndex) => {
    const normalizedCharacter = character
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9ØÆÅøæå]+/g, "")
      .toUpperCase();
    if (!normalizedCharacter) {
      if (searchable) pendingSpaceIndex = sourceIndex;
      return;
    }
    if (pendingSpaceIndex >= 0 && !searchable.endsWith(" ")) {
      searchable += " ";
      normalizedToSource.push(pendingSpaceIndex);
    }
    pendingSpaceIndex = -1;
    Array.from(normalizedCharacter).forEach((normalizedCharacterPart) => {
      searchable += normalizedCharacterPart;
      normalizedToSource.push(sourceIndex);
    });
  });

  const mappedIndex = searchable.indexOf(normalizedQuery);
  if (mappedIndex < 0) return escapeHtml(label);
  const sourceStart = normalizedToSource[mappedIndex];
  const sourceEnd = normalizedToSource[mappedIndex + normalizedQuery.length - 1] + 1;
  return `${escapeHtml(label.slice(0, sourceStart))}<mark class="directory-search-match">${escapeHtml(label.slice(sourceStart, sourceEnd))}</mark>${escapeHtml(label.slice(sourceEnd))}`;
}

function fieldForecastProduction(field) {
  return number(field.global_mlp_total_forecast_production_msm3oe);
}

function fieldFuelConsumption(field) {
  return historyFor(field).slice(-12).reduce((sum, row) => sum + number(row.fuel), 0);
}

function fieldProduction(field) {
  return historyFor(field).slice(-12).reduce((sum, row) => sum + number(row.production), 0);
}

function formatAnnualProduction(value) {
  const production = Math.max(0, number(value));
  return `${production.toLocaleString("en", { maximumFractionDigits: production < 1 ? 2 : 1 })}M Sm³ o.e./y`;
}

function sortDirectoryFields(fields) {
  return [...fields].sort((a, b) => {
    if (state.directorySort === "production") return fieldForecastProduction(b) - fieldForecastProduction(a) || a.field.localeCompare(b.field);
    if (state.directorySort === "fuel") return fieldFuelConsumption(b) - fieldFuelConsumption(a) || a.field.localeCompare(b.field);
    return a.field.localeCompare(b.field);
  });
}

function orderedDirectoryFields(fields) {
  const sortedFields = sortDirectoryFields(fields);
  return FIELD_DIRECTORY_REGIONS.flatMap((region) => sortedFields.filter((field) => field.region === region));
}

function commitFieldDirectory(fields) {
  const orderedFields = orderedDirectoryFields(fields);
  state.directoryFieldSignature = `${state.directorySort}:${fieldSetSignature(orderedFields)}`;
  updateBrowseLabel(fields.length);
  els.directoryList.innerHTML = FIELD_DIRECTORY_REGIONS
    .map((region) => {
      const group = orderedFields.filter((field) => field.region === region);
      if (!group.length) return "";
      return `<section><h3>${region}<span>${group.length}</span></h3>${group
        .map((field) => {
          const isShutDown = field.statusGroup === "Shut down";
          const forecastProduction = fieldForecastProduction(field);
          const fuelLastYear = fieldFuelConsumption(field);
          return `<button class="directory-field${isShutDown ? " shut-down" : ""}${field.key === state.selected?.key ? " selected" : ""}" type="button" data-field-key="${escapeHtml(field.key)}">
            <i class="${markerClass(field)}"></i>
            <span class="directory-field-copy"><strong>${highlightSearchMatch(field.field)}</strong><span class="directory-field-chips">
              ${isShutDown ? directoryShutdownChip() : `
                ${directoryPowerChip(field)}
                ${directoryMetricChip("reserve", forecastProduction)}
                ${directoryFuelChip(field, fuelLastYear)}
              `}
            </span></span><b>→</b>
          </button>`;
        })
        .join("")}</section>`;
    })
    .join("") || '<p class="directory-empty">No fields match.</p>';
  els.directoryList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const field = state.fields.find((item) => item.key === button.dataset.fieldKey);
      els.search.value = "";
      updateSearchClear();
      state.visibleFields = baseFilteredFields();
      closeFieldDirectory();
      renderMarkers();
      void selectField(field);
    });
  });
}

function renderFieldDirectory(fields = null) {
  const query = normalize(els.search.value);
  commitFieldDirectory(fields || baseFilteredFields().filter((field) => !query || field.key.includes(query)));
}

function transitionFieldDirectory(fields) {
  commitFieldDirectory(fields);
}

async function selectField(field) {
  if (!field) return;
  state.selected = field;
  if (!field.hasForecast && state.metric === "reserves") state.metric = "production";
  hideHover();
  const selectionVersion = ++state.selectionVersion;
  updateMarkerSelection();
  updateFieldNavigation();
  renderFieldDirectory();
  try {
    await ensureForecast(field);
    if (selectionVersion !== state.selectionVersion) return;
    renderInspector();
  } catch (error) {
    console.error(error);
    if (selectionVersion !== state.selectionVersion) return;
    els.inspector.innerHTML = `<div class="error-state"><p>Could not load the forecast for ${escapeHtml(field.field)}.</p></div>`;
  }
}

async function ensureForecast(field) {
  if (state.forecasts.has(field.key)) return state.forecasts.get(field.key);
  if (!field.hasForecast) {
    state.forecasts.set(field.key, []);
    return [];
  }
  const forecast = parseCsv(await getText(`${field.field_dir}/forecast_global_mlp.csv`));
  state.forecasts.set(field.key, forecast);
  return forecast;
}

function percent(value) {
  return Number.isFinite(number(value, NaN)) ? `${(number(value) * 100).toFixed(1)}%` : "—";
}

function formatValue(value, metric, precise = false) {
  const numeric = number(value, NaN);
  if (!Number.isFinite(numeric)) return "—";
  const digits = precise ? 3 : numeric < 1 ? 2 : 1;
  if (metric === "fuel") return `${numeric.toLocaleString("en", { maximumFractionDigits: digits })} million Sm³`;
  if (metric === "reserves") return `${numeric.toLocaleString("en", { maximumFractionDigits: digits })} million Sm³ o.e. remaining`;
  return `${numeric.toLocaleString("en", { maximumFractionDigits: digits })} million Sm³ o.e.`;
}

function formatCompactValue(value, metric) {
  const numeric = number(value, NaN);
  if (!Number.isFinite(numeric)) return "—";
  const formatted = numeric.toLocaleString("en", { maximumFractionDigits: numeric < 1 ? 2 : 1 });
  return metric === "fuel" ? `${formatted}M Sm³` : `${formatted}M Sm³ o.e.`;
}

function historyFor(field) {
  return state.histories.get(field.key) || [];
}

function hasFuelGasData(field, forecast = state.forecasts.get(field.key) || []) {
  if (field.fuelForecastMethod === "external_power_zero") return false;
  const hasHistory = historyFor(field).some((row) => Number.isFinite(numericOrNaN(row.fuel)));
  const hasForecast = forecast.some((row) => Number.isFinite(chartValue(row, "fuel")));
  return hasHistory || hasForecast;
}

function correlation(rows) {
  if (rows.length < 2) return NaN;
  const meanX = rows.reduce((sum, row) => sum + row.production, 0) / rows.length;
  const meanY = rows.reduce((sum, row) => sum + row.fuel, 0) / rows.length;
  const parts = rows.reduce((acc, row) => {
    const dx = row.production - meanX;
    const dy = row.fuel - meanY;
    acc.xy += dx * dy;
    acc.xx += dx * dx;
    acc.yy += dy * dy;
    return acc;
  }, { xy: 0, xx: 0, yy: 0 });
  return parts.xx > 0 && parts.yy > 0 ? parts.xy / Math.sqrt(parts.xx * parts.yy) : NaN;
}

function renderScatterPlot(field) {
  const allPairs = historyFor(field)
    .map((row) => ({ month: row.month, production: numericOrNaN(row.production), fuel: numericOrNaN(row.fuel) }))
    .filter((row) => Number.isFinite(row.production) && Number.isFinite(row.fuel));
  if (!allPairs.length) return "";
  const pairs = state.scatterRange === "5y" ? allPairs.slice(-60) : allPairs;
  const olderPairs = allPairs.slice(0, Math.max(0, allPairs.length - 60));
  const recentPairs = allPairs.slice(-60);
  const width = 520;
  const height = 180;
  const margin = { top: 12, right: 14, bottom: 31, left: 43 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const xScale = niceScale(Math.max(...allPairs.map((row) => row.production), 0.001) * 1.03, 4);
  const yScale = niceScale(Math.max(...allPairs.map((row) => row.fuel), 0.001) * 1.03, 4);
  const x = (value) => margin.left + (value / xScale.max) * innerWidth;
  const y = (value) => margin.top + innerHeight - (value / yScale.max) * innerHeight;
  const horizontalGrid = yScale.ticks.map((value) => {
    const tickY = y(value);
    return `<line class="scatter-grid" x1="${margin.left}" y1="${tickY}" x2="${width - margin.right}" y2="${tickY}"></line>
      <text class="chart-axis-label" x="${margin.left - 6}" y="${tickY + 3}" text-anchor="end">${formatAxisNumber(value, yScale.step)}</text>`;
  }).join("");
  const verticalGrid = xScale.ticks.map((value) => {
    const tickX = x(value);
    return `<line class="scatter-grid vertical" x1="${tickX}" y1="${margin.top}" x2="${tickX}" y2="${height - margin.bottom}"></line>
      <text class="chart-axis-label" x="${tickX}" y="${height - 10}" text-anchor="middle">${formatAxisNumber(value, xScale.step)}</text>`;
  }).join("");
  const pointMarkup = (row, latest = false) => `<circle class="scatter-point${latest ? " latest" : ""}" cx="${x(row.production).toFixed(2)}" cy="${y(row.fuel).toFixed(2)}" r="${latest ? 3.4 : 2.2}"><title>${escapeHtml(row.month)} · ${escapeHtml(formatValue(row.production, "production", true))} · ${escapeHtml(formatValue(row.fuel, "fuel", true))}</title></circle>`;
  const olderPoints = olderPairs.map((row) => pointMarkup(row)).join("");
  const recentPoints = recentPairs.map((row, index) => pointMarkup(row, index === recentPairs.length - 1)).join("");
  const r = correlation(pairs);
  return `<section class="scatter-section" data-scatter-slot>
    <div class="scatter-head"><div><h3>Fuel gas vs production history</h3><p data-scatter-summary>${pairs.length} observed monthly pairs${Number.isFinite(r) ? ` · correlation ${r.toFixed(2)}` : ""}</p></div><div class="scatter-actions"><span><i></i>Most recent</span><div class="scatter-range-group" role="group" aria-label="Scatter plot history range"><button type="button" data-scatter-range="all" class="${state.scatterRange === "all" ? "active" : ""}">All</button><button type="button" data-scatter-range="5y" class="${state.scatterRange === "5y" ? "active" : ""}">Last 5 years</button></div></div></div>
    <svg class="scatter-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Historical fuel gas consumption versus production for ${escapeHtml(field.field)}">
      ${horizontalGrid}${verticalGrid}<g class="scatter-older-points${state.scatterRange === "5y" ? " hidden" : ""}" data-scatter-older-points>${olderPoints}</g><g class="scatter-recent-points">${recentPoints}</g>
      <text class="scatter-axis-title" x="${margin.left + innerWidth / 2}" y="${height - 1}" text-anchor="middle">Production · million Sm³ o.e.</text>
      <text class="scatter-axis-title" transform="translate(10 ${margin.top + innerHeight / 2}) rotate(-90)" text-anchor="middle">Fuel gas · million Sm³</text>
    </svg>
  </section>`;
}

function hasScatterPlotData(field) {
  if (field.fuelForecastMethod === "external_power_zero") return false;
  return historyFor(field).some((row) => Number.isFinite(numericOrNaN(row.production)) && Number.isFinite(numericOrNaN(row.fuel)));
}

function supplierFieldFor(field) {
  const registryRow = state.accountingRows.find((row) => normalize(row.field_key || row.field) === field.key);
  const supplierKey = normalize(registryRow?.supplied_by_field_key || registryRow?.fuel_accounted_field_key);
  return supplierKey ? state.fields.find((candidate) => candidate.key === supplierKey) || null : null;
}

function renderFuelSupplierNotice(field) {
  if (field.fuelForecastMethod !== "external_power_zero") return renderScatterPlot(field);
  const supplier = supplierFieldFor(field);
  const supplierName = supplier?.field || field.fuelSourceField || "external facility";
  const outsideNcs = OUTSIDE_NCS_POWER_SUPPLIERS.has(normalize(supplierName));
  const supplierMarkup = supplier
    ? `<button type="button" data-supplier-field-key="${escapeHtml(supplier.key)}">${escapeHtml(supplierName)}</button>`
    : `<strong>${escapeHtml(supplierName)}</strong>`;
  return `<section class="fuel-supply-section" aria-label="Fuel and power accounting">
    <p>Power supplied by ${supplierMarkup}</p>
    ${outsideNcs ? '<p class="fuel-supply-boundary">Outside NCS</p>' : ""}
  </section>`;
}

function wireScatterControls() {
  els.inspector.querySelectorAll("[data-scatter-range]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.scatterRange === button.dataset.scatterRange) return;
      state.scatterRange = button.dataset.scatterRange;
      transitionScatterPlot();
    });
  });
}

function transitionScatterPlot() {
  const current = els.inspector.querySelector("[data-scatter-slot]");
  if (!current) return;
  const allPairs = historyFor(state.selected)
    .map((row) => ({ production: numericOrNaN(row.production), fuel: numericOrNaN(row.fuel) }))
    .filter((row) => Number.isFinite(row.production) && Number.isFinite(row.fuel));
  const visiblePairs = state.scatterRange === "5y" ? allPairs.slice(-60) : allPairs;
  const r = correlation(visiblePairs);
  const summary = current.querySelector("[data-scatter-summary]");
  if (summary) summary.textContent = `${visiblePairs.length} observed monthly pairs${Number.isFinite(r) ? ` · correlation ${r.toFixed(2)}` : ""}`;
  current.querySelectorAll("[data-scatter-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.scatterRange === state.scatterRange);
  });

  const olderPoints = current.querySelector("[data-scatter-older-points]");
  if (!olderPoints) return;
  const version = ++state.scatterTransitionVersion;
  state.scatterAnimation?.cancel();
  state.scatterAnimation = null;
  const showOlder = state.scatterRange === "all";
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    olderPoints.classList.toggle("hidden", !showOlder);
    return;
  }
  const startOpacity = Number.parseFloat(getComputedStyle(olderPoints).opacity);
  olderPoints.classList.toggle("hidden", !showOlder);
  const animation = olderPoints.animate(
    [{ opacity: Number.isFinite(startOpacity) ? startOpacity : (showOlder ? 0 : 1) }, { opacity: showOlder ? 1 : 0 }],
    { duration: 150, easing: "ease-in-out" },
  );
  state.scatterAnimation = animation;
  animation.finished.then(() => {
    if (version !== state.scatterTransitionVersion || state.scatterAnimation !== animation) return;
    state.scatterAnimation = null;
  }).catch(() => {});
}

function fieldNavigationTargets() {
  const fields = orderedDirectoryFields(state.visibleFields);
  if (!fields.length) return { previous: null, next: null };
  const index = fields.findIndex((field) => field.key === state.selected?.key);
  if (index < 0) return { previous: fields[fields.length - 1], next: fields[0] };
  if (fields.length === 1) return { previous: null, next: null };
  return {
    previous: fields[(index - 1 + fields.length) % fields.length],
    next: fields[(index + 1) % fields.length],
  };
}

function updateFieldNavigation() {
  const targets = fieldNavigationTargets();
  els.inspector?.querySelectorAll("[data-field-nav]").forEach((button) => {
    const direction = button.dataset.fieldNav;
    const target = targets[direction];
    button.disabled = !target;
    button.dataset.targetField = target?.key || "";
    const directionLabel = direction === "previous" ? "Previous" : "Next";
    const label = target ? `${directionLabel} field: ${target.field}` : `No ${directionLabel.toLowerCase()} field`;
    button.setAttribute("aria-label", label);
    button.title = label;
  });
}

function renderInspector() {
  const field = state.selected;
  const forecast = state.forecasts.get(field.key) || [];
  const hasFuel = hasFuelGasData(field, forecast);
  if (!hasFuel && state.metric === "fuel") state.metric = "production";
  const first = forecast[0] || {};
  const remaining = number(first.remaining_reserves_start_msm3oe, NaN);
  const isShut = field.statusGroup === "Shut down";
  const hasForecast = field.hasForecast && forecast.length > 0;
  const hasInterval = forecast.some((row) => chartInterval(row, "production") || chartInterval(row, "fuel"));
  const hasScatter = hasScatterPlotData(field);
  const productionLastYear = fieldProduction(field);
  const productionChip = `<span class="field-meta-chip production-meta-chip"><span class="field-meta-icon">${icon("trend")}</span><span class="field-meta-copy"><small>Production</small><strong>${escapeHtml(formatAnnualProduction(productionLastYear))}</strong></span></span>`;
  const reserveChip = hasForecast ? `<span class="field-meta-chip"><span class="field-meta-icon">${icon("reserve")}</span><span class="field-meta-copy"><small>Reserves</small><strong>${Number.isFinite(remaining) ? `${remaining.toFixed(1)}M Sm³ o.e.` : "Unavailable"}</strong></span></span>` : "";
  const forecastLegend = hasForecast
    ? `${hasInterval ? '<span class="interval-key"><i></i>Q10–Q90</span><span class="inner-interval-key"><i></i>Q30–Q70</span>' : ""}<span class="forecast-key"><i></i>${hasInterval ? "Median" : "Forecast"}</span>`
    : "";
  state.inspectorRenderCount += 1;
  els.inspector.classList.toggle("no-scatter", !hasScatter);
  els.inspector.innerHTML = `
    <div class="inspector-content global-inspector${hasForecast ? " has-footer-spacing" : ""}" data-render-token="${state.inspectorRenderCount}">
      <div class="inspector-head simplified-inspector-head integrated-field-head">
        <span class="field-icon">${icon("rig")}</span>
        <div class="field-head-copy">
          <div class="field-title-row field-identity-row"><h2>${escapeHtml(field.field)}</h2><span class="status-inline${isShut ? " shut" : ""}">${escapeHtml(field.status)}</span></div>
          <div class="field-meta-row">${powerBadge(field)}${futurePowerBadge(field)}<span class="field-meta-chip"><span class="field-meta-icon">${icon("history")}</span><span class="field-meta-copy"><small>History</small><strong>${escapeHtml(formatHistoryLength(field.months_total))}</strong></span></span>${productionChip}${reserveChip}</div>
        </div>
        <div class="field-nav-controls" role="group" aria-label="Navigate visible fields">
          <button type="button" data-field-nav="previous" aria-label="Previous field"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5 5.5 5 5.5"></path></svg></button>
          <button type="button" data-field-nav="next" aria-label="Next field"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 4.5 5 5.5-5 5.5"></path></svg></button>
        </div>
      </div>

      <section class="chart-section global-chart-section">
        <div class="metric-tabs" aria-label="Forecast metric">
          <button class="active" type="button" data-metric="production">Production</button>
          ${hasFuel ? '<button type="button" data-metric="fuel">Fuel gas</button>' : ""}
          ${hasForecast ? '<button type="button" data-metric="reserves">Remaining reserves</button>' : ""}
        </div>
        <div class="chart-card">
          <div class="chart-head">
            <div><h3 data-chart-title>${hasForecast ? "Production history &amp; forecast" : "Production history"}</h3><p data-chart-summary></p></div>
            <div class="chart-head-actions"><label class="chart-smoothing"><input type="checkbox" data-chart-smoothing ${state.smoothCharts ? "checked" : ""}><span aria-hidden="true"></span>12-month MA</label><div class="chart-legend series-legend"><span class="history-key"><i></i>Historical</span>${forecastLegend}</div></div>
          </div>
          <div class="chart-mount" data-chart></div>
          ${hasForecast ? `<div class="range-row">
            <div class="range-tabs" aria-label="Forecast range">
              <button type="button" data-range="72">6 years</button>
              <button type="button" data-range="300">25 years</button>
            </div>
          </div>` : ""}
        </div>
      </section>

      ${renderFuelSupplierNotice(field)}
    </div>`;
  updateFieldNavigation();
  wireInspector();
  wireScatterControls();
  updateChartSection();
}

function wireInspector() {
  els.inspector.querySelectorAll("[data-field-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = state.visibleFields.find((field) => field.key === button.dataset.targetField);
      if (target) void selectField(target);
    });
  });
  els.inspector.querySelectorAll("[data-metric]").forEach((button) => {
    button.addEventListener("click", () => {
      state.metric = button.dataset.metric;
      updateChartSection();
    });
  });
  els.inspector.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.range = Number(button.dataset.range);
      updateChartSection({ animateNote: true });
    });
  });
  els.inspector.querySelector("[data-chart-smoothing]")?.addEventListener("change", (event) => {
    state.smoothCharts = event.currentTarget.checked;
    renderChart();
  });
  els.inspector.querySelector("[data-supplier-field-key]")?.addEventListener("click", (event) => {
    const supplier = state.fields.find((field) => field.key === event.currentTarget.dataset.supplierFieldKey);
    if (supplier) void selectField(supplier);
  });
}

function updateChartSection() {
  const forecast = state.forecasts.get(state.selected.key) || [];
  if (state.metric === "fuel" && !hasFuelGasData(state.selected, forecast)) state.metric = "production";
  const hasForecast = state.selected.hasForecast && forecast.length > 0;
  const forecastWindow = visibleForecast(forecast, effectiveRange());
  const firstYear = forecast.slice(0, 12);
  const total = firstYear.reduce((sum, row) => sum + number(chartValue(row, state.metric)), 0);
  const hasInterval = forecast.some((row) => chartInterval(row, state.metric));
  const title = els.inspector.querySelector("[data-chart-title]");
  const summary = els.inspector.querySelector("[data-chart-summary]");
  if (title) title.textContent = state.metric === "fuel"
    ? state.selected.fuelForecastMethod === "external_power_zero" ? "Field-level fuel accounting" : `Fuel-gas history${hasForecast ? " & forecast" : ""}`
    : state.metric === "reserves" ? "Remaining reserves history & forecast" : `Production history${hasForecast ? " & forecast" : ""}`;
  if (summary) {
    if (!hasForecast) {
      const observed = historyFor(state.selected).filter((row) => Number.isFinite(historyValue(row, state.metric))).length;
      summary.textContent = `${observed} observed monthly values`;
    } else if (state.metric === "fuel" && state.selected.fuelForecastMethod === "external_power_zero") {
      summary.textContent = `No field-level fuel · accounted at ${state.selected.fuelSourceField || "host"}`;
    } else if (state.metric === "fuel" && state.selected.fuelZeroFromMonth) {
      summary.textContent = `Modeled normally, then fixed at zero from ${formatMonthLabel(state.selected.fuelZeroFromMonth)} for planned electrification`;
    } else if (state.metric === "reserves") {
      const start = numericOrNaN(forecast[0]?.remaining_reserves_start_msm3oe);
      summary.textContent = `${formatValue(start, "reserves")} now`;
    } else {
      summary.textContent = `${formatValue(total, state.metric)} in the first forecasted year${hasInterval ? " · sum of monthly medians" : ""}`;
    }
  }
  els.inspector.querySelectorAll("[data-metric]").forEach((button) => button.classList.toggle("active", button.dataset.metric === state.metric));
  els.inspector.querySelectorAll("[data-range]").forEach((button) => button.classList.toggle("active", Number(button.dataset.range) === state.range));
  const rangeRow = els.inspector.querySelector(".range-row");
  if (rangeRow) rangeRow.hidden = !hasForecast || state.metric === "reserves";
  const smoothing = els.inspector.querySelector("[data-chart-smoothing]");
  if (smoothing) {
    smoothing.checked = state.smoothCharts;
    smoothing.disabled = state.metric === "reserves";
    smoothing.closest(".chart-smoothing")?.classList.toggle("disabled", state.metric === "reserves");
  }
  renderChart();
}

function chartValue(row, metric = state.metric) {
  const base = metric === "reserves"
    ? "remaining_reserves_end_msm3oe"
    : metric === "fuel" ? "fuel_gas_forecast_msm3" : "production_forecast_msm3oe";
  const median = numericOrNaN(row[`${base}_q50`]);
  return Number.isFinite(median) ? median : numericOrNaN(row[base]);
}

function chartInterval(row, metric = state.metric) {
  const base = metric === "reserves"
    ? "remaining_reserves_end_msm3oe"
    : metric === "fuel" ? "fuel_gas_forecast_msm3" : "production_forecast_msm3oe";
  const low = numericOrNaN(row[`${base}_q10`]);
  const innerLow = numericOrNaN(row[`${base}_q30`]);
  const innerHigh = numericOrNaN(row[`${base}_q70`]);
  const high = numericOrNaN(row[`${base}_q90`]);
  return Number.isFinite(low) && Number.isFinite(high)
    ? { low, innerLow, innerHigh, high }
    : null;
}

function tooltipNumber(value) {
  const numeric = number(value, NaN);
  if (!Number.isFinite(numeric)) return "—";
  const digits = Math.abs(numeric) < 1 ? 3 : 2;
  return numeric.toLocaleString("en", { maximumFractionDigits: digits });
}

function metricUnit(metric) {
  if (metric === "fuel") return "million Sm³";
  if (metric === "reserves") return "million Sm³ o.e. remaining";
  return "million Sm³ o.e.";
}

function historyValue(row, metric = state.metric) {
  if (metric === "reserves") return numericOrNaN(row.reserves);
  return numericOrNaN(metric === "fuel" ? row.fuel : row.production);
}

function monthOrdinal(month) {
  const match = String(month || "").match(/^(\d{4})-(\d{2})/);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : NaN;
}

function decimalPlacesForStep(step) {
  if (!Number.isFinite(step)) return null;
  for (let places = 0; places <= 3; places += 1) {
    const scaled = step * (10 ** places);
    if (Math.abs(scaled - Math.round(scaled)) < 0.0000001) return places;
  }
  return 3;
}

function formatAxisNumber(value, step = NaN) {
  const absolute = Math.abs(value);
  if (value === 0) return "0";
  if (absolute >= 1000) return `${(value / 1000).toFixed(absolute >= 10000 ? 0 : 1)}k`;
  const stepPlaces = decimalPlacesForStep(step);
  if (stepPlaces !== null) return value.toFixed(stepPlaces);
  if (absolute < 0.1) return value.toFixed(2);
  if (absolute < 10) return value.toFixed(1);
  return Math.round(value).toLocaleString("en");
}

function niceScale(maxValue, targetIntervals = 5) {
  const safeMax = Math.max(number(maxValue, 0), 0.000001);
  const roughStep = safeMax / Math.max(2, targetIntervals);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  const max = Math.ceil(safeMax / step) * step;
  const ticks = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return { max, step, ticks };
}

function forecastShutdown(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const production = chartValue(row, "production");
    if (!Number.isFinite(production) || production > 0.000001) continue;
    const staysAtZero = rows.slice(index).every((item) => {
      const value = chartValue(item, "production");
      return !Number.isFinite(value) || value <= 0.000001;
    });
    if (staysAtZero) return { index, month: row.month };
  }
  return null;
}

function visibleForecast(rows, range = state.range) {
  const shutdown = forecastShutdown(rows);
  const limit = shutdown && shutdown.index < range ? shutdown.index + 1 : range;
  return { rows: rows.slice(0, limit), shutdown: shutdown && shutdown.index < range ? shutdown : null };
}

function effectiveRange(metric = state.metric) {
  return metric === "reserves" ? 300 : state.range;
}

function visibleHistory(rows, forecastRows, range = effectiveRange()) {
  const start = monthOrdinal(forecastRows[0]?.month);
  const historyMonths = range === 12 ? 48 : range === 72 ? 144 : Infinity;
  if (!Number.isFinite(start)) return rows;
  const available = rows.filter((row) => monthOrdinal(row.month) < start);
  return Number.isFinite(historyMonths) ? available.slice(-historyMonths) : available;
}

function chartTickOrdinals(start, end) {
  const span = Math.max(1, end - start);
  let step;
  let first;
  if (span <= 42) {
    step = 6;
    first = Math.ceil(start / step) * step;
  } else {
    step = span <= 96 ? 12 : span <= 180 ? 24 : 60;
    const startYear = Math.floor(start / 12);
    const yearStep = step / 12;
    first = Math.ceil(startYear / yearStep) * yearStep * 12;
    if (first < start) first += step;
  }
  const ticks = [];
  for (let value = first; value <= end; value += step) ticks.push(value);
  return ticks;
}

function tickLabel(ordinal, span) {
  const year = Math.floor(ordinal / 12);
  const month = (ordinal % 12) + 1;
  return span <= 42 ? `${year}-${String(month).padStart(2, "0")}` : String(year);
}

function seriesPaths(rows, getValue, x, y, className, maxGap = 1) {
  const segments = [];
  let segment = [];
  let previousMonth = NaN;
  const flush = () => {
    if (segment.length > 1) segments.push(segment);
    segment = [];
  };
  rows.forEach((row) => {
    const value = getValue(row);
    const ordinal = monthOrdinal(row.month);
    if (!Number.isFinite(value) || !Number.isFinite(ordinal)) {
      flush();
      previousMonth = NaN;
      return;
    }
    if (Number.isFinite(previousMonth) && ordinal - previousMonth > maxGap) flush();
    segment.push({ row, ordinal, value });
    previousMonth = ordinal;
  });
  flush();
  return segments.map((points) => `<path class="chart-path ${className}" d="${points.map((point, index) => `${index ? "L" : "M"}${x(point.ordinal).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ")}"></path>`).join("");
}

function intervalAreaPaths(rows, x, y, className, maxGap = 1, lowKey = "low", highKey = "high") {
  const segments = [];
  let segment = [];
  let previousMonth = NaN;
  const flush = () => {
    if (segment.length > 1) segments.push(segment);
    segment = [];
  };
  rows.forEach((row) => {
    const ordinal = monthOrdinal(row.month);
    if (!Number.isFinite(row[lowKey]) || !Number.isFinite(row[highKey]) || !Number.isFinite(ordinal)) {
      flush();
      previousMonth = NaN;
      return;
    }
    if (Number.isFinite(previousMonth) && ordinal - previousMonth > maxGap) flush();
    segment.push({ ordinal, low: row[lowKey], high: row[highKey] });
    previousMonth = ordinal;
  });
  flush();
  return segments.map((points) => {
    const upper = points.map((point, index) => `${index ? "L" : "M"}${x(point.ordinal).toFixed(2)},${y(point.high).toFixed(2)}`).join(" ");
    const lower = [...points].reverse().map((point) => `L${x(point.ordinal).toFixed(2)},${y(point.low).toFixed(2)}`).join(" ");
    return `<path class="${className}" d="${upper} ${lower} Z"></path>`;
  }).join("");
}

function movingAveragePoints(points, windowSize = 12) {
  const queue = [];
  let previousOrdinal = NaN;
  return points.flatMap((point) => {
    const ordinal = monthOrdinal(point.month);
    if (!Number.isFinite(point.value) || !Number.isFinite(ordinal)) {
      queue.length = 0;
      previousOrdinal = NaN;
      return [];
    }
    if (Number.isFinite(previousOrdinal) && ordinal - previousOrdinal > 1) queue.length = 0;
    previousOrdinal = ordinal;
    queue.push(point);
    if (queue.length > windowSize) queue.shift();
    if (queue.length < windowSize) return [];
    const mean = (key) => {
      const values = queue.map((item) => item[key]).filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
    };
    return [{
      ...point,
      value: mean("value"),
      low: mean("low"),
      innerLow: mean("innerLow"),
      innerHigh: mean("innerHigh"),
      high: mean("high"),
    }];
  });
}

function updateChartLegend(container, hasInterval, smooth) {
  const labels = {
    ".history-key": smooth ? "Historical MA" : "Historical",
    ".interval-key": smooth ? "Q10–Q90 MA" : "Q10–Q90",
    ".inner-interval-key": smooth ? "Q30–Q70 MA" : "Q30–Q70",
    ".forecast-key": hasInterval ? (smooth ? "Median MA" : "Median") : (smooth ? "Forecast MA" : "Forecast"),
  };
  Object.entries(labels).forEach(([selector, label]) => {
    const item = container.querySelector(selector);
    if (item) {
      item.innerHTML = `<i></i>${label}`;
      item.title = smooth
        ? "12-month averages of the monthly series and quantile boundaries, not quantiles of 12-month averages."
        : "";
    }
  });
}

function renderChart() {
  const mount = els.inspector.querySelector("[data-chart]");
  if (!mount) return;
  const window = visibleForecast(state.forecasts.get(state.selected.key) || [], effectiveRange());
  const forecast = window.rows;
  const sourceHistory = state.metric === "reserves" ? (state.reservesHistories.get(state.selected.key) || []) : historyFor(state.selected);
  const history = visibleHistory(sourceHistory, forecast);
  updateChartLegend(els.inspector, forecast.some((row) => chartInterval(row, state.metric)), state.smoothCharts && state.metric !== "reserves");
  const phaseLabel = forecast.length ? "history and forecast" : "history";
  renderForecastChart(mount, history, forecast, state.metric, `${state.selected.field} ${state.metric} ${phaseLabel}`, {
    shutdownMonth: window.shutdown?.month,
    electrificationMonth: state.metric === "fuel" ? state.selected.fuelZeroFromMonth : "",
    smooth: state.smoothCharts,
  });
}

function renderForecastChart(mount, historyRows, forecastRows, metric, label, options = {}) {
  if (!forecastRows.length && !historyRows.length) {
    mount.innerHTML = '<p class="chart-empty">History unavailable.</p>';
    return;
  }
  // Keep aggregate chart text at a readable size instead of shrinking a desktop SVG.
  const width = options.aggregate ? Math.min(520, mount.clientWidth || 520) : 520;
  const height = options.aggregate && width < 520 ? 230 : 190;
  const margin = { top: 20, right: 14, bottom: 27, left: 42 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const rawHistoryPoints = historyRows.map((row) => ({ ...row, phase: "Historical", value: historyValue(row, metric) }));
  const rawForecastPoints = forecastRows.map((row) => {
    const interval = chartInterval(row, metric);
    return {
      ...row,
      phase: "Forecast",
      value: chartValue(row, metric),
      low: interval?.low ?? NaN,
      innerLow: interval?.innerLow ?? NaN,
      innerHigh: interval?.innerHigh ?? NaN,
      high: interval?.high ?? NaN,
    };
  });
  const allPoints = options.smooth && metric !== "reserves" ? movingAveragePoints([...rawHistoryPoints, ...rawForecastPoints]) : [...rawHistoryPoints, ...rawForecastPoints];
  const historyPoints = allPoints.filter((row) => row.phase === "Historical");
  const forecastPoints = allPoints.filter((row) => row.phase === "Forecast");
  const values = allPoints.flatMap((row) => [row.value, row.high]).filter(Number.isFinite);
  const allZero = values.length > 0 && values.every((value) => Math.abs(value) <= 0.000000001);
  const yScale = allZero ? { max: 1, step: 1, ticks: [0] } : niceScale(Math.max(...values, 0.001) * 1.04, 5);
  const max = yScale.max;
  const startOrdinal = Math.min(...allPoints.map((row) => monthOrdinal(row.month)).filter(Number.isFinite));
  const endOrdinal = Math.max(...allPoints.map((row) => monthOrdinal(row.month)).filter(Number.isFinite));
  const span = Math.max(1, endOrdinal - startOrdinal);
  const x = (ordinal) => margin.left + ((ordinal - startOrdinal) / span) * innerWidth;
  const y = (value) => margin.top + innerHeight - (value / max) * innerHeight;
  const grid = yScale.ticks
    .map((value) => {
      const tickY = y(value);
      return `<line class="chart-grid" x1="${margin.left}" y1="${tickY}" x2="${width - margin.right}" y2="${tickY}"></line><text class="chart-axis-label" x="${margin.left - 6}" y="${tickY + 3}" text-anchor="end">${formatAxisNumber(value, yScale.step)}</text>`;
    })
    .join("");
  const ticks = chartTickOrdinals(startOrdinal, endOrdinal);
  const tickStride = options.aggregate ? Math.max(1, Math.ceil(ticks.length / Math.max(2, Math.floor(innerWidth / 44)))) : 1;
  const axisLabels = ticks.filter((_, index) => index % tickStride === 0).map((ordinal) => `<text class="chart-axis-label" x="${x(ordinal)}" y="${height - 7}" text-anchor="middle">${tickLabel(ordinal, span)}</text>`).join("");
  const historyPaths = seriesPaths(historyPoints, (row) => row.value, x, y, "history-line", metric === "reserves" ? 13 : 1);
  const forecastPaths = seriesPaths(forecastPoints, (row) => row.value, x, y, "forecast-line");
  const outerIntervalPaths = intervalAreaPaths(forecastPoints, x, y, "forecast-interval");
  const innerIntervalPaths = intervalAreaPaths(forecastPoints, x, y, "forecast-inner-interval", 1, "innerLow", "innerHigh");
  const forecastStart = monthOrdinal(forecastRows[0]?.month);
  const boundaryX = Number.isFinite(forecastStart) ? x(forecastStart) : null;
  const forecastLabelWidth = 34;
  const forecastLabelX = Number.isFinite(boundaryX) ? Math.min(width - margin.right - forecastLabelWidth, Math.max(margin.left + 2, boundaryX + 4)) : null;
  const forecastBoundaryLine = Number.isFinite(boundaryX) ? `
      <line class="forecast-boundary" x1="${boundaryX}" y1="${margin.top - 3}" x2="${boundaryX}" y2="${height - margin.bottom}"></line>` : "";
  const forecastBoundaryLabel = Number.isFinite(boundaryX) ? `
      <g class="chart-boundary-label forecast-label-group"><rect x="${forecastLabelX}" y="2" width="${forecastLabelWidth}" height="18" rx="4.5"></rect><text class="forecast-boundary-label" x="${forecastLabelX + 3}" y="9"><tspan>Forecast</tspan><tspan x="${forecastLabelX + 3}" dy="7">starts</tspan></text></g>` : "";
  const shutdownX = options.shutdownMonth ? x(monthOrdinal(options.shutdownMonth)) : null;
  const shutdownLabelX = Number.isFinite(shutdownX) ? Math.min(width - margin.right - 48, Math.max(margin.left + 2, shutdownX - 48)) : null;
  const shutdownBoundaryLine = Number.isFinite(shutdownX) ? `
      <line class="shutdown-boundary" x1="${shutdownX}" y1="${margin.top}" x2="${shutdownX}" y2="${height - margin.bottom}"></line>
      <circle class="shutdown-dot" cx="${shutdownX}" cy="${y(0)}" r="3.6"></circle>` : "";
  const shutdownBoundaryLabel = Number.isFinite(shutdownX) ? `
      <g class="chart-boundary-label shutdown-label-group"><rect x="${shutdownLabelX}" y="25" width="48" height="20" rx="5"></rect><text class="shutdown-label" x="${shutdownLabelX + 4}" y="33"><tspan>Forecasted</tspan><tspan x="${shutdownLabelX + 4}" dy="7.5">shutdown</tspan></text></g>` : "";
  const electrificationOrdinal = monthOrdinal(options.electrificationMonth);
  const electrificationX = Number.isFinite(electrificationOrdinal) && electrificationOrdinal >= startOrdinal && electrificationOrdinal <= endOrdinal
    ? x(electrificationOrdinal)
    : null;
  const electrificationLabelX = Number.isFinite(electrificationX)
    ? Math.min(width - margin.right - 49, Math.max(margin.left + 2, electrificationX - 49))
    : null;
  const electrificationBoundaryLine = Number.isFinite(electrificationX) ? `
      <line class="electrification-boundary" x1="${electrificationX}" y1="${margin.top}" x2="${electrificationX}" y2="${height - margin.bottom}"></line>
      <circle class="electrification-dot" cx="${electrificationX}" cy="${y(0)}" r="3.6"></circle>` : "";
  const electrificationBoundaryLabel = Number.isFinite(electrificationX) ? `
      <g class="chart-boundary-label electrification-label-group"><rect x="${electrificationLabelX}" y="48" width="49" height="20" rx="5"></rect><text class="electrification-label" x="${electrificationLabelX + 4}" y="56"><tspan>Shore power,</tspan><tspan x="${electrificationLabelX + 4}" dy="7.5">fuel = 0</tspan></text></g>` : "";
  mount.innerHTML = `
    <svg class="forecast-chart chart-crossfade-in${options.aggregate ? " aggregate-forecast-chart" : ""}" ${options.aggregate ? `style="aspect-ratio: ${width} / ${height}"` : ""} viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-label="${escapeHtml(label)}">
      ${grid}${axisLabels}${outerIntervalPaths}${innerIntervalPaths}${historyPaths}${forecastPaths}${shutdownBoundaryLine}${electrificationBoundaryLine}${forecastBoundaryLine}
      ${shutdownBoundaryLabel}${electrificationBoundaryLabel}${forecastBoundaryLabel}
      <g data-chart-cursor hidden><line class="chart-crosshair" y1="${margin.top}" y2="${height - margin.bottom}"></line><circle class="chart-dot" r="4"></circle></g>
      <rect class="chart-hit-area" x="${margin.left}" y="${margin.top}" width="${innerWidth}" height="${innerHeight}"></rect>
    </svg>
    <div class="chart-tooltip" data-chart-tooltip hidden></div>`;
  const svg = mount.querySelector("svg");
  const hit = mount.querySelector(".chart-hit-area");
  const cursor = mount.querySelector("[data-chart-cursor]");
  const tooltip = mount.querySelector("[data-chart-tooltip]");
  hit.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    const targetOrdinal = startOrdinal + ((svgX - margin.left) / innerWidth) * span;
    const candidates = allPoints.filter((row) => Number.isFinite(row.value));
    const point = candidates.reduce((best, row) => Math.abs(monthOrdinal(row.month) - targetOrdinal) < Math.abs(monthOrdinal(best.month) - targetOrdinal) ? row : best, candidates[0]);
    if (!point) return;
    const value = point.value;
    const pointX = x(monthOrdinal(point.month));
    cursor.removeAttribute("hidden");
    cursor.querySelector("line").setAttribute("x1", pointX);
    cursor.querySelector("line").setAttribute("x2", pointX);
    cursor.querySelector("circle").setAttribute("cx", pointX);
    cursor.querySelector("circle").setAttribute("cy", y(value));
    tooltip.hidden = false;
    const hasOuter = Number.isFinite(point.low) && Number.isFinite(point.high);
    const hasInner = Number.isFinite(point.innerLow) && Number.isFinite(point.innerHigh);
    const intervalRows = hasOuter ? `
      ${hasInner ? `<span>Q30–Q70${options.smooth && metric !== "reserves" ? " MA" : ""}</span><b>${tooltipNumber(point.innerLow)}–${tooltipNumber(point.innerHigh)}</b>` : ""}
      <span>Q10–Q90${options.smooth && metric !== "reserves" ? " MA" : ""}</span><b>${tooltipNumber(point.low)}–${tooltipNumber(point.high)}</b>` : "";
    const smoothed = options.smooth && metric !== "reserves";
    tooltip.innerHTML = `<strong>${escapeHtml(point.month)} · ${escapeHtml(point.phase)}</strong>
      <div class="chart-tooltip-table"><span>${hasOuter ? (smoothed ? "Median MA" : "Median") : (smoothed ? "12-month mean" : "Value")}</span><b>${tooltipNumber(value)}</b>${intervalRows}</div>
      <small>${escapeHtml(metricUnit(metric))}${smoothed && hasOuter ? " · averages of monthly quantiles" : ""}</small>`;
    const localX = (pointX / width) * rect.width;
    tooltip.style.left = `${Math.max(2, Math.min(rect.width - tooltip.offsetWidth - 2, localX + 9))}px`;
    tooltip.style.top = `${Math.max(4, (y(value) / height) * rect.height - 12)}px`;
    options.onHover?.(point);
  });
  hit.addEventListener("pointerleave", () => {
    cursor.setAttribute("hidden", "");
    tooltip.hidden = true;
    options.onLeave?.();
  });
}

async function ensureAggregateForecast() {
  if (state.aggregateForecast) return state.aggregateForecast;
  if (!state.aggregateForecastPromise) {
    state.aggregateForecastPromise = getText(DATA_URLS.aggregateQuantiles)
      .then((text) => {
        const rows = parseCsv(text);
        if (!rows.length || rows.some((row) => !chartInterval(row, "production") || !chartInterval(row, "fuel"))) {
          throw new Error("Aggregate forecast quantiles are incomplete.");
        }
        return rows;
      })
      .finally(() => { state.aggregateForecastPromise = null; });
  }
  const forecast = await state.aggregateForecastPromise;
  const historyMonths = new Map();
  state.fields.forEach((field) => {
    historyFor(field).forEach((row) => {
      const aggregate = historyMonths.get(row.month) || { month: row.month, production: 0, fuel: 0, productionSeen: 0, fuelSeen: 0 };
      const production = numericOrNaN(row.production);
      const fuel = numericOrNaN(row.fuel);
      if (Number.isFinite(production)) {
        aggregate.production += production;
        aggregate.productionSeen += 1;
      }
      if (Number.isFinite(fuel)) {
        aggregate.fuel += fuel;
        aggregate.fuelSeen += 1;
      }
      historyMonths.set(row.month, aggregate);
    });
  });
  state.aggregateHistory = [...historyMonths.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((row) => ({ month: row.month, production: row.productionSeen ? row.production : null, fuel: row.fuelSeen ? row.fuel : null }));
  state.aggregateForecast = forecast;
  return forecast;
}

async function loadAggregateContributors() {
  if (state.aggregateContributorData || state.aggregateContributorPromise) return;
  state.aggregateContributorError = false;
  updateAggregateContributors(state.aggregateHoverPoint);
  state.aggregateContributorPromise = getJson(DATA_URLS.aggregateContributors);
  try {
    const data = await state.aggregateContributorPromise;
    if (!data.firstYear || !data.months) throw new Error("Contributor data is incomplete.");
    state.aggregateContributorData = data;
  } catch (error) {
    state.aggregateContributorError = true;
    console.warn("Could not load field contributors.", error);
  } finally {
    state.aggregateContributorPromise = null;
    if (state.view === "aggregate") updateAggregateContributors(state.aggregateHoverPoint);
  }
}

function aggregateContributors(point = null) {
  let rows;
  if (!point || point.phase === "Forecast") {
    if (!state.aggregateContributorData) {
      return state.aggregateContributorError
        ? '<p>Contributors could not be loaded. <button type="button" data-retry-contributors>Retry</button></p>'
        : '<p>Loading contributors…</p>';
    }
    const period = point ? state.aggregateContributorData.months[point.month] : state.aggregateContributorData.firstYear;
    rows = (period?.[state.metric] || []).map((row) => ({ field: row.field, [state.metric]: row.value }));
  } else {
    rows = state.fields.map((field) => {
      const row = historyFor(field).find((item) => item.month === point.month);
      return { field: field.field, [state.metric]: row ? historyValue(row, state.metric) : 0 };
    });
  }
  rows = [...rows].filter((row) => Number.isFinite(row[state.metric]) && row[state.metric] > 0).sort((a, b) => b[state.metric] - a[state.metric]).slice(0, 10);
  const max = rows[0]?.[state.metric] || 1;
  return rows.map((row) => `<div class="aggregate-contributor"><div><strong>${escapeHtml(row.field)}</strong><span>${escapeHtml(formatCompactValue(row[state.metric], state.metric))}</span></div><i style="--share:${Math.max(2, (row[state.metric] / max) * 100)}%"></i></div>`).join("");
}

function updateAggregateContributors(point = null) {
  state.aggregateHoverPoint = point;
  const card = els.aggregateView.querySelector(".aggregate-contributors-card");
  if (!card) return;
  const eyebrow = card.querySelector("[data-contributor-period]");
  const title = card.querySelector("[data-contributor-title]");
  const list = card.querySelector("[data-aggregate-contributors]");
  if (eyebrow) eyebrow.textContent = point ? `${point.month} · ${point.phase}` : "First forecasted year";
  if (title) title.textContent = "Top 10 contributors";
  if (list) list.innerHTML = aggregateContributors(point);
}

let aggregateChartObserver;

function renderAggregate() {
  aggregateChartObserver?.disconnect();
  const forecast = state.aggregateForecast || [];
  const hasInterval = forecast.some((row) => chartInterval(row, "production") || chartInterval(row, "fuel"));
  els.aggregateView.innerHTML = `
    <div class="aggregate-panel compact-aggregate-panel">
      <div class="aggregate-grid">
        <section class="aggregate-chart-section">
          <div class="metric-tabs" aria-label="Aggregate forecast metric">
            <button type="button" data-aggregate-metric="production">Production</button>
            <button type="button" data-aggregate-metric="fuel">Fuel gas</button>
          </div>
          <div class="chart-card aggregate-chart-card">
            <div class="chart-head"><div><h3 data-aggregate-chart-title></h3><p data-aggregate-chart-summary></p></div><div class="chart-head-actions"><label class="chart-smoothing"><input type="checkbox" data-aggregate-smoothing ${state.smoothCharts ? "checked" : ""}><span aria-hidden="true"></span>12-month MA</label><div class="chart-legend series-legend"><span class="history-key"><i></i>Historical</span>${hasInterval ? '<span class="interval-key"><i></i>Q10–Q90</span><span class="inner-interval-key"><i></i>Q30–Q70</span>' : ""}<span class="forecast-key"><i></i>${hasInterval ? "Median" : "Forecast"}</span></div></div></div>
            <div class="chart-mount" data-aggregate-chart></div>
            <div class="range-row"><div class="range-tabs" aria-label="Aggregate forecast range">
              <button type="button" data-aggregate-range="72">6 years</button><button type="button" data-aggregate-range="300">25 years</button>
            </div></div>
          </div>
        </section>
        <aside class="aggregate-contributors-card"><p class="eyebrow" data-contributor-period>First forecasted year</p><h2 data-contributor-title>Top 10 contributors</h2><div data-aggregate-contributors></div></aside>
      </div>
    </div>`;
  els.aggregateView.querySelectorAll("[data-aggregate-metric]").forEach((button) => button.addEventListener("click", () => {
    state.metric = button.dataset.aggregateMetric;
    updateAggregateChart();
  }));
  els.aggregateView.querySelectorAll("[data-aggregate-range]").forEach((button) => button.addEventListener("click", () => {
    state.aggregateRange = Number(button.dataset.aggregateRange);
    updateAggregateChart({ animateNote: true });
  }));
  els.aggregateView.querySelector("[data-aggregate-smoothing]")?.addEventListener("change", (event) => {
    state.smoothCharts = event.currentTarget.checked;
    updateAggregateChart();
  });
  updateAggregateChart();
  const chartMount = els.aggregateView.querySelector("[data-aggregate-chart]");
  let chartWidth = chartMount.clientWidth;
  aggregateChartObserver = new ResizeObserver(() => {
    const nextWidth = chartMount.clientWidth;
    if (nextWidth > 0 && nextWidth !== chartWidth) {
      chartWidth = nextWidth;
      updateAggregateChart();
    }
  });
  aggregateChartObserver.observe(chartMount);
  animateView(els.aggregateView);
  void loadAggregateContributors();
}

function updateAggregateChart() {
  const forecast = state.aggregateForecast || [];
  const firstYear = forecast.slice(0, 12);
  const total = firstYear.reduce((sum, row) => sum + chartValue(row), 0);
  const hasInterval = forecast.some((row) => chartInterval(row, state.metric));
  const title = els.aggregateView.querySelector("[data-aggregate-chart-title]");
  const summary = els.aggregateView.querySelector("[data-aggregate-chart-summary]");
  if (title) title.textContent = state.metric === "fuel" ? "NCS fuel-gas history & forecast" : "NCS production history & forecast";
  const forecastFieldCount = state.fields.filter((field) => field.hasForecast).length;
  if (summary) summary.textContent = `${formatValue(total, state.metric)} across ${forecastFieldCount} forecast fields in the first forecasted year`;
  els.aggregateView.querySelectorAll("[data-aggregate-metric]").forEach((button) => {
    const active = button.dataset.aggregateMetric === state.metric;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  els.aggregateView.querySelectorAll("[data-aggregate-range]").forEach((button) => {
    const active = Number(button.dataset.aggregateRange) === state.aggregateRange;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const smoothing = els.aggregateView.querySelector("[data-aggregate-smoothing]");
  if (smoothing) smoothing.checked = state.smoothCharts;
  updateChartLegend(els.aggregateView, hasInterval, state.smoothCharts);
  updateAggregateContributors();
  const mount = els.aggregateView.querySelector("[data-aggregate-chart]");
  if (mount) {
    const forecastRows = forecast.slice(0, state.aggregateRange);
    const historyRows = visibleHistory(state.aggregateHistory || [], forecastRows, state.aggregateRange);
    renderForecastChart(mount, historyRows, forecastRows, state.metric, `NCS ${state.metric} history and aggregate forecast`, {
      aggregate: true,
      smooth: state.smoothCharts,
      onHover: updateAggregateContributors,
      onLeave: () => updateAggregateContributors(),
    });
  }
}

function accountingType(row) {
  const classification = String(row.power_source_class || "");
  if (/power_from_shore|shore_power|shore_planned/.test(classification)) return "shore";
  if (/host_supplied|host_gas|tieback/.test(classification) || row.fuel_forecast_method === "external_power_zero") return "host";
  return "field";
}

const ACCOUNTING_SHORE_NODES = {
  haugsneset: { id: "haugsneset", label: "Haugsneset / Kårstø", lon: 5.52, lat: 59.28, labelY: -7 },
  mongstad: { id: "mongstad", label: "Mongstad", lon: 5.03, lat: 60.81, labelY: -7 },
  kollsnes: { id: "kollsnes", label: "Kollsnes", lon: 4.84, lat: 60.55, labelY: 15 },
  nyhamna: { id: "nyhamna", label: "Nyhamna", lon: 6.95, lat: 62.84, labelY: -7 },
  lista: { id: "lista", label: "Lista", lon: 6.65, lat: 58.10, labelY: 15 },
  hyggevatn: { id: "hyggevatn", label: "Hyggevatn", lon: 23.67, lat: 70.66, labelY: -7 },
};

const ACCOUNTING_SHORE_NODE_BY_FIELD = {
  "EDVARD GRIEG": "haugsneset",
  "GINA KROG": "haugsneset",
  "IVAR AASEN": "haugsneset",
  "JOHAN SVERDRUP": "haugsneset",
  "SLEIPNER VEST": "haugsneset",
  "SLEIPNER ØST": "haugsneset",
  "GJØA": "mongstad",
  "MARTIN LINGE": "kollsnes",
  "OSEBERG": "kollsnes",
  "TROLL": "kollsnes",
  "ORMEN LANGE": "nyhamna",
  "VALHALL": "lista",
  "GOLIAT": "hyggevatn",
};

const ACCOUNTING_POWER_ROUTE_PARENT_BY_FIELD = {
  "EDVARD GRIEG": "JOHAN SVERDRUP",
  "GINA KROG": "JOHAN SVERDRUP",
  "SLEIPNER ØST": "GINA KROG",
  "SLEIPNER VEST": "SLEIPNER ØST",
  "IVAR AASEN": "EDVARD GRIEG",
  "HANZ": "IVAR AASEN",
};

function accountingShoreNode(field) {
  const configured = ACCOUNTING_SHORE_NODES[ACCOUNTING_SHORE_NODE_BY_FIELD[field.key]];
  if (configured) return configured;
  if (field.lat >= 68) return ACCOUNTING_SHORE_NODES.hyggevatn;
  if (field.lat >= 62) return ACCOUNTING_SHORE_NODES.nyhamna;
  if (field.lat >= 60) return ACCOUNTING_SHORE_NODES.kollsnes;
  return ACCOUNTING_SHORE_NODES.haugsneset;
}

function accountingConnections() {
  const fieldsByKey = new Map(state.fields.map((field) => [field.key, field]));
  return state.accountingRows.flatMap((row) => {
    const field = fieldsByKey.get(normalize(row.field_key || row.field));
    if (!field) return [];
    const type = accountingType(row);
    const accountedKey = normalize(row.fuel_accounted_field_key);
    const suppliedByKey = normalize(row.supplied_by_field_key);
    const directRegistryHost = suppliedByKey ? fieldsByKey.get(suppliedByKey) : null;
    const routeParent = directRegistryHost || fieldsByKey.get(ACCOUNTING_POWER_ROUTE_PARENT_BY_FIELD[field.key]);
    const registryHost = accountedKey ? fieldsByKey.get(accountedKey) : null;
    const host = routeParent || registryHost;
    const connectsToHost = host && host.key !== field.key;
    const directShore = type === "shore" && !connectsToHost;
    const shoreNode = directShore ? accountingShoreNode(field) : null;
    const offMapSupplier = type === "host" && !connectsToHost && Boolean(row.host_or_source_field);
    return [{
      row,
      field,
      host: connectsToHost ? host : null,
      shoreNode,
      offMapSupplier,
      type,
      routeKind: directShore ? "trunk" : type === "shore" && connectsToHost ? "distribution" : "host",
      mapped: Boolean(connectsToHost || directShore),
      start: directShore
        ? project(shoreNode.lon, shoreNode.lat)
        : connectsToHost
          ? project(host.lon, host.lat)
          : project(field.lon, field.lat),
      end: directShore || connectsToHost ? project(field.lon, field.lat) : null,
      targetLabel: directShore
        ? shoreNode.label
        : routeParent?.field
          || (offMapSupplier && OFF_MAP_SUPPLIER_LABELS[normalize(row.host_or_source_field)])
          || row.host_or_source_field
          || (row.fuel_forecast_method === "reported_conditioned_mlp" ? "Field-reported fuel" : "No active field series"),
    }];
  });
}

function accountingLandPaths() {
  const visibleCountries = new Set(["Norway", "Sweden", "Denmark", "United Kingdom", "Finland"]);
  const paths = [];
  for (const country of state.land?.countries || []) {
    if (!visibleCountries.has(country.name)) continue;
    for (const polygon of country.polygons || []) {
      const points = polygon
        .filter(([lon, lat]) => lon >= MAP.bbox.minLon - 5 && lon <= MAP.bbox.maxLon + 5 && lat >= MAP.bbox.minLat - 3 && lat <= MAP.bbox.maxLat + 3)
        .map(([lon, lat]) => project(lon, lat));
      if (points.length < 3) continue;
      paths.push(`<path class="land-shape" d="M${points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}Z"></path>`);
    }
  }
  return paths.join("");
}

function accountingDecision(entry) {
  if (entry.row.fuel_forecast_method === "external_power_zero") {
    return `Fuel is set to zero at ${entry.field.field}. Its power or processing energy is carried at ${entry.targetLabel}, so adding an inferred field series would count the same fuel twice.`;
  }
  if (entry.row.fuel_forecast_method === "reported_conditioned_mlp") {
    return `This field has its own reported fuel series. It stays in the aggregate and is forecast by the fuel MLP, even though its power setup includes a shore connection.`;
  }
  return "The registry keeps this connection visible, but no active field-level fuel forecast is added at this boundary.";
}

function accountingFieldRole(entry, supplierFieldKeys) {
  if (entry.type === "shore") return { label: "Shore", className: "shore" };
  if (supplierFieldKeys.has(entry.field.key)) return { label: "Host", className: "host" };
  if (entry.type === "host") return { label: "Supplied", className: "supplied" };
  return { label: "Self-supplied", className: "self-supplied" };
}

function accountingCategories(entry, supplierFieldKeys) {
  const categories = new Set();
  if (entry.type === "shore") categories.add("shore");
  if (entry.type === "host" || supplierFieldKeys.has(entry.field.key)) categories.add("shared");
  if (entry.type === "field" && !supplierFieldKeys.has(entry.field.key)) categories.add("self");
  return categories;
}

function accountingFixedTransform(x, y, view = state.accountingViewBox) {
  const inverseScale = view.width / MAP.width;
  return `matrix(${inverseScale.toFixed(5)} 0 0 ${inverseScale.toFixed(5)} ${Number(x).toFixed(2)} ${Number(y).toFixed(2)})`;
}

function syncAccountingMapScale() {
  const map = els.accountingView.querySelector("[data-accounting-map]");
  if (!map) return;
  const inverseScale = state.accountingViewBox.width / MAP.width;
  map.querySelectorAll("[data-accounting-fixed]").forEach((item) => {
    item.setAttribute("transform", accountingFixedTransform(item.dataset.x, item.dataset.y));
  });
  map.querySelectorAll("marker[data-accounting-arrow]").forEach((marker) => {
    marker.setAttribute("markerWidth", (5 * inverseScale).toFixed(4));
    marker.setAttribute("markerHeight", (5 * inverseScale).toFixed(4));
  });
}

function normalizedAccountingViewBox(next) {
  const target = {
    width: Math.max(ACCOUNTING_MIN_VIEWBOX.width, Math.min(MAP.width, next.width)),
    height: Math.max(ACCOUNTING_MIN_VIEWBOX.height, Math.min(MAP.height, next.height)),
  };
  target.x = Math.max(0, Math.min(MAP.width - target.width, next.x));
  target.y = Math.max(0, Math.min(MAP.height - target.height, next.y));
  return target;
}

function applyAccountingViewBox(target) {
  state.accountingViewBox = target;
  els.accountingView.querySelector("[data-accounting-map]")?.setAttribute("viewBox", `${target.x} ${target.y} ${target.width} ${target.height}`);
  syncAccountingMapScale();
}

function setAccountingViewBox(next, animate = true) {
  const target = normalizedAccountingViewBox(next);
  if (state.accountingViewAnimationFrame) cancelAnimationFrame(state.accountingViewAnimationFrame);
  if (!animate) {
    applyAccountingViewBox(target);
    state.accountingViewAnimationFrame = null;
    return;
  }
  const start = { ...state.accountingViewBox };
  const started = performance.now();
  function frame(now) {
    const progress = Math.min(1, (now - started) / 320);
    const eased = 1 - (1 - progress) ** 3;
    applyAccountingViewBox(Object.fromEntries(Object.keys(target).map((key) => [key, start[key] + (target[key] - start[key]) * eased])));
    if (progress < 1) state.accountingViewAnimationFrame = requestAnimationFrame(frame);
    else state.accountingViewAnimationFrame = null;
  }
  state.accountingViewAnimationFrame = requestAnimationFrame(frame);
}

function focusAccountingField(field) {
  const point = project(field.lon, field.lat);
  const { width, height } = ACCOUNTING_FIELD_FOCUS_VIEWBOX;
  setAccountingViewBox({
    x: point.x - width / 2,
    y: point.y - height / 2,
    width,
    height,
  });
}

function accountingRenderedViewport(map, view = state.accountingViewBox) {
  const rect = map.getBoundingClientRect();
  const elementRatio = rect.width / rect.height;
  const viewRatio = view.width / view.height;
  if (elementRatio > viewRatio) {
    const width = rect.height * viewRatio;
    return { rect, width, height: rect.height, offsetX: (rect.width - width) / 2, offsetY: 0 };
  }
  const height = rect.width / viewRatio;
  return { rect, width: rect.width, height, offsetX: 0, offsetY: (rect.height - height) / 2 };
}

function zoomAccountingMap(factor, event = null, animate = true) {
  const map = els.accountingView.querySelector("[data-accounting-map]");
  if (!map) return;
  const current = state.accountingViewBox;
  const width = Math.max(ACCOUNTING_MIN_VIEWBOX.width, Math.min(MAP.width, current.width * factor));
  const height = Math.max(ACCOUNTING_MIN_VIEWBOX.height, Math.min(MAP.height, current.height * factor));
  if (Math.abs(width - current.width) < 0.001 && Math.abs(height - current.height) < 0.001) return;
  const viewport = accountingRenderedViewport(map, current);
  const normalizedX = event ? Math.max(0, Math.min(1, (event.clientX - viewport.rect.left - viewport.offsetX) / viewport.width)) : 0.5;
  const normalizedY = event ? Math.max(0, Math.min(1, (event.clientY - viewport.rect.top - viewport.offsetY) / viewport.height)) : 0.5;
  const worldX = current.x + normalizedX * current.width;
  const worldY = current.y + normalizedY * current.height;
  setAccountingViewBox({
    x: worldX - normalizedX * width,
    y: worldY - normalizedY * height,
    width,
    height,
  }, animate);
}

function wireAccountingMap() {
  const map = els.accountingView.querySelector("[data-accounting-map]");
  if (!map) return;
  els.accountingView.querySelector("[data-accounting-zoom-in]")?.addEventListener("click", () => zoomAccountingMap(0.8));
  els.accountingView.querySelector("[data-accounting-zoom-out]")?.addEventListener("click", () => zoomAccountingMap(1.25));
  els.accountingView.querySelector("[data-accounting-zoom-reset]")?.addEventListener("click", () => setAccountingViewBox({ ...MAP.baseViewBox }));
  map.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAccountingMap(event.deltaY > 0 ? 1.12 : 0.88, event, false);
  }, { passive: false });
  map.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest?.("[data-accounting-index], [data-accounting-supplier-key]")) return;
    state.accountingMapDrag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      viewBox: { ...state.accountingViewBox },
    };
    map.classList.add("is-panning");
    map.setPointerCapture(event.pointerId);
  });
  map.addEventListener("pointermove", (event) => {
    const drag = state.accountingMapDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const viewport = accountingRenderedViewport(map, drag.viewBox);
    setAccountingViewBox({
      ...drag.viewBox,
      x: drag.viewBox.x - ((event.clientX - drag.x) / viewport.width) * drag.viewBox.width,
      y: drag.viewBox.y - ((event.clientY - drag.y) / viewport.height) * drag.viewBox.height,
    }, false);
  });
  const endPan = (event) => {
    const drag = state.accountingMapDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    state.accountingMapDrag = null;
    map.classList.remove("is-panning");
    if (map.hasPointerCapture(event.pointerId)) map.releasePointerCapture(event.pointerId);
  };
  map.addEventListener("pointerup", endPan);
  map.addEventListener("pointercancel", endPan);
}

function renderAccounting() {
  if (state.accountingViewAnimationFrame) {
    cancelAnimationFrame(state.accountingViewAnimationFrame);
    state.accountingViewAnimationFrame = null;
  }
  const previousList = els.accountingView.querySelector("[data-accounting-field-list]");
  if (previousList) state.accountingListScroll = previousList.scrollTop;
  const allConnections = accountingConnections()
    .filter((entry) => entry.field.statusGroup !== "Shut down")
    .sort((a, b) => a.field.field.localeCompare(b.field.field));
  const supplierFieldKeys = new Set(allConnections.filter((entry) => entry.host).map((entry) => entry.host.key));
  const connections = allConnections.filter((entry) => [...accountingCategories(entry, supplierFieldKeys)]
    .some((category) => state.accountingFilters.has(category)));
  const requestedSelection = state.accountingSelection || { kind: "field", key: null };
  let selectedIndex = requestedSelection.kind === "field"
    ? connections.findIndex((entry) => entry.field.key === requestedSelection.key)
    : -1;
  if (requestedSelection.kind === "field" && selectedIndex < 0 && connections.length) {
    selectedIndex = 0;
    state.accountingSelection = { kind: "field", key: connections[0].field.key };
  }
  const selected = selectedIndex >= 0 ? connections[selectedIndex] : null;
  const supplierKey = requestedSelection.kind === "supplier" ? requestedSelection.key : null;
  const supplier = supplierKey ? state.fields.find((field) => field.key === supplierKey) : null;
  const suppliedConnections = supplier
    ? allConnections.filter((entry) => entry.host?.key === supplier.key)
    : [];
  state.accountingSelected = selectedIndex;
  const mapped = connections.filter((entry) => entry.mapped);
  const accountingView = state.accountingViewBox;
  const arrowSize = (5 * accountingView.width / MAP.width).toFixed(4);
  const grid = [58, 62, 66, 70].map((lat) => {
    const { y } = project(0, lat);
    return `<line class="map-grid-line" x1="0" y1="${y}" x2="${MAP.width}" y2="${y}" vector-effect="non-scaling-stroke"></line><g data-accounting-fixed data-x="10" data-y="${y - 7}" transform="${accountingFixedTransform(10, y - 7, accountingView)}"><text class="map-grid-label" x="0" y="0">${lat}°N</text></g>`;
  }).join("");
  const linkMarkup = mapped.map((entry) => {
    const index = connections.indexOf(entry);
    const path = `M${entry.start.x.toFixed(1)},${entry.start.y.toFixed(1)} L${entry.end.x.toFixed(1)},${entry.end.y.toFixed(1)}`;
    const active = index === selectedIndex || (supplier && entry.host?.key === supplier.key) ? " active" : "";
    return `<g class="accounting-connection ${entry.type} ${entry.routeKind}${active}" data-accounting-index="${index}" tabindex="0" role="button" aria-label="Power from ${escapeHtml(entry.targetLabel)} to ${escapeHtml(entry.field.field)}">
      <path class="accounting-link" d="${path}" marker-end="url(#accountingArrow-${entry.type})" vector-effect="non-scaling-stroke"></path>
      <path class="accounting-flow-motion" d="${path}" vector-effect="non-scaling-stroke"></path>
      <path class="accounting-link-hit" d="${path}" vector-effect="non-scaling-stroke"></path>
      ${entry.shoreNode ? "" : `<g class="accounting-origin-marker" data-accounting-fixed data-x="${entry.start.x}" data-y="${entry.start.y}" transform="${accountingFixedTransform(entry.start.x, entry.start.y, accountingView)}"><circle class="accounting-origin" cx="0" cy="0" r="3.4"></circle></g>`}
    </g>`;
  }).join("");
  const visibleShoreNodes = new Map();
  mapped.filter((entry) => entry.shoreNode).forEach((entry) => visibleShoreNodes.set(entry.shoreNode.id, entry.shoreNode));
  const shoreNodes = [...visibleShoreNodes.values()].map((node) => {
    const point = project(node.lon, node.lat);
    return `<g class="accounting-shore-node" data-accounting-fixed data-x="${point.x}" data-y="${point.y}" transform="${accountingFixedTransform(point.x, point.y, accountingView)}"><circle cx="0" cy="0" r="4.5"></circle><text x="8" y="${node.labelY}">${escapeHtml(node.label)}</text></g>`;
  }).join("");
  const ownIndexByKey = new Map(connections.map((entry, index) => [entry.field.key, index]));
  const nodeEntries = new Map(connections.map((entry, index) => [entry.field.key, {
    field: entry.field,
    index,
    supplies: false,
    type: entry.type,
  }]));
  mapped.forEach((entry) => {
    const index = connections.indexOf(entry);
    if (entry.host) {
      const hostEntry = nodeEntries.get(entry.host.key) || { field: entry.host, index: ownIndexByKey.get(entry.host.key) ?? -1, supplies: false, type: "host" };
      hostEntry.supplies = true;
      nodeEntries.set(entry.host.key, hostEntry);
    }
  });
  const nodes = [...nodeEntries.values()].sort((a, b) => Number(a.supplies) - Number(b.supplies)).map(({ field, index, supplies, type }) => {
    const point = project(field.lon, field.lat);
    const isSelected = supplier?.key === field.key || (selected && (selected.field.key === field.key || selected.host?.key === field.key));
    const labelY = selected?.host?.key === field.key ? 16 : -9;
    const selectionAttribute = supplies ? `data-accounting-supplier-key="${escapeHtml(field.key)}"` : `data-accounting-index="${index}"`;
    const ariaLabel = supplies ? `View fields supplied by ${field.field}` : `View accounting for ${field.field}`;
    return `<g class="accounting-node${supplies ? " supplier" : ""}${type === "field" ? " self-supplied" : ""}${isSelected ? " active" : ""}" data-accounting-fixed data-x="${point.x}" data-y="${point.y}" ${selectionAttribute} transform="${accountingFixedTransform(point.x, point.y, accountingView)}" tabindex="0" role="button" aria-label="${escapeHtml(ariaLabel)}"><circle class="accounting-node-hit" cx="0" cy="0" r="12"></circle><circle class="accounting-node-core" cx="0" cy="0" r="${isSelected ? 6.5 : supplies ? 4.5 : 3.5}"></circle>${isSelected ? `<text x="9" y="${labelY}">${escapeHtml(field.field)}</text>` : ""}</g>`;
  }).join("");
  const detailField = supplier || selected?.field;
  const forecastButton = detailField ? `<button type="button" class="accounting-view-forecasts" data-accounting-view-field="${escapeHtml(detailField.key)}">View forecasts <span aria-hidden="true">→</span></button>` : "";
  const supplierDetail = supplier ? `<div class="accounting-detail-heading supplier"><span class="accounting-type supplier">Supplier field</span><h2>${escapeHtml(supplier.field)}</h2><p>${suppliedConnections.length} linked ${suppliedConnections.length === 1 ? "field" : "fields"}</p></div>${forecastButton}
    <p class="accounting-decision">Power or processing energy for these fields is supplied by ${escapeHtml(supplier.field)}. Their field-level fuel stays at zero where that energy is accounted at the supplier.</p>
    <div class="accounting-supplied-fields"><h3>Fields supplied</h3>${suppliedConnections.map((entry) => `<button type="button" data-accounting-child-key="${escapeHtml(entry.field.key)}"><span><strong>${escapeHtml(entry.field.field)}</strong><small>${entry.type === "shore" ? "Shore-assisted supply" : "Host-supplied power / processing"}</small></span><em>${entry.row.fuel_forecast_method === "external_power_zero" ? "Fuel zero" : "Reported"}</em></button>`).join("")}</div>` : "";
  const fieldDetail = selected ? `<div class="accounting-detail-heading"><span class="accounting-type ${selected.type}">${selected.type === "shore" ? "Shore power" : selected.type === "field" ? "Self-supplied" : "Supplied field"}</span><h2>${escapeHtml(selected.field.field)}</h2><p>${selected.host ? "Receives power or processing energy from a supplier field" : selected.shoreNode ? "Receives power directly from shore" : selected.offMapSupplier ? "Receives power or processing energy from an off-map supplier" : "Own reported fuel series"}</p></div>${forecastButton}
    ${selected.host || selected.shoreNode || selected.offMapSupplier ? `<div class="accounting-supplier-card"><span>${selected.offMapSupplier ? "Off-map supplier" : selected.host ? "Supplier field" : "Power source"}</span>${selected.host ? `<button type="button" data-accounting-supplier-key="${escapeHtml(selected.host.key)}">${escapeHtml(selected.targetLabel)}</button>` : `<strong>${escapeHtml(selected.targetLabel)}</strong>`}</div>
    <div class="accounting-flow"><strong>${escapeHtml(selected.targetLabel)}</strong><span>→</span><strong>${escapeHtml(selected.field.field)}</strong></div>` : ""}
    ${selected.offMapSupplier ? `<p class="accounting-decision">${escapeHtml(selected.targetLabel)} ${OUTSIDE_NCS_POWER_SUPPLIERS.has(normalize(selected.row.host_or_source_field)) ? "is outside the Norwegian continental shelf" : "is a supplier facility outside this field map"}. The supplier has no map node, so no connection line is drawn. This field is still supplied externally.</p>` : ""}
    <p class="accounting-decision">${escapeHtml(accountingDecision(selected))}</p>
    <dl class="accounting-facts"><div><dt>Field-level treatment</dt><dd>${selected.row.fuel_forecast_method === "external_power_zero" ? "Zero — accounted elsewhere" : "Reported series retained"}</dd></div><div><dt>Confidence</dt><dd>${escapeHtml(titleCaseStatus(selected.row.confidence || "unavailable"))}</dd></div></dl>
    ${selected.row.evidence_summary ? `<div class="accounting-evidence"><strong>Registry evidence</strong><p>${escapeHtml(selected.row.evidence_summary)}</p></div>` : ""}
    ${selected.row.source_url ? `<a class="data-link" href="${escapeHtml(selected.row.source_url)}" target="_blank" rel="noopener">Open source</a>` : ""}` : "";
  const details = supplierDetail || fieldDetail || '<p class="accounting-empty">No connections in this category.</p>';
  const fieldList = connections.map((entry, index) => {
    const role = accountingFieldRole(entry, supplierFieldKeys);
    return `<button type="button" class="accounting-field-row${index === selectedIndex ? " active" : ""}" data-accounting-index="${index}" data-accounting-search-text="${escapeHtml(normalize(`${entry.field.field} ${entry.targetLabel} ${role.label}`))}" aria-pressed="${index === selectedIndex}">
      <i class="${role.className}" aria-hidden="true"></i><span><strong>${escapeHtml(entry.field.field)}</strong><small>${escapeHtml(entry.targetLabel)}${entry.offMapSupplier ? " · Off-map supplier" : ""}</small></span><em>${role.label}</em>
    </button>`;
  }).join("");
  els.accountingView.innerHTML = `<div class="accounting-panel">
    <header class="accounting-head"><div class="accounting-heading"><h1>Tiebacks &amp; fuel accounting</h1></div><div class="accounting-filters" role="group" aria-label="Filter fields by power supply">${[["shore", "Power from shore"], ["shared", "Shared power"], ["self", "Self-supplied"]].map(([value, label]) => `<label><input type="checkbox" data-accounting-filter="${value}" ${state.accountingFilters.has(value) ? "checked" : ""}><span aria-hidden="true"></span>${label}</label>`).join("")}</div></header>
    <div class="accounting-grid"><section class="accounting-field-panel"><header><div class="accounting-field-heading"><h2>Fields</h2><span data-accounting-field-count>${connections.length}</span></div><label class="accounting-field-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg><span class="sr-only">Search accounting fields</span><input type="search" data-accounting-search placeholder="Search fields" value="${escapeHtml(state.accountingSearch)}" autocomplete="off"></label></header><div class="accounting-field-list" data-accounting-field-list>${fieldList}<p class="accounting-empty" data-accounting-search-empty ${fieldList ? "hidden" : ""}>${fieldList ? "No matching fields." : "No fields in this category."}</p></div></section><div class="accounting-map-shell"><svg class="accounting-map" data-accounting-map viewBox="${accountingView.x} ${accountingView.y} ${accountingView.width} ${accountingView.height}" role="img" aria-label="Zoomable map of NCS power and accounting connections"><defs><marker id="accountingArrow-shore" data-accounting-arrow markerUnits="userSpaceOnUse" markerWidth="${arrowSize}" markerHeight="${arrowSize}" viewBox="0 0 5 5" refX="4.5" refY="2.5" orient="auto"><path d="M0 0 5 2.5 0 5Z"></path></marker><marker id="accountingArrow-host" data-accounting-arrow markerUnits="userSpaceOnUse" markerWidth="${arrowSize}" markerHeight="${arrowSize}" viewBox="0 0 5 5" refX="4.5" refY="2.5" orient="auto"><path d="M0 0 5 2.5 0 5Z"></path></marker></defs><rect width="${MAP.width}" height="${MAP.height}" class="accounting-sea"></rect><g>${grid}</g><g>${accountingLandPaths()}</g><g>${linkMarkup}</g><g>${shoreNodes}</g><g>${nodes}</g></svg><div class="accounting-map-legend"><span><i class="shore"></i>Shore trunk / distribution</span><span><i class="host"></i>Host-supplied</span></div><div class="accounting-map-controls" aria-label="Accounting map controls"><button type="button" data-accounting-zoom-in aria-label="Zoom in">+</button><button type="button" data-accounting-zoom-out aria-label="Zoom out">−</button><button type="button" data-accounting-zoom-reset aria-label="Reset map zoom" title="Reset map"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 8.5A7 7 0 1 1 5 14"></path><path d="M6.5 4v4.5H11"></path></svg></button></div><p>${nodeEntries.size} fields shown <span>·</span> ${mapped.length} connections</p></div><section class="accounting-detail">${details}</section></div>
  </div>`;
  const searchInput = els.accountingView.querySelector("[data-accounting-search]");
  els.accountingView.querySelector("[data-accounting-view-field]")?.addEventListener("click", (event) => {
    const field = state.fields.find((entry) => entry.key === event.currentTarget.dataset.accountingViewField);
    if (!field) return;
    state.selected = field;
    void selectView("fields", { updateHash: true });
  });
  const filterAccountingFieldList = () => {
    const query = normalize(searchInput?.value || "");
    state.accountingSearch = searchInput?.value || "";
    let visibleCount = 0;
    els.accountingView.querySelectorAll(".accounting-field-row").forEach((row) => {
      const visible = !query || row.dataset.accountingSearchText.includes(query);
      row.hidden = !visible;
      if (visible) visibleCount += 1;
    });
    const count = els.accountingView.querySelector("[data-accounting-field-count]");
    if (count) count.textContent = query ? `${visibleCount} of ${connections.length}` : connections.length;
    const empty = els.accountingView.querySelector("[data-accounting-search-empty]");
    if (empty) {
      empty.hidden = visibleCount > 0;
      empty.textContent = connections.length ? "No matching fields." : "No fields in this category.";
    }
  };
  searchInput?.addEventListener("input", filterAccountingFieldList);
  filterAccountingFieldList();
  els.accountingView.querySelectorAll("[data-accounting-filter]").forEach((input) => input.addEventListener("change", () => {
    if (input.checked) state.accountingFilters.add(input.dataset.accountingFilter);
    else state.accountingFilters.delete(input.dataset.accountingFilter);
    state.accountingSelected = 0;
    state.accountingSelection = { kind: "field", key: null };
    renderAccounting();
  }));
  els.accountingView.querySelectorAll("[data-accounting-index]").forEach((item) => {
    const activate = () => {
      state.accountingSelected = Number(item.dataset.accountingIndex);
      const field = connections[state.accountingSelected]?.field;
      const focusField = item.classList.contains("accounting-field-row");
      state.accountingSelection = { kind: "field", key: field?.key || null };
      renderAccounting();
      if (focusField && field) focusAccountingField(field);
    };
    item.addEventListener("click", activate);
    item.addEventListener("keydown", (event) => {
      if (item.tagName !== "BUTTON" && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        activate();
      }
    });
  });
  els.accountingView.querySelectorAll("[data-accounting-supplier-key]").forEach((item) => {
    const activate = () => {
      state.accountingSelection = { kind: "supplier", key: item.dataset.accountingSupplierKey };
      renderAccounting();
    };
    item.addEventListener("click", activate);
    item.addEventListener("keydown", (event) => {
      if (item.tagName !== "BUTTON" && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        activate();
      }
    });
  });
  els.accountingView.querySelectorAll("[data-accounting-child-key]").forEach((item) => item.addEventListener("click", () => {
    const key = item.dataset.accountingChildKey;
    if (!connections.some((entry) => entry.field.key === key)) {
      const child = allConnections.find((entry) => entry.field.key === key);
      if (child) accountingCategories(child, supplierFieldKeys).forEach((category) => state.accountingFilters.add(category));
    }
    state.accountingSelection = { kind: "field", key };
    renderAccounting();
  }));
  const nextList = els.accountingView.querySelector("[data-accounting-field-list]");
  if (nextList) nextList.scrollTop = state.accountingListScroll;
  syncAccountingMapScale();
  wireAccountingMap();
}

function animateView(element) {
  if (!element) return;
  element.classList.remove("view-crossfade-in");
  void element.offsetWidth;
  element.classList.add("view-crossfade-in");
}

function viewFromHash() {
  const view = window.location.hash.slice(1).toLowerCase();
  return VIEW_HASHES.has(view) ? view : null;
}

function setViewHash(view, replace = false) {
  const hash = `#${view}`;
  if (window.location.hash === hash) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", hash);
}

function syncViewShell(view) {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  els.fieldView.hidden = view !== "fields";
  els.aggregateView.hidden = view !== "aggregate";
  els.accountingView.hidden = view !== "accounting";
}

async function selectView(view, { updateHash = false } = {}) {
  if (!VIEW_HASHES.has(view)) return;
  if (updateHash) setViewHash(view);
  if (state.view === view) return;
  if (view === "aggregate" && state.metric === "reserves") state.metric = "production";
  state.view = view;
  syncViewShell(view);
  if (view === "fields") {
    await selectField(state.selected);
    animateView(els.fieldView);
    return;
  }
  if (view === "accounting") {
    renderAccounting();
    animateView(els.accountingView);
    return;
  }
  if (!state.aggregateForecast) els.aggregateView.innerHTML = '<div class="aggregate-loading"><span></span><p>Loading the aggregate forecast…</p></div>';
  try {
    await ensureAggregateForecast();
    if (state.view === "aggregate") renderAggregate();
  } catch (error) {
    console.error(error);
    els.aggregateView.innerHTML = '<div class="error-state"><p>Could not load the aggregate forecast.</p></div>';
  }
}

function setViewBox(next, animate = true) {
  const target = {
    width: Math.max(MAP.minViewBox.width, Math.min(MAP.width, next.width)),
    height: Math.max(MAP.minViewBox.height, Math.min(MAP.height, next.height)),
  };
  target.x = Math.max(0, Math.min(MAP.width - target.width, next.x));
  target.y = Math.max(0, Math.min(MAP.height - target.height, next.y));
  if (state.viewAnimationFrame) cancelAnimationFrame(state.viewAnimationFrame);
  if (!animate) {
    state.viewBox = target;
    els.map.setAttribute("viewBox", `${target.x} ${target.y} ${target.width} ${target.height}`);
    syncFieldMapMarkerScale();
    state.viewAnimationFrame = null;
    return;
  }
  const start = { ...state.viewBox };
  const started = performance.now();
  function frame(now) {
    const progress = Math.min(1, (now - started) / 360);
    const eased = 1 - (1 - progress) ** 3;
    state.viewBox = Object.fromEntries(Object.keys(target).map((key) => [key, start[key] + (target[key] - start[key]) * eased]));
    const view = state.viewBox;
    els.map.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
    syncFieldMapMarkerScale();
    if (progress < 1) state.viewAnimationFrame = requestAnimationFrame(frame);
    else state.viewAnimationFrame = null;
  }
  state.viewAnimationFrame = requestAnimationFrame(frame);
}

function zoom(factor) {
  const current = state.viewBox;
  const width = Math.max(MAP.minViewBox.width, Math.min(MAP.width, current.width * factor));
  const height = Math.max(MAP.minViewBox.height, Math.min(MAP.height, current.height * factor));
  if (Math.abs(width - current.width) < 0.001 && Math.abs(height - current.height) < 0.001) return;
  setViewBox({ x: current.x + (current.width - width) / 2, y: current.y + (current.height - height) / 2, width, height });
}

function zoomAtPointer(factor, event) {
  const rect = els.map.getBoundingClientRect();
  const current = state.viewBox;
  const screenX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const screenY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  const worldX = current.x + (screenX / rect.width) * current.width;
  const worldY = current.y + (screenY / rect.height) * current.height;
  const width = Math.max(MAP.minViewBox.width, Math.min(MAP.width, current.width * factor));
  const height = Math.max(MAP.minViewBox.height, Math.min(MAP.height, current.height * factor));
  if (Math.abs(width - current.width) < 0.001 && Math.abs(height - current.height) < 0.001) return;
  setViewBox({
    x: worldX - (screenX / rect.width) * width,
    y: worldY - (screenY / rect.height) * height,
    width,
    height,
  }, false);
}

function beginMapPan(event) {
  if (event.button !== 0 || event.target.closest?.(".field-marker")) return;
  state.mapDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, viewBox: { ...state.viewBox }, moved: false };
  hideHover();
  els.map.classList.add("is-panning");
  els.map.setPointerCapture(event.pointerId);
}

function moveMapPan(event) {
  const drag = state.mapDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const rect = els.map.getBoundingClientRect();
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (Math.hypot(dx, dy) > 3) drag.moved = true;
  setViewBox({
    ...drag.viewBox,
    x: drag.viewBox.x - (dx / rect.width) * drag.viewBox.width,
    y: drag.viewBox.y - (dy / rect.height) * drag.viewBox.height,
  }, false);
}

function endMapPan(event) {
  const drag = state.mapDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  state.suppressMapClick = drag.moved;
  state.mapDrag = null;
  els.map.classList.remove("is-panning");
  if (els.map.hasPointerCapture(event.pointerId)) els.map.releasePointerCapture(event.pointerId);
  if (state.suppressMapClick) window.setTimeout(() => { state.suppressMapClick = false; }, 0);
}

function wireGlobalEvents() {
  els.aggregateView.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry-contributors]")) void loadAggregateContributors();
  });
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    void selectView(button.dataset.view, { updateHash: true });
  }));
  window.addEventListener("hashchange", () => {
    const view = viewFromHash();
    if (view) void selectView(view);
    else setViewHash(state.view, true);
  });
  els.search.addEventListener("input", () => {
    updateSearchClear();
    applyFilters();
  });
  els.search.addEventListener("focus", () => setFieldDirectoryOpen(true));
  els.searchClear.addEventListener("click", () => {
    els.search.value = "";
    updateSearchClear();
    applyFilters();
    els.search.focus();
  });
  document.querySelectorAll("[data-directory-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      state.directorySort = button.dataset.directorySort;
      document.querySelectorAll("[data-directory-sort]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      renderFieldDirectory();
      updateFieldNavigation();
    });
  });
  document.querySelectorAll("[data-filter-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.filterKind;
      state[kind] = button.dataset.filterValue;
      document.querySelectorAll(`[data-filter-kind="${kind}"]`).forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      applyFilters();
    });
  });
  els.browseButton.addEventListener("click", () => {
    if (state.directoryOpen) closeFieldDirectory();
    else openFieldDirectory({ focus: true });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.directoryOpen) closeFieldDirectory();
  });
  document.querySelector("#zoomIn").addEventListener("click", () => zoom(0.72));
  document.querySelector("#zoomOut").addEventListener("click", () => zoom(1.38));
  document.querySelector("#zoomReset").addEventListener("click", () => setViewBox({ ...MAP.baseViewBox }));
  els.map.addEventListener("wheel", (event) => {
    event.preventDefault();
    hideHover();
    const factor = Math.max(0.78, Math.min(1.28, Math.exp(event.deltaY * 0.0015)));
    zoomAtPointer(factor, event);
  }, { passive: false });
  els.map.addEventListener("pointerdown", beginMapPan);
  els.map.addEventListener("pointermove", moveMapPan);
  els.map.addEventListener("pointerup", endMapPan);
  els.map.addEventListener("pointercancel", endMapPan);
  els.map.addEventListener("click", (event) => {
    if (state.suppressMapClick || event.target.closest?.(".field-marker")) return;
    hideHover();
  });
}

async function init() {
  const initialView = viewFromHash() || "fields";
  syncViewShell(initialView);
  wireGlobalEvents();
  try {
    await loadData();
    renderGrid();
    renderLand();
    renderMarkers();
    renderFieldDirectory();
    if (initialView === "fields") await selectField(state.selected);
    setViewHash(initialView, true);
    delete document.documentElement.dataset.initialView;
    await selectView(initialView);
  } catch (error) {
    console.error("MLP explorer failed to initialize", error);
    els.mapSummary.textContent = "The field data could not be loaded.";
    els.inspector.innerHTML = '<div class="error-state"><p>Could not load the global MLP results. Start a web server at the repository root and reload this page.</p></div>';
  }
}

init();
