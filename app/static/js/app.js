/**
 * Map Analytics & HA30 Hexagonal Fleet Performance Engine Frontend
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
  currentLayer: 'source', // 'source' or 'destination'
  currentRes: 8,
  autoRes: false,
  opacity: 0.65,
  showLabels: false,
  activeBasemap: 'voyager',
  minBreachFilter: 0,
  data: null,
  polygons: [],
  labels: [],
  selectedHex: null,
};

// Basemap Tile Providers (Tested & Reliable - No API key expiration)
const BASEMAP_PROVIDERS = {
  voyager: {
    url: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
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

// Map & Layer references
let map;
let tileLayer;
let hexLayerGroup;
let labelLayerGroup;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupEventListeners();
  loadCityData('isfahan');
});

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    preferCanvas: true
  }).setView([32.6546, 51.6680], 12);

  // Custom zoom control position
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  tileLayer = L.tileLayer(BASEMAP_PROVIDERS.voyager.url, BASEMAP_PROVIDERS.voyager.options).addTo(map);
  hexLayerGroup = L.layerGroup().addTo(map);
  labelLayerGroup = L.layerGroup().addTo(map);

  // Zoom end listener for auto-resolution
  map.on('zoomend', () => {
    if (state.autoRes && state.data) {
      const zoom = map.getZoom();
      // Zoom 10 -> Res 6; Zoom 11 -> Res 7; Zoom 12-13 -> Res 8; Zoom 14 -> Res 9; Zoom 15+ -> Res 10
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
      loadCityData(city);
    }
  });

  // Layer buttons (Source vs Destination)
  document.getElementById('btnLayerSrc').addEventListener('click', () => setLayer('source'));
  document.getElementById('btnLayerDest').addEventListener('click', () => setLayer('destination'));

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
      item.polygon.setStyle({ fillOpacity: state.opacity });
    });
  });

  // SLA breach filter slider
  document.getElementById('sliderBreachFilter').addEventListener('input', (e) => {
    state.minBreachFilter = parseFloat(e.target.value);
    document.getElementById('valBreachFilter').textContent = `${state.minBreachFilter}%`;
    filterHexagons();
  });

  // Show labels checkbox
  document.getElementById('checkShowLabels').addEventListener('change', (e) => {
    state.showLabels = e.target.checked;
    renderLabels();
  });

  // Basemap buttons
  document.querySelectorAll('.basemap-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const provider = e.currentTarget.dataset.basemap;
      switchBasemap(provider);
    });
  });

  // Preset city chips
  document.querySelectorAll('.chip-btn').forEach(chip => {
    chip.addEventListener('click', (e) => {
      const city = e.currentTarget.dataset.city;
      document.getElementById('cityInput').value = city;
      loadCityData(city);
    });
  });

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
    document.getElementById('filterModal').classList.remove('open');
    loadCityData(state.city);
  });

  // Fit bounds button
  document.getElementById('btnFitBounds').addEventListener('click', fitMapToBounds);

  // Inspector close button
  document.getElementById('btnCloseInspector').addEventListener('click', closeInspector);

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
        updateKpis(data.kpis, state.city, data.data_source);
        renderMapHexagons();
        renderBottlenecks(data.bottlenecks);
        fitMapToBounds();
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

// Fetch city data from API
async function loadCityData(city) {
  showLoading(true, `Analyzing ${city.toUpperCase()} HA${state.threshold}% Fleet Data...`);
  state.city = city;
  
  // Highlight active chip if matches
  document.querySelectorAll('.chip-btn').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.city.toLowerCase() === city.toLowerCase());
  });

  try {
    const params = new URLSearchParams({
      city: city,
      threshold: state.threshold,
      min_orders: state.minOrders,
      customer_id: state.customerId,
      start_date: state.startDate,
      end_date: state.endDate,
    });

    const res = await fetch(`/api/data?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    const data = await res.json();
    state.data = data;

    updateKpis(data.kpis, city, data.data_source);
    renderMapHexagons();
    renderBottlenecks(data.bottlenecks);
    fitMapToBounds();
    updateLegend();
    updateResolutionUI();
  } catch (err) {
    console.error('Error loading city data:', err);
    alert(`Could not load data for "${city}": ${err.message}`);
  } finally {
    showLoading(false);
  }
}

// Update Top Floating KPI Cards
function updateKpis(kpis, city, dataSource) {
  document.getElementById('kpiTotalOrders').textContent = kpis.total_orders.toLocaleString();
  
  const haEl = document.getElementById('kpiHaPct');
  haEl.textContent = `${kpis.overall_ha_pct.toFixed(1)}%`;
  haEl.className = 'kpi-val ' + (kpis.overall_ha_pct > 25 ? 'highlight-breach' : 'highlight-success');
  
  document.getElementById('kpiSlowOrders').textContent = kpis.total_slow.toLocaleString();
  document.getElementById('kpiMeanDuration').textContent = `${kpis.overall_mean_duration.toFixed(1)}s`;
  
  document.getElementById('headerCityLabel').textContent = `${city.toUpperCase()}`;
  document.getElementById('headerThresholdLabel').textContent = `HA${kpis.threshold}%`;
  
  const sourceBadge = document.getElementById('dataSourceBadge');
  if (sourceBadge) {
    sourceBadge.textContent = dataSource.includes('ClickHouse') ? 'ClickHouse Live' : 'High-Fidelity Engine';
    sourceBadge.title = dataSource;
  }
}

// Render Hexagons for current layer and resolution
function renderMapHexagons() {
  if (!state.data) return;

  hexLayerGroup.clearLayers();
  labelLayerGroup.clearLayers();
  state.polygons = [];
  state.labels = [];

  const layerData = state.data.layers[state.currentLayer].res[state.currentRes];
  if (!layerData || !layerData.hexes) return;

  layerData.hexes.forEach(h => {
    const isVisible = h.pct >= state.minBreachFilter;
    const polygon = L.polygon(h.ring, {
      color: '#ffffff',
      weight: 1.2,
      fillColor: h.color,
      fillOpacity: isVisible ? state.opacity : 0.05,
      className: `h3-hex ${h.status}`
    });

    // Tooltip formatting deeply showing orders & HA30
    polygon.bindTooltip(createTooltipContent(h), {
      sticky: true,
      className: 'hex-tooltip'
    });

    polygon.on('mouseover', () => {
      polygon.setStyle({ weight: 2.8, color: '#0f172a' });
      polygon.bringToFront();
    });

    polygon.on('mouseout', () => {
      const isSelected = state.selectedHex && state.selectedHex.hex === h.hex;
      polygon.setStyle({
        weight: isSelected ? 3.0 : 1.2,
        color: isSelected ? '#2563eb' : '#ffffff'
      });
    });

    polygon.on('click', () => {
      selectHexagon(h, polygon);
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

  return `
    <div style="font-family:Inter,sans-serif;font-size:12px;line-height:1.45;min-width:180px">
      <div style="font-weight:700;font-size:13px;color:#0f172a;display:flex;justify-content:space-between">
        <span>HA${state.threshold}%: <span style="color:${h.pct > 25 ? '#dc2626' : '#16a34a'}">${h.pct.toFixed(1)}%</span></span>
      </div>
      <div style="font-size:10.5px;color:#64748b;margin-bottom:4px">${statusText}</div>
      <hr style="border:0;border-top:1px solid #e2e8f0;margin:4px 0">
      <div style="display:flex;justify-content:space-between">
        <span style="color:#64748b">Total Orders:</span>
        <b style="color:#0f172a">${h.orders}</b>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span style="color:#64748b">Slow (&ge;${state.threshold}s):</span>
        <b style="color:#dc2626">${h.slow}</b>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span style="color:#64748b">Mean Duration:</span>
        <b>${h.mean.toFixed(1)}s</b>
      </div>
      <div style="margin-top:4px;font-size:9.5px;color:#94a3b8">Hex: ${h.hex}</div>
    </div>
  `;
}

// Select a hexagon and show in Inspector Card
function selectHexagon(h, polygon) {
  // Clear previous selection highlight
  if (state.selectedHex && state.selectedHex.polygon) {
    state.selectedHex.polygon.setStyle({ weight: 1.2, color: '#ffffff' });
  }

  state.selectedHex = { h, polygon };
  polygon.setStyle({ weight: 3.2, color: '#2563eb' });
  polygon.bringToFront();

  const inspector = document.getElementById('inspectorPanel');
  const totalWithVal = h.with_value || h.orders;
  const fast = totalWithVal - h.slow;
  const slowPct = totalWithVal > 0 ? (h.slow / totalWithVal * 100) : 0;
  const fastPct = totalWithVal > 0 ? (fast / totalWithVal * 100) : 0;

  document.getElementById('inspHexId').textContent = h.hex;
  document.getElementById('inspStatusBadge').className = `badge badge-${h.status}`;
  document.getElementById('inspStatusBadge').textContent = h.status.replace('_', ' ').toUpperCase();
  document.getElementById('inspHaPct').textContent = `${h.pct.toFixed(1)}%`;
  document.getElementById('inspHaPct').style.color = h.pct > 25 ? '#dc2626' : '#16a34a';
  document.getElementById('inspTotalOrders').textContent = h.orders;
  document.getElementById('inspSlowOrders').textContent = h.slow;
  document.getElementById('inspFastOrders').textContent = fast;
  document.getElementById('inspMeanDuration').textContent = `${h.mean.toFixed(1)}s`;
  document.getElementById('inspCoords').textContent = `${h.center[0]}, ${h.center[1]}`;

  const barSlow = document.getElementById('inspBarSlow');
  const barFast = document.getElementById('inspBarFast');
  barSlow.style.width = `${slowPct}%`;
  barFast.style.width = `${fastPct}%`;

  inspector.classList.add('active');
}

function closeInspector() {
  if (state.selectedHex && state.selectedHex.polygon) {
    state.selectedHex.polygon.setStyle({ weight: 1.2, color: '#ffffff' });
  }
  state.selectedHex = null;
  document.getElementById('inspectorPanel').classList.remove('active');
}

// Render labels on hexagons
function renderLabels() {
  labelLayerGroup.clearLayers();
  if (!state.showLabels) return;

  state.polygons.forEach(item => {
    const h = item.h;
    if (h.pct < state.minBreachFilter) return;

    const icon = L.divIcon({
      className: 'leaflet-hex-label',
      html: `<div>${h.pct.toFixed(0)}%</div><div class="lbl-orders">${h.orders} ord</div>`,
      iconSize: [60, 26],
      iconAnchor: [30, 13]
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
    item.polygon.setStyle({
      fillOpacity: isVisible ? state.opacity : 0.05,
      weight: isVisible ? 1.2 : 0.2
    });
  });
  if (state.showLabels) {
    renderLabels();
  }
}

// Update Legend UI
function updateLegend() {
  if (!state.data) return;
  const layerData = state.data.layers[state.currentLayer].res[state.currentRes];
  if (!layerData) return;

  const s = layerData.scale;
  document.getElementById('legendMin').textContent = `${s.vmin.toFixed(0)}% (Best)`;
  document.getElementById('legendMax').textContent = `${s.vmax.toFixed(0)}% (Worst)`;
  document.getElementById('legendThreshold').textContent = state.threshold;
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
  renderMapHexagons();
}

// Set Resolution (6 to 10)
function setResolution(r) {
  if (!state.data) return;
  r = Math.max(state.data.res_min, Math.min(state.data.res_max, r));
  if (r === state.currentRes) return;
  state.currentRes = r;
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

// Fit Map to current hexagons bounds
function fitMapToBounds() {
  if (state.polygons.length > 0) {
    const bounds = L.latLngBounds(state.polygons.map(p => p.h.center));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  } else if (state.data && state.data.center) {
    map.setView(state.data.center, 12);
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
        <div class="b-sub">${b.orders} orders &bull; ${b.slow} slow &bull; ${b.mean}s avg</div>
      </div>
      <div class="b-badge">${b.pct.toFixed(1)}%</div>
    </div>
  `).join('');
}

window.flyToHexagon = function(hexId, center) {
  map.flyTo(center, 14, { duration: 1.2 });
  const found = state.polygons.find(p => p.h.hex === hexId);
  if (found) {
    selectHexagon(found.h, found.polygon);
  }
};

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
  window.open(`/api/export-html?${params.toString()}`, '_blank');
}

// Export CSV data
function exportCsvData() {
  if (!state.data) return;
  const layerData = state.data.layers[state.currentLayer].res[state.currentRes];
  if (!layerData || !layerData.hexes) return;

  const rows = [
    ['hex', 'latitude', 'longitude', 'orders', 'slow', 'fast', 'pct_slow', 'mean_duration', 'reliable', 'status']
  ];

  layerData.hexes.forEach(h => {
    rows.push([
      h.hex,
      h.center[0],
      h.center[1],
      h.orders,
      h.slow,
      h.fast,
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
