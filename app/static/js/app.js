/**
 * Map Analytics & HA30 Hexagonal Fleet Performance Engine Frontend
 * Supports single-query batch loading with circle spinner,
 * dynamic filter scaling, transparent compact cell labels,
 * and calendar period selection.
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
  minOrdersFilter: 0,
  selectedDates: [],          // Active YYYY-MM-DD date strings
  allDates: [],               // Full range of dates
  dailyStats: [],             // Daily breakdown stats
  data: null,
  polygons: [],
  selectedHexes: new Map(),   // Multi-selected cells: hexId -> { h, polygon }
  singleSelectedHex: null,    // Single selected cell
};

// Basemap Tile Providers (Carto with API key, OpenStreetMap, Esri Satellite)
const mapApiKey = window.MAP_API_KEY || 'cb1_5558_1_345367a66619045ea57fcdba';
const cartoTileUrl = window.CARTO_TILE_URL || `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${mapApiKey}`;

const BASEMAP_PROVIDERS = {
  voyager: {
    url: cartoTileUrl.includes('key=') ? cartoTileUrl : `${cartoTileUrl}?key=${mapApiKey}`,
    options: {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: {
      maxZoom: 19,
      attribution: '&copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye'
    }
  }
};

let map;
let tileLayer;
let hexLayerGroup;
let labelLayerGroup;

function createTileLayer(type) {
  const cfg = BASEMAP_PROVIDERS[type] || BASEMAP_PROVIDERS.osm;
  const layer = L.tileLayer(cfg.url, cfg.options);

  let tileErrors = 0;
  layer.on('tileerror', () => {
    tileErrors++;
    // If Voyager tiles fail or API key is rejected, auto-fallback to OpenStreetMap
    if (tileErrors >= 2 && state.activeBasemap === 'voyager') {
      console.warn('Voyager tiles failed or API key rejected. Auto-switching to OpenStreetMap.');
      switchBasemap('osm');
    }
  });

  return layer;
}

// Proactively test if Carto Voyager API key works or is rejected
function probeVoyagerApiKey() {
  const testUrl = BASEMAP_PROVIDERS.voyager.url
    .replace('{z}', '13')
    .replace('{x}', '4812')
    .replace('{y}', '3256')
    .replace('{r}', '');

  const img = new Image();
  img.onerror = () => {
    console.warn('Carto Voyager API key rejected (401/403). Falling back to OpenStreetMap.');
    if (state.activeBasemap === 'voyager') {
      switchBasemap('osm');
    }
  };
  img.src = testUrl;
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupEventListeners();
  probeVoyagerApiKey();
  // Load default days at first in one query
  loadCityData('isfahan', true);
});

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    preferCanvas: true
  }).setView([32.6546, 51.6680], 13.5);

  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  tileLayer = createTileLayer(state.activeBasemap).addTo(map);

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

  setTimeout(() => {
    map.invalidateSize();
  }, 200);
}

function setupEventListeners() {
  // City search submit
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
      let targetRes = Math.min(10, Math.max(6, Math.round(zoom - 5)));
      setResolution(targetRes);
    }
  });

  // Basemap buttons
  document.querySelectorAll('.basemap-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      switchBasemap(e.target.dataset.basemap);
    });
  });

  // Hexagon Opacity slider
  document.getElementById('sliderOpacity').addEventListener('input', (e) => {
    state.opacity = parseFloat(e.target.value);
    document.getElementById('valOpacity').textContent = `${Math.round(state.opacity * 100)}%`;
    filterHexagons();
  });

  // Dynamic SLA breach filter slider
  const sliderBreach = document.getElementById('sliderBreachFilter');
  if (sliderBreach) {
    sliderBreach.addEventListener('input', (e) => {
      state.minBreachFilter = parseFloat(e.target.value) || 0;
      updateFilterLabels();
      filterHexagons();
    });
  }

  // Dynamic Min Orders filter slider
  const sliderOrders = document.getElementById('sliderOrdersFilter');
  if (sliderOrders) {
    sliderOrders.addEventListener('input', (e) => {
      state.minOrdersFilter = parseInt(e.target.value, 10) || 0;
      updateFilterLabels();
      filterHexagons();
    });
  }

  // Show labels checkbox and mode toggles
  const checkLabels = document.getElementById('checkShowLabels');
  if (checkLabels) {
    checkLabels.checked = state.showLabels;
    checkLabels.addEventListener('change', (e) => {
      state.showLabels = e.target.checked;
      renderLabels();
    });
  }

  const btnLblOnly = document.getElementById('btnLabelOrdersOnly');
  const btnLblHa = document.getElementById('btnLabelOrdersHa');
  if (btnLblOnly && btnLblHa) {
    btnLblOnly.addEventListener('click', () => {
      state.cellLabelMode = 'orders_only';
      btnLblOnly.classList.add('active');
      btnLblHa.classList.remove('active');
      renderLabels();
    });
    btnLblHa.addEventListener('click', () => {
      state.cellLabelMode = 'orders_ha';
      btnLblHa.classList.add('active');
      btnLblOnly.classList.remove('active');
      renderLabels();
    });
  }

  // Multi-select mode checkbox
  const checkMulti = document.getElementById('checkMultiSelectMode');
  if (checkMulti) {
    checkMulti.addEventListener('change', (e) => {
      state.multiSelectMode = e.target.checked;
    });
  }

  // Calendar / Period Trigger & Popover
  const btnTrigger = document.getElementById('btnCalendarTrigger');
  const popover = document.getElementById('calendarPopover');
  const btnClosePopover = document.getElementById('btnCloseCalendarPopover');
  const btnCancelPopover = document.getElementById('btnCancelCalendar');
  const btnApplyPeriod = document.getElementById('btnApplyCalendarPeriod');

  if (btnTrigger && popover) {
    btnTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      popover.classList.toggle('open');
      if (popover.classList.contains('open')) {
        document.getElementById('popoverStartDate').value = state.startDate;
        document.getElementById('popoverEndDate').value = state.endDate;
      }
    });

    if (btnClosePopover) {
      btnClosePopover.addEventListener('click', () => popover.classList.remove('open'));
    }
    if (btnCancelPopover) {
      btnCancelPopover.addEventListener('click', () => popover.classList.remove('open'));
    }

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && !btnTrigger.contains(e.target)) {
        popover.classList.remove('open');
      }
    });

    // Preset chips in popover
    document.querySelectorAll('.btn-preset-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const sDate = chip.dataset.start;
        const eDate = chip.dataset.end;
        if (sDate && eDate) {
          document.getElementById('popoverStartDate').value = sDate;
          document.getElementById('popoverEndDate').value = eDate;
          applyNewDatePeriod(sDate, eDate);
          popover.classList.remove('open');
        }
      });
    });

    // Apply button in popover
    if (btnApplyPeriod) {
      btnApplyPeriod.addEventListener('click', () => {
        const sDate = document.getElementById('popoverStartDate').value;
        const eDate = document.getElementById('popoverEndDate').value;
        if (!sDate || !eDate) {
          alert("Please select both start date and end date.");
          return;
        }
        if (sDate > eDate) {
          alert("Start date must be before or equal to end date.");
          return;
        }
        applyNewDatePeriod(sDate, eDate);
        popover.classList.remove('open');
      });
    }
  }

  // Refresh button
  const btnRefresh = document.getElementById('btnRefreshData');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      loadCityData(state.city, false, true);
    });
  }

  // Quick Day Actions
  document.getElementById('btnSelectAllDays').addEventListener('click', selectAllDays);
  document.getElementById('btnSelectWeekdays').addEventListener('click', selectWeekdays);
  document.getElementById('btnSelectWeekends').addEventListener('click', selectWeekends);

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
    updateCalendarTriggerLabel();
    loadCityData(state.city, false);
  });

  // Center Map button
  document.getElementById('btnFitBounds').addEventListener('click', () => centerAndZoomMap(true));

  // Export buttons
  document.getElementById('btnExportHtml').addEventListener('click', exportStandaloneHtml);

  // CSV file upload handler
  const btnUpload = document.getElementById('btnOpenUpload');
  const fileInput = document.getElementById('csvFileInput');
  if (btnUpload && fileInput) {
    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);

      showLoading(true, `Uploading & analyzing ${file.name}...`);
      try {
        const res = await fetch(`/api/upload-csv?threshold=${state.threshold}&min_orders=${state.minOrders}`, {
          method: 'POST',
          body: formData
        });
        if (!res.ok) throw new Error('Upload failed');
        const data = await res.json();
        state.data = data;
        state.city = 'Uploaded CSV';
        state.allDates = [];
        state.selectedDates = [];
        state.dailyStats = [];

        clearHexSelection();
        updateKpis(data.kpis, 'Uploaded CSV', data.data_source);
        renderDaysSelector([], [], []);
        renderMapHexagons();
        resizeFilterSliders();
        renderBottlenecks(data.bottlenecks);
        centerAndZoomMap(true);
        updateLegend();
        updateResolutionUI();
      } catch (err) {
        alert('Could not parse CSV: ' + err.message);
      } finally {
        showLoading(false);
      }
    });
  }
}

// Format date nicely: YYYY-MM-DD -> "Oct 22, 2026"
function formatDateReadable(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = parseInt(parts[1], 10) - 1;
  const monthName = monthNames[monthIdx] || parts[1];
  return `${monthName} ${parseInt(parts[2], 10)}`;
}

function updateCalendarTriggerLabel() {
  const lbl = document.getElementById('calendarTriggerLabel');
  if (!lbl) return;
  const startFmt = formatDateReadable(state.startDate);
  const endFmt = formatDateReadable(state.endDate);
  const year = (state.endDate || state.startDate || '').split('-')[0] || '2026';
  lbl.textContent = `${startFmt} – ${endFmt}, ${year}`;
}

function applyNewDatePeriod(startDate, endDate) {
  state.startDate = startDate;
  state.endDate = endDate;
  state.selectedDates = null; // Reset to select all dates in new period
  updateCalendarTriggerLabel();
  loadCityData(state.city, false);
}

// Fetch city data from API with optional dates filter
async function loadCityData(city, isNewCity = false, forceRefresh = false) {
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

    if (forceRefresh) {
      params.append('force_refresh', 'true');
    }

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

    updateCalendarTriggerLabel();

    const modalStart = document.getElementById('inputStartDate');
    const modalEnd = document.getElementById('inputEndDate');
    if (modalStart) modalStart.value = state.startDate;
    if (modalEnd) modalEnd.value = state.endDate;

    clearHexSelection();
    updateKpis(data.kpis, city, data.data_source);
    renderDaysSelector(state.dailyStats, state.allDates, state.selectedDates);
    renderMapHexagons();
    resizeFilterSliders();
    renderBottlenecks(data.bottlenecks);

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

// Dynamically rescale Min SLA Breach and Min Orders filter sliders to the max in active data
function resizeFilterSliders() {
  if (!state.data) return;
  const layerData = state.data.layers?.[state.currentLayer]?.res?.[state.currentRes];
  const hexes = layerData?.hexes || [];

  let maxSla = 0;
  let maxOrders = 0;
  hexes.forEach(h => {
    if (h.pct > maxSla) maxSla = h.pct;
    if (h.orders > maxOrders) maxOrders = h.orders;
  });

  // Scale Min SLA Breach Filter slider
  const breachSlider = document.getElementById('sliderBreachFilter');
  if (breachSlider) {
    const ceilSla = Math.ceil(maxSla);
    const sliderMax = Math.max(ceilSla, 10);
    breachSlider.max = sliderMax;
    breachSlider.step = sliderMax > 25 ? 1 : 0.5;
    if (state.minBreachFilter > sliderMax) {
      state.minBreachFilter = 0;
    }
    breachSlider.value = state.minBreachFilter;
    breachSlider.dataset.dataMax = ceilSla;
  }

  // Scale Min Orders in Cell slider
  const ordersSlider = document.getElementById('sliderOrdersFilter');
  if (ordersSlider) {
    const sliderMax = Math.max(maxOrders, 10);
    ordersSlider.max = sliderMax;
    ordersSlider.step = 1;
    if (state.minOrdersFilter > sliderMax) {
      state.minOrdersFilter = 0;
    }
    ordersSlider.value = state.minOrdersFilter;
    ordersSlider.dataset.dataMax = maxOrders;
  }

  updateFilterLabels();
}

function updateFilterLabels() {
  const breachSlider = document.getElementById('sliderBreachFilter');
  const breachVal = document.getElementById('valBreachFilter');
  if (breachSlider && breachVal) {
    const maxVal = breachSlider.dataset.dataMax || breachSlider.max;
    breachVal.textContent = `${state.minBreachFilter}% (max: ${maxVal}%)`;
  }

  const ordersSlider = document.getElementById('sliderOrdersFilter');
  const ordersVal = document.getElementById('valOrdersFilter');
  if (ordersSlider && ordersVal) {
    const maxVal = ordersSlider.dataset.dataMax || ordersSlider.max;
    ordersVal.textContent = `${state.minOrdersFilter} (max: ${maxVal})`;
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
}

// Render Interactive Day Selector Strip
function renderDaysSelector(dailyStats, allDates, selectedDates) {
  const container = document.getElementById('daysPillsContainer');
  if (!container) return;

  if (!dailyStats || dailyStats.length === 0) {
    container.innerHTML = '<span style="font-size:11px;color:#64748b;padding:4px">No day breakdown for active data</span>';
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

// Render Hexagon Polygons on Map
function renderMapHexagons() {
  if (!state.data) return;

  hexLayerGroup.clearLayers();
  labelLayerGroup.clearLayers();
  state.polygons = [];

  const layerData = state.data.layers[state.currentLayer].res[state.currentRes];
  if (!layerData || !layerData.hexes) return;

  layerData.hexes.forEach(h => {
    const isVisible = (h.pct >= state.minBreachFilter) && (h.orders >= state.minOrdersFilter);
    const isSelected = state.selectedHexes.has(h.hex);
    const fillColor = state.colorMetric === 'ha' ? h.color_ha : h.color_mean;

    const polygon = L.polygon(h.ring, {
      color: isSelected ? '#06b6d4' : '#ffffff',
      weight: isVisible ? (isSelected ? 3.5 : 1.2) : 0,
      fillColor: fillColor,
      fillOpacity: isVisible ? state.opacity : 0,
      opacity: isVisible ? 1 : 0,
      className: `h3-hex ${h.status}`,
      interactive: isVisible
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

  return `
    <div style="font-family:Inter,sans-serif;font-size:12px;line-height:1.45;min-width:180px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
        <span style="font-size:13.5px;color:#0f172a"><b>HA${state.threshold}%: ${h.pct.toFixed(1)}%</b></span>
        <span style="font-size:12px;font-weight:400;color:#475569">${h.orders} orders</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1px">
        <span style="color:#64748b">HA${state.threshold} Orders Count:</span>
        <b style="color:#dc2626">${h.slow}</b>
      </div>
      <div style="font-size:9.5px;color:#94a3b8;margin-bottom:4px">(create to accept time &ge; ${state.threshold} min)</div>
      <div style="display:flex;justify-content:space-between;margin:2px 0">
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

// Render labels on hexagons: SMALLER, TRANSPARENT (NO WHITE BACKGROUND), FITS CELL
function renderLabels() {
  labelLayerGroup.clearLayers();
  if (!state.showLabels) return;

  state.polygons.forEach(item => {
    const h = item.h;
    // Only render label if cell passes active breach and orders filters
    if (h.pct < state.minBreachFilter || h.orders < state.minOrdersFilter) return;

    let htmlContent;
    if (state.cellLabelMode === 'orders_only') {
      htmlContent = `<span class="lbl-main-orders">${h.orders.toLocaleString()}</span>`;
    } else {
      const metricText = state.colorMetric === 'ha'
        ? `${h.pct.toFixed(0)}%`
        : `${h.mean.toFixed(1)}m`;
      htmlContent = `
        <span class="lbl-main-orders">${h.orders.toLocaleString()}</span>
        <span class="lbl-sub-metric">${metricText}</span>
      `;
    }

    const icon = L.divIcon({
      className: 'leaflet-hex-label',
      html: htmlContent,
      iconSize: [44, 20],
      iconAnchor: [22, 10]
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

// Filter hexagons by breach rate and orders slider: completely hides non-matching cells
function filterHexagons() {
  state.polygons.forEach(item => {
    const isVisible = (item.h.pct >= state.minBreachFilter) && (item.h.orders >= state.minOrdersFilter);
    const isSelected = state.selectedHexes.has(item.h.hex);

    if (isVisible) {
      item.polygon.setStyle({
        fillOpacity: state.opacity,
        opacity: 1,
        weight: isSelected ? 3.5 : 1.2,
        color: isSelected ? '#06b6d4' : '#ffffff'
      });
      const el = item.polygon.getElement();
      if (el) el.style.pointerEvents = 'auto';
    } else {
      item.polygon.setStyle({
        fillOpacity: 0,
        opacity: 0,
        weight: 0
      });
      const el = item.polygon.getElement();
      if (el) el.style.pointerEvents = 'none';
    }
  });

  renderLabels();
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
    subEl.textContent = `Orders exceeding ${state.threshold} min contractual accept`;
    minEl.textContent = `${s.vmin.toFixed(0)}% (Fast)`;
    maxEl.textContent = `${s.vmax.toFixed(0)}% (Slow)`;
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
  resizeFilterSliders();
}

// Set Resolution (6 to 10)
function setResolution(r) {
  if (!state.data) return;
  r = Math.max(state.data.res_min, Math.min(state.data.res_max, r));
  if (r === state.currentRes) return;
  state.currentRes = r;
  clearHexSelection();
  renderMapHexagons();
  resizeFilterSliders();
  updateResolutionUI();
}

// Basemap switcher
function switchBasemap(type) {
  if (!BASEMAP_PROVIDERS[type]) return;
  state.activeBasemap = type;

  document.querySelectorAll('.basemap-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.basemap === type);
  });

  if (tileLayer) {
    map.removeLayer(tileLayer);
  }
  tileLayer = createTileLayer(type).addTo(map);
  tileLayer.bringToBack();
}

// Center Map on city core
function centerAndZoomMap(animate = true) {
  let center = [32.6546, 51.6680];
  if (state.data && state.data.city && state.data.city.lat && state.data.city.lng) {
    center = [state.data.city.lat, state.data.city.lng];
  } else if (state.data && state.data.center) {
    center = state.data.center;
  }

  const targetZoom = 13.5;

  if (state.polygons.length > 0) {
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
    <div class="bottleneck-row" onclick="flyToHexagon('${b.hex}', [${b.center[0]}, ${b.center[1]}])">
      <div>
        <div style="font-weight:700">#${i + 1} ${b.hex.substring(0, 8)}...</div>
        <div style="font-size:9.5px;color:#64748b">${b.orders} orders &bull; ${b.slow} HA30 &bull; ${b.mean}m avg</div>
      </div>
      <div style="font-weight:800;color:#dc2626">${b.pct.toFixed(1)}%</div>
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

// Show/Hide Circle Loading Spinner
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
