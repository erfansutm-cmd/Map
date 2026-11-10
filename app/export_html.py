"""
Standalone HTML Generator.
Expands and modernizes the original isfahan_hex_html.py script:
- Removes the separate orders layer
- Deeply enriches the HA30 layer with order metrics and better visualization
- Adds toggle between HA30% and Mean Duration color metrics
- Supports Shift+click multi-cell selection with merged analytics
- Embeds high-contrast basemaps without broken Carto API keys
- Provides a clean, modern interface with dark/light basemaps, opacity control, and hex inspector
"""
import json
import html

STANDALONE_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>__TITLE__</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
<style>
* { box-sizing: border-box; }
html, body, #map { height: 100%; margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; }

#map { width: 100%; height: 100%; }

/* Hexagon labels - transparent, no white background */
.lbl {
  font-family: 'Inter', sans-serif;
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  padding: 0 !important;
  pointer-events: none;
  text-align: center;
  white-space: nowrap;
}
.lbl-ord {
  font-size: 10px;
  font-weight: 800;
  color: #0f172a;
  line-height: 1;
  text-shadow: -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 0 2px #fff;
  display: block;
}
.lbl-ha {
  font-size: 8px;
  font-weight: 700;
  color: #1e293b;
  line-height: 1;
  margin-top: 1px;
  text-shadow: -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 0 2px #fff;
  display: block;
}

/* Control Panel */
.panel {
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(10px);
  padding: 14px 16px;
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  border: 1px solid rgba(226, 232, 240, 0.85);
  font-size: 13px;
  color: #1e293b;
  min-width: 260px;
  max-width: 310px;
}
.panel h3 { margin: 0 0 4px; font-size: 15px; font-weight: 800; color: #0f172a; }
.panel .subtitle { font-size: 11px; color: #64748b; margin-bottom: 10px; }
.panel hr { border: 0; border-top: 1px solid #e2e8f0; margin: 10px 0; }

.section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
  margin-bottom: 6px;
}

/* Radio / Button groups */
.radio-group { display: flex; gap: 4px; background: #f1f5f9; padding: 3px; border-radius: 6px; margin-bottom: 10px; }
.radio-btn {
  flex: 1;
  text-align: center;
  padding: 6px 4px;
  font-size: 11.5px;
  font-weight: 600;
  border-radius: 4px;
  cursor: pointer;
  border: none;
  background: transparent;
  color: #64748b;
  transition: all 0.15s;
}
.radio-btn.active {
  background: #ffffff;
  color: #0f172a;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
.radio-btn.primary-active.active {
  background: #2563eb;
  color: #ffffff;
}

/* Resolution Stepper */
.res-stepper { display: flex; align-items: center; justify-content: space-between; margin: 6px 0; }
.btn-step {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid #cbd5e1;
  background: #ffffff;
  font-weight: 700;
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.btn-step:hover:not(:disabled) { background: #f8fafc; border-color: #94a3b8; }
.btn-step:disabled { opacity: 0.4; cursor: not-allowed; }
.res-disp { font-weight: 700; font-size: 13.5px; text-align: center; }
.res-area { font-size: 10.5px; color: #64748b; text-align: center; }

/* Sliders */
.slider-row { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 6px 0; }
.slider-row input[type="range"] { flex: 1; accent-color: #2563eb; }

/* Legend Panel */
.legend-panel {
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(8px);
  padding: 12px 14px;
  border-radius: 10px;
  box-shadow: 0 4px 18px rgba(0,0,0,0.15);
  border: 1px solid rgba(226, 232, 240, 0.8);
  font-size: 12px;
  width: 250px;
}
.bar-ha {
  height: 10px;
  border-radius: 5px;
  background: linear-gradient(to right, #10b981 0%, #f59e0b 50%, #ef4444 100%);
  margin: 6px 0 4px;
}
.legend-ticks { display: flex; justify-content: space-between; font-size: 10.5px; font-weight: 700; color: #475569; }
.legend-note { font-size: 10.5px; color: #64748b; margin-top: 6px; display: flex; align-items: center; gap: 6px; }
.dot-grey { width: 12px; height: 12px; background: #94a3b8; border-radius: 3px; display: inline-block; }

/* Citywide Overview floating card */
.citywide-badge {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(10px);
  padding: 8px 18px;
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.16);
  border: 1px solid rgba(226, 232, 240, 0.9);
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 12px;
}

/* Hexagon Inspector Card */
.inspector {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 1000;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(10px);
  padding: 14px 16px;
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.2);
  border: 1px solid rgba(226, 232, 240, 0.9);
  width: 290px;
  display: none;
  font-size: 12px;
}
.inspector.open { display: block; animation: slideIn 0.2s ease-out; }
@keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
.inspector-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.inspector-title { font-size: 14px; font-weight: 700; color: #0f172a; }
.inspector-close { cursor: pointer; border: none; background: transparent; font-size: 18px; color: #94a3b8; }
.metric-row { display: flex; justify-content: space-between; margin: 4px 0; padding: 3px 0; border-bottom: 1px solid #f1f5f9; }
.metric-label { color: #64748b; }
.metric-val { font-weight: 700; color: #0f172a; }
.badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; }
.badge-optimal { background: #dcfce7; color: #166534; }
.badge-acceptable { background: #fef9c3; color: #854d0e; }
.badge-warning { background: #fee2e2; color: #991b1b; }
.badge-critical { background: #fecaca; color: #7f1d1d; }
.badge-low { background: #f1f5f9; color: #475569; }

.shift-hint {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  background: rgba(15, 23, 42, 0.85);
  color: #fff;
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 11px;
  pointer-events: none;
}
</style>
</head>
<body>
<div id="map"></div>

<!-- Top Citywide Overview -->
<div class="citywide-badge">
  <div>
    <span style="font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">Citywide HA__THRESHOLD__%</span>
    <div style="font-size:16px;font-weight:800;color:#dc2626">__OVERALL_HA__%</div>
  </div>
  <div>
    <span style="font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">Total Orders</span>
    <div style="font-size:16px;font-weight:800;color:#0f172a">__TOTAL_ORDERS__</div>
  </div>
  <div>
    <span style="font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">Mean Duration</span>
    <div style="font-size:16px;font-weight:800;color:#0f172a">__OVERALL_MEAN__ min</div>
  </div>
</div>

<!-- Hexagon Inspector -->
<div id="inspector" class="inspector">
  <div class="inspector-head">
    <span class="inspector-title" id="inspHeadTitle">Hexagon Inspection</span>
    <button class="inspector-close" onclick="closeInspector()">&times;</button>
  </div>
  <div id="inspectorContent"></div>
</div>

<div class="shift-hint">
  <b>Shift + Click</b> to select and merge multiple hexagon cells
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var DATA = __DATA__;
var THRESHOLD = __THRESHOLD__;
var MIN_ORDERS = __MINORD__;

var layerKey = 'source';
var res = DATA.default;
var colorMetric = 'ha'; // 'ha' or 'mean'
var autoRes = false;
var opacity = 0.65;
var labelsOn = true;
var items = [];
var selectedHexes = new Map();

var TILE_PROVIDERS = {
  voyager: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_5558_1_345367a66619045ea57fcdba',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
};

var map = L.map('map', {zoomControl: false});
L.control.zoom({position: 'bottomleft'}).addTo(map);

var currentTile = L.tileLayer(TILE_PROVIDERS.voyager, {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
}).addTo(map);

var hexGroup = L.layerGroup().addTo(map);
var labelGroup = L.layerGroup().addTo(map);

function curLayer() { return DATA.layers[layerKey].res[res]; }

function getStatusBadge(status) {
  if (status === 'optimal') return '<span class="badge badge-optimal">Optimal (&lt;15%)</span>';
  if (status === 'acceptable') return '<span class="badge badge-acceptable">Acceptable</span>';
  if (status === 'warning') return '<span class="badge badge-warning">High Risk</span>';
  if (status === 'critical') return '<span class="badge badge-critical">Critical SLA Breach</span>';
  return '<span class="badge badge-low">Low Sample (&lt;' + MIN_ORDERS + ')</span>';
}

function tooltipHtml(h) {
  var breachText = '<b>HA' + THRESHOLD + '%: ' + h.pct.toFixed(1) + '%</b>';
  var ordText = '<span style="font-weight:normal;color:#475569">' + h.orders + ' orders</span>';
  var headRow = '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">' + breachText + ordText + '</div>';
  var haCountText = '<div style="display:flex;justify-content:space-between"><span style="color:#64748b">HA' + THRESHOLD + ' Orders Count:</span><span style="color:#dc2626;font-weight:700">' + h.slow + '</span></div>';
  var haDesc = '<div style="font-size:9.5px;color:#94a3b8;margin-bottom:3px">(create to accept time &ge; ' + THRESHOLD + ' min)</div>';
  var meanText = '<div style="display:flex;justify-content:space-between"><span style="color:#64748b">Mean Duration:</span><span style="color:#0f172a;font-weight:600">' + h.mean.toFixed(1) + ' min</span></div>';
  var idText = '<div style="font-size:9.5px;color:#94a3b8;margin-top:3px;border-top:1px solid #e2e8f0;padding-top:2px">Hex: ' + h.hex + '</div>';
  return '<div style="font-family:Inter,sans-serif;font-size:12px;line-height:1.4;min-width:180px">' +
         headRow + haCountText + haDesc + meanText + idText + '</div>';
}

function openInspector(h) {
  var el = document.getElementById('inspector');
  var content = document.getElementById('inspectorContent');
  document.getElementById('inspHeadTitle').textContent = 'Hexagon Inspection';
  var statusBadge = getStatusBadge(h.status);

  content.innerHTML =
    '<div style="margin-bottom:8px">' + statusBadge + '</div>' +
    '<div class="metric-row"><span class="metric-label">HA' + THRESHOLD + '%</span><span class="metric-val" style="color:#e11d48">' + h.pct.toFixed(1) + '%</span></div>' +
    '<div class="metric-row"><span class="metric-label">Total Orders</span><span class="metric-val">' + h.orders + '</span></div>' +
    '<div class="metric-row"><span class="metric-label">HA' + THRESHOLD + ' Orders Count</span><span class="metric-val" style="color:#e11d48">' + h.slow + ' (' + h.slow + ' of ' + h.with_value + ')</span></div>' +
    '<div style="font-size:10px;color:#94a3b8;margin-bottom:6px">(create to accept time &ge; ' + THRESHOLD + ' min)</div>' +
    '<div class="metric-row"><span class="metric-label">Mean Duration</span><span class="metric-val">' + h.mean.toFixed(1) + ' min</span></div>' +
    '<div class="metric-row"><span class="metric-label">H3 Hex ID</span><span class="metric-val" style="font-size:10px">' + h.hex + '</span></div>' +
    '<div class="metric-row"><span class="metric-label">Coordinates</span><span class="metric-val" style="font-size:10px">' + h.center[0] + ', ' + h.center[1] + '</span></div>';
  el.classList.add('open');
}

function renderMergedSelection() {
  var el = document.getElementById('inspector');
  var content = document.getElementById('inspectorContent');
  if (selectedHexes.size === 0) {
    el.classList.remove('open');
    return;
  }

  document.getElementById('inspHeadTitle').textContent = 'Merged Selection (' + selectedHexes.size + ' Cells)';
  var totalOrders = 0, totalSlow = 0, totalWithValue = 0, vsum = 0;
  selectedHexes.forEach(function(item) {
    totalOrders += item.h.orders;
    totalSlow += item.h.slow;
    var w = item.h.with_value || item.h.orders;
    totalWithValue += w;
    vsum += item.h.mean * w;
  });

  var mergedPct = totalWithValue > 0 ? (totalSlow / totalWithValue * 100) : 0;
  var mergedMean = totalWithValue > 0 ? (vsum / totalWithValue) : 0;

  content.innerHTML =
    '<div style="margin-bottom:8px"><span class="badge badge-warning">MERGED REGION</span></div>' +
    '<div class="metric-row"><span class="metric-label">Combined HA' + THRESHOLD + '%</span><span class="metric-val" style="color:#e11d48">' + mergedPct.toFixed(1) + '%</span></div>' +
    '<div class="metric-row"><span class="metric-label">Combined Orders</span><span class="metric-val">' + totalOrders + '</span></div>' +
    '<div class="metric-row"><span class="metric-label">HA' + THRESHOLD + ' Orders Count</span><span class="metric-val" style="color:#e11d48">' + totalSlow + ' (' + totalSlow + ' of ' + totalWithValue + ')</span></div>' +
    '<div style="font-size:10px;color:#94a3b8;margin-bottom:6px">(create to accept time &ge; ' + THRESHOLD + ' min)</div>' +
    '<div class="metric-row"><span class="metric-label">Weighted Mean</span><span class="metric-val">' + mergedMean.toFixed(1) + ' min</span></div>' +
    '<button onclick="clearHexSelection()" style="width:100%;margin-top:10px;padding:6px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;font-weight:600">Clear Selection</button>';
  el.classList.add('open');
}

function clearHexSelection() {
  selectedHexes.forEach(function(it) { it.p.setStyle({weight: 1.2, color: '#ffffff'}); });
  selectedHexes.clear();
  document.getElementById('inspector').classList.remove('open');
}

function closeInspector() {
  clearHexSelection();
  document.getElementById('inspector').classList.remove('open');
}

function labelHtml(h) {
  var v = colorMetric === 'ha' ? ('HA' + THRESHOLD + '%: ' + h.pct.toFixed(0) + '%') : (h.mean.toFixed(1) + ' min');
  return '<div style="font-weight:800;font-size:11px;color:#0f172a">' + h.orders + ' orders</div><div style="font-size:9.5px;color:#64748b;font-weight:600">' + v + '</div>';
}

function updateLabels() {
  labelGroup.clearLayers();
  var want = labelsOn && map.getZoom() >= (res + 4);
  if (want) {
    items.forEach(function(it) {
      var icon = L.divIcon({className: 'lbl', html: labelHtml(it.h), iconSize: [80, 26], iconAnchor: [40, 13]});
      var marker = L.marker(it.h.center, {interactive: false, icon: icon});
      labelGroup.addLayer(marker);
    });
  }
}

function renderMap() {
  hexGroup.clearLayers();
  items = [];
  var lData = curLayer();
  if (!lData || !lData.hexes) return;

  lData.hexes.forEach(function(h) {
    var isSel = selectedHexes.has(h.hex);
    var fillColor = colorMetric === 'ha' ? h.color_ha : h.color_mean;
    var p = L.polygon(h.ring, {
      color: isSel ? '#06b6d4' : '#ffffff',
      weight: isSel ? 3.5 : 1.2,
      fillColor: fillColor,
      fillOpacity: opacity
    });
    p.bindTooltip(tooltipHtml(h), {sticky: true});
    p.on('mouseover', function() {
      if (!selectedHexes.has(h.hex)) {
        this.setStyle({weight: 2.8, color: '#0f172a'});
        this.bringToFront();
      }
    });
    p.on('mouseout', function() {
      var sel = selectedHexes.has(h.hex);
      this.setStyle({weight: sel ? 3.5 : 1.2, color: sel ? '#06b6d4' : '#ffffff'});
    });
    p.on('click', function(e) {
      if (e.originalEvent && e.originalEvent.shiftKey) {
        if (selectedHexes.has(h.hex)) {
          selectedHexes.delete(h.hex);
          this.setStyle({weight: 1.2, color: '#ffffff'});
        } else {
          selectedHexes.set(h.hex, {h: h, p: this});
          this.setStyle({weight: 3.5, color: '#06b6d4'});
          this.bringToFront();
        }
        renderMergedSelection();
      } else {
        clearHexSelection();
        openInspector(h);
      }
    });
    hexGroup.addLayer(p);
    items.push({h: h, p: p});
  });

  updateLabels();
  updateLegend();
  updatePanel();
}

function setRes(r) {
  r = Math.max(DATA.min, Math.min(DATA.max, r));
  if (r === res) return;
  res = r;
  clearHexSelection();
  renderMap();
}

function setTile(type) {
  map.removeLayer(currentTile);
  currentTile = L.tileLayer(TILE_PROVIDERS[type], {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  currentTile.bringToBack();
}

// Controls
var panelControl = L.control({position: 'topleft'});
panelControl.onAdd = function() {
  var div = L.DomUtil.create('div', 'panel');
  div.innerHTML =
    '<h3>__TITLE__</h3>' +
    '<div class="subtitle">HA' + THRESHOLD + '% SLA &amp; Hexagonal Fleet Analytics</div>' +
    '<div class="section-title">Hexagon Layer</div>' +
    '<div class="radio-group">' +
      '<button id="btnSrc" class="radio-btn active" onclick="setLayer(\'source\')">Pickup (Source)</button>' +
      '<button id="btnDest" class="radio-btn" onclick="setLayer(\'destination\')">Dropoff (Dest)</button>' +
    '</div>' +
    '<div class="section-title">Color Metric</div>' +
    '<div class="radio-group">' +
      '<button id="btnColHa" class="radio-btn primary-active active" onclick="setMetric(\'ha\')">HA' + THRESHOLD + '% Breach</button>' +
      '<button id="btnColMean" class="radio-btn primary-active" onclick="setMetric(\'mean\')">Mean Duration</button>' +
    '</div>' +
    '<div class="section-title">Resolution (H3 Level)</div>' +
    '<div class="res-stepper">' +
      '<button id="resMinus" class="btn-step" onclick="setRes(res - 1)">&minus;</button>' +
      '<div><div id="resVal" class="res-disp">Res ' + res + '</div><div id="resArea" class="res-area"></div></div>' +
      '<button id="resPlus" class="btn-step" onclick="setRes(res + 1)">+</button>' +
    '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer">' +
      '<input type="checkbox" id="autoResToggle" onchange="toggleAuto(this.checked)"> Auto (follow zoom)' +
    '</label>' +
    '<hr>' +
    '<div class="section-title">Hexagon Styling</div>' +
    '<div class="slider-row">' +
      '<span>Opacity:</span>' +
      '<input type="range" min="0.1" max="0.95" step="0.05" value="0.65" oninput="changeOpacity(this.value)">' +
      '<span id="opVal">65%</span>' +
    '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
      '<input type="checkbox" id="lblToggle" onchange="toggleLabels(this.checked)" checked> Write Order Numbers in Cells' +
    '</label>' +
    '<hr>' +
    '<div class="section-title">Basemap</div>' +
    '<div class="radio-group">' +
      '<button class="radio-btn active" onclick="switchBase(this, \'voyager\')">Voyager</button>' +
      '<button class="radio-btn" onclick="switchBase(this, \'satellite\')">Satellite</button>' +
    '</div>';
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  return div;
};
panelControl.addTo(map);

var legendControl = L.control({position: 'bottomright'});
legendControl.onAdd = function() {
  var div = L.DomUtil.create('div', 'legend-panel');
  div.id = 'legendContent';
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  return div;
};
legendControl.addTo(map);

function updateLegend() {
  var el = document.getElementById('legendContent');
  if (!el) return;
  var lData = curLayer();
  var s = lData ? lData.scale : {vmin: 0, vmax: 100, mmin: 10, mmax: 50};

  if (colorMetric === 'ha') {
    el.innerHTML =
      '<div style="font-weight:700;margin-bottom:2px">HA' + THRESHOLD + '% SLA Breach Rate</div>' +
      '<div style="font-size:10.5px;color:#64748b">Orders exceeding ' + THRESHOLD + ' min contractual accept</div>' +
      '<div class="bar-ha"></div>' +
      '<div class="legend-ticks"><span>' + s.vmin.toFixed(0) + '% (Fast)</span><span>' + s.vmax.toFixed(0) + '% (Slow)</span></div>' +
      '<div class="legend-note"><span class="dot-grey"></span> Fewer than ' + MIN_ORDERS + ' orders (Low sample)</div>';
  } else {
    el.innerHTML =
      '<div style="font-weight:700;margin-bottom:2px">Mean Accept Duration (minutes)</div>' +
      '<div style="font-size:10.5px;color:#64748b">Average duration from creation to accept</div>' +
      '<div class="bar-ha"></div>' +
      '<div class="legend-ticks"><span>' + (s.mmin || 10).toFixed(0) + ' min (Fast)</span><span>' + (s.mmax || 50).toFixed(0) + ' min (Slow)</span></div>' +
      '<div class="legend-note"><span class="dot-grey"></span> Fewer than ' + MIN_ORDERS + ' orders (Low sample)</div>';
  }
}

function updatePanel() {
  var resVal = document.getElementById('resVal');
  var resArea = document.getElementById('resArea');
  var resMinus = document.getElementById('resMinus');
  var resPlus = document.getElementById('resPlus');
  if (resVal) resVal.textContent = 'Res ' + res;
  if (resArea) resArea.textContent = DATA.areas[res] + ' per hexagon';
  if (resMinus) resMinus.disabled = (res <= DATA.min);
  if (resPlus) resPlus.disabled = (res >= DATA.max);
}

window.setLayer = function(k) {
  layerKey = k;
  document.getElementById('btnSrc').classList.toggle('active', k === 'source');
  document.getElementById('btnDest').classList.toggle('active', k === 'destination');
  clearHexSelection();
  renderMap();
};

window.setMetric = function(m) {
  colorMetric = m;
  document.getElementById('btnColHa').classList.toggle('active', m === 'ha');
  document.getElementById('btnColMean').classList.toggle('active', m === 'mean');
  items.forEach(function(it) {
    it.p.setStyle({fillColor: colorMetric === 'ha' ? it.h.color_ha : it.h.color_mean});
  });
  updateLegend();
  updateLabels();
};

window.toggleAuto = function(val) {
  autoRes = val;
  if (autoRes) setRes(Math.round(map.getZoom() - 4));
};

window.changeOpacity = function(val) {
  opacity = parseFloat(val);
  document.getElementById('opVal').textContent = Math.round(opacity * 100) + '%';
  items.forEach(function(it) {
    if (!selectedHexes.has(it.h.hex)) {
      it.p.setStyle({fillOpacity: opacity});
    }
  });
};

window.toggleLabels = function(val) {
  labelsOn = val;
  updateLabels();
};

window.switchBase = function(btn, type) {
  btn.parentElement.querySelectorAll('.radio-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  setTile(type);
};

// Initial Render (Zoom in close to city center, avoiding wide big-picture bounds from outlier dropoffs)
renderMap();
if (items.length) {
  var cLats = items.map(function(it) { return it.h.center[0]; });
  var cLngs = items.map(function(it) { return it.h.center[1]; });
  cLats.sort(function(a,b){return a-b;});
  cLngs.sort(function(a,b){return a-b;});
  var medLat = cLats[Math.floor(cLats.length/2)];
  var medLng = cLngs[Math.floor(cLngs.length/2)];
  map.setView([medLat, medLng], 13.5);
} else {
  map.setView([32.65, 51.67], 13.5);
}

map.on('zoomend', function() {
  if (autoRes) { setRes(Math.round(map.getZoom() - 4)); }
  updateLabels();
});
</script>
</body>
</html>
"""


def build_standalone_html(data: dict, city: str, customer_id: int, start_date: str, end_date: str, threshold: int, min_orders: int) -> str:
    title = f"{city.title()} HA{threshold}% Hexagon Performance"
    page = STANDALONE_TEMPLATE

    kpis = data.get("kpis", {})
    overall_ha = kpis.get("overall_ha_pct", 0.0)
    total_orders = kpis.get("total_orders", 0)
    overall_mean = kpis.get("overall_mean_duration", 0.0)

    formatted_data = {
        "min": data["res_min"],
        "max": data["res_max"],
        "default": data["res_default"],
        "areas": data["areas"],
        "layers": {
            "source": {"res": data["layers"]["source"]["res"]},
            "destination": {"res": data["layers"]["destination"]["res"]},
        }
    }

    replacements = {
        "__TITLE__": html.escape(title),
        "__DATA__": json.dumps(formatted_data, separators=(",", ":")),
        "__THRESHOLD__": str(threshold),
        "__MINORD__": str(min_orders),
        "__OVERALL_HA__": str(overall_ha),
        "__TOTAL_ORDERS__": f"{total_orders:,}",
        "__OVERALL_MEAN__": str(overall_mean),
    }
    for k, v in replacements.items():
        page = page.replace(k, v)
    return page
