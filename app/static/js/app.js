/**
 * Map Analytics & HA30 Hexagonal Fleet Performance Engine Frontend
 * Supports day-level filtering, Shift+click multi-cell merged analytics,
 * and dynamic toggling between HA30% and Mean Duration color metrics.
 */

// Application State
const state = {
  city: 'isfahan',
  status: 'DELIVERED',
  customerId: 2,
  startDate: '2026-10-22',
  endDate: '2026-11-05',
  threshold: 30,
  minOrders: 5,
  currentLayer: 'source',     // 'source' or 'destination'
  currentRes: 8,              // H3 resolution 6-10
  autoRes: false,
  opacity: 0.65,
  showLabels: true,
  cellLabelMode: 'orders_ha', // 'orders_ha' or 'orders_only'
  multiSelectMode: false,
  colorMetric: 'ha',          // 'ha' (HA30% breach) or 'mean' (Mean duration)
  activeBasemap: 'voyager',
  minBreachFilter: 0,
  selectedDates: [],          // Active YYYY-MM-DD date strings
  allDates: [],               // Full range of dates
  dailyStats: [],             // Daily breakdown stats
  data: null,
  polygons: [],
  selectedHexes: new Map(),   // Multi-selected cells: hexId -> { h, polygon }
  singleSelectedHex: null,    // Single selected cell
};

// Basemap Tile Providers (Tested & Reliable - using Carto API Key from previous file)
const mapApiKey = window.MAP_API_KEY || 'cb1_5558_1_345367a66619045ea57fcdba';
const BASEMAP_PROVIDERS = {
  voyager: {
    url: window.CARTO_TILE_URL || `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${mapApiKey}`,
    options: { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }
  },
  positron: {
    url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }
  },
  dark: {
    url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19, attribution: '&copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye' }
  }
};

let map;
let tileLayer;
let hexLayerGroup;
let labelLayerGroup;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupEventListeners();
  loadCityData('isfahan', true);
});

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    preferCanvas: true
  }).setView([32.6546, 51.6680], 13.5);

  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  tileLayer = L.tileLayer(BASEMAP_PROVIDERS.voyager.url, BASEMAP_PROVIDERS.voyager.options).addTo(map);
  hexLayerGroup = L.layerGroup().addTo(map);
  labelLayerGroup = L.layerGroup().addTo(map);

  map.on('zoomend', () => {
    if (state.autoRes && state.data) {
      const zoom = map.getZoom();
      let targetRes = Math.min(10, Math.max(6, Math.round(zoom - 5)));
      if (targetRes !== state.currentRes) {
        setResolution(targetRes);
      }
    }
    updateLabelsVisibility();
  });
}

function setupEventListeners() {
  // Search submit
  document.getElementById('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const city = document.getElementById('cityInput').value.trim();
    if (city) {
      const isNewCity = !state.city || (city.toLowerCase() !== state.city.toLowerCase());
      state.selectedDates = [];
      loadCityData(city, isNewCity);
    }
  });

  // Layer buttons (Source vs Destination)
  document.getElementById('btnLayerSrc').addEventListener('click', () => setLayer('source'));
  document.getElementById('btnLayerDest').addEventListener('click', () => setLayer('destination'));

  // Color Metric Toggle (HA30 vs Mean Duration)
  document.getElementById('btnMetricHa').addEventListener('click', () => setColorMetric('ha'));
  document.getElementById('btnMetricMean').addEventListener('click', () => setColorMetric('mean'));

  // Resolution stepper
  document.getElementById('btnResMinus').addEventListener('click', () => setResolution(state.currentRes - 1));
  document.getElementById('btnResPlus').addEventListener('click', () => setResolution(state.currentRes + 1));

  // Auto-resolution checkbox
  document.getElementById('checkAutoRes').addEventListener('change', (e) => {
    state.autoRes = e.target.checked;
    if (state.autoRes) {
      const zoom = map.getZoom();
      setResolution(Math.min(10, Math.max(6, Math.round(zoom - 5))));
    }
  });

  // Opacity slider
  document.getElementById('sliderOpacity').addEventListener('input', (e) => {
    state.opacity = parseFloat(e.target.value);
    document.getElementById('valOpacity').textContent = `${Math.round(state.opacity * 100)}%`;
    state.polygons.forEach(item => {
      const isSelected = state.selectedHexes.has(item.h.hex);
      if (!isSelected) {
        item.polygon.setStyle({ fillOpacity: state.opacity });
      }
    });
  });

  // SLA breach filter slider
  document.getElementById('sliderBreachFilter').addEventListener('input', (e) => {
    state.minBreachFilter = parseFloat(e.target.value);
    document.getElementById('valBreachFilter').textContent = `${state.minBreachFilter}%`;
    filterHexagons();
  });

  // Show labels checkbox and mode toggles
  const checkLabels = document.getElementById('checkShowLabels');
  if (checkLabels) {
    checkLabels.checked = state.showLabels;
    checkLabels.addEventListener('change', (e) => {
      state.showLabels = e.target.checked;
      renderLabels();
    });
  }

  const btnLblOrdersOnly = document.getElementById('btnLabelOrdersOnly');
  const btnLblOrdersHa = document.getElementById('btnLabelOrdersHa');
  if (btnLblOrdersOnly && btnLblOrdersHa) {
    btnLblOrdersOnly.addEventListener('click', () => {
      state.cellLabelMode = 'orders_only';
      btnLblOrdersOnly.classList.add('active');
      btnLblOrdersHa.classList.remove('active');
      if (!state.showLabels) {
        state.showLabels = true;
        if (checkLabels) checkLabels.checked = true;
      }
      renderLabels();
    });
    btnLblOrdersHa.addEventListener('click', () => {
      state.cellLabelMode = 'orders_ha';
      btnLblOrdersHa.classList.add('active');
      btnLblOrdersOnly.classList.remove('active');
      if (!state.showLabels) {
        state.showLabels = true;
        if (checkLabels) checkLabels.checked = true;
      }
      renderLabels();
    });
  }

  // Multi-select mode checkbox
  document.getElementById('checkMultiSelectMode').addEventListener('change', (e) => {
    state.multiSelectMode = e.target.checked;
  });

  // Basemap buttons
  document.querySelectorAll('.basemap-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const provider = e.currentTarget.dataset.basemap;
      switchBasemap(provider);
    });
  });

  // Day preset buttons
  document.getElementById('btnSelectAllDays').addEventListener('click', selectAllDays);
  document.getElementById('btnSelectWeekdays').addEventListener('click', selectWeekdays);
  document.getElementById('btnSelectWeekends').addEventListener('click', selectWeekends);
  document.getElementById('btnInvertDays').addEventListener('click', invertDays);

  // Date Range Fetch & Custom Days (Allows selecting days outside last 2 weeks from DB)
  const btnFetchRange = document.getElementById('btnFetchDateRange');
  if (btnFetchRange) {
    btnFetchRange.addEventListener('click', () => {
      const sDate = document.getElementById('barStartDate').value;
      const eDate = document.getElementById('barEndDate').value;
      if (!sDate || !eDate) {
        alert("Please specify both Start Date and End Date.");
        return;
      }
      if (sDate > eDate) {
        alert("Start Date must be before or equal to End Date.");
        return;
      }
      state.startDate = sDate;
      state.endDate = eDate;
      state.selectedDates = null;
      loadCityData(state.city);
    });
  }

  // Quick Date Window Presets
  const selectPreset = document.getElementById('selectDatePreset');
  if (selectPreset) {
    selectPreset.addEventListener('change', (e) => {
      const val = e.target.value;
      if (!val) return;
      if (val === 'last14') {
        state.startDate = '2026-10-22';
        state.endDate = '2026-11-05';
      } else if (val === 'last7') {
        state.startDate = '2026-10-15';
        state.endDate = '2026-10-21';
      } else if (val === 'last30') {
        state.startDate = '2026-10-07';
        state.endDate = '2026-11-05';
      } else if (val === 'monthSep') {
        state.startDate = '2026-09-01';
        state.endDate = '2026-09-30';
      } else if (val === 'monthOct') {
        state.startDate = '2026-10-01';
        state.endDate = '2026-10-31';
      }
      const barStart = document.getElementById('barStartDate');
      const barEnd = document.getElementById('barEndDate');
      if (barStart) barStart.value = state.startDate;
      if (barEnd) barEnd.value = state.endDate;
      state.selectedDates = null;
      loadCityData(state.city);
    });
  }

  // Add Specific Custom Day from DB
  const btnAddDay = document.getElementById('btnAddSpecificDate');
  if (btnAddDay) {
    btnAddDay.addEventListener('click', () => {
      const newDate = document.getElementById('inputAddSpecificDate').value;
      if (!newDate) {
        alert("Please choose a date to add from DB.");
        return;
      }
      const set = new Set(state.selectedDates || state.allDates || []);
      set.add(newDate);
      state.selectedDates = Array.from(set).sort();

      if (!state.startDate || newDate < state.startDate) {
        state.startDate = newDate;
      }
      if (!state.endDate || newDate > state.endDate) {
        state.endDate = newDate;
      }
      loadCityData(state.city);
    });
  }

  // Inspector & Merged panel close buttons
  document.getElementById('btnCloseInspector').addEventListener('click', closeSingleInspector);
  document.getElementById('btnCloseMerged').addEventListener('click', clearHexSelection);
  document.getElementById('btnClearSelection').addEventListener('click', clearHexSelection);
  document.getElementById('btnZoomToSelection').addEventListener('click', zoomToSelection);

  // Citywide Report Modal
  document.getElementById('btnOpenCityModal').addEventListener('click', openCityModal);
  document.getElementById('kpiCardCityOverview').addEventListener('click', openCityModal);
  document.getElementById('btnCloseCityModal').addEventListener('click', closeCityModal);
  document.getElementById('btnModalCloseDone').addEventListener('click', closeCityModal);

  // Filter settings modal
  document.getElementById('btnOpenFilters').addEventListener('click', () => {
    document.getElementById('filterModal').classList.add('open');
  });
  document.getElementById('btnCloseFilters').addEventListener('click', () => {
    document.getElementById('filterModal').classList.remove('open');
  });
  document.getElementById('filterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.threshold = parseInt(document.getElementById('inputThreshold').value, 10) || 30;
    state.minOrders = parseInt(document.getElementById('inputMinOrders').value, 10) || 5;
    state.customerId = parseInt(document.getElementById('inputCustomerId').value, 10) || 2;
    state.startDate = document.getElementById('inputStartDate').value || '2026-10-22';
    state.endDate = document.getElementById('inputEndDate').value || '2026-11-05';
    state.selectedDates = [];
    document.getElementById('filterModal').classList.remove('open');
    loadCityData(state.city, false);
  });

  // Center Map button (Zooms in to city core, avoiding distant outlier big-picture view)
  document.getElementById('btnFitBounds').addEventListener('click', () => centerAndZoomMap(true));

  // Export buttons
  document.getElementById('btnExportHtml').addEventListener('click', exportStandaloneHtml);
  document.getElementById('btnExportCsv').addEventListener('click', exportCsvData);

  // CSV file upload handler
  const btnUpload = document.getElementById('btnOpenUpload');
  const fileInput = document.getElementById('csvFileInput');
  if (btnUpload && fileInput) {
    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      showLoading(true, `Uploading and analyzing ${file.name}...`);
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch(`/api/upload-csv?threshold=${state.threshold}&min_orders=${state.minOrders}`, {
          method: 'POST',
          body: formData
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || `Upload failed with status ${res.status}`);
        }
        const data = await res.json();
        state.data = data;
        state.city = data.city.name || 'Custom CSV';
        clearHexSelection();
        updateKpis(data.kpis, state.city, data.data_source);
        renderMapHexagons();
        renderBottlenecks(data.bottlenecks);
        renderDaysSelector([], [], []);
        centerAndZoomMap(true);
        updateLegend();
        updateResolutionUI();
      } catch (err) {
        alert(`Error parsing CSV: ${err.message}`);
      } finally {
        fileInput.value = '';
        showLoading(false);
      }
    });
  }
}

// Fetch city data from API with optional dates filter
async function loadCityData(city, isNewCity = false) {
  showLoading(true, `Analyzing ${city.toUpperCase()} Fleet HA${state.threshold}% SLA...`);
  state.city = city;

  try {
    const params = new URLSearchParams({
      city: city,
      threshold: state.threshold,
      min_orders: state.minOrders,
      customer_id: state.customerId,
      start_date: state.startDate,
      end_date: state.endDate,
    });

    if (state.selectedDates && state.selectedDates.length > 0) {
      params.append('dates', state.selectedDates.join(','));
    }

    const res = await fetch(`/api/data?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    const data = await res.json();
    state.data = data;
    state.allDates = data.all_dates || [];
    state.selectedDates = data.selected_dates || data.all_dates || [];
    state.dailyStats = data.daily_stats || [];

    const barStart = document.getElementById('barStartDate');
    const barEnd = document.getElementById('barEndDate');
    if (barStart) barStart.value = state.startDate;
    if (barEnd) barEnd.value = state.endDate;
    const modalStart = document.getElementById('inputStartDate');
    const modalEnd = document.getElementById('inputEndDate');
    if (modalStart) modalStart.value = state.startDate;
    if (modalEnd) modalEnd.value = state.endDate;

    clearHexSelection();
    updateKpis(data.kpis, city, data.data_source);
    renderDaysSelector(state.dailyStats, state.allDates, state.selectedDates);
    renderMapHexagons();
    renderBottlenecks(data.bottlenecks);

    // Center and zoom map ONLY on new city load or initial search; NEVER zoom out on update!
    if (isNewCity) {
      centerAndZoomMap(false);
    }

    updateLegend();
    updateResolutionUI();
  } catch (err) {
    console.error('Error loading city data:', err);
    alert(`Could not load data for "${city}": ${err.message}`);
  } finally {
    showLoading(false);
  }
}

// Update Top Floating Citywide HA30 Overview & KPI Cards
function updateKpis(kpis, city, dataSource) {
  document.getElementById('headerCityLabel').textContent = `${city.toUpperCase()}`;
  document.getElementById('headerThresholdLabel').textContent = `HA${kpis.threshold}%`;
  document.getElementById('kpiThresholdVal').textContent = kpis.threshold;

  // Citywide HA30 Overview Card
  const haEl = document.getElementById('kpiHaPct');
  haEl.textContent = `${kpis.overall_ha_pct.toFixed(1)}%`;
  haEl.className = 'kpi-val ' + (kpis.overall_ha_pct > 25 ? 'highlight-breach' : 'highlight-success');

  const badgeEl = document.getElementById('citySlaBadge');
  badgeEl.textContent = kpis.sla_health || 'SLA';
  badgeEl.className = 'badge ' + (kpis.overall_ha_pct > 30 ? 'badge-critical' : kpis.overall_ha_pct > 20 ? 'badge-warning' : 'badge-optimal');

  document.getElementById('kpiSlowRatio').textContent = `${(kpis.ha30_count || kpis.total_slow || 0).toLocaleString()} of ${kpis.total_orders.toLocaleString()}`;
  document.getElementById('cityTotalOrdersLabel').textContent = `${kpis.total_orders.toLocaleString()} Delivered`;

  const haOrdersCountEl = document.getElementById('kpiHaOrdersCount');
  if (haOrdersCountEl) {
    haOrdersCountEl.textContent = (kpis.ha30_count || kpis.total_slow || 0).toLocaleString();
  }
  const kpiCardThreshold = document.getElementById('kpiCardThreshold');
  if (kpiCardThreshold) {
    kpiCardThreshold.textContent = state.threshold;
  }

  // Total Delivered Orders card
  const totalOrdersVal = document.getElementById('kpiTotalOrdersVal');
  if (totalOrdersVal) {
    totalOrdersVal.textContent = kpis.total_orders.toLocaleString();
  }

  // Duration metrics (minutes)
  document.getElementById('kpiMeanDuration').textContent = `${kpis.overall_mean_duration.toFixed(1)} min`;
  document.getElementById('kpiP90Duration').textContent = `P90: ${kpis.p90_duration || 0} min`;
  document.getElementById('kpiP50Duration').textContent = `Med: ${kpis.p50_duration || 0} min`;

  // DataSource Badge
  const sourceBadge = document.getElementById('dataSourceBadge');
  if (sourceBadge) {
    sourceBadge.textContent = dataSource.includes('ClickHouse') ? 'ClickHouse Live' : (dataSource.includes('Cached') ? 'Cached Query' : 'High-Fidelity Engine');
    sourceBadge.title = dataSource;
  }
}

// Render Interactive Day Selector Strip
function renderDaysSelector(dailyStats, allDates, selectedDates) {
  const container = document.getElementById('daysPillsContainer');
  if (!container) return;

  if (!dailyStats || dailyStats.length === 0) {
    container.innerHTML = '<span style="font-size:11px;color:#64748b;padding:4px">No day breakdown for uploaded data</span>';
    return;
  }

  const selectedSet = new Set(selectedDates);

  container.innerHTML = dailyStats.map(d => {
    const isSelected = selectedSet.has(d.date);
    const breachColor = d.pct > 35 ? '#ef4444' : d.pct > 20 ? '#f59e0b' : '#10b981';
    return `
      <div class="day-pill ${isSelected ? 'active' : ''}" data-date="${d.date}" title="${d.label}: ${d.orders} orders, ${d.pct}% breach, ${d.mean} min avg">
        <div class="day-pill-date">${d.label}</div>
        <div class="day-pill-meta">
          <span>${d.orders} ord</span> &bull; <b style="color:${breachColor}">${d.pct.toFixed(0)}%</b>
        </div>
      </div>
    `;
  }).join('');

  // Attach toggle listeners
  container.querySelectorAll('.day-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      const dateStr = e.currentTarget.dataset.date;
      toggleDaySelection(dateStr);
    });
  });
}

function toggleDaySelection(dateStr) {
  const set = new Set(state.selectedDates);
  if (set.has(dateStr)) {
    if (set.size <= 1) {
      alert("At least one day must remain selected.");
      return;
    }
    set.delete(dateStr);
  } else {
    set.add(dateStr);
  }
  state.selectedDates = Array.from(set).sort();
  loadCityData(state.city, false);
}

function selectAllDays() {
  state.selectedDates = [...state.allDates];
  loadCityData(state.city, false);
}

function selectWeekdays() {
  const weekdays = state.dailyStats
    .filter(d => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(d.day_name))
    .map(d => d.date);
  if (weekdays.length > 0) {
    state.selectedDates = weekdays;
    loadCityData(state.city, false);
  }
}

function selectWeekends() {
  const weekends = state.dailyStats
    .filter(d => ['Sat', 'Sun'].includes(d.day_name))
    .map(d => d.date);
  if (weekends.length > 0) {
    state.selectedDates = weekends;
    loadCityData(state.city, false);
  }
}

function invertDays() {
  const currentSet = new Set(state.selectedDates);
  const inverted = state.allDates.filter(d => !currentSet.has(d));
  if (inverted.length === 0) {
    alert("Inverting would select 0 days.");
    return;
  }
  state.selectedDates = inverted;
  loadCityData(state.city, false);
}

// Render Hexagons for current layer and resolution
function renderMapHexagons() {
  if (!state.data) return;

  hexLayerGroup.clearLayers();
  labelLayerGroup.clearLayers();
  state.polygons = [];

  const layerData = state.data.layers[state.currentLayer].res[state.currentRes];
  if (!layerData || !layerData.hexes) return;

  layerData.hexes.forEach(h => {
    const isVisible = h.pct >= state.minBreachFilter;
    const isSelected = state.selectedHexes.has(h.hex);
    const fillColor = state.colorMetric === 'ha' ? h.color_ha : h.color_mean;

    const polygon = L.polygon(h.ring, {
      color: isSelected ? '#06b6d4' : '#ffffff',
      weight: isSelected ? 3.5 : 1.2,
      fillColor: fillColor,
      fillOpacity: isVisible ? state.opacity : 0.05,
      className: `h3-hex ${h.status}`
    });

    polygon.bindTooltip(createTooltipContent(h), {
      sticky: true,
      className: 'hex-tooltip'
    });

    polygon.on('mouseover', () => {
      if (!state.selectedHexes.has(h.hex)) {
        polygon.setStyle({ weight: 2.8, color: '#0f172a' });
        polygon.bringToFront();
      }
    });

    polygon.on('mouseout', () => {
      const selected = state.selectedHexes.has(h.hex);
      const singleSel = state.singleSelectedHex && state.singleSelectedHex.hex === h.hex;
      polygon.setStyle({
        weight: selected ? 3.5 : (singleSel ? 3.0 : 1.2),
        color: selected ? '#06b6d4' : (singleSel ? '#2563eb' : '#ffffff')
      });
    });

    // Hexagon Click handler: Shift+Click for Multi-Select merge, normal click for Single-Inspector
    polygon.on('click', (e) => {
      const isShift = (e.originalEvent && e.originalEvent.shiftKey) || state.multiSelectMode;
      if (isShift) {
        toggleMultiSelectHex(h, polygon);
      } else {
        clearHexSelection();
        selectSingleHexagon(h, polygon);
      }
    });

    hexLayerGroup.addLayer(polygon);
    state.polygons.push({ h, polygon });
  });

  renderLabels();
  updateLegend();
}

function createTooltipContent(h) {
  const statusLabels = {
    optimal: '🟢 Optimal SLA (&lt;15%)',
    acceptable: '🟡 Acceptable (15-25%)',
    warning: '🟠 Elevated SLA Risk (25-35%)',
    critical: '🔴 Critical SLA Breach (&gt;35%)',
    low_sample: '⚪ Low Order Volume (&lt;5)'
  };
  const statusText = statusLabels[h.status] || '';

  const haHighlight = state.colorMetric === 'ha' ? 'background:#f1f5f9;padding:2px 4px;border-radius:4px' : '';
  const meanHighlight = state.colorMetric === 'mean' ? 'background:#f1f5f9;padding:2px 4px;border-radius:4px' : '';

  return `
    <div style="font-family:Inter,sans-serif;font-size:12px;line-height:1.45;min-width:180px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px;${haHighlight}">
        <span style="font-size:13.5px;color:#0f172a"><b>HA${state.threshold}%: ${h.pct.toFixed(1)}%</b></span>
        <span style="font-size:12px;font-weight:400;color:#475569">${h.orders} orders</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1px">
        <span style="color:#64748b">HA${state.threshold} Orders Count:</span>
        <b style="color:#dc2626">${h.slow}</b>
      </div>
      <div style="font-size:9.5px;color:#94a3b8;margin-bottom:4px">(create to accept time &ge; ${state.threshold} min)</div>
      <div style="display:flex;justify-content:space-between;${meanHighlight};margin:2px 0">
        <span style="color:#64748b">Mean Duration:</span>
        <span style="color:#0f172a;font-weight:600">${h.mean.toFixed(1)} min</span>
      </div>
      <div style="font-size:10.5px;color:#64748b;margin:4px 0 2px">${statusText}</div>
      <div style="margin-top:4px;font-size:9.5px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:3px">Hex: ${h.hex}</div>
    </div>
  `;
}

// Single Hexagon Inspection
function selectSingleHexagon(h, polygon) {
  if (state.singleSelectedHex && state.singleSelectedHex.polygon) {
    state.singleSelectedHex.polygon.setStyle({ weight: 1.2, color: '#ffffff' });
  }

  state.singleSelectedHex = { h, polygon };
  polygon.setStyle({ weight: 3.2, color: '#2563eb' });
  polygon.bringToFront();

  const inspector = document.getElementById('inspectorPanel');
  document.getElementById('mergedSelectionPanel').classList.remove('active');

  const totalWithVal = h.with_value || h.orders;

  document.getElementById('inspHexId').textContent = h.hex;
  document.getElementById('inspStatusBadge').className = `badge badge-${h.status}`;
  document.getElementById('inspStatusBadge').textContent = h.status.replace('_', ' ').toUpperCase();
  document.getElementById('inspHaPct').textContent = `${h.pct.toFixed(1)}%`;
  document.getElementById('inspHaPct').style.color = h.pct > 25 ? '#dc2626' : '#16a34a';
  document.getElementById('inspTotalOrders').textContent = h.orders;

  const slowEl = document.getElementById('inspSlowOrders');
  if (slowEl) slowEl.textContent = h.slow;
  const ratioEl = document.getElementById('inspHaRatio');
  if (ratioEl) ratioEl.textContent = `${h.slow} of ${totalWithVal} orders`;

  document.querySelectorAll('.inspThresholdText').forEach(el => {
    el.textContent = state.threshold;
  });

  document.getElementById('inspMeanDuration').textContent = `${h.mean.toFixed(1)} min`;
  document.getElementById('inspCoords').textContent = `${h.center[0]}, ${h.center[1]}`;

  inspector.classList.add('active');
}

function closeSingleInspector() {
  if (state.singleSelectedHex && state.singleSelectedHex.polygon) {
    state.singleSelectedHex.polygon.setStyle({ weight: 1.2, color: '#ffffff' });
  }
  state.singleSelectedHex = null;
  document.getElementById('inspectorPanel').classList.remove('active');
}

// Shift + Click Multi-Cell Selection & Merged Analytics
function toggleMultiSelectHex(h, polygon) {
  closeSingleInspector();

  if (state.selectedHexes.has(h.hex)) {
    state.selectedHexes.delete(h.hex);
    polygon.setStyle({ weight: 1.2, color: '#ffffff' });
  } else {
    state.selectedHexes.set(h.hex, { h, polygon });
    polygon.setStyle({ weight: 3.5, color: '#06b6d4' });
    polygon.bringToFront();
  }

  renderMergedSelection();
}

function renderMergedSelection() {
  const panel = document.getElementById('mergedSelectionPanel');
  if (state.selectedHexes.size === 0) {
    panel.classList.remove('active');
    return;
  }

  let totalOrders = 0;
  let totalSlow = 0;
  let totalWithValue = 0;
  let vsum = 0;
  const hexItems = Array.from(state.selectedHexes.values());

  hexItems.forEach(item => {
    const h = item.h;
    totalOrders += h.orders;
    totalSlow += h.slow;
    const withVal = h.with_value || h.orders;
    totalWithValue += withVal;
    vsum += h.mean * withVal;
  });

  const mergedPct = totalWithValue > 0 ? (totalSlow / totalWithValue * 100) : 0;
  const mergedMean = totalWithValue > 0 ? (vsum / totalWithValue) : 0;
  const cityAverage = state.data && state.data.kpis ? state.data.kpis.overall_ha_pct : 0;
  const delta = mergedPct - cityAverage;

  document.getElementById('mergedTitleText').textContent = `Merged Region (${state.selectedHexes.size} Cells)`;
  document.getElementById('mergedHaPct').textContent = `${mergedPct.toFixed(1)}%`;
  document.getElementById('mergedHaPct').style.color = mergedPct > 25 ? '#dc2626' : '#16a34a';

  const deltaBadge = document.getElementById('mergedDeltaBadge');
  deltaBadge.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs City Avg`;
  deltaBadge.style.color = delta > 0 ? '#dc2626' : '#16a34a';

  document.getElementById('mergedTotalOrders').textContent = totalOrders.toLocaleString();

  const mergedSlowEl = document.getElementById('mergedSlowOrders');
  if (mergedSlowEl) mergedSlowEl.textContent = totalSlow.toLocaleString();
  const mergedRatioEl = document.getElementById('mergedHaRatio');
  if (mergedRatioEl) mergedRatioEl.textContent = `${totalSlow.toLocaleString()} of ${totalWithValue.toLocaleString()} orders`;

  document.getElementById('mergedMeanDuration').textContent = `${mergedMean.toFixed(1)} min`;

  // Render chip tags for selected cells
  const chipsContainer = document.getElementById('mergedCellsList');
  chipsContainer.innerHTML = hexItems.map(item => `
    <span class="hex-cell-chip">
      ${item.h.hex.substring(0, 9)}...
      <span class="hex-cell-remove" onclick="removeSingleSelectedHex('${item.h.hex}')">&times;</span>
    </span>
  `).join('');

  panel.classList.add('active');
}

window.removeSingleSelectedHex = function(hexId) {
  const item = state.selectedHexes.get(hexId);
  if (item && item.polygon) {
    item.polygon.setStyle({ weight: 1.2, color: '#ffffff' });
  }
  state.selectedHexes.delete(hexId);
  renderMergedSelection();
};

function clearHexSelection() {
  state.selectedHexes.forEach(item => {
    if (item.polygon) {
      item.polygon.setStyle({ weight: 1.2, color: '#ffffff' });
    }
  });
  state.selectedHexes.clear();
  document.getElementById('mergedSelectionPanel').classList.remove('active');
}

function zoomToSelection() {
  if (state.selectedHexes.size === 0) return;
  const bounds = L.latLngBounds(Array.from(state.selectedHexes.values()).map(it => it.h.center));
  map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
}

// Color Metric Switcher (HA30 vs Mean Duration)
function setColorMetric(metric) {
  state.colorMetric = metric;
  document.getElementById('btnMetricHa').classList.toggle('active', metric === 'ha');
  document.getElementById('btnMetricMean').classList.toggle('active', metric === 'mean');

  // Re-color all polygons
  state.polygons.forEach(item => {
    const isSelected = state.selectedHexes.has(item.h.hex);
    const color = metric === 'ha' ? item.h.color_ha : item.h.color_mean;
    item.polygon.setStyle({
      fillColor: color,
      color: isSelected ? '#06b6d4' : '#ffffff'
    });
  });

  updateLegend();
  renderLabels();
}

// Render labels on hexagons
function renderLabels() {
  labelLayerGroup.clearLayers();
  if (!state.showLabels) return;

  state.polygons.forEach(item => {
    const h = item.h;
    if (h.pct < state.minBreachFilter) return;

    let htmlContent;
    if (state.cellLabelMode === 'orders_only') {
      htmlContent = `<div class="lbl-main-orders"><b>${h.orders.toLocaleString()}</b> <span class="lbl-unit">orders</span></div>`;
    } else {
      const metricText = state.colorMetric === 'ha'
        ? `${h.pct.toFixed(0)}% HA${state.threshold}`
        : `${h.mean.toFixed(1)} min`;
      htmlContent = `
        <div class="lbl-main-orders"><b>${h.orders.toLocaleString()}</b> <span class="lbl-unit">orders</span></div>
        <div class="lbl-sub-metric">${metricText}</div>
      `;
    }

    const icon = L.divIcon({
      className: 'leaflet-hex-label',
      html: htmlContent,
      iconSize: [84, 32],
      iconAnchor: [42, 16]
    });
    const marker = L.marker(h.center, { interactive: false, icon: icon });
    labelLayerGroup.addLayer(marker);
  });
}

function updateLabelsVisibility() {
  if (state.showLabels) {
    renderLabels();
  }
}

// Filter hexagons by breach rate slider
function filterHexagons() {
  state.polygons.forEach(item => {
    const isVisible = item.h.pct >= state.minBreachFilter;
    const isSelected = state.selectedHexes.has(item.h.hex);
    item.polygon.setStyle({
      fillOpacity: isVisible ? state.opacity : 0.05,
      weight: isSelected ? 3.5 : (isVisible ? 1.2 : 0.2)
    });
  });
  if (state.showLabels) {
    renderLabels();
  }
}

// Update Legend UI based on active color metric
function updateLegend() {
  if (!state.data) return;
  const layerData = state.data.layers[state.currentLayer].res[state.currentRes];
  if (!layerData) return;

  const s = layerData.scale;
  const titleEl = document.getElementById('legendTitle');
  const subEl = document.getElementById('legendSub');
  const minEl = document.getElementById('legendMin');
  const maxEl = document.getElementById('legendMax');

  if (state.colorMetric === 'ha') {
    titleEl.textContent = `HA${state.threshold}% SLA Breach Rate`;
    subEl.textContent = `Share of orders exceeding ${state.threshold} min contractual accept`;
    minEl.textContent = `${s.vmin.toFixed(0)}% (Fast/Best)`;
    maxEl.textContent = `${s.vmax.toFixed(0)}% (Slow/Worst)`;
  } else {
    titleEl.textContent = `Mean Accept Duration (minutes)`;
    subEl.textContent = `Average time from order creation to courier accept`;
    minEl.textContent = `${s.mmin.toFixed(0)} min (Fastest)`;
    maxEl.textContent = `${s.mmax.toFixed(0)} min (Slowest)`;
  }

  document.getElementById('legendMinOrders').textContent = state.minOrders;
}

// Update Resolution Controls UI
function updateResolutionUI() {
  if (!state.data) return;
  const areas = state.data.areas;
  document.getElementById('resValMain').textContent = `Resolution ${state.currentRes}`;
  document.getElementById('resValArea').textContent = areas[state.currentRes] || '';

  document.getElementById('btnResMinus').disabled = (state.currentRes <= state.data.res_min);
  document.getElementById('btnResPlus').disabled = (state.currentRes >= state.data.res_max);
}

// Switch Layer (Source vs Destination)
function setLayer(layerName) {
  state.currentLayer = layerName;
  document.getElementById('btnLayerSrc').classList.toggle('active', layerName === 'source');
  document.getElementById('btnLayerDest').classList.toggle('active', layerName === 'destination');
  clearHexSelection();
  renderMapHexagons();
}

// Set Resolution (6 to 10)
function setResolution(r) {
  if (!state.data) return;
  r = Math.max(state.data.res_min, Math.min(state.data.res_max, r));
  if (r === state.currentRes) return;
  state.currentRes = r;
  clearHexSelection();
  renderMapHexagons();
  updateResolutionUI();
}

// Basemap switcher
function switchBasemap(type) {
  if (!BASEMAP_PROVIDERS[type]) return;
  state.activeBasemap = type;

  document.querySelectorAll('.basemap-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.basemap === type);
  });

  map.removeLayer(tileLayer);
  const cfg = BASEMAP_PROVIDERS[type];
  tileLayer = L.tileLayer(cfg.url, cfg.options).addTo(map);
  tileLayer.bringToBack();
}

// Center Map on city core and zoom in (avoids zooming out to a giant picture from distant outlier dropoffs)
function centerAndZoomMap(animate = true) {
  let center = [32.6546, 51.6680];
  if (state.data && state.data.city && state.data.city.lat && state.data.city.lng) {
    center = [state.data.city.lat, state.data.city.lng];
  } else if (state.data && state.data.center) {
    center = state.data.center;
  }

  // Zoomed-in level to inspect hexagons clearly without a wide "big picture"
  const targetZoom = 13.5;

  if (state.polygons.length > 0) {
    // Filter to core urban polygons within 10km of city center
    const coreCenters = state.polygons
      .map(p => p.h.center)
      .filter(c => {
        const dLat = (c[0] - center[0]) * 111.0;
        const dLng = (c[1] - center[1]) * 111.0 * Math.cos(center[0] * Math.PI / 180.0);
        return (dLat * dLat + dLng * dLng) <= 100.0;
      });

    if (coreCenters.length >= 3) {
      const bounds = L.latLngBounds(coreCenters);
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14.2, animate: animate });
      if (map.getZoom() < 13) {
        map.setZoom(13.2, { animate: false });
      }
      return;
    }
  }

  if (animate) {
    map.flyTo(center, targetZoom, { duration: 0.8 });
  } else {
    map.setView(center, targetZoom);
  }
}

// Render Bottlenecks drawer
function renderBottlenecks(bottlenecks) {
  const container = document.getElementById('bottlenecksList');
  if (!container) return;
  if (!bottlenecks || bottlenecks.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:#94a3b8;padding:8px">No critical bottlenecks detected.</div>';
    return;
  }

  container.innerHTML = bottlenecks.map((b, i) => `
    <div class="bottleneck-item" onclick="flyToHexagon('${b.hex}', [${b.center[0]}, ${b.center[1]}])">
      <div>
        <div class="b-name">#${i + 1} Zone: ${b.hex.substring(0, 8)}...</div>
        <div class="b-sub">${b.orders} orders &bull; ${b.slow} HA30 count &bull; ${b.mean} min avg</div>
      </div>
      <div class="b-badge">${b.pct.toFixed(1)}%</div>
    </div>
  `).join('');
}

window.flyToHexagon = function(hexId, center) {
  map.flyTo(center, 14, { duration: 1.2 });
  const found = state.polygons.find(p => p.h.hex === hexId);
  if (found) {
    selectSingleHexagon(found.h, found.polygon);
  }
};

// Citywide Performance Report Modal
function openCityModal() {
  if (!state.data) return;
  const kpis = state.data.kpis;
  const city = state.city;

  document.getElementById('cityModalSubtitle').textContent =
    `Full city analysis for ${city.toUpperCase()} (${state.startDate} to ${state.endDate}) &bull; ${state.selectedDates.length} days active`;

  document.getElementById('modalCityHaPct').textContent = `${kpis.overall_ha_pct.toFixed(1)}%`;
  document.getElementById('modalCityTotalOrders').textContent = kpis.total_orders.toLocaleString();
  const modalSlow = document.getElementById('modalCitySlowOrders');
  if (modalSlow) {
    modalSlow.textContent = `${(kpis.ha30_count || kpis.total_slow || 0).toLocaleString()} (of ${kpis.total_orders.toLocaleString()})`;
  }

  document.getElementById('modalCityP50').textContent = `${kpis.p50_duration || 0} min`;
  document.getElementById('modalCityMean').textContent = `${kpis.overall_mean_duration.toFixed(1)} min`;
  document.getElementById('modalCityP90').textContent = `${kpis.p90_duration || 0} min`;
  document.getElementById('modalCityP95').textContent = `${kpis.p95_duration || 0} min`;

  // Daily Table
  const tbody = document.getElementById('modalDailyTableBody');
  if (state.dailyStats && state.dailyStats.length > 0) {
    tbody.innerHTML = state.dailyStats.map(d => {
      const isSelected = state.selectedDates.includes(d.date);
      const rowStyle = isSelected ? '' : 'opacity:0.4;background:#f8fafc';
      const color = d.pct > 35 ? '#dc2626' : d.pct > 20 ? '#d97706' : '#16a34a';
      return `
        <tr style="${rowStyle};border-bottom:1px solid #f1f5f9">
          <td style="padding:5px 8px;font-weight:600">${d.label} ${isSelected ? '' : '<span style="font-size:9px;color:#94a3b8">(excluded)</span>'}</td>
          <td style="padding:5px 8px">${d.orders.toLocaleString()}</td>
          <td style="padding:5px 8px;color:#dc2626">${(d.ha30_count !== undefined ? d.ha30_count : (d.slow || 0)).toLocaleString()}</td>
          <td style="padding:5px 8px;font-weight:700;color:${color}">${d.pct.toFixed(1)}%</td>
          <td style="padding:5px 8px">${d.mean.toFixed(1)} min</td>
        </tr>
      `;
    }).join('');
  } else {
    tbody.innerHTML = '<tr><td colspan="5" style="padding:8px;text-align:center;color:#94a3b8">No daily records available</td></tr>';
  }

  document.getElementById('citywideModal').classList.add('open');
}

function closeCityModal() {
  document.getElementById('citywideModal').classList.remove('open');
}

// Export Standalone HTML
function exportStandaloneHtml() {
  const params = new URLSearchParams({
    city: state.city,
    threshold: state.threshold,
    min_orders: state.minOrders,
    customer_id: state.customerId,
    start_date: state.startDate,
    end_date: state.endDate,
  });
  if (state.selectedDates.length > 0) {
    params.append('dates', state.selectedDates.join(','));
  }
  window.open(`/api/export-html?${params.toString()}`, '_blank');
}

// Export CSV data
function exportCsvData() {
  if (!state.data) return;
  const layerData = state.data.layers[state.currentLayer].res[state.currentRes];
  if (!layerData || !layerData.hexes) return;

  const rows = [
    ['hex', 'latitude', 'longitude', 'orders', 'ha30_orders_count', 'ha30_pct', 'mean_duration_min', 'reliable', 'status']
  ];

  layerData.hexes.forEach(h => {
    rows.push([
      h.hex,
      h.center[0],
      h.center[1],
      h.orders,
      h.ha30_count !== undefined ? h.ha30_count : h.slow,
      h.pct,
      h.mean,
      h.reliable,
      h.status
    ]);
  });

  const csvContent = 'data:text/csv;charset=utf-8,' + rows.map(e => e.join(',')).join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `${state.city}_ha${state.threshold}_res${state.currentRes}_${state.currentLayer}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function showLoading(show, message = 'Loading...') {
  const el = document.getElementById('loadingIndicator');
  const txt = document.getElementById('loadingText');
  if (show) {
    txt.textContent = message;
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}
