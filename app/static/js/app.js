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
  cellLabelMode: 'orders_ha', // 'orders_ha', 'ha_only', or 'orders_only'
  multiSelectMode: false,
  colorMetric: 'ha',          // 'ha' (HA30% breach), 'mean' (Mean duration), 'share' (City HA Share %), or 'fare' (Biker Fare)
  activeBasemap: 'voyager',
  minBreachFilter: 0,
  minMeanFilter: 0,
  minShareFilter: 0,
  minFareFilter: 0,
  minOrdersFilter: 0,
  selectedDates: [],          // Active YYYY-MM-DD date strings
  allDates: [],               // Full range of dates
  dailyStats: [],             // Daily breakdown stats
  data: null,
  polygons: [],
  selectedHexes: new Map(),   // Multi-selected cells: hexId -> { h, polygon }
  singleSelectedHex: null,    // Single selected cell
  bikerExportToggle: 'less',  // 'less' or 'more' (default on less)
  bikerPreviewRecords: [],    // Live cached records for biker preview table
  bikerSortCol: 'percentage_of_rides_in_boundary',
  bikerSortDir: 'desc',
};

// Helpers for Currency & Fare Formatting
function formatFare(val) {
  if (val === undefined || val === null || isNaN(val)) return '0';
  if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
  if (val >= 1000) return Math.round(val / 1000) + 'k';
  return Math.round(val).toString();
}

function formatFareFull(val) {
  if (val === undefined || val === null || isNaN(val)) return '0';
  return Number(Math.round(val)).toLocaleString();
}

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
  initCalendarUI();
  initBikerCalendarUI();
  probeVoyagerApiKey();
  initSessionDialog();
});

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    preferCanvas: true,
    doubleClickZoom: false
  }).setView([32.6546, 51.6680], 12);

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
        return;
      }
    }
    renderLabels();
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

  // City input datalist change
  document.getElementById('cityInput').addEventListener('change', () => {
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

  // Color Metric Toggle (HA30 vs Mean Duration vs City HA Share vs Biker Fare)
  document.getElementById('btnMetricHa').addEventListener('click', () => setColorMetric('ha'));
  document.getElementById('btnMetricMean').addEventListener('click', () => setColorMetric('mean'));
  const btnMetricShare = document.getElementById('btnMetricShare');
  if (btnMetricShare) {
    btnMetricShare.addEventListener('click', () => setColorMetric('share'));
  }
  const btnMetricFare = document.getElementById('btnMetricFare');
  if (btnMetricFare) {
    btnMetricFare.addEventListener('click', () => setColorMetric('fare'));
  }

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

  // Dynamic SLA breach filter slider & number input
  // Dynamic Metric (SLA breach / Mean duration / City HA share / Biker Fare) filter slider & number input
  const sliderBreach = document.getElementById('sliderBreachFilter');
  const numBreach = document.getElementById('numBreachFilter');
  if (sliderBreach) {
    sliderBreach.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) || 0;
      if (state.colorMetric === 'ha') {
        state.minBreachFilter = val;
      } else if (state.colorMetric === 'mean') {
        state.minMeanFilter = val;
      } else if (state.colorMetric === 'fare') {
        state.minFareFilter = val;
      } else {
        state.minShareFilter = val;
      }
      if (numBreach) numBreach.value = val;
      updateFilterLabels();
      filterHexagons();
    });
  }
  if (numBreach) {
    ['input', 'change'].forEach(evt => {
      numBreach.addEventListener(evt, (e) => {
        let val = parseFloat(e.target.value) || 0;
        const isHa = state.colorMetric === 'ha';
        const maxVal = isHa ? 5 : (parseFloat(sliderBreach?.dataset.dataMax || sliderBreach?.max) || 100);
        val = Math.max(0, Math.min(val, maxVal));
        if (state.colorMetric === 'ha') {
          state.minBreachFilter = val;
        } else if (state.colorMetric === 'mean') {
          state.minMeanFilter = val;
        } else if (state.colorMetric === 'fare') {
          state.minFareFilter = val;
        } else {
          state.minShareFilter = val;
        }
        if (sliderBreach) sliderBreach.value = val;
        updateFilterLabels();
        filterHexagons();
      });
    });
  }

  // Dynamic Min Orders filter slider & number input
  const sliderOrders = document.getElementById('sliderOrdersFilter');
  const numOrders = document.getElementById('numOrdersFilter');
  if (sliderOrders) {
    sliderOrders.addEventListener('input', (e) => {
      state.minOrdersFilter = parseInt(e.target.value, 10) || 0;
      if (numOrders) numOrders.value = state.minOrdersFilter;
      updateFilterLabels();
      filterHexagons();
    });
  }
  if (numOrders) {
    ['input', 'change'].forEach(evt => {
      numOrders.addEventListener(evt, (e) => {
        let val = parseInt(e.target.value, 10) || 0;
        const maxVal = parseInt(sliderOrders?.dataset.dataMax || sliderOrders?.max, 10) || 10000;
        val = Math.max(0, Math.min(val, maxVal));
        state.minOrdersFilter = val;
        if (sliderOrders) sliderOrders.value = val;
        updateFilterLabels();
        filterHexagons();
      });
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

  const btnLblHa = document.getElementById('btnLabelOrdersHa');
  const btnLblHaOnly = document.getElementById('btnLabelHaOnly');
  const btnLblOnly = document.getElementById('btnLabelOrdersOnly');

  function setCellLabelMode(mode) {
    state.cellLabelMode = mode;
    if (btnLblHa) btnLblHa.classList.toggle('active', mode === 'orders_ha');
    if (btnLblHaOnly) btnLblHaOnly.classList.toggle('active', mode === 'ha_only');
    if (btnLblOnly) btnLblOnly.classList.toggle('active', mode === 'orders_only');
    if (!state.showLabels) {
      state.showLabels = true;
      if (checkLabels) checkLabels.checked = true;
    }
    renderLabels();
  }

  if (btnLblHa) btnLblHa.addEventListener('click', () => setCellLabelMode('orders_ha'));
  if (btnLblHaOnly) btnLblHaOnly.addEventListener('click', () => setCellLabelMode('ha_only'));
  if (btnLblOnly) btnLblOnly.addEventListener('click', () => setCellLabelMode('orders_only'));

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
        calState.startDate = state.startDate;
        calState.endDate = state.endDate;
        calState.pickingState = 'none';
        calState.hoverDate = null;
        if (state.startDate) {
          const parts = state.startDate.split('-');
          calState.viewYear = parseInt(parts[0], 10);
          calState.viewMonth = parseInt(parts[1], 10) - 1;
        }
        renderCalendarGrid();
      }
    });

    // Prevent clicks inside popover from closing it
    popover.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    if (btnClosePopover) {
      btnClosePopover.addEventListener('click', (e) => {
        e.stopPropagation();
        popover.classList.remove('open');
      });
    }
    if (btnCancelPopover) {
      btnCancelPopover.addEventListener('click', (e) => {
        e.stopPropagation();
        popover.classList.remove('open');
      });
    }

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && !btnTrigger.contains(e.target)) {
        popover.classList.remove('open');
      }
    });

    // Preset chips in popover
    document.querySelectorAll('.btn-preset-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        let sDate = chip.dataset.start;
        let eDate = chip.dataset.end;

        if (chip.dataset.relative) {
          const days = parseInt(chip.dataset.relative, 10);
          const rng = getRelativeDateRange(days);
          sDate = rng.start;
          eDate = rng.end;
        }

        if (sDate && eDate) {
          calState.startDate = sDate;
          calState.endDate = eDate;
          calState.pickingState = 'none';
          calState.hoverDate = null;
          const parts = sDate.split('-');
          calState.viewYear = parseInt(parts[0], 10);
          calState.viewMonth = parseInt(parts[1], 10) - 1;
          renderCalendarGrid();

          document.querySelectorAll('.btn-preset-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
        }
      });
    });

    // Apply button in popover
    if (btnApplyPeriod) {
      btnApplyPeriod.addEventListener('click', (e) => {
        e.stopPropagation();
        const sDate = calState.startDate;
        const eDate = calState.endDate || calState.startDate;
        if (!sDate) {
          alert("Please select dates on the calendar.");
          return;
        }
        const minD = sDate < eDate ? sDate : eDate;
        const maxD = sDate < eDate ? eDate : sDate;
        applyNewDatePeriod(minD, maxD);
        popover.classList.remove('open');
      });
    }
  }

  // Refresh button (forces cache refresh)
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

  // KML Export for selected cell boundaries
  const btnKmlMerged = document.getElementById('btnExportKmlSelection');
  if (btnKmlMerged) {
    btnKmlMerged.addEventListener('click', () => exportSelectedCellsKml());
  }
  const btnKmlSingle = document.getElementById('btnExportKmlSingle');
  if (btnKmlSingle) {
    btnKmlSingle.addEventListener('click', () => exportSelectedCellsKml());
  }
  const btnKmlCtrl = document.getElementById('btnExportKmlFromControls');
  if (btnKmlCtrl) {
    btnKmlCtrl.addEventListener('click', () => exportSelectedCellsKml());
  }

  // Biker Boundary Ride Filter & CSV Export Panel
  const btnToggleBikerExport = document.getElementById('btnToggleBikerExport');
  const bikerExportBody = document.getElementById('bikerExportBody');
  const iconBikerArrow = document.getElementById('iconBikerExportArrow');
  if (btnToggleBikerExport && bikerExportBody) {
    btnToggleBikerExport.addEventListener('click', () => {
      const isHidden = bikerExportBody.style.display === 'none' || !bikerExportBody.style.display;
      bikerExportBody.style.display = isHidden ? 'block' : 'none';
      if (iconBikerArrow) iconBikerArrow.innerHTML = isHidden ? '&#9650;' : '&#9660;';
    });
  }

    function setBikerToggle(mode) {
    state.bikerExportToggle = mode;
    const btnLess = document.getElementById('btnToggleLess');
    const btnMore = document.getElementById('btnToggleMore');
    const modalLess = document.getElementById('bikerModalToggleLess');
    const modalMore = document.getElementById('bikerModalToggleMore');

    [btnLess, modalLess].forEach(btn => {
      if (!btn) return;
      btn.classList.toggle('active', mode === 'less');
      btn.style.background = '';
      btn.style.color = '';
    });

    [btnMore, modalMore].forEach(btn => {
      if (!btn) return;
      btn.classList.toggle('active', mode === 'more');
      btn.style.background = '';
      btn.style.color = '';
    });
  }

  const btnToggleLess = document.getElementById('btnToggleLess');
  const btnToggleMore = document.getElementById('btnToggleMore');
  if (btnToggleLess) btnToggleLess.addEventListener('click', () => setBikerToggle('less'));
  if (btnToggleMore) btnToggleMore.addEventListener('click', () => setBikerToggle('more'));

  const bikerModalToggleLess = document.getElementById('bikerModalToggleLess');
  const bikerModalToggleMore = document.getElementById('bikerModalToggleMore');
  if (bikerModalToggleLess) bikerModalToggleLess.addEventListener('click', () => setBikerToggle('less'));
  if (bikerModalToggleMore) bikerModalToggleMore.addEventListener('click', () => setBikerToggle('more'));

  const btnExportBikersCsv = document.getElementById('btnExportBikersCsv');
  if (btnExportBikersCsv) {
    btnExportBikersCsv.addEventListener('click', () => exportBikersBoundaryCsv());
  }

  const btnOpenBikerModal = document.getElementById('btnOpenBikerModal');
  if (btnOpenBikerModal) {
    btnOpenBikerModal.addEventListener('click', openBikerModal);
  }

  // Hexagon Resolution Export buttons & select listener
  const btnExportHexCsv = document.getElementById('btnExportHexCsv');
  if (btnExportHexCsv) {
    btnExportHexCsv.addEventListener('click', () => exportHexagonsByResolution('csv'));
  }

  const btnExportHexTxt = document.getElementById('btnExportHexTxt');
  if (btnExportHexTxt) {
    btnExportHexTxt.addEventListener('click', () => exportHexagonsByResolution('txt'));
  }

  const btnCopyHexList = document.getElementById('btnCopyHexList');
  if (btnCopyHexList) {
    btnCopyHexList.addEventListener('click', () => exportHexagonsByResolution('copy'));
  }

  const selectHexExportRes = document.getElementById('selectHexExportRes');
  if (selectHexExportRes) {
    selectHexExportRes.addEventListener('change', updateHexExportBadge);
  }

  const btnCloseBikerModal = document.getElementById('btnCloseBikerModal');
  const btnBikerModalClose = document.getElementById('btnBikerModalClose');
  if (btnCloseBikerModal) btnCloseBikerModal.addEventListener('click', closeBikerModal);
  if (btnBikerModalClose) btnBikerModalClose.addEventListener('click', closeBikerModal);

  const btnBikerModalApply = document.getElementById('btnBikerModalApply');
  if (btnBikerModalApply) {
    btnBikerModalApply.addEventListener('click', () => loadBikerModalPreview());
  }

  const btnBikerModalExportCsv = document.getElementById('btnBikerModalExportCsv');
  if (btnBikerModalExportCsv) {
    btnBikerModalExportCsv.addEventListener('click', () => exportBikersBoundaryCsv());
  }

  const bikerModalSearch = document.getElementById('bikerModalSearch');
  if (bikerModalSearch) {
    bikerModalSearch.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!state.bikerPreviewRecords || state.bikerPreviewRecords.length === 0) return;
      const filtered = q
        ? state.bikerPreviewRecords.filter(r => String(r.biker_id).toLowerCase().includes(q))
        : state.bikerPreviewRecords;
      renderBikerModalTable(filtered);
    });
  }

  // Column header sorting
  document.querySelectorAll('.sortable-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (col) sortBikerTableBy(col);
    });
  });

  // Preset chips click listeners
  document.querySelectorAll('[data-biker-preset]').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const preset = chip.dataset.bikerPreset;
      const isInsideModal = !!chip.closest('#bikerModal');
      handleBikerPresetClick(preset, isInsideModal ? 'modal' : 'card');
    });
  });

  // Date inputs change listeners for two-way sync
  ['bikerExportStartDate', 'bikerExportEndDate', 'bikerModalStartDate', 'bikerModalEndDate'].forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('change', () => {
        const isModal = id.startsWith('bikerModal');
        const s = isModal ? document.getElementById('bikerModalStartDate').value : document.getElementById('bikerExportStartDate').value;
        const e = isModal ? document.getElementById('bikerModalEndDate').value : document.getElementById('bikerExportEndDate').value;
        if (isModal) {
          const cardStart = document.getElementById('bikerExportStartDate');
          const cardEnd = document.getElementById('bikerExportEndDate');
          if (cardStart) cardStart.value = s;
          if (cardEnd) cardEnd.value = e;
        } else {
          const modalStart = document.getElementById('bikerModalStartDate');
          const modalEnd = document.getElementById('bikerModalEndDate');
          if (modalStart) modalStart.value = s;
          if (modalEnd) modalEnd.value = e;
        }
        updateBikerPeriodDisplay(s, e);
        document.querySelectorAll('[data-biker-preset]').forEach(c => c.classList.remove('active'));
      });
    }
  });

  // Citywide Report Modal
  document.getElementById('btnOpenCityModal').addEventListener('click', openCityModal);
  document.getElementById('kpiCardCityOverview').addEventListener('click', openCityModal);
  const kpiCardFare = document.getElementById('kpiCardFare');
  if (kpiCardFare) {
    kpiCardFare.addEventListener('click', openCityModal);
  }
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

  // Map Only Mode toggle handlers
  let mapOnlyMode = false;
  function setMapOnlyMode(enabled) {
    mapOnlyMode = enabled;
    document.body.classList.toggle('map-only-mode', mapOnlyMode);

    const labelEl = document.getElementById('btnMapOnlyLabel');
    if (labelEl) {
      labelEl.textContent = mapOnlyMode ? 'Show Controls' : 'Map Only';
    }

    const btnHeader = document.getElementById('btnToggleMapOnly');
    if (btnHeader) {
      btnHeader.classList.toggle('active', mapOnlyMode);
    }

    if (map) {
      setTimeout(() => map.invalidateSize(), 240);
    }
  }

  const btnMapOnly = document.getElementById('btnToggleMapOnly');
  if (btnMapOnly) {
    btnMapOnly.addEventListener('click', () => setMapOnlyMode(!mapOnlyMode));
  }

  const btnExitMapOnly = document.getElementById('btnExitMapOnly');
  if (btnExitMapOnly) {
    btnExitMapOnly.addEventListener('click', () => setMapOnlyMode(false));
  }

  const btnHideFromPanel = document.getElementById('btnHideControlsFromPanel');
  if (btnHideFromPanel) {
    btnHideFromPanel.addEventListener('click', () => setMapOnlyMode(true));
  }

  // Keyboard shortcut: 'm' or 'M' toggles Map Only mode
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'm' || e.key === 'M') {
      setMapOnlyMode(!mapOnlyMode);
    }
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

  // Setup redesigned Control Panel Tabs, Collapse & Presets
  setupControlPanelTabs();
}

// Redesigned Control Panel Tabs, Collapse & Filter Presets
function setupControlPanelTabs() {
  const tabs = document.querySelectorAll('.ctrl-tab-btn');
  const sections = document.querySelectorAll('.ctrl-section');
  const panel = document.getElementById('controlPanel');
  const headerBar = document.getElementById('panelHeaderBar');
  const btnCollapse = document.getElementById('btnToggleCollapsePanel');

  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t === tab));

      sections.forEach(sec => {
        if (target === 'all') {
          sec.style.display = 'block';
        } else {
          sec.style.display = sec.dataset.section === target ? 'block' : 'none';
        }
      });

      // If panel was collapsed, expand it when clicking a tab
      if (panel && panel.classList.contains('is-collapsed')) {
        panel.classList.remove('is-collapsed');
      }
    });
  });

  // Collapse / Expand toggle
  function togglePanelCollapse(e) {
    if (e) e.stopPropagation();
    if (panel) {
      panel.classList.toggle('is-collapsed');
    }
  }

  if (btnCollapse) {
    btnCollapse.addEventListener('click', togglePanelCollapse);
  }
  if (headerBar) {
    headerBar.addEventListener('click', (e) => {
      // Don't trigger if clicked on hide button or other action buttons
      if (e.target.closest('#btnHideControlsFromPanel') || e.target.closest('#btnToggleCollapsePanel')) return;
      togglePanelCollapse(e);
    });
  }

  // Reset all filters button
  const btnResetAll = document.getElementById('btnResetAllFilters');
  if (btnResetAll) {
    btnResetAll.addEventListener('click', () => {
      state.minBreachFilter = 0;
      state.minMeanFilter = 0;
      state.minShareFilter = 0;
      state.minOrdersFilter = 0;
      const sliderBreach = document.getElementById('sliderBreachFilter');
      const numBreach = document.getElementById('numBreachFilter');
      const sliderOrders = document.getElementById('sliderOrdersFilter');
      const numOrders = document.getElementById('numOrdersFilter');
      if (sliderBreach) sliderBreach.value = 0;
      if (numBreach) numBreach.value = 0;
      if (sliderOrders) sliderOrders.value = 0;
      if (numOrders) numOrders.value = 0;
      updateFilterLabels();
      filterHexagons();
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

// Compute relative dynamic date ranges ending yesterday
function getRelativeDateRange(daysCount) {
  // End date is yesterday
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (daysCount - 1));

  const toYMD = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  return {
    start: toYMD(start),
    end: toYMD(end)
  };
}

function updateCalendarTriggerLabel() {
  const lbl = document.getElementById('calendarTriggerLabel');
  if (!lbl) return;
  const startFmt = formatDateReadable(state.startDate);
  const endFmt = formatDateReadable(state.endDate);
  const year = (state.endDate || state.startDate || '').split('-')[0] || '2026';
  lbl.textContent = `${startFmt} – ${endFmt}, ${year}`;
}

// Interactive Visual Calendar & Cache State
const calState = {
  viewYear: 2026,
  viewMonth: 9, // 0-indexed (9 = October)
  startDate: '2026-10-22',
  endDate: '2026-11-05',
  pickingState: 'none', // 'none' or 'picking_end'
  hoverDate: null
};

// Initial Modal Calendar State
const initCalState = {
  viewYear: 2026,
  viewMonth: 9, // 0-indexed (9 = October)
  startDate: '2026-10-22',
  endDate: '2026-11-05',
  pickingState: 'none', // 'none' or 'picking_end'
  hoverDate: null
};

function renderInitCalendarGrid() {
  const container = document.getElementById('initCalDaysGrid');
  const monthTitle = document.getElementById('initCalMonthTitle');
  if (!container || !monthTitle) return;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  monthTitle.textContent = `${monthNames[initCalState.viewMonth]} ${initCalState.viewYear}`;

  container.innerHTML = '';

  const y = initCalState.viewYear;
  const m = initCalState.viewMonth;

  // First day of month (0 = Sun, 1 = Mon ... 6 = Sat)
  const firstDay = new Date(y, m, 1);
  let startDayOfWeek = firstDay.getDay();
  // Monday is 0, Sunday is 6
  let firstCol = (startDayOfWeek + 6) % 7;

  // Days in current and previous months
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevMonthDays = new Date(y, m, 0).getDate();

  // Trailing days from previous month
  for (let i = firstCol - 1; i >= 0; i--) {
    const dayNum = prevMonthDays - i;
    const prevMonthIdx = m === 0 ? 11 : m - 1;
    const prevYear = m === 0 ? y - 1 : y;
    const dateStr = `${prevYear}-${String(prevMonthIdx + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    container.appendChild(createInitCalendarCell(dayNum, dateStr, true));
  }

  // Days in current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    container.appendChild(createInitCalendarCell(d, dateStr, false));
  }

  // Remaining slots to fill up grid row (multiples of 7)
  const totalCells = firstCol + daysInMonth;
  const nextMonthSlots = (7 - (totalCells % 7)) % 7;
  for (let n = 1; n <= nextMonthSlots; n++) {
    const nextMonthIdx = m === 11 ? 0 : m + 1;
    const nextYear = m === 11 ? y + 1 : y;
    const dateStr = `${nextYear}-${String(nextMonthIdx + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    container.appendChild(createInitCalendarCell(n, dateStr, true));
  }

  updateInitCalHintAndBadge();
}

function createInitCalendarCell(dayNum, dateStr, isOtherMonth) {
  const cell = document.createElement('div');
  cell.className = 'cal-day-cell';
  cell.dataset.date = dateStr;

  if (isOtherMonth) {
    cell.classList.add('other-month');
  }

  cell.textContent = dayNum;

  const s = initCalState.startDate;
  const e = initCalState.endDate;

  const minD = (s && e) ? (s < e ? s : e) : (s || e);
  const maxD = (s && e) ? (s < e ? e : s) : (s || e);

  if (dateStr === initCalState.startDate) {
    cell.classList.add('range-start');
  }
  if (dateStr === initCalState.endDate && initCalState.pickingState !== 'picking_end') {
    cell.classList.add('range-end');
  }
  if (initCalState.startDate && (!initCalState.endDate || initCalState.pickingState === 'picking_end') && dateStr === initCalState.startDate) {
    cell.classList.add('single-day');
  }
  if (minD && maxD && dateStr >= minD && dateStr <= maxD && initCalState.pickingState !== 'picking_end') {
    cell.classList.add('in-range');
  }

  cell.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Clear active status on presets
    document.querySelectorAll('.init-preset-btn').forEach(b => b.classList.remove('active'));

    if (initCalState.pickingState === 'none' || !initCalState.startDate) {
      initCalState.startDate = dateStr;
      initCalState.endDate = null;
      initCalState.pickingState = 'picking_end';
      initCalState.hoverDate = null;
      renderInitCalendarGrid();
    } else {
      if (dateStr < initCalState.startDate) {
        initCalState.endDate = initCalState.startDate;
        initCalState.startDate = dateStr;
      } else {
        initCalState.endDate = dateStr;
      }
      initCalState.pickingState = 'none';
      initCalState.hoverDate = null;
      renderInitCalendarGrid();
    }
  });

  cell.addEventListener('mouseenter', () => {
    if (initCalState.pickingState === 'picking_end' && initCalState.startDate) {
      updateInitHoverRange(dateStr);
    }
  });

  return cell;
}

function updateInitHoverRange(hoverDateStr) {
  if (initCalState.pickingState !== 'picking_end' || !initCalState.startDate) return;

  const minD = hoverDateStr < initCalState.startDate ? hoverDateStr : initCalState.startDate;
  const maxD = hoverDateStr < initCalState.startDate ? initCalState.startDate : hoverDateStr;

  const container = document.getElementById('initCalDaysGrid');
  if (!container) return;

  container.querySelectorAll('.cal-day-cell').forEach(c => {
    const d = c.dataset.date;
    if (!d) return;
    const inRange = d >= minD && d <= maxD;
    c.classList.toggle('in-range', inRange);

    if (d === minD && d === maxD) {
      c.classList.add('range-start', 'single-day');
      c.classList.remove('range-end');
    } else if (d === minD) {
      c.classList.add('range-start');
      c.classList.remove('range-end', 'single-day');
    } else if (d === maxD) {
      c.classList.add('range-end');
      c.classList.remove('range-start', 'single-day');
    } else {
      c.classList.remove('range-start', 'range-end', 'single-day');
    }
  });

  const hintEl = document.getElementById('initCalSelectionHint');
  if (hintEl) {
    hintEl.textContent = `Click to select end date: ${formatDateReadable(minD)} → ${formatDateReadable(maxD)}`;
    hintEl.style.color = '#38bdf8';
  }
}

function clearInitHoverRange() {
  if (initCalState.pickingState !== 'picking_end' || !initCalState.startDate) return;

  const container = document.getElementById('initCalDaysGrid');
  if (!container) return;

  container.querySelectorAll('.cal-day-cell').forEach(c => {
    const d = c.dataset.date;
    const isStart = d === initCalState.startDate;
    c.classList.toggle('range-start', isStart);
    c.classList.toggle('single-day', isStart);
    c.classList.remove('range-end');
    c.classList.remove('in-range');
  });

  updateInitCalHintAndBadge();
}

function updateInitCalHintAndBadge() {
  const hintEl = document.getElementById('initCalSelectionHint');
  const badgeEl = document.getElementById('initPeriodDaysBadge');

  const s = initCalState.startDate;
  const e = initCalState.endDate;

  if (hintEl) {
    if (initCalState.pickingState === 'picking_end') {
      hintEl.textContent = `Start date selected (${formatDateReadable(s)}). Now click a date to select end date.`;
      hintEl.style.color = '#38bdf8';
    } else if (s && e) {
      hintEl.textContent = `Selected: ${formatDateReadable(s)} – ${formatDateReadable(e)}`;
      hintEl.style.color = '#cbd5e1';
    } else if (s) {
      hintEl.textContent = `Selected: ${formatDateReadable(s)}`;
      hintEl.style.color = '#cbd5e1';
    } else {
      hintEl.textContent = 'Click start date, then click end date';
      hintEl.style.color = '#94a3b8';
    }
  }

  if (badgeEl && s) {
    const activeE = e || s;
    const minD = s < activeE ? s : activeE;
    const maxD = s < activeE ? activeE : s;
    const d1 = new Date(minD);
    const d2 = new Date(maxD);
    const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
    badgeEl.textContent = `${formatDateReadable(minD)} – ${formatDateReadable(maxD)} (${diff} Day${diff > 1 ? 's' : ''})`;
  }
}

// Initial City & Period Setup Modal Logic
function initSessionDialog() {
  const modal = document.getElementById('initSessionModal');
  const form = document.getElementById('initSessionForm');
  const cityButtons = document.querySelectorAll('.init-city-btn');
  const customCityInput = document.getElementById('initCustomCityInput');
  const selectedLabel = document.getElementById('initSelectedCityLabel');
  const presetButtons = document.querySelectorAll('.init-preset-btn');
  const prevBtn = document.getElementById('initCalPrevMonth');
  const nextBtn = document.getElementById('initCalNextMonth');
  const grid = document.getElementById('initCalDaysGrid');
  const btnClose = document.getElementById('btnCloseInitModal');
  const btnOpenModal = document.getElementById('btnOpenInitModal');

  if (!modal || !form) return;

  let currentChosenCity = state.city || 'isfahan';

  // Wire up the 4 primary cities
  cityButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      cityButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentChosenCity = btn.dataset.city;
      const cityName = btn.querySelector('.city-name') ? btn.querySelector('.city-name').textContent : btn.dataset.city;
      if (selectedLabel) selectedLabel.textContent = cityName;
      if (customCityInput) customCityInput.value = '';
    });
  });

  // Wire up custom city input
  if (customCityInput) {
    customCityInput.addEventListener('input', () => {
      const val = customCityInput.value.trim();
      if (val) {
        cityButtons.forEach(b => b.classList.remove('active'));
        currentChosenCity = val.toLowerCase();
        if (selectedLabel) selectedLabel.textContent = val;
      } else {
        // Fall back to active button if any
        const activeBtn = document.querySelector('.init-city-btn.active');
        if (activeBtn) {
          currentChosenCity = activeBtn.dataset.city;
          const cityName = activeBtn.querySelector('.city-name') ? activeBtn.querySelector('.city-name').textContent : activeBtn.dataset.city;
          if (selectedLabel) selectedLabel.textContent = cityName;
        } else {
          // Select isfahan by default
          const isfahanBtn = document.querySelector('.init-city-btn[data-city="isfahan"]');
          if (isfahanBtn) isfahanBtn.classList.add('active');
          currentChosenCity = 'isfahan';
          if (selectedLabel) selectedLabel.textContent = 'Isfahan';
        }
      }
    });
  }

  // Wire up visual calendar navigation
  if (prevBtn) {
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      initCalState.viewMonth--;
      if (initCalState.viewMonth < 0) {
        initCalState.viewMonth = 11;
        initCalState.viewYear--;
      }
      renderInitCalendarGrid();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      initCalState.viewMonth++;
      if (initCalState.viewMonth > 11) {
        initCalState.viewMonth = 0;
        initCalState.viewYear++;
      }
      renderInitCalendarGrid();
    });
  }

  if (grid) {
    grid.addEventListener('mouseleave', () => {
      clearInitHoverRange();
    });
  }

  // Wire up presets
  presetButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      presetButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      let sDate = btn.dataset.start;
      let eDate = btn.dataset.end;

      if (btn.dataset.relative) {
        const days = parseInt(btn.dataset.relative, 10);
        const rng = getRelativeDateRange(days);
        sDate = rng.start;
        eDate = rng.end;
      }

      if (sDate && eDate) {
        initCalState.startDate = sDate;
        initCalState.endDate = eDate;
        initCalState.pickingState = 'none';
        initCalState.hoverDate = null;
        const parts = sDate.split('-');
        initCalState.viewYear = parseInt(parts[0], 10);
        initCalState.viewMonth = parseInt(parts[1], 10) - 1;
        renderInitCalendarGrid();
      }
    });
  });

  // Render initial calendar
  renderInitCalendarGrid();

  // Form submit -> Load data & open map
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const s = initCalState.startDate || '2026-10-22';
    const end = initCalState.endDate || initCalState.startDate || '2026-11-05';
    const minD = s < end ? s : end;
    const maxD = s < end ? end : s;

    state.city = currentChosenCity;
    state.startDate = minD;
    state.endDate = maxD;
    state.selectedDates = [];

    // Sync calState for the top-bar calendar popover
    calState.startDate = minD;
    calState.endDate = maxD;
    calState.pickingState = 'none';
    calState.hoverDate = null;
    const parts = minD.split('-');
    calState.viewYear = parseInt(parts[0], 10);
    calState.viewMonth = parseInt(parts[1], 10) - 1;

    // Sync input fields & trigger label
    const cityInp = document.getElementById('cityInput');
    if (cityInp) cityInp.value = currentChosenCity;
    const inpStart = document.getElementById('inputStartDate');
    if (inpStart) inpStart.value = minD;
    const inpEnd = document.getElementById('inputEndDate');
    if (inpEnd) inpEnd.value = maxD;

    updateCalendarTriggerLabel();

    modal.classList.remove('open');

    // Fetch city fleet data and open map
    loadCityData(state.city, true);
  });

  if (btnOpenModal) {
    btnOpenModal.addEventListener('click', (e) => {
      e.preventDefault();
      // Sync dialog with current state before opening
      initCalState.startDate = state.startDate || '2026-10-22';
      initCalState.endDate = state.endDate || '2026-11-05';
      initCalState.pickingState = 'none';
      initCalState.hoverDate = null;
      if (state.startDate) {
        const parts = state.startDate.split('-');
        initCalState.viewYear = parseInt(parts[0], 10);
        initCalState.viewMonth = parseInt(parts[1], 10) - 1;
      }
      renderInitCalendarGrid();

      let matched = false;
      cityButtons.forEach(b => {
        if (b.dataset.city.toLowerCase() === (state.city || '').toLowerCase()) {
          b.classList.add('active');
          matched = true;
          const cityName = b.querySelector('.city-name') ? b.querySelector('.city-name').textContent : b.dataset.city;
          if (selectedLabel) selectedLabel.textContent = cityName;
        } else {
          b.classList.remove('active');
        }
      });

      if (!matched && customCityInput) {
        customCityInput.value = state.city || '';
        if (selectedLabel) selectedLabel.textContent = state.city || '';
      } else if (customCityInput) {
        customCityInput.value = '';
      }

      modal.classList.add('open');
    });
  }

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      modal.classList.remove('open');
      if (!state.data) {
        loadCityData(state.city || 'isfahan', true);
      }
    });
  }
}

function initCalendarUI() {
  calState.startDate = state.startDate;
  calState.endDate = state.endDate;
  if (state.startDate) {
    const parts = state.startDate.split('-');
    calState.viewYear = parseInt(parts[0], 10);
    calState.viewMonth = parseInt(parts[1], 10) - 1;
  }

  const prevBtn = document.getElementById('calPrevMonth');
  const nextBtn = document.getElementById('calNextMonth');
  if (prevBtn) {
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      calState.viewMonth--;
      if (calState.viewMonth < 0) {
        calState.viewMonth = 11;
        calState.viewYear--;
      }
      renderCalendarGrid();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      calState.viewMonth++;
      if (calState.viewMonth > 11) {
        calState.viewMonth = 0;
        calState.viewYear++;
      }
      renderCalendarGrid();
    });
  }

  // Mouseleave on grid to clear hover preview back to start date
  const daysGrid = document.getElementById('calDaysGrid');
  if (daysGrid) {
    daysGrid.addEventListener('mouseleave', () => {
      clearHoverRange();
    });
  }

  // Refresh cache button in calendar popover
  const btnCalRefresh = document.getElementById('btnCalRefreshCache');
  if (btnCalRefresh) {
    btnCalRefresh.addEventListener('click', (e) => {
      e.stopPropagation();
      const popover = document.getElementById('calendarPopover');
      if (popover) popover.classList.remove('open');
      loadCityData(state.city, false, true);
    });
  }
}

function renderCalendarGrid() {
  const container = document.getElementById('calDaysGrid');
  const monthTitle = document.getElementById('calMonthTitle');
  if (!container || !monthTitle) return;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  monthTitle.textContent = `${monthNames[calState.viewMonth]} ${calState.viewYear}`;

  container.innerHTML = '';

  const y = calState.viewYear;
  const m = calState.viewMonth;

  // First day of month (0 = Sun, 1 = Mon ... 6 = Sat)
  const firstDay = new Date(y, m, 1);
  let startDayOfWeek = firstDay.getDay();
  // Monday is 0, Sunday is 6
  let firstCol = (startDayOfWeek + 6) % 7;

  // Days in current and previous months
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevMonthDays = new Date(y, m, 0).getDate();

  // Trailing days from previous month
  for (let i = firstCol - 1; i >= 0; i--) {
    const dayNum = prevMonthDays - i;
    const prevMonthIdx = m === 0 ? 11 : m - 1;
    const prevYear = m === 0 ? y - 1 : y;
    const dateStr = `${prevYear}-${String(prevMonthIdx + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const cell = createCalendarDayCell(dayNum, dateStr, true);
    container.appendChild(cell);
  }

  // Days in current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = createCalendarDayCell(d, dateStr, false);
    container.appendChild(cell);
  }

  // Remaining slots to fill up grid row (multiples of 7)
  const totalCells = firstCol + daysInMonth;
  const nextMonthSlots = (7 - (totalCells % 7)) % 7;
  for (let n = 1; n <= nextMonthSlots; n++) {
    const nextMonthIdx = m === 11 ? 0 : m + 1;
    const nextYear = m === 11 ? y + 1 : y;
    const dateStr = `${nextYear}-${String(nextMonthIdx + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    const cell = createCalendarDayCell(n, dateStr, true);
    container.appendChild(cell);
  }

  updateCalendarCacheStats();
}

function createCalendarDayCell(dayNum, dateStr, isOtherMonth) {
  const cell = document.createElement('div');
  cell.className = 'cal-day-cell';
  cell.dataset.date = dateStr;

  if (isOtherMonth) {
    cell.classList.add('other-month');
  }

  cell.textContent = dayNum;

  // Dot indicator if date is already in state.allDates (cached)
  const isCached = state.allDates && state.allDates.includes(dateStr);
  if (isCached) {
    const dot = document.createElement('span');
    dot.className = 'cal-day-cache-dot';
    dot.title = 'Cached in memory';
    cell.appendChild(dot);
  }

  // Selection states
  const s = calState.startDate;
  const e = calState.endDate;

  const minD = (s && e) ? (s < e ? s : e) : (s || e);
  const maxD = (s && e) ? (s < e ? e : s) : (s || e);

  if (dateStr === calState.startDate) {
    cell.classList.add('range-start');
  }
  if (dateStr === calState.endDate && calState.pickingState !== 'picking_end') {
    cell.classList.add('range-end');
  }
  if (calState.startDate && (!calState.endDate || calState.pickingState === 'picking_end') && dateStr === calState.startDate) {
    cell.classList.add('single-day');
  }
  if (minD && maxD && dateStr >= minD && dateStr <= maxD && calState.pickingState !== 'picking_end') {
    cell.classList.add('in-range');
  }

  // Click handler: Click 1 selects start, Click 2 selects end, next click starts fresh
  cell.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (calState.pickingState === 'none' || !calState.startDate) {
      // First click: select start date
      calState.startDate = dateStr;
      calState.endDate = null;
      calState.pickingState = 'picking_end';
      calState.hoverDate = null;
      renderCalendarGrid();
    } else {
      // Second click: select end date
      if (dateStr < calState.startDate) {
        calState.endDate = calState.startDate;
        calState.startDate = dateStr;
      } else {
        calState.endDate = dateStr;
      }
      calState.pickingState = 'none';
      calState.hoverDate = null;
      renderCalendarGrid();
    }
  });

  // Hover handler for range preview without recreating DOM nodes
  cell.addEventListener('mouseenter', () => {
    if (calState.pickingState === 'picking_end' && calState.startDate) {
      updateHoverRange(dateStr);
    }
  });

  return cell;
}

function updateHoverRange(hoverDateStr) {
  if (calState.pickingState !== 'picking_end' || !calState.startDate) return;

  const minD = hoverDateStr < calState.startDate ? hoverDateStr : calState.startDate;
  const maxD = hoverDateStr < calState.startDate ? calState.startDate : hoverDateStr;

  const container = document.getElementById('calDaysGrid');
  if (!container) return;

  container.querySelectorAll('.cal-day-cell').forEach(c => {
    const d = c.dataset.date;
    if (!d) return;
    const inRange = d >= minD && d <= maxD;
    c.classList.toggle('in-range', inRange);

    if (d === minD && d === maxD) {
      c.classList.add('range-start');
      c.classList.add('single-day');
      c.classList.remove('range-end');
    } else if (d === minD) {
      c.classList.add('range-start');
      c.classList.remove('range-end');
      c.classList.remove('single-day');
    } else if (d === maxD) {
      c.classList.add('range-end');
      c.classList.remove('range-start');
      c.classList.remove('single-day');
    } else {
      c.classList.remove('range-start');
      c.classList.remove('range-end');
      c.classList.remove('single-day');
    }
  });

  updateCalendarCacheStats(hoverDateStr);
}

function clearHoverRange() {
  if (calState.pickingState !== 'picking_end' || !calState.startDate) return;

  const container = document.getElementById('calDaysGrid');
  if (!container) return;

  container.querySelectorAll('.cal-day-cell').forEach(c => {
    const d = c.dataset.date;
    const isStart = d === calState.startDate;
    c.classList.toggle('range-start', isStart);
    c.classList.toggle('single-day', isStart);
    c.classList.remove('range-end');
    c.classList.remove('in-range');
  });

  updateCalendarCacheStats(null);
}

function updateCalendarCacheStats(previewEndDate = null) {
  const daysText = document.getElementById('calCacheDaysText');
  const desc = document.getElementById('calCacheDesc');
  const hintEl = document.getElementById('calSelectionHint');

  // Update selection hint text
  if (hintEl) {
    if (calState.pickingState === 'picking_end') {
      if (previewEndDate) {
        const minD = calState.startDate < previewEndDate ? calState.startDate : previewEndDate;
        const maxD = calState.startDate < previewEndDate ? previewEndDate : calState.startDate;
        hintEl.textContent = `Click to select end date: ${formatDateReadable(minD)} → ${formatDateReadable(maxD)}`;
        hintEl.style.color = '#38bdf8';
      } else {
        hintEl.textContent = `Start date selected (${formatDateReadable(calState.startDate)}). Now click a date to select end date.`;
        hintEl.style.color = '#38bdf8';
      }
    } else if (calState.startDate && calState.endDate) {
      hintEl.textContent = `Selected: ${formatDateReadable(calState.startDate)} – ${formatDateReadable(calState.endDate)}`;
      hintEl.style.color = '#cbd5e1';
    } else if (calState.startDate) {
      hintEl.textContent = `Selected: ${formatDateReadable(calState.startDate)}`;
      hintEl.style.color = '#cbd5e1';
    } else {
      hintEl.textContent = `Click start date, then click end date`;
      hintEl.style.color = '#94a3b8';
    }
  }

  if (!daysText) return;

  if (!state.allDates || state.allDates.length === 0) {
    daysText.textContent = 'No cached data';
    return;
  }

  let selectedList = [];
  const activeEnd = previewEndDate || calState.endDate || calState.startDate;
  if (calState.startDate && activeEnd) {
    const minD = calState.startDate < activeEnd ? calState.startDate : activeEnd;
    const maxD = calState.startDate < activeEnd ? activeEnd : calState.startDate;
    let curr = new Date(minD);
    const end = new Date(maxD);
    while (curr <= end) {
      selectedList.push(curr.toISOString().split('T')[0]);
      curr.setDate(curr.getDate() + 1);
    }
  }

  const cachedCount = selectedList.filter(d => state.allDates.includes(d)).length;
  const missingCount = selectedList.length - cachedCount;

  if (missingCount === 0 && selectedList.length > 0) {
    daysText.textContent = `⚡ All ${selectedList.length} days cached (0ms)`;
    daysText.style.color = '#10b981';
    if (desc) desc.textContent = 'Selected range is fully cached in memory.';
  } else if (missingCount > 0) {
    daysText.textContent = `⏳ ${cachedCount} cached, ${missingCount} missing`;
    daysText.style.color = '#f59e0b';
    if (desc) desc.textContent = `Only ${missingCount} missing days will be fetched from database.`;
  } else {
    daysText.textContent = `${state.allDates.length} days cached`;
    daysText.style.color = '#38bdf8';
  }
}

function updateCacheStatusUI(data) {
  const pill = document.getElementById('cacheStatusPill');
  const text = document.getElementById('cacheStatusText');
  if (!pill || !text) return;

  const src = data.data_source || '';
  if (src.includes('Cached') || src.includes('0ms')) {
    pill.className = 'cache-status-pill';
    text.textContent = '⚡ Cached (0ms)';
    pill.title = src;
  } else if (src.includes('Incremental')) {
    pill.className = 'cache-status-pill fetching';
    text.textContent = '🔄 Incremental Hit';
    pill.title = src;
  } else if (src.includes('Refreshed')) {
    pill.className = 'cache-status-pill fetching';
    text.textContent = '🔄 Refreshed';
    pill.title = src;
  } else {
    pill.className = 'cache-status-pill';
    text.textContent = '⚡ In-Memory Cache';
    pill.title = src;
  }

  updateCalendarCacheStats();
}

function applyNewDatePeriod(startDate, endDate) {
  state.startDate = startDate;
  state.endDate = endDate;
  state.selectedDates = null; // Reset to select all dates in new period
  updateCalendarTriggerLabel();
  const cardStart = document.getElementById('bikerExportStartDate');
  const cardEnd = document.getElementById('bikerExportEndDate');
  if (cardStart) cardStart.value = startDate;
  if (cardEnd) cardEnd.value = endDate;
  updateBikerPeriodDisplay(startDate, endDate);
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
    updateCacheStatusUI(data);
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

// Dynamically rescale Primary Metric (SLA breach / Mean duration / City HA share / Biker Fare) and Min Orders filter sliders to the max in active data
function resizeFilterSliders() {
  if (!state.data) return;
  const layerData = state.data.layers?.[state.currentLayer]?.res?.[state.currentRes];
  const hexes = layerData?.hexes || [];

  let maxSla = 0;
  let maxMean = 0;
  let maxOrders = 0;
  let maxShare = 0;
  let maxFare = 0;
  hexes.forEach(h => {
    if (h.pct > maxSla) maxSla = h.pct;
    if (h.mean > maxMean) maxMean = h.mean;
    if (h.orders > maxOrders) maxOrders = h.orders;
    if (h.avg_fare && h.avg_fare > maxFare) maxFare = h.avg_fare;
    const s = getHexSharePct(h);
    if (s > maxShare) maxShare = s;
  });

  const isHa = state.colorMetric === 'ha';
  const isMean = state.colorMetric === 'mean';
  const isShare = state.colorMetric === 'share';
  const isFare = state.colorMetric === 'fare';

  // Scale Primary Metric Filter slider (HA%, Mean Duration, City HA Share, or Biker Fare)
  const breachSlider = document.getElementById('sliderBreachFilter');
  if (breachSlider) {
    if (isHa) {
      breachSlider.min = 0;
      breachSlider.max = 5;
      breachSlider.step = 0.1;
      if (state.minBreachFilter > 5) {
        state.minBreachFilter = 0;
      }
      breachSlider.value = state.minBreachFilter;
      breachSlider.dataset.dataMax = '5';
    } else if (isMean) {
      const ceilMean = Math.ceil(maxMean);
      const sliderMax = Math.max(ceilMean, 10);
      breachSlider.min = 0;
      breachSlider.max = sliderMax;
      breachSlider.step = sliderMax > 20 ? 1 : 0.5;
      if ((state.minMeanFilter || 0) > sliderMax) {
        state.minMeanFilter = 0;
      }
      breachSlider.value = state.minMeanFilter || 0;
      breachSlider.dataset.dataMax = ceilMean;
    } else if (isFare) {
      const ceilFare = Math.ceil(maxFare / 1000) * 1000 || 80000;
      const sliderMax = Math.max(ceilFare, 10000);
      breachSlider.min = 0;
      breachSlider.max = sliderMax;
      breachSlider.step = 1000;
      if ((state.minFareFilter || 0) > sliderMax) {
        state.minFareFilter = 0;
      }
      breachSlider.value = state.minFareFilter || 0;
      breachSlider.dataset.dataMax = Math.round(maxFare).toString();
    } else {
      const ceilShare = Math.ceil(maxShare * 1.05) || 5;
      const sliderMax = Math.max(ceilShare, 2);
      breachSlider.min = 0;
      breachSlider.max = sliderMax;
      breachSlider.step = 0.1;
      if ((state.minShareFilter || 0) > sliderMax) {
        state.minShareFilter = 0;
      }
      breachSlider.value = state.minShareFilter || 0;
      breachSlider.dataset.dataMax = maxShare.toFixed(1);
    }
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
  const isHa = state.colorMetric === 'ha';
  const isMean = state.colorMetric === 'mean';
  const isShare = state.colorMetric === 'share';
  const isFare = state.colorMetric === 'fare';
  const titleEl = document.getElementById('titleMetricFilter');
  const unitEl = document.getElementById('unitBreachFilter');
  const minScaleEl = document.getElementById('minScaleMetricFilter');
  const breachSlider = document.getElementById('sliderBreachFilter');
  const breachVal = document.getElementById('valBreachFilter');
  const breachNum = document.getElementById('numBreachFilter');

  if (titleEl) {
    if (isHa) titleEl.textContent = 'Min SLA Breach Filter';
    else if (isMean) titleEl.textContent = 'Min Mean Duration Filter';
    else if (isFare) titleEl.textContent = 'Min Mean Fare Filter';
    else titleEl.textContent = 'Min HA Share Filter';
  }
  if (unitEl) {
    unitEl.textContent = isMean ? 'min' : (isFare ? 'Toman' : '%');
  }
  if (minScaleEl) {
    minScaleEl.textContent = isMean ? '0 min' : (isFare ? '0' : (isShare ? '0.0%' : '0%'));
  }

  if (breachSlider) {
    const maxVal = breachSlider.dataset.dataMax || breachSlider.max;
    if (breachVal) {
      if (isHa) breachVal.textContent = `max: ${maxVal}%`;
      else if (isMean) breachVal.textContent = `max: ${maxVal} min`;
      else if (isFare) breachVal.textContent = `max: ${Number(maxVal).toLocaleString()}`;
      else breachVal.textContent = `max: ${maxVal}%`;
    }
    if (breachNum) {
      let curVal = 0;
      if (isHa) curVal = state.minBreachFilter;
      else if (isMean) curVal = state.minMeanFilter || 0;
      else if (isFare) curVal = state.minFareFilter || 0;
      else curVal = state.minShareFilter || 0;

      breachNum.value = curVal;
      breachNum.max = maxVal;
      breachNum.step = isFare ? '1000' : (isShare ? '0.1' : (isMean ? '0.5' : (isHa ? '0.1' : '1')));
      breachNum.title = isHa
        ? 'Type minimum SLA breach percentage (0 to 5%)'
        : (isMean ? 'Type minimum mean accept duration in minutes' : (isFare ? 'Type minimum average biker fare in Toman' : 'Type minimum citywide HA share percentage'));
    }
  }

  const ordersSlider = document.getElementById('sliderOrdersFilter');
  const ordersVal = document.getElementById('valOrdersFilter');
  const ordersNum = document.getElementById('numOrdersFilter');
  if (ordersSlider) {
    const maxVal = ordersSlider.dataset.dataMax || ordersSlider.max;
    if (ordersVal) ordersVal.textContent = `max: ${Number(maxVal).toLocaleString()} ord`;
    if (ordersNum) {
      ordersNum.value = state.minOrdersFilter;
      ordersNum.max = maxVal;
    }
  }

  // Update cell numbers button labels, badge, and checkbox text
  const btnLabelOrdersHa = document.getElementById('btnLabelOrdersHa');
  const btnLabelHaOnly = document.getElementById('btnLabelHaOnly');
  const btnLabelOrdersOnly = document.getElementById('btnLabelOrdersOnly');
  const labelCheckboxText = document.getElementById('labelCheckboxText');

  if (btnLabelOrdersHa) {
    if (isHa) btnLabelOrdersHa.textContent = 'HA% + Orders';
    else if (isMean) btnLabelOrdersHa.textContent = 'Mean + Orders';
    else if (isFare) btnLabelOrdersHa.textContent = 'Fare + Inc';
    else btnLabelOrdersHa.textContent = 'Share + HA';
  }
  if (btnLabelHaOnly) {
    if (isHa) btnLabelHaOnly.textContent = 'HA% Only';
    else if (isMean) btnLabelHaOnly.textContent = 'Mean Only';
    else if (isFare) btnLabelHaOnly.textContent = 'Fare Only';
    else btnLabelHaOnly.textContent = 'Share Only';
  }
  if (btnLabelOrdersOnly) {
    if (isShare) btnLabelOrdersOnly.textContent = 'HA Only';
    else btnLabelOrdersOnly.textContent = 'Orders Only';
  }
  if (labelCheckboxText) {
    if (isHa) labelCheckboxText.textContent = 'Cell Numbers (HA% & Orders)';
    else if (isMean) labelCheckboxText.textContent = 'Cell Numbers (Mean & Orders)';
    else if (isFare) labelCheckboxText.textContent = 'Cell Numbers (Biker Fare)';
    else labelCheckboxText.textContent = 'Cell Numbers (HA Share)';
  }

  // Update indicator dot on filters tab
  const tabFilterDot = document.getElementById('tabFilterDot');
  let activeMetricVal = 0;
  if (isHa) activeMetricVal = state.minBreachFilter;
  else if (isMean) activeMetricVal = state.minMeanFilter || 0;
  else if (isFare) activeMetricVal = state.minFareFilter || 0;
  else activeMetricVal = state.minShareFilter || 0;

  const isFiltered = (activeMetricVal > 0) || (state.minOrdersFilter > 0);
  if (tabFilterDot) {
    tabFilterDot.style.display = isFiltered ? 'inline-block' : 'none';
  }
}

// Update Top Floating Citywide HA30 Overview & KPI Cards
function updateKpis(kpis, city, dataSource) {
  document.getElementById('headerCityLabel').textContent = `${city.toUpperCase()}`;
  document.getElementById('headerThresholdLabel').textContent = state.colorMetric === 'ha'
    ? `HA${kpis.threshold}%`
    : (state.colorMetric === 'mean' ? 'MEAN DURATION' : (state.colorMetric === 'fare' ? 'BIKER FARE' : 'HA SHARE'));
  document.getElementById('kpiThresholdVal').textContent = kpis.threshold;

  // Citywide HA30 Overview Card
  const haEl = document.getElementById('kpiHaPct');
  haEl.textContent = `${kpis.overall_ha_pct.toFixed(1)}%`;
  haEl.className = 'kpi-val ' + (kpis.overall_ha_pct > 25 ? 'highlight-breach' : 'highlight-success');

  const badgeEl = document.getElementById('citySlaBadge');
  if (badgeEl) {
    if (kpis.overall_ha_pct > 30) {
      badgeEl.textContent = 'CRITICAL BREACH';
      badgeEl.className = 'badge badge-critical';
      badgeEl.style.display = 'inline-block';
    } else if (kpis.overall_ha_pct > 20) {
      badgeEl.textContent = 'ELEVATED RISK';
      badgeEl.className = 'badge badge-warning';
      badgeEl.style.display = 'inline-block';
    } else {
      badgeEl.style.display = 'none';
    }
  }

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

  // Citywide Fare & Incentive metrics
  const meanFareEl = document.getElementById('kpiMeanFare');
  if (meanFareEl) {
    const rawFare = kpis.avg_biker_fare !== undefined ? kpis.avg_biker_fare : 0;
    meanFareEl.textContent = formatFareFull(rawFare);
  }
  const meanIncEl = document.getElementById('kpiMeanIncentive');
  if (meanIncEl) {
    const rawInc = kpis.avg_incentive !== undefined ? kpis.avg_incentive : 0;
    meanIncEl.textContent = `+${formatFareFull(rawInc)} inc`;
  }
}

// Render Interactive Day Selector Strip with 1-float precision HA30 for each date
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
    const haPrecise = `${d.pct.toFixed(1)}%`;
    const farePart = d.avg_fare ? `<span class="day-pill-sep">&bull;</span><span style="color:#2563eb;font-weight:600">${formatFare(d.avg_fare)}</span>` : '';
    const incPart = (d.avg_incentive && d.avg_incentive > 0) ? `<span style="color:#059669;font-size:9.5px;font-weight:600;margin-left:2px">+${formatFare(d.avg_incentive)}</span>` : '';
    return `
      <div class="day-pill ${isSelected ? 'active' : ''}" data-date="${d.date}" title="${d.label}: ${d.orders} orders, HA${state.threshold}: ${haPrecise}, Mean Fare: ${formatFareFull(d.avg_fare)} Toman, Incentive: +${formatFareFull(d.avg_incentive)} Toman">
        <div class="day-pill-date">${d.label}</div>
        <div class="day-pill-meta">
          <span class="day-pill-ha" style="color:${breachColor}">HA${state.threshold}: <b>${haPrecise}</b></span>
          <span class="day-pill-sep">&bull;</span>
          <span>${d.orders.toLocaleString()} ord</span>
          ${farePart}
          ${incPart}
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

// Helpers for Citywide HA Share Calculation & Color Interpolation
function getCityTotalSlow() {
  if (!state.data || !state.data.kpis) return 1;
  return state.data.kpis.ha30_count || state.data.kpis.total_slow || 1;
}

function getHexSharePct(h) {
  if (h.share_pct !== undefined && h.share_pct !== null) return h.share_pct;
  const total = getCityTotalSlow();
  return total > 0 ? (h.slow / total * 100) : 0;
}

function interpolateHaColor(t) {
  t = Math.min(Math.max(t, 0.0), 1.0);
  const GREEN = [16, 185, 129];
  const YELLOW = [250, 204, 21];
  const RED = [239, 68, 68];
  let a, b, f;
  if (t < 0.5) {
    a = GREEN; b = YELLOW; f = t / 0.5;
  } else {
    a = YELLOW; b = RED; f = (t - 0.5) / 0.5;
  }
  const rgb = a.map((val, i) => Math.round(val + (b[i] - val) * f));
  return `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

function getHexFillColor(h) {
  if (state.colorMetric === 'ha') return h.color_ha;
  if (state.colorMetric === 'mean') return h.color_mean;
  if (state.colorMetric === 'fare') return h.color_fare || h.color_ha;
  if (h.color_share) return h.color_share;
  const layerData = state.data?.layers?.[state.currentLayer]?.res?.[state.currentRes];
  const smax = layerData?.scale?.smax || 5.0;
  const share = getHexSharePct(h);
  return h.reliable ? interpolateHaColor(share / smax) : '#94a3b8';
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
    let passesMetric = true;
    if (state.colorMetric === 'ha') {
      passesMetric = h.pct >= state.minBreachFilter;
    } else if (state.colorMetric === 'mean') {
      passesMetric = h.mean >= (state.minMeanFilter || 0);
    } else if (state.colorMetric === 'fare') {
      passesMetric = (h.avg_fare || 0) >= (state.minFareFilter || 0);
    } else {
      passesMetric = getHexSharePct(h) >= (state.minShareFilter || 0);
    }
    const isVisible = passesMetric && (h.orders >= state.minOrdersFilter);
    const isSelected = state.selectedHexes.has(h.hex);
    const fillColor = getHexFillColor(h);

    const polygon = L.polygon(h.ring, {
      color: isSelected ? '#000000' : '#ffffff',
      weight: isVisible ? (isSelected ? 2.5 : 1.2) : 0,
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
      const selected = state.selectedHexes.has(h.hex);
      polygon.setStyle({
        weight: selected ? 3.5 : 2.8,
        color: selected ? '#000000' : '#0f172a'
      });
      polygon.bringToFront();
    });

    polygon.on('mouseout', () => {
      const selected = state.selectedHexes.has(h.hex);
      const singleSel = state.singleSelectedHex && state.singleSelectedHex.hex === h.hex;
      polygon.setStyle({
        weight: selected ? 2.5 : (singleSel ? 3.0 : 1.2),
        color: selected ? '#000000' : (singleSel ? '#2563eb' : '#ffffff'),
        opacity: 1,
      });
    });

    polygon.on('dblclick', (e) => {
      if (e.originalEvent) {
        L.DomEvent.stopPropagation(e.originalEvent);
        L.DomEvent.preventDefault(e.originalEvent);
      }
    });

    polygon.on('click', (e) => {
      if (e.originalEvent) {
        L.DomEvent.stopPropagation(e.originalEvent);
      }
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
  const isMean = state.colorMetric === 'mean';
  const isShare = state.colorMetric === 'share';
  const isFare = state.colorMetric === 'fare';
  let topMetricHtml;

  if (isFare) {
    topMetricHtml = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
        <span style="font-size:13.5px;color:#0f172a"><b>Mean Fare: ${formatFareFull(h.avg_fare)} Toman</b></span>
        <span style="font-size:12px;font-weight:600;color:#2563eb">${h.orders.toLocaleString()} orders</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin:2px 0">
        <span style="color:#64748b">Mean Incentive:</span>
        <span style="color:#059669;font-weight:700">+${formatFareFull(h.avg_incentive || 0)} Toman</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin:2px 0">
        <span style="color:#64748b">Mean Duration:</span>
        <span style="color:#0f172a;font-weight:600">${h.mean.toFixed(1)} min</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin:2px 0">
        <span style="color:#64748b">Cell HA${state.threshold}% Breach:</span>
        <span style="color:#0f172a;font-weight:600">${h.pct.toFixed(1)}%</span>
      </div>`;
  } else if (isShare) {
    const sharePct = getHexSharePct(h);
    topMetricHtml = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
        <span style="font-size:13.5px;color:#0f172a"><b>City HA Share: ${sharePct.toFixed(1)}%</b></span>
        <span style="font-size:12px;font-weight:600;color:#2563eb">${h.orders.toLocaleString()} orders</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin:2px 0">
        <span style="color:#64748b">Cell HA${state.threshold}% Breach:</span>
        <span style="color:#0f172a;font-weight:600">${h.pct.toFixed(1)}%</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin:2px 0">
        <span style="color:#64748b">Mean Duration:</span>
        <span style="color:#0f172a;font-weight:600">${h.mean.toFixed(1)} min</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin:2px 0">
        <span style="color:#64748b">Cell Total Orders:</span>
        <span style="color:#0f172a;font-weight:600">${h.orders.toLocaleString()}</span>
      </div>`;
  } else if (isMean) {
    topMetricHtml = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
        <span style="font-size:13.5px;color:#0f172a"><b>Mean: ${h.mean.toFixed(1)} min</b></span>
        <span style="font-size:12px;font-weight:400;color:#475569">${h.orders.toLocaleString()} orders</span>
       </div>
       <div style="display:flex;justify-content:space-between;margin:2px 0">
        <span style="color:#64748b">HA${state.threshold}% Breach:</span>
        <span style="color:#dc2626;font-weight:700">${h.pct.toFixed(1)}% (${h.slow.toLocaleString()} ord)</span>
       </div>
       <div style="font-size:9.5px;color:#94a3b8;margin-bottom:4px">(create to accept average: ${h.mean.toFixed(1)} min)</div>`;
  } else {
    topMetricHtml = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
        <span style="font-size:13.5px;color:#0f172a"><b>HA${state.threshold}%: ${h.pct.toFixed(1)}%</b></span>
        <span style="font-size:12px;font-weight:400;color:#475569">${h.orders.toLocaleString()} orders</span>
       </div>
       <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1px">
        <span style="color:#64748b">HA${state.threshold} Orders Count:</span>
        <b style="color:#dc2626">${h.slow.toLocaleString()}</b>
       </div>
       <div style="font-size:9.5px;color:#94a3b8;margin-bottom:4px">(create to accept time &ge; ${state.threshold} min)</div>
       <div style="display:flex;justify-content:space-between;margin:2px 0">
        <span style="color:#64748b">Mean Duration:</span>
        <span style="color:#0f172a;font-weight:600">${h.mean.toFixed(1)} min</span>
       </div>`;
  }

  return `
    <div style="font-family:Inter,sans-serif;font-size:12px;line-height:1.45;min-width:180px">
      ${topMetricHtml}
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
  const inspBadge = document.getElementById('inspStatusBadge');
  if (inspBadge) {
    if (h.status === 'critical' || h.status === 'warning' || h.status === 'low_sample') {
      inspBadge.style.display = 'inline-block';
      inspBadge.className = `badge badge-${h.status}`;
      inspBadge.textContent = h.status.replace('_', ' ').toUpperCase();
    } else {
      inspBadge.style.display = 'none';
    }
  }
  document.getElementById('inspHaPct').textContent = `${h.pct.toFixed(1)}%`;
  document.getElementById('inspHaPct').style.color = '';
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

  const boxInspHa = document.getElementById('boxInspHa');
  const boxInspMean = document.getElementById('boxInspMean');
  const boxInspShare = document.getElementById('boxInspShare');
  const boxInspFare = document.getElementById('boxInspFare');
  if (boxInspHa && boxInspMean) {
    boxInspHa.classList.toggle('active-metric-box', state.colorMetric === 'ha');
    boxInspMean.classList.toggle('active-metric-box', state.colorMetric === 'mean');
  }
  if (boxInspShare) {
    boxInspShare.classList.toggle('active-metric-box', state.colorMetric === 'share');
  }
  if (boxInspFare) {
    boxInspFare.classList.toggle('active-metric-box', state.colorMetric === 'fare');
  }

  const inspFareEl = document.getElementById('inspFareVal');
  if (inspFareEl) inspFareEl.textContent = formatFareFull(h.avg_fare);
  const inspIncEl = document.getElementById('inspIncentiveVal');
  if (inspIncEl) inspIncEl.textContent = `+${formatFareFull(h.avg_incentive || 0)} inc`;

  const sharePct = getHexSharePct(h);
  const inspShareEl = document.getElementById('inspSharePct');
  if (inspShareEl) inspShareEl.textContent = `${sharePct.toFixed(1)}%`;

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
    polygon.setStyle({ weight: 1.2, color: '#ffffff', opacity: 1, fillOpacity: state.opacity });
  } else {
    state.selectedHexes.set(h.hex, { h, polygon });
    polygon.setStyle({ weight: 2.5, color: '#000000', opacity: 1, fillOpacity: state.opacity });
    polygon.bringToFront();
  }

  renderMergedSelection();
}

function renderMergedSelection() {
  const panel = document.getElementById('mergedSelectionPanel');
  const ctrlKml = document.getElementById('multiSelectControlsKml');
  const ctrlCountText = document.getElementById('multiKmlCountText');

  if (state.selectedHexes.size === 0) {
    panel.classList.remove('active');
    if (ctrlKml) ctrlKml.style.display = 'none';
    return;
  }

  if (ctrlKml && ctrlCountText) {
    ctrlCountText.textContent = state.selectedHexes.size;
    ctrlKml.style.display = 'block';
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
  document.getElementById('mergedHaPct').style.color = '';

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

  const totalCitySlow = getCityTotalSlow();
  const mergedSharePct = totalCitySlow > 0 ? (totalSlow / totalCitySlow * 100) : 0;
  const mergedShareEl = document.getElementById('mergedSharePct');
  if (mergedShareEl) mergedShareEl.textContent = `${mergedSharePct.toFixed(1)}%`;

  const boxMergedHa = document.getElementById('boxMergedHa');
  const boxMergedMean = document.getElementById('boxMergedMean');
  const boxMergedShare = document.getElementById('boxMergedShare');
  const boxMergedFare = document.getElementById('boxMergedFare');
  if (boxMergedHa && boxMergedMean) {
    boxMergedHa.classList.toggle('active-metric-box', state.colorMetric === 'ha');
    boxMergedMean.classList.toggle('active-metric-box', state.colorMetric === 'mean');
  }
  if (boxMergedShare) {
    boxMergedShare.classList.toggle('active-metric-box', state.colorMetric === 'share');
  }
  if (boxMergedFare) {
    boxMergedFare.classList.toggle('active-metric-box', state.colorMetric === 'fare');
  }

  const totalFare = hexItems.reduce((acc, item) => acc + (item.h.total_fare || 0), 0);
  const totalInc = hexItems.reduce((acc, item) => acc + (item.h.total_incentive || 0), 0);
  const weightedFare = totalOrders > 0 ? (totalFare / totalOrders) : 0;
  const weightedInc = totalOrders > 0 ? (totalInc / totalOrders) : 0;

  const mergedFareEl = document.getElementById('mergedFareVal');
  if (mergedFareEl) mergedFareEl.textContent = formatFareFull(weightedFare);
  const mergedIncEl = document.getElementById('mergedIncentiveVal');
  if (mergedIncEl) mergedIncEl.textContent = `+${formatFareFull(weightedInc)} inc`;

  const inputStartDate = document.getElementById('bikerExportStartDate');
  const inputEndDate = document.getElementById('bikerExportEndDate');
  if (inputStartDate && !inputStartDate.value) {
    inputStartDate.value = state.startDate;
  }
  if (inputEndDate && !inputEndDate.value) {
    inputEndDate.value = state.endDate;
  }
  updateBikerPeriodDisplay(inputStartDate ? inputStartDate.value : null, inputEndDate ? inputEndDate.value : null);
  updateHexExportBadge();

  panel.classList.add('active');
}

window.removeSingleSelectedHex = function(hexId) {
  const item = state.selectedHexes.get(hexId);
  if (item && item.polygon) {
    item.polygon.setStyle({ weight: 1.2, color: '#ffffff', opacity: 1, fillOpacity: state.opacity });
  }
  state.selectedHexes.delete(hexId);
  renderMergedSelection();
};

function clearHexSelection() {
  state.selectedHexes.forEach(item => {
    if (item.polygon) {
      item.polygon.setStyle({ weight: 1.2, color: '#ffffff', opacity: 1, fillOpacity: state.opacity });
    }
  });
  state.selectedHexes.clear();
  document.getElementById('mergedSelectionPanel').classList.remove('active');

  const ctrlKml = document.getElementById('multiSelectControlsKml');
  if (ctrlKml) ctrlKml.style.display = 'none';
}

function zoomToSelection() {
  if (state.selectedHexes.size === 0) return;
  const bounds = L.latLngBounds(Array.from(state.selectedHexes.values()).map(it => it.h.center));
  map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
}

// Export Selected Cell Boundaries as KML (2 Layers: Per-Cell and Outer Boundary)
async function exportSelectedCellsKml() {
  let hexItems = [];
  if (state.selectedHexes && state.selectedHexes.size > 0) {
    hexItems = Array.from(state.selectedHexes.values());
  } else if (state.singleSelectedHex) {
    hexItems = [state.singleSelectedHex];
  }

  if (hexItems.length === 0) {
    alert('Please select one or more cells on the map to output as KML (hold Shift or enable Multi-Select mode).');
    return;
  }

  const cityName = state.city ? state.city.toLowerCase() : 'fleet';
  const count = hexItems.length;
  const filename = `${cityName}_${count}_cells_2layers.kml`;
  const docTitle = `${state.city ? state.city.toUpperCase() : 'Fleet'} Selected Cells (${count} cell${count > 1 ? 's' : ''})`;

  try {
    const res = await fetch('/api/export-kml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cells: hexItems.map(item => item.h),
        filename: filename,
        mode: 'both'
      })
    });
    if (res.ok) {
      const blob = await res.blob();
      downloadKmlBlob(blob, filename);
      showKmlToast(`Exported 2-layer KML (Per-cell & Outer boundary) for ${count} cell${count > 1 ? 's' : ''}`);
      return;
    }
  } catch (err) {
    console.warn('API KML export failed, using client fallback:', err);
  }

  // Client-side fallback if network error
  const kmlContent = generateKmlTwoLayers(hexItems, docTitle);
  downloadKmlFile(kmlContent, filename);
  showKmlToast(`Exported 2-layer KML for ${count} cell${count > 1 ? 's' : ''}`);
}

function formatBikerDate(ymd) {
  if (!ymd) return '';
  const parts = ymd.split('-');
  if (parts.length !== 3) return ymd;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  return `${monthNames[m] || parts[1]} ${d}, ${parts[0]}`;
}

function getBikerDaysDiff(s, e) {
  if (!s || !e) return 1;
  const d1 = new Date(s);
  const d2 = new Date(e);
  const diffTime = Math.abs(d2 - d1);
  return Math.max(1, Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1);
}

function updateBikerPeriodDisplay(startDate, endDate) {
  const s = startDate || state.startDate;
  const e = endDate || state.endDate;
  const days = getBikerDaysDiff(s, e);
  const formatted = `${formatBikerDate(s)} – ${formatBikerDate(e)}`;
  const subText = `${days} day${days > 1 ? 's' : ''} selected • Click to open calendar`;

  // Front card
  const cardText = document.getElementById('bikerCardPeriodText');
  const cardSub = document.getElementById('bikerCardPeriodSub');
  if (cardText) cardText.textContent = formatted;
  if (cardSub) cardSub.textContent = subText;

  // Modal
  const modalText = document.getElementById('bikerModalPeriodText');
  const modalSub = document.getElementById('bikerModalPeriodSub');
  if (modalText) modalText.textContent = formatted;
  if (modalSub) modalSub.textContent = subText;

  // Inputs
  const cardStart = document.getElementById('bikerExportStartDate');
  const cardEnd = document.getElementById('bikerExportEndDate');
  if (cardStart && s) cardStart.value = s;
  if (cardEnd && e) cardEnd.value = e;

  const modalStart = document.getElementById('bikerModalStartDate');
  const modalEnd = document.getElementById('bikerModalEndDate');
  if (modalStart && s) modalStart.value = s;
  if (modalEnd && e) modalEnd.value = e;
}

const bikerCalState = {
  startDate: null,
  endDate: null,
  viewYear: 2026,
  viewMonth: 9, // October (0-indexed)
  pickingState: 'none',
  hoverDate: null,
  activeSource: 'card',
};

function initBikerCalendarUI() {
  const popover = document.getElementById('bikerCalendarPopover');
  if (!popover) return;

  const btnPrev = document.getElementById('bikerCalPrevMonth');
  const btnNext = document.getElementById('bikerCalNextMonth');
  if (btnPrev) {
    btnPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      bikerCalState.viewMonth--;
      if (bikerCalState.viewMonth < 0) {
        bikerCalState.viewMonth = 11;
        bikerCalState.viewYear--;
      }
      renderBikerCalendarGrid();
    });
  }
  if (btnNext) {
    btnNext.addEventListener('click', (e) => {
      e.stopPropagation();
      bikerCalState.viewMonth++;
      if (bikerCalState.viewMonth > 11) {
        bikerCalState.viewMonth = 0;
        bikerCalState.viewYear++;
      }
      renderBikerCalendarGrid();
    });
  }

  // Preset buttons inside popover
  popover.querySelectorAll('[data-bcal-preset]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.dataset.bcalPreset;
      let sDate = state.startDate;
      let eDate = state.endDate;

      if (p === 'active') {
        sDate = state.startDate;
        eDate = state.endDate;
      } else if (p === 'yesterday') {
        const rng = getRelativeDateRange(1);
        sDate = rng.start;
        eDate = rng.end;
      } else if (p === '3') {
        const rng = getRelativeDateRange(3);
        sDate = rng.start;
        eDate = rng.end;
      } else if (p === '7') {
        const rng = getRelativeDateRange(7);
        sDate = rng.start;
        eDate = rng.end;
      } else if (p === '14') {
        const rng = getRelativeDateRange(14);
        sDate = rng.start;
        eDate = rng.end;
      }

      bikerCalState.startDate = sDate;
      bikerCalState.endDate = eDate;
      bikerCalState.pickingState = 'none';
      bikerCalState.hoverDate = null;
      if (sDate) {
        const parts = sDate.split('-');
        bikerCalState.viewYear = parseInt(parts[0], 10);
        bikerCalState.viewMonth = parseInt(parts[1], 10) - 1;
      }
      popover.querySelectorAll('[data-bcal-preset]').forEach(b => b.classList.toggle('active', b === btn));
      renderBikerCalendarGrid();
    });
  });

  // Cancel and Close buttons
  const btnClose = document.getElementById('btnCloseBikerCalendar');
  const btnCancel = document.getElementById('btnCancelBikerCalendar');
  [btnClose, btnCancel].forEach(b => {
    if (b) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeBikerCalendarPopover();
      });
    }
  });

  // Apply button
  const btnApply = document.getElementById('btnApplyBikerCalendar');
  if (btnApply) {
    btnApply.addEventListener('click', (e) => {
      e.stopPropagation();
      applyBikerCalendarRange();
    });
  }

  // Mouseleave on days grid to clear hover preview
  const daysGrid = document.getElementById('bikerCalDaysGrid');
  if (daysGrid) {
    daysGrid.addEventListener('mouseleave', () => {
      clearBikerHoverRange();
    });
  }

  // Document click outside to close popover
  document.addEventListener('click', (e) => {
    if (!popover.classList.contains('open')) return;
    const triggerCard = document.getElementById('btnBikerCalTrigger');
    const triggerModal = document.getElementById('btnBikerModalCalTrigger');
    if (!popover.contains(e.target) &&
        (!triggerCard || !triggerCard.contains(e.target)) &&
        (!triggerModal || !triggerModal.contains(e.target))) {
      closeBikerCalendarPopover();
    }
  });

  // Trigger from Card
  const btnCardTrigger = document.getElementById('btnBikerCalTrigger');
  if (btnCardTrigger) {
    btnCardTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popover.classList.contains('open') && bikerCalState.activeSource === 'card') {
        closeBikerCalendarPopover();
      } else {
        openBikerCalendarPopover('card', btnCardTrigger);
      }
    });
  }

  // Trigger from Modal
  const btnModalTrigger = document.getElementById('btnBikerModalCalTrigger');
  if (btnModalTrigger) {
    btnModalTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popover.classList.contains('open') && bikerCalState.activeSource === 'modal') {
        closeBikerCalendarPopover();
      } else {
        openBikerCalendarPopover('modal', btnModalTrigger);
      }
    });
  }
}

function openBikerCalendarPopover(source, anchorEl) {
  const popover = document.getElementById('bikerCalendarPopover');
  if (!popover) return;

  bikerCalState.activeSource = source;

  const currentStart = (source === 'modal'
    ? document.getElementById('bikerModalStartDate')?.value
    : document.getElementById('bikerExportStartDate')?.value) || state.startDate;

  const currentEnd = (source === 'modal'
    ? document.getElementById('bikerModalEndDate')?.value
    : document.getElementById('bikerExportEndDate')?.value) || state.endDate;

  bikerCalState.startDate = currentStart;
  bikerCalState.endDate = currentEnd;
  bikerCalState.pickingState = 'none';
  bikerCalState.hoverDate = null;

  if (currentStart) {
    const parts = currentStart.split('-');
    bikerCalState.viewYear = parseInt(parts[0], 10);
    bikerCalState.viewMonth = parseInt(parts[1], 10) - 1;
  }

  // Position popover
  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const popWidth = 320;
    const popHeight = 350;

    let left = rect.left;
    if (left + popWidth > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - popWidth - 12);
    }

    let top = rect.bottom + 6;
    if (top + popHeight > window.innerHeight - 12) {
      top = Math.max(12, rect.top - popHeight - 6);
    }

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  renderBikerCalendarGrid();
  popover.classList.add('open');
}

function closeBikerCalendarPopover() {
  const popover = document.getElementById('bikerCalendarPopover');
  if (popover) {
    popover.classList.remove('open');
    bikerCalState.pickingState = 'none';
    bikerCalState.hoverDate = null;
  }
}

function renderBikerCalendarGrid() {
  const container = document.getElementById('bikerCalDaysGrid');
  const monthTitle = document.getElementById('bikerCalMonthTitle');
  if (!container || !monthTitle) return;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  monthTitle.textContent = `${monthNames[bikerCalState.viewMonth]} ${bikerCalState.viewYear}`;

  container.innerHTML = '';

  const y = bikerCalState.viewYear;
  const m = bikerCalState.viewMonth;

  // First day of month (Monday = 0, Sunday = 6)
  const firstDay = new Date(y, m, 1);
  const startDayOfWeek = firstDay.getDay();
  const firstCol = (startDayOfWeek + 6) % 7;

  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevMonthDays = new Date(y, m, 0).getDate();

  // Trailing days from previous month
  for (let i = firstCol - 1; i >= 0; i--) {
    const dayNum = prevMonthDays - i;
    const prevMonthIdx = m === 0 ? 11 : m - 1;
    const prevYear = m === 0 ? y - 1 : y;
    const dateStr = `${prevYear}-${String(prevMonthIdx + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const cell = createBikerCalDayCell(dayNum, dateStr, true);
    container.appendChild(cell);
  }

  // Days in current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = createBikerCalDayCell(d, dateStr, false);
    container.appendChild(cell);
  }

  // Trailing days for next month
  const totalCells = firstCol + daysInMonth;
  const nextMonthSlots = (7 - (totalCells % 7)) % 7;
  for (let n = 1; n <= nextMonthSlots; n++) {
    const nextMonthIdx = m === 11 ? 0 : m + 1;
    const nextYear = m === 11 ? y + 1 : y;
    const dateStr = `${nextYear}-${String(nextMonthIdx + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    const cell = createBikerCalDayCell(n, dateStr, true);
    container.appendChild(cell);
  }

  updateBikerCalFooter();
}

function createBikerCalDayCell(dayNum, dateStr, isOtherMonth) {
  const cell = document.createElement('div');
  cell.className = 'biker-day-cell';
  cell.dataset.date = dateStr;
  cell.textContent = dayNum;

  if (isOtherMonth) {
    cell.classList.add('other-month');
    return cell;
  }

  const s = bikerCalState.startDate;
  const e = bikerCalState.endDate;
  const minD = (s && e) ? (s < e ? s : e) : (s || e);
  const maxD = (s && e) ? (s < e ? e : s) : (s || e);

  if (dateStr === bikerCalState.startDate) {
    cell.classList.add('range-start');
  }
  if (dateStr === bikerCalState.endDate && bikerCalState.pickingState !== 'picking_end') {
    cell.classList.add('range-end');
  }
  if (bikerCalState.startDate && (!bikerCalState.endDate || bikerCalState.pickingState === 'picking_end') && dateStr === bikerCalState.startDate) {
    cell.classList.add('single-day');
  }
  if (minD && maxD && dateStr >= minD && dateStr <= maxD && bikerCalState.pickingState !== 'picking_end') {
    cell.classList.add('in-range');
  }

  cell.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (bikerCalState.pickingState === 'none' || !bikerCalState.startDate) {
      bikerCalState.startDate = dateStr;
      bikerCalState.endDate = null;
      bikerCalState.pickingState = 'picking_end';
      bikerCalState.hoverDate = null;
      renderBikerCalendarGrid();
    } else {
      if (dateStr < bikerCalState.startDate) {
        bikerCalState.endDate = bikerCalState.startDate;
        bikerCalState.startDate = dateStr;
      } else {
        bikerCalState.endDate = dateStr;
      }
      bikerCalState.pickingState = 'none';
      bikerCalState.hoverDate = null;
      renderBikerCalendarGrid();
    }
  });

  cell.addEventListener('mouseenter', () => {
    if (bikerCalState.pickingState === 'picking_end' && bikerCalState.startDate) {
      updateBikerCalHoverRange(dateStr);
    }
  });

  return cell;
}

function updateBikerCalHoverRange(hoverDateStr) {
  if (bikerCalState.pickingState !== 'picking_end' || !bikerCalState.startDate) return;

  const minD = hoverDateStr < bikerCalState.startDate ? hoverDateStr : bikerCalState.startDate;
  const maxD = hoverDateStr < bikerCalState.startDate ? bikerCalState.startDate : hoverDateStr;

  const cells = document.querySelectorAll('#bikerCalDaysGrid .biker-day-cell:not(.other-month)');
  cells.forEach(cell => {
    const d = cell.dataset.date;
    cell.classList.toggle('in-range', d >= minD && d <= maxD);
    cell.classList.toggle('range-start', d === minD);
    cell.classList.toggle('range-end', d === maxD && minD !== maxD);
    cell.classList.toggle('single-day', minD === maxD && d === minD);
  });

  // Update preview in footer
  const preview = document.getElementById('bikerCalRangePreviewText');
  const daysBadge = document.getElementById('bikerCalRangeDaysText');
  if (preview) preview.textContent = `${minD} → ${maxD}`;
  if (daysBadge) {
    const count = getBikerDaysDiff(minD, maxD);
    daysBadge.textContent = `${count} day${count > 1 ? 's' : ''}`;
  }
}

function clearBikerHoverRange() {
  if (bikerCalState.pickingState === 'picking_end') {
    renderBikerCalendarGrid();
  }
}

function updateBikerCalFooter() {
  const s = bikerCalState.startDate;
  const e = bikerCalState.endDate || s;
  const preview = document.getElementById('bikerCalRangePreviewText');
  const daysBadge = document.getElementById('bikerCalRangeDaysText');
  const hint = document.getElementById('bikerCalSelectionHint');

  if (s && e) {
    if (preview) preview.textContent = `${s} → ${e}`;
    if (daysBadge) {
      const count = getBikerDaysDiff(s, e);
      daysBadge.textContent = `${count} day${count > 1 ? 's' : ''}`;
    }
  } else if (s) {
    if (preview) preview.textContent = `${s} → ...`;
    if (daysBadge) daysBadge.textContent = '1 day';
  } else {
    if (preview) preview.textContent = 'No dates chosen';
    if (daysBadge) daysBadge.textContent = '0 days';
  }

  if (hint) {
    hint.textContent = bikerCalState.pickingState === 'picking_end'
      ? 'Now click on your end date'
      : 'Click start date, then click end date';
  }
}

function applyBikerCalendarRange() {
  const s = bikerCalState.startDate;
  const e = bikerCalState.endDate || s;
  if (!s) {
    alert('Please select a date range on the calendar.');
    return;
  }

  updateBikerPeriodDisplay(s, e);
  closeBikerCalendarPopover();

  if (bikerCalState.activeSource === 'modal') {
    loadBikerModalPreview();
  }
}

function handleBikerPresetClick(preset, source) {
  let sDate = state.startDate;
  let eDate = state.endDate;

  if (preset === 'active') {
    sDate = state.startDate;
    eDate = state.endDate;
  } else if (preset === 'yesterday') {
    const rng = getRelativeDateRange(1);
    sDate = rng.start;
    eDate = rng.end;
  } else if (preset === '3') {
    const rng = getRelativeDateRange(3);
    sDate = rng.start;
    eDate = rng.end;
  } else if (preset === '7') {
    const rng = getRelativeDateRange(7);
    sDate = rng.start;
    eDate = rng.end;
  } else if (preset === '14') {
    const rng = getRelativeDateRange(14);
    sDate = rng.start;
    eDate = rng.end;
  }

  updateBikerPeriodDisplay(sDate, eDate);

  // Sync active states on chips across card, modal and calendar popover
  document.querySelectorAll('[data-biker-preset]').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.bikerPreset === preset);
  });
  document.querySelectorAll('[data-bcal-preset]').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.bcalPreset === preset);
  });

  if (source === 'modal') {
    loadBikerModalPreview();
  }
}

function sortBikerTableBy(col) {
  if (state.bikerSortCol === col) {
    state.bikerSortDir = state.bikerSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.bikerSortCol = col;
    state.bikerSortDir = (col === 'biker_id') ? 'asc' : 'desc';
  }

  // Update header sort indicators
  ['biker_id', 'total_rides_in_period', 'total_rides_in_boundary', 'percentage_of_rides_in_boundary'].forEach(c => {
    const th = document.querySelector(`.sortable-th[data-col="${c}"]`);
    const icon = document.getElementById(`sortIcon_${c}`);
    if (th && icon) {
      if (c === state.bikerSortCol) {
        th.classList.add('active-sort');
        icon.innerHTML = state.bikerSortDir === 'asc' ? '&#9650;' : '&#9660;';
        icon.style.color = '#2563eb';
      } else {
        th.classList.remove('active-sort');
        icon.innerHTML = '&#8645;';
        icon.style.color = '#94a3b8';
      }
    }
  });

  // Re-render table with current search query preserved
  const searchInput = document.getElementById('bikerModalSearch');
  const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const list = (q && state.bikerPreviewRecords)
    ? state.bikerPreviewRecords.filter(r => String(r.biker_id).toLowerCase().includes(q))
    : (state.bikerPreviewRecords || []);

  renderBikerModalTable(list);
}

function openBikerModal() {
  if (state.selectedHexes.size === 0) {
    alert('Please select one or more boundary cells first.');
    return;
  }

  const inputStartDate = document.getElementById('bikerExportStartDate');
  const inputEndDate = document.getElementById('bikerExportEndDate');
  const inputMinRides = document.getElementById('bikerExportMinRides');
  const inputPct = document.getElementById('bikerExportPct');

  const modalStartDate = document.getElementById('bikerModalStartDate');
  const modalEndDate = document.getElementById('bikerModalEndDate');
  const modalMinRides = document.getElementById('bikerModalMinRides');
  const modalPct = document.getElementById('bikerModalPct');

  const sVal = (inputStartDate && inputStartDate.value) || state.startDate;
  const eVal = (inputEndDate && inputEndDate.value) || state.endDate;

  if (modalStartDate) modalStartDate.value = sVal;
  if (modalEndDate) modalEndDate.value = eVal;
  if (modalMinRides) modalMinRides.value = (inputMinRides && inputMinRides.value) || '5';
  if (modalPct) modalPct.value = (inputPct && inputPct.value) || '20';

  updateBikerPeriodDisplay(sVal, eVal);

  const subEl = document.getElementById('bikerModalSubtitle');
  if (subEl) {
    subEl.textContent = `Analyzing ${state.city.toUpperCase()} • ${state.selectedHexes.size} boundary cells selected (customer_id = 2)`;
  }

  // Clear search field on open
  const searchInput = document.getElementById('bikerModalSearch');
  if (searchInput) searchInput.value = '';

  // Ensure sort indicators are in sync
  ['biker_id', 'total_rides_in_period', 'total_rides_in_boundary', 'percentage_of_rides_in_boundary'].forEach(c => {
    const th = document.querySelector(`.sortable-th[data-col="${c}"]`);
    const icon = document.getElementById(`sortIcon_${c}`);
    if (th && icon) {
      if (c === state.bikerSortCol) {
        th.classList.add('active-sort');
        icon.innerHTML = state.bikerSortDir === 'asc' ? '&#9650;' : '&#9660;';
        icon.style.color = '#2563eb';
      } else {
        th.classList.remove('active-sort');
        icon.innerHTML = '&#8645;';
        icon.style.color = '#94a3b8';
      }
    }
  });

  document.getElementById('bikerModal').classList.add('open');
  loadBikerModalPreview();
}

function closeBikerModal() {
  const modal = document.getElementById('bikerModal');
  if (modal) modal.classList.remove('open');
}

async function loadBikerModalPreview() {
  const cellIds = Array.from(state.selectedHexes.keys());
  if (cellIds.length === 0) return;

  const modalStartDate = document.getElementById('bikerModalStartDate');
  const modalEndDate = document.getElementById('bikerModalEndDate');
  const modalMinRides = document.getElementById('bikerModalMinRides');
  const modalPct = document.getElementById('bikerModalPct');
  const tbody = document.getElementById('bikerModalTableBody');

  const startDate = modalStartDate ? modalStartDate.value || state.startDate : state.startDate;
  const endDate = modalEndDate ? modalEndDate.value || state.endDate : state.endDate;
  const minRides = modalMinRides ? Math.max(0, parseInt(modalMinRides.value, 10) || 0) : 0;
  const pct = modalPct ? Math.max(0, Math.min(100, parseFloat(modalPct.value) || 0)) : 20;
  const toggle = state.bikerExportToggle || 'less';

  // Sync back to card
  const inputStartDate = document.getElementById('bikerExportStartDate');
  const inputEndDate = document.getElementById('bikerExportEndDate');
  const inputMinRides = document.getElementById('bikerExportMinRides');
  const inputPct = document.getElementById('bikerExportPct');
  if (inputStartDate) inputStartDate.value = startDate;
  if (inputEndDate) inputEndDate.value = endDate;
  if (inputMinRides) inputMinRides.value = minRides;
  if (inputPct) inputPct.value = pct;

  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:18px;color:#64748b">Analyzing biker rides in boundary...</td></tr>';
  }

  try {
    const res = await fetch('/api/biker-rides-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        city: state.city,
        start_date: startDate,
        end_date: endDate,
        cells: cellIds,
        min_rides: minRides,
        toggle: toggle,
        percentage: pct,
        layer: state.currentLayer,
        status: state.status,
        customer_id: state.customerId,
      })
    });

    if (!res.ok) {
      throw new Error('Failed to load biker preview');
    }

    const data = await res.json();
    document.getElementById('bikerModalKpiCount').textContent = (data.matching_bikers_count || 0).toLocaleString();
    document.getElementById('bikerModalKpiTotalRides').textContent = (data.total_period_rides || 0).toLocaleString();
    document.getElementById('bikerModalKpiBoundaryRides').textContent = (data.total_boundary_rides || 0).toLocaleString();
    document.getElementById('bikerModalKpiAvgPct').textContent = `${(data.avg_boundary_pct || 0).toFixed(1)}%`;

    const sub = document.getElementById('bikerModalTableSub');
    if (sub) sub.textContent = `(${data.matching_bikers_count || 0} matching)`;

    const btnModalExport = document.getElementById('btnBikerModalExportCsv');
    if (btnModalExport) {
      btnModalExport.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        Download CSV (${data.matching_bikers_count || 0})
      `;
    }

    state.bikerPreviewRecords = data.bikers || [];
    renderBikerModalTable(state.bikerPreviewRecords);
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:18px;color:#dc2626">Error: ${escapeXml(err.message)}</td></tr>`;
    }
  }
}

function renderBikerModalTable(bikers) {
  const tbody = document.getElementById('bikerModalTableBody');
  if (!tbody) return;

  const records = bikers !== undefined ? bikers : (state.bikerPreviewRecords || []);

  if (!records || records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:18px;color:#94a3b8">No bikers match the selected criteria</td></tr>';
    return;
  }

  // Sort according to active column & direction
  const col = state.bikerSortCol || 'percentage_of_rides_in_boundary';
  const dir = state.bikerSortDir === 'asc' ? 1 : -1;

  const sorted = [...records].sort((a, b) => {
    if (col === 'biker_id') {
      return dir * String(a.biker_id).localeCompare(String(b.biker_id), undefined, { numeric: true });
    }
    const valA = Number(a[col]) || 0;
    const valB = Number(b[col]) || 0;
    if (valA !== valB) {
      return dir * (valA - valB);
    }
    return (Number(b.total_rides_in_period) || 0) - (Number(a.total_rides_in_period) || 0);
  });

  tbody.innerHTML = sorted.map(b => {
    const pct = typeof b.percentage_of_rides_in_boundary === 'number'
      ? b.percentage_of_rides_in_boundary
      : parseFloat(b.percentage_of_rides_in_boundary) || 0;
    const isGood = state.bikerExportToggle === 'less' ? (pct <= 20) : (pct >= 50);
    const pillClass = isGood ? 'good' : 'warn';
    return `
      <tr>
        <td style="font-weight:700;color:#0f172a;font-family:monospace">${escapeXml(String(b.biker_id))}</td>
        <td style="text-align:right;font-weight:600">${Number(b.total_rides_in_period || 0).toLocaleString()}</td>
        <td style="text-align:right;font-weight:600;color:#0e7490">${Number(b.total_rides_in_boundary || 0).toLocaleString()}</td>
        <td style="text-align:right">
          <span class="biker-pct-pill ${pillClass}">
            ${pct.toFixed(1)}%
          </span>
        </td>
      </tr>
    `;
  }).join('');
}

// Export Filtered Bikers in Boundary to CSV
async function exportBikersBoundaryCsv() {
  const cellIds = Array.from(state.selectedHexes.keys());
  if (cellIds.length === 0) {
    alert('Please select one or more cells on the map to define the boundary.');
    return;
  }

  const isModalOpen = document.getElementById('bikerModal')?.classList.contains('open');

  const startDateInput = document.getElementById(isModalOpen ? 'bikerModalStartDate' : 'bikerExportStartDate');
  const endDateInput = document.getElementById(isModalOpen ? 'bikerModalEndDate' : 'bikerExportEndDate');
  const minRidesInput = document.getElementById(isModalOpen ? 'bikerModalMinRides' : 'bikerExportMinRides');
  const pctInput = document.getElementById(isModalOpen ? 'bikerModalPct' : 'bikerExportPct');
  const btnExport = document.getElementById('btnExportBikersCsv');
  const btnModalExport = document.getElementById('btnBikerModalExportCsv');
  const feedbackEl = document.getElementById('bikerExportFeedback');

  const startDate = startDateInput ? startDateInput.value || state.startDate : state.startDate;
  const endDate = endDateInput ? endDateInput.value || state.endDate : state.endDate;
  const minRides = minRidesInput ? Math.max(0, parseInt(minRidesInput.value, 10) || 0) : 0;
  const percentage = pctInput ? Math.max(0, Math.min(100, parseFloat(pctInput.value) || 0)) : 20;
  const toggle = state.bikerExportToggle || 'less';

  const origBtnHtml = btnExport ? btnExport.innerHTML : 'Export CSV';
  const origModalHtml = btnModalExport ? btnModalExport.innerHTML : 'Download CSV';

  if (btnExport) {
    btnExport.disabled = true;
    btnExport.innerHTML = `Exporting...`;
  }
  if (btnModalExport) {
    btnModalExport.disabled = true;
    btnModalExport.innerHTML = `Exporting...`;
  }
  if (feedbackEl) {
    feedbackEl.style.display = 'block';
    feedbackEl.textContent = 'Querying rides and filtering bikers (customer_id = 2)...';
  }

  try {
    const res = await fetch('/api/export-biker-rides-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        city: state.city,
        start_date: startDate,
        end_date: endDate,
        cells: cellIds,
        min_rides: minRides,
        toggle: toggle,
        percentage: percentage,
        layer: state.currentLayer,
        status: state.status,
        customer_id: state.customerId,
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Export request failed' }));
      throw new Error(err.detail || 'Failed to export CSV');
    }

    const matchedCount = res.headers.get('x-matched-bikers-count') || '0';
    const blob = await res.blob();
    const filename = `${state.city}_bikers_boundary_${toggle}_${percentage}pct_${startDate}_to_${endDate}.csv`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showKmlToast(`Exported ${matchedCount} bikers to CSV (${filename})`);
    if (feedbackEl) {
      feedbackEl.textContent = `Done! ${matchedCount} bikers matched and exported.`;
      setTimeout(() => { feedbackEl.style.display = 'none'; }, 4000);
    }
  } catch (err) {
    alert(`CSV Export Error: ${err.message}`);
    if (feedbackEl) {
      feedbackEl.textContent = `Error: ${err.message}`;
    }
  } finally {
    if (btnExport) {
      btnExport.disabled = false;
      btnExport.innerHTML = origBtnHtml;
    }
    if (btnModalExport) {
      btnModalExport.disabled = false;
      btnModalExport.innerHTML = origModalHtml;
    }
  }
}

// Export List of Selected Hexagons by Resolution
async function exportHexagonsByResolution(format) {
  let hexIds = Array.from(state.selectedHexes.keys());
  if (hexIds.length === 0 && state.singleSelectedHex && state.singleSelectedHex.h) {
    hexIds = [state.singleSelectedHex.h.hex];
  }

  const feedbackEl = document.getElementById('hexExportFeedback');
  const selectResEl = document.getElementById('selectHexExportRes');
  const targetResolution = selectResEl ? selectResEl.value : 'current';

  if (!hexIds || hexIds.length === 0) {
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.color = '#dc2626';
      feedbackEl.textContent = 'Please select one or more hexagons on the map first.';
      setTimeout(() => { feedbackEl.style.display = 'none'; }, 4000);
    } else {
      alert('Please select one or more hexagons on the map first.');
    }
    return;
  }

  const btnCsv = document.getElementById('btnExportHexCsv');
  const btnTxt = document.getElementById('btnExportHexTxt');
  const btnCopy = document.getElementById('btnCopyHexList');
  const activeBtn = format === 'csv' ? btnCsv : (format === 'txt' ? btnTxt : btnCopy);
  const origBtnContent = activeBtn ? activeBtn.innerHTML : '';

  if (activeBtn) {
    activeBtn.disabled = true;
    activeBtn.innerHTML = `<span>Loading...</span>`;
  }
  if (feedbackEl) {
    feedbackEl.style.display = 'block';
    feedbackEl.style.color = '#15803d';
    feedbackEl.textContent = `Resolving hexagons (${targetResolution === 'all' ? 'All Resolutions' : 'Res ' + targetResolution})...`;
  }

  try {
    const payloadFormat = format === 'copy' ? 'txt' : format;
    const res = await fetch('/api/export-hexagons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hex_ids: hexIds,
        target_resolution: targetResolution,
        format: payloadFormat,
        city: state.city
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Hexagon export failed' }));
      throw new Error(err.detail || 'Hexagon export failed');
    }

    const countHeader = res.headers.get('x-hexagons-count') || hexIds.length;

    if (format === 'copy') {
      const textContent = await res.text();
      let copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(textContent.trim());
          copied = true;
        } catch (clipErr) {
          console.warn('navigator.clipboard write failed, using textarea fallback', clipErr);
        }
      }
      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = textContent.trim();
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }

      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.color = '#15803d';
        feedbackEl.textContent = `Copied ${countHeader} hexagons to clipboard!`;
        setTimeout(() => { feedbackEl.style.display = 'none'; }, 4000);
      }
      showKmlToast(`Copied ${countHeader} hexagons to clipboard!`);
    } else {
      const disposition = res.headers.get('content-disposition') || '';
      let filename = `hexagons_${targetResolution}_${state.city}.${format}`;
      const fnMatch = disposition.match(/filename="?([^";]+)"?/i);
      if (fnMatch && fnMatch[1]) {
        filename = fnMatch[1];
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.color = '#15803d';
        feedbackEl.textContent = `Downloaded ${countHeader} hexagons (${filename})`;
        setTimeout(() => { feedbackEl.style.display = 'none'; }, 4000);
      }
      showKmlToast(`Downloaded ${countHeader} hexagons (${filename})`);
    }
  } catch (err) {
    console.error('Hexagon export error:', err);
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.color = '#dc2626';
      feedbackEl.textContent = `Error: ${err.message}`;
      setTimeout(() => { feedbackEl.style.display = 'none'; }, 5000);
    } else {
      alert(`Hexagon Export Error: ${err.message}`);
    }
  } finally {
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.innerHTML = origBtnContent;
    }
  }
}

function updateHexExportBadge() {
  const badgeEl = document.getElementById('hexExportBadge');
  if (!badgeEl) return;
  const count = state.selectedHexes.size || (state.singleSelectedHex ? 1 : 0);
  badgeEl.textContent = `${count} ${count === 1 ? 'cell' : 'cells'}`;
}

function generateKmlTwoLayers(hexItems, docTitle) {
  let totalOrders = 0;
  let totalSlow = 0;
  let vsum = 0;
  let totalFare = 0;
  let totalInc = 0;

  const placemarksXml = hexItems.map(item => {
    const h = item.h || item;
    const hexId = h.hex || 'unknown_cell';
    const ring = h.ring;
    if (!ring || ring.length < 3) return '';

    const pct = typeof h.pct === 'number' ? h.pct : 0;
    const orders = typeof h.orders === 'number' ? h.orders : 0;
    const slow = typeof (h.ha30_count != null ? h.ha30_count : h.slow) === 'number'
      ? (h.ha30_count != null ? h.ha30_count : h.slow)
      : 0;
    const mean = typeof h.mean === 'number' ? h.mean : 0;
    const avgFare = h.avg_fare || 0;
    const avgInc = h.avg_incentive || 0;

    totalOrders += orders;
    totalSlow += slow;
    vsum += mean * orders;
    totalFare += avgFare * orders;
    totalInc += avgInc * orders;

    const coordPairs = ring.map(pt => `${Number(pt[1]).toFixed(6)},${Number(pt[0]).toFixed(6)},0`);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Number(first[0]).toFixed(6) !== Number(last[0]).toFixed(6) ||
        Number(first[1]).toFixed(6) !== Number(last[1]).toFixed(6)) {
      coordPairs.push(`${Number(first[1]).toFixed(6)},${Number(first[0]).toFixed(6)},0`);
    }

    const coordsStr = coordPairs.join(' ');
    const safeHex = escapeXml(hexId);
    const placemarkName = `${safeHex} — HA30: ${pct.toFixed(1)}% (${orders.toLocaleString()} ord)`;

    const fareRow = avgFare > 0 ? `
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Mean Biker Fare:</b></td><td style="padding:2px 0;font-weight:700;">${formatFareFull(avgFare)} Toman</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Mean Incentive:</b></td><td style="padding:2px 0;color:#059669;font-weight:700;">+${formatFareFull(avgInc)} Toman</td></tr>` : '';

    const descHtml = `<![CDATA[
<div style="font-family:sans-serif;font-size:12px;line-height:1.5;">
  <h4 style="margin:0 0 6px 0;color:#0e7490;">H3 Cell: ${safeHex}</h4>
  <table style="border-collapse:collapse;width:100%;font-size:12px;">
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>HA30 Breach Rate:</b></td><td style="padding:2px 0;font-weight:700;color:${pct > 25 ? '#dc2626' : '#16a34a'};">${pct.toFixed(1)}%</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Total Orders:</b></td><td style="padding:2px 0;font-weight:700;">${orders.toLocaleString()}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>HA30 Orders Count:</b></td><td style="padding:2px 0;">${slow.toLocaleString()}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Mean Duration:</b></td><td style="padding:2px 0;">${mean.toFixed(1)} min</td></tr>
    ${fareRow}
  </table>
</div>
]]>`;

    return `      <Placemark>
        <name>${placemarkName}</name>
        <description>${descHtml}</description>
        <styleUrl>#cellBoundary</styleUrl>
        <ExtendedData>
          <Data name="h3_index"><value>${safeHex}</value></Data>
          <Data name="ha30_pct"><value>${pct.toFixed(1)}</value></Data>
          <Data name="orders"><value>${orders}</value></Data>
          <Data name="ha30_orders"><value>${slow}</value></Data>
          <Data name="mean_duration_min"><value>${mean.toFixed(1)}</value></Data>
        </ExtendedData>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>${coordsStr}</coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
      </Placemark>`;
  }).filter(Boolean).join('\n');

  const haPct = totalOrders > 0 ? (totalSlow / totalOrders * 100) : 0;
  const meanDur = totalOrders > 0 ? (vsum / totalOrders) : 0;
  const meanFare = totalOrders > 0 ? (totalFare / totalOrders) : 0;
  const meanInc = totalOrders > 0 ? (totalInc / totalOrders) : 0;

  const fareRowAgg = meanFare > 0 ? `
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Mean Biker Fare:</b></td><td style="padding:2px 0;font-weight:700;">${formatFareFull(meanFare)} Toman</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Mean Incentive:</b></td><td style="padding:2px 0;color:#059669;font-weight:700;">+${formatFareFull(meanInc)} Toman</td></tr>` : '';

  const outerDesc = `<![CDATA[
<div style="font-family:sans-serif;font-size:12px;line-height:1.5;">
  <h4 style="margin:0 0 6px 0;color:#000000;">Merged Region Outer Boundary (${hexItems.length} Cells)</h4>
  <table style="border-collapse:collapse;width:100%;font-size:12px;">
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Combined HA30% Breach:</b></td><td style="padding:2px 0;font-weight:700;color:${haPct > 25 ? '#dc2626' : '#16a34a'};">${haPct.toFixed(1)}%</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Total Orders:</b></td><td style="padding:2px 0;font-weight:700;">${totalOrders.toLocaleString()}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>HA30 Orders Count:</b></td><td style="padding:2px 0;">${totalSlow.toLocaleString()}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Weighted Mean Duration:</b></td><td style="padding:2px 0;">${meanDur.toFixed(1)} min</td></tr>
    ${fareRowAgg}
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Cell Count:</b></td><td style="padding:2px 0;">${hexItems.length}</td></tr>
  </table>
</div>
]]>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(docTitle || 'Selected Region Boundaries')}</name>
    <description>Two-layer export: Per-cell boundaries and outer boundary from Fleet HexMap</description>
    <Style id="cellBoundary">
      <LineStyle>
        <color>ffd4b606</color>
        <width>2.5</width>
      </LineStyle>
      <PolyStyle>
        <fill>0</fill>
        <outline>1</outline>
      </PolyStyle>
    </Style>
    <Style id="blackOuterBoundary">
      <LineStyle>
        <color>ff000000</color>
        <width>3.5</width>
      </LineStyle>
      <PolyStyle>
        <fill>0</fill>
        <outline>1</outline>
      </PolyStyle>
    </Style>
    <Folder id="layer_per_cell">
      <name>Per-Cell Boundaries</name>
      <open>1</open>
      <description>Individual H3 cell polygons with metrics</description>
${placemarksXml}
    </Folder>
    <Folder id="layer_outer_boundary">
      <name>Outer Boundary (Black)</name>
      <open>1</open>
      <description>Dissolved black outer perimeter</description>
      <Placemark>
        <name>${escapeXml(docTitle || 'Merged Region Outer Boundary')}</name>
        <description>${outerDesc}</description>
        <styleUrl>#blackOuterBoundary</styleUrl>
      </Placemark>
    </Folder>
  </Document>
</kml>`;
}

function generateKmlForHexes(hexItems, docTitle) {
  const placemarksXml = hexItems.map(item => {
    const h = item.h || item;
    const hexId = h.hex || 'unknown_cell';
    const ring = h.ring;
    if (!ring || ring.length < 3) return '';

    const pct = typeof h.pct === 'number' ? h.pct : 0;
    const orders = typeof h.orders === 'number' ? h.orders : 0;
    const slow = typeof (h.ha30_count != null ? h.ha30_count : h.slow) === 'number'
      ? (h.ha30_count != null ? h.ha30_count : h.slow)
      : 0;
    const mean = typeof h.mean === 'number' ? h.mean : 0;

    // Convert [lat, lng] to "longitude,latitude,altitude" (KML requires lng,lat,alt)
    const coordPairs = ring.map(pt => `${Number(pt[1]).toFixed(6)},${Number(pt[0]).toFixed(6)},0`);

    // Ensure LinearRing is closed (first coordinate equals last coordinate)
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Number(first[0]).toFixed(6) !== Number(last[0]).toFixed(6) ||
        Number(first[1]).toFixed(6) !== Number(last[1]).toFixed(6)) {
      coordPairs.push(`${Number(first[1]).toFixed(6)},${Number(first[0]).toFixed(6)},0`);
    }

    const coordsStr = coordPairs.join(' ');
    const safeHex = escapeXml(hexId);
    const placemarkName = `${safeHex} — HA30: ${pct.toFixed(1)}% (${orders.toLocaleString()} ord)`;

    const descHtml = `<![CDATA[
<div style="font-family:sans-serif;font-size:12px;line-height:1.5;">
  <h4 style="margin:0 0 6px 0;color:#0e7490;">H3 Cell: ${safeHex}</h4>
  <table style="border-collapse:collapse;width:100%;font-size:12px;">
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>HA30 Breach Rate:</b></td><td style="padding:2px 0;font-weight:700;color:${pct > 25 ? '#dc2626' : '#16a34a'};">${pct.toFixed(1)}%</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Total Orders:</b></td><td style="padding:2px 0;font-weight:700;">${orders.toLocaleString()}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>HA30 Orders Count:</b></td><td style="padding:2px 0;">${slow.toLocaleString()}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Mean Duration:</b></td><td style="padding:2px 0;">${mean.toFixed(1)} min</td></tr>
  </table>
</div>
]]>`;

    return `    <Placemark>
      <name>${placemarkName}</name>
      <description>${descHtml}</description>
      <styleUrl>#cellBoundary</styleUrl>
      <ExtendedData>
        <Data name="h3_index"><value>${safeHex}</value></Data>
        <Data name="ha30_pct"><value>${pct.toFixed(1)}</value></Data>
        <Data name="orders"><value>${orders}</value></Data>
        <Data name="ha30_orders"><value>${slow}</value></Data>
        <Data name="mean_duration_min"><value>${mean.toFixed(1)}</value></Data>
      </ExtendedData>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordsStr}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>`;
  }).filter(Boolean).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(docTitle || 'Selected Cell Boundaries')}</name>
    <description>H3 cell boundaries with HA30 breach rates and order counts exported from Fleet HexMap</description>
    <Style id="cellBoundary">
      <LineStyle>
        <color>ffd4b606</color>
        <width>2.5</width>
      </LineStyle>
      <PolyStyle>
        <fill>0</fill>
        <outline>1</outline>
      </PolyStyle>
    </Style>
${placemarksXml}
  </Document>
</kml>`;
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function downloadKmlFile(content, filename) {
  const blob = new Blob([content], { type: 'application/vnd.google-earth.kml+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'selected_cells_boundaries.kml';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let kmlToastTimer = null;
function showKmlToast(message) {
  const toast = document.getElementById('kmlToastNotification');
  const msgEl = document.getElementById('kmlToastMessage');
  if (!toast || !msgEl) return;

  msgEl.textContent = message;
  toast.classList.add('show');

  if (kmlToastTimer) clearTimeout(kmlToastTimer);
  kmlToastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

// Color Metric Switcher (HA30 vs Mean Duration vs City HA Share vs Biker Fare)
function setColorMetric(metric) {
  state.colorMetric = metric;
  document.getElementById('btnMetricHa').classList.toggle('active', metric === 'ha');
  document.getElementById('btnMetricMean').classList.toggle('active', metric === 'mean');
  const btnShare = document.getElementById('btnMetricShare');
  if (btnShare) btnShare.classList.toggle('active', metric === 'share');
  const btnFare = document.getElementById('btnMetricFare');
  if (btnFare) btnFare.classList.toggle('active', metric === 'fare');

  state.polygons.forEach(item => {
    const isSelected = state.selectedHexes.has(item.h.hex);
    const color = getHexFillColor(item.h);
    item.polygon.setStyle({
      fillColor: color,
      color: isSelected ? '#000000' : '#ffffff'
    });
  });

  resizeFilterSliders();
  updateFilterLabels();
  filterHexagons();
  updateLegend();
  renderLabels();

  const headerThresh = document.getElementById('headerThresholdLabel');
  if (headerThresh) {
    if (metric === 'ha') headerThresh.textContent = `HA${state.threshold}%`;
    else if (metric === 'mean') headerThresh.textContent = 'MEAN DURATION';
    else if (metric === 'fare') headerThresh.textContent = 'BIKER FARE';
    else headerThresh.textContent = 'HA SHARE';
  }

  const boxInspHa = document.getElementById('boxInspHa');
  const boxInspMean = document.getElementById('boxInspMean');
  const boxInspShare = document.getElementById('boxInspShare');
  const boxInspFare = document.getElementById('boxInspFare');
  if (boxInspHa && boxInspMean) {
    boxInspHa.classList.toggle('active-metric-box', metric === 'ha');
    boxInspMean.classList.toggle('active-metric-box', metric === 'mean');
  }
  if (boxInspShare) {
    boxInspShare.classList.toggle('active-metric-box', metric === 'share');
  }
  if (boxInspFare) {
    boxInspFare.classList.toggle('active-metric-box', metric === 'fare');
  }

  const boxMergedHa = document.getElementById('boxMergedHa');
  const boxMergedMean = document.getElementById('boxMergedMean');
  const boxMergedShare = document.getElementById('boxMergedShare');
  const boxMergedFare = document.getElementById('boxMergedFare');
  if (boxMergedHa && boxMergedMean) {
    boxMergedHa.classList.toggle('active-metric-box', metric === 'ha');
    boxMergedMean.classList.toggle('active-metric-box', metric === 'mean');
  }
  if (boxMergedShare) {
    boxMergedShare.classList.toggle('active-metric-box', metric === 'share');
  }
  if (boxMergedFare) {
    boxMergedFare.classList.toggle('active-metric-box', metric === 'fare');
  }

  if (state.data && state.data.bottlenecks) {
    renderBottlenecks(state.data.bottlenecks);
  }
}

// Render labels on hexagons: dynamically sized and centered to fit inside each cell on every zoom & resolution
// Displays HA percentage with 1 float precision (e.g. 14.2%) in each cell, along with order volume
function renderLabels() {
  labelLayerGroup.clearLayers();
  if (!state.showLabels || !state.polygons || state.polygons.length === 0) return;

  // Measure exact pixel radius of a hexagon in the current viewport & resolution
  const samplePoly = state.polygons[0];
  let radiusPx = 25;
  if (samplePoly && samplePoly.h && samplePoly.h.ring && samplePoly.h.ring.length > 0) {
    try {
      const ptCenter = map.latLngToLayerPoint(samplePoly.h.center);
      const ptEdge = map.latLngToLayerPoint(samplePoly.h.ring[0]);
      radiusPx = Math.hypot(ptEdge.x - ptCenter.x, ptEdge.y - ptCenter.y);
    } catch (e) {
      radiusPx = 25;
    }
  }

  // If zoomed out so far that hexagons are tiny slivers (< 7px radius, < 14px diameter),
  // hide labels so they do not overlap outside the cell
  if (radiusPx < 7) {
    return;
  }

  // Compute dynamic font sizes and bounding box scaled to hexagon radius
  let fontHaPx, fontSubPx, boxWPx, boxHPx;

  if (radiusPx < 11) {
    // Zoomed out / fine resolution (14px - 22px diameter): micro compact HA float
    fontHaPx = 6.5;
    fontSubPx = 5.5;
    boxWPx = Math.max(22, Math.round(radiusPx * 1.8));
    boxHPx = Math.max(12, Math.round(radiusPx * 1.2));
  } else if (radiusPx < 18) {
    // Small cells (22px - 36px diameter)
    fontHaPx = 8.5;
    fontSubPx = 6.5;
    boxWPx = Math.round(radiusPx * 1.5);
    boxHPx = Math.round(radiusPx * 1.2);
  } else if (radiusPx < 28) {
    // Medium cells (36px - 56px diameter)
    fontHaPx = 10;
    fontSubPx = 7.5;
    boxWPx = Math.round(radiusPx * 1.4);
    boxHPx = Math.round(radiusPx * 1.1);
  } else if (radiusPx < 45) {
    // Large cells (56px - 90px diameter)
    fontHaPx = 11.5;
    fontSubPx = 8.5;
    boxWPx = Math.round(radiusPx * 1.3);
    boxHPx = Math.round(radiusPx * 1.0);
  } else {
    // Extra large cells (> 90px diameter)
    fontHaPx = Math.min(14, Math.round(radiusPx * 0.26));
    fontSubPx = Math.min(10.5, Math.round(radiusPx * 0.19));
    boxWPx = Math.round(radiusPx * 1.2);
    boxHPx = Math.round(radiusPx * 0.9);
  }

  // Exact anchor at box midpoint ensures the text is centered precisely at hexagon centroid
  const anchorX = boxWPx / 2;
  const anchorY = boxHPx / 2;
  const isHa = state.colorMetric === 'ha';
  const isMean = state.colorMetric === 'mean';
  const isShare = state.colorMetric === 'share';
  const isFare = state.colorMetric === 'fare';

  state.polygons.forEach(item => {
    const h = item.h;
    // Only render label if cell passes active metric and orders filters
    let passesMetric = true;
    if (isHa) {
      passesMetric = h.pct >= state.minBreachFilter;
    } else if (isMean) {
      passesMetric = h.mean >= (state.minMeanFilter || 0);
    } else if (isFare) {
      passesMetric = (h.avg_fare || 0) >= (state.minFareFilter || 0);
    } else {
      passesMetric = getHexSharePct(h) >= (state.minShareFilter || 0);
    }
    if (!passesMetric || h.orders < state.minOrdersFilter) return;

    let htmlContent;

    if (isFare) {
      const metricText = formatFare(h.avg_fare);

      if (state.cellLabelMode === 'orders_only') {
        htmlContent = `<span class="lbl-main-orders" style="font-size:${fontHaPx}px">${h.orders.toLocaleString()}</span>`;
      } else if (state.cellLabelMode === 'ha_only' || radiusPx < 11) {
        htmlContent = `<span class="lbl-main-orders" style="font-size:${fontHaPx}px">${metricText}</span>`;
      } else {
        const subText = (h.avg_incentive > 0) ? `+${formatFare(h.avg_incentive)}` : `${h.orders.toLocaleString()} ord`;
        htmlContent = `
          <span class="lbl-main-orders" style="font-size:${fontHaPx}px">${metricText}</span>
          <span class="lbl-sub-metric" style="font-size:${fontSubPx}px">${subText}</span>
        `;
      }
    } else if (isShare) {
      const sharePct = getHexSharePct(h);
      const metricText = `${sharePct.toFixed(1)}%`;

      if (state.cellLabelMode === 'orders_only') {
        htmlContent = `<span class="lbl-main-orders" style="font-size:${fontHaPx}px">${h.orders.toLocaleString()}</span>`;
      } else if (state.cellLabelMode === 'ha_only' || radiusPx < 11) {
        htmlContent = `<span class="lbl-main-orders" style="font-size:${fontHaPx}px">${metricText}</span>`;
      } else {
        htmlContent = `
          <span class="lbl-main-orders" style="font-size:${fontHaPx}px">${metricText}</span>
          <span class="lbl-sub-metric" style="font-size:${fontSubPx}px">${h.orders.toLocaleString()} ord</span>
        `;
      }
    } else {
      // Default HA or Mean mode
      const metricText = isHa
        ? `${h.pct.toFixed(1)}%`
        : (radiusPx < 14 ? `${h.mean.toFixed(1)}m` : `${h.mean.toFixed(1)} min`);

      if (state.cellLabelMode === 'orders_only') {
        htmlContent = `<span class="lbl-main-orders" style="font-size:${fontHaPx}px">${h.orders.toLocaleString()}</span>`;
      } else if (state.cellLabelMode === 'ha_only' || radiusPx < 11) {
        htmlContent = `<span class="lbl-main-orders" style="font-size:${fontHaPx}px">${metricText}</span>`;
      } else {
        htmlContent = `
          <span class="lbl-main-orders" style="font-size:${fontHaPx}px">${metricText}</span>
          <span class="lbl-sub-metric" style="font-size:${fontSubPx}px">${h.orders.toLocaleString()} ord</span>
        `;
      }
    }

    const icon = L.divIcon({
      className: 'leaflet-hex-label',
      html: htmlContent,
      iconSize: [boxWPx, boxHPx],
      iconAnchor: [anchorX, anchorY]
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

// Filter hexagons by breach rate, mean duration, city HA share, or biker fare and orders slider
function filterHexagons() {
  const isHa = state.colorMetric === 'ha';
  const isMean = state.colorMetric === 'mean';
  const isFare = state.colorMetric === 'fare';

  state.polygons.forEach(item => {
    let passesMetric = true;
    if (isHa) {
      passesMetric = item.h.pct >= state.minBreachFilter;
    } else if (isMean) {
      passesMetric = item.h.mean >= (state.minMeanFilter || 0);
    } else if (isFare) {
      passesMetric = (item.h.avg_fare || 0) >= (state.minFareFilter || 0);
    } else {
      passesMetric = getHexSharePct(item.h) >= (state.minShareFilter || 0);
    }
    const isVisible = passesMetric && (item.h.orders >= state.minOrdersFilter);
    const isSelected = state.selectedHexes.has(item.h.hex);

    if (isVisible) {
      item.polygon.setStyle({
        fillOpacity: state.opacity,
        opacity: 1,
        weight: isSelected ? 2.5 : 1.2,
        color: isSelected ? '#000000' : '#ffffff'
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
  } else if (state.colorMetric === 'mean') {
    titleEl.textContent = `Mean Accept Duration (minutes)`;
    subEl.textContent = `Average time from order creation to courier accept`;
    minEl.textContent = `${s.mmin.toFixed(0)} min (Fastest)`;
    maxEl.textContent = `${s.mmax.toFixed(0)} min (Slowest)`;
  } else if (state.colorMetric === 'fare') {
    titleEl.textContent = `Mean Biker Fare & Incentive`;
    subEl.textContent = `Mean final biker fare and incentive per order in cell`;
    minEl.textContent = `${formatFare(s.fmin || 0)} (Lowest)`;
    maxEl.textContent = `${formatFare(s.fmax || 60000)} (Highest)`;
  } else {
    titleEl.textContent = `Citywide HA${state.threshold}% Order Share`;
    subEl.textContent = `Percentage of whole city's hyper act orders`;
    minEl.textContent = `0.0% (Low Share)`;
    const smaxVal = s.smax || 5.0;
    maxEl.textContent = `${smaxVal.toFixed(1)}% (High Share)`;
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
  const badge = document.getElementById('tabHotspotBadge');
  if (badge) {
    if (bottlenecks && bottlenecks.length > 0) {
      badge.textContent = bottlenecks.length;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  if (!container) return;
  if (!bottlenecks || bottlenecks.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:#94a3b8;padding:8px">No critical bottlenecks detected.</div>';
    return;
  }

  // Rank bottlenecks by share of hyperact orders in city (highest city HA share first)
  const sorted = [...bottlenecks].sort((a, b) => {
    const shareA = getHexSharePct(a);
    const shareB = getHexSharePct(b);
    if (shareB !== shareA) return shareB - shareA;
    if ((b.slow || 0) !== (a.slow || 0)) return (b.slow || 0) - (a.slow || 0);
    return (b.orders || 0) - (a.orders || 0);
  });

  const thresh = state.threshold || 30;

  container.innerHTML = sorted.map((b, i) => {
    const sharePct = getHexSharePct(b);
    return `
      <div class="bottleneck-row" onclick="flyToHexagon('${b.hex}', [${b.center[0]}, ${b.center[1]}])">
        <div style="min-width:0;flex:1">
          <div style="font-weight:700">#${i + 1} ${b.hex.substring(0, 8)}...</div>
          <div style="font-size:9.5px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${(b.orders || 0).toLocaleString()} orders &bull; ${(b.slow || 0).toLocaleString()} HA${thresh} &bull; ${b.mean ? b.mean.toFixed(1) : 0}m avg</div>
        </div>
        <div style="font-weight:800;font-size:12.5px;color:#dc2626;margin-left:8px;flex-shrink:0" title="${sharePct.toFixed(1)}% share of whole city HA${thresh} orders">${sharePct.toFixed(1)}%</div>
      </div>
    `;
  }).join('');
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

  const modalAvgVendors = document.getElementById('modalCityAvgVendorsPerBiker');
  if (modalAvgVendors) {
    const rawVal = kpis.avg_vendors_per_biker !== undefined ? kpis.avg_vendors_per_biker : null;
    const numVal = Number(rawVal);
    modalAvgVendors.textContent = (!isNaN(numVal) && numVal > 0) ? `${numVal.toFixed(1)} vendors` : '-';
  }

  const modalAvgFare = document.getElementById('modalCityAvgFare');
  if (modalAvgFare) {
    const rawFare = kpis.avg_biker_fare !== undefined ? kpis.avg_biker_fare : 0;
    modalAvgFare.textContent = `${formatFareFull(rawFare)} Toman`;
  }
  const modalAvgInc = document.getElementById('modalCityAvgIncentive');
  if (modalAvgInc) {
    const rawInc = kpis.avg_incentive !== undefined ? kpis.avg_incentive : 0;
    modalAvgInc.textContent = `+${formatFareFull(rawInc)} Toman`;
  }

  // Daily Table
  const tbody = document.getElementById('modalDailyTableBody');
  if (state.dailyStats && state.dailyStats.length > 0) {
    tbody.innerHTML = state.dailyStats.map(d => {
      const isSelected = state.selectedDates.includes(d.date);
      const rowStyle = isSelected ? '' : 'opacity:0.4;background:#f8fafc';
      const color = d.pct > 35 ? '#dc2626' : d.pct > 20 ? '#d97706' : '#16a34a';
      const rawAvg = d.avg_vendors_per_biker !== undefined ? d.avg_vendors_per_biker : null;
      const numAvg = Number(rawAvg);
      const avgStr = (!isNaN(numAvg) && numAvg > 0) ? numAvg.toFixed(1) : '-';
      const fareStr = d.avg_fare ? `${formatFareFull(d.avg_fare)}` : '-';
      const incStr = d.avg_incentive ? `+${formatFareFull(d.avg_incentive)}` : '-';
      return `
        <tr style="${rowStyle};border-bottom:1px solid #f1f5f9">
          <td style="padding:5px 8px;font-weight:600">${d.label} ${isSelected ? '' : '<span style="font-size:9px;color:#94a3b8">(excluded)</span>'}</td>
          <td style="padding:5px 8px">${d.orders.toLocaleString()}</td>
          <td style="padding:5px 8px;color:#dc2626">${(d.ha30_count !== undefined ? d.ha30_count : (d.slow || 0)).toLocaleString()}</td>
          <td style="padding:5px 8px;font-weight:700;color:${color}">${d.pct.toFixed(1)}%</td>
          <td style="padding:5px 8px">${d.mean.toFixed(1)} min</td>
          <td style="padding:5px 8px;font-weight:600;color:#2563eb">${avgStr}</td>
          <td style="padding:5px 8px;font-weight:600;color:#0f172a">${fareStr}</td>
          <td style="padding:5px 8px;font-weight:600;color:#059669">${incStr}</td>
        </tr>
      `;
    }).join('');
  } else {
    tbody.innerHTML = '<tr><td colspan="8" style="padding:8px;text-align:center;color:#94a3b8">No daily records available</td></tr>';
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
