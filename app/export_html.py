"""
Standalone HTML Generator.
Expands and modernizes the original isfahan_hex_html.py script:
- Removes the separate orders layer
- Deeply enriches the HA30 layer with order metrics and better visualization
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
* { box-sizing: border-box; }
html, body, #map { height: 100%; margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; }

/* Map & Overlays */
#map { width: 100%; height: 100%; }

/* Hexagon labels */
.lbl {
  font: 600 11px/1.2 'Inter', sans-serif;
  color: #0f172a;
  text-align: center;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.92);
  padding: 3px 6px;
  border-radius: 4px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.25);
  pointer-events: none;
  border: 1px solid rgba(0,0,0,0.1);
}
.lbl-ha { font-weight: 700; color: #1e293b; }
.lbl-ord { font-size: 9.5px; color: #64748b; }

/* Control Panel */
.panel {
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(8px);
  padding: 14px 16px;
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  border: 1px solid rgba(226, 232, 240, 0.8);
  font-size: 13px;
  color: #1e293b;
  min-width: 250px;
  max-width: 310px;
}
.panel h3 { margin: 0 0 6px; font-size: 15px; font-weight: 700; color: #0f172a; }
.panel .subtitle { font-size: 11px; color: #64748b; margin-bottom: 12px; }
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

/* Resolution Stepper */
.res-stepper { display: flex; align-items: center; justify-content: space-between; margin: 6px 0; }
.btn-step {
  width: 32px;
  height: 32px;
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
.res-disp { font-weight: 700; font-size: 14px; text-align: center; }
.res-area { font-size: 11px; color: #64748b; text-align: center; }

/* Sliders */
.slider-row { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 6px 0; }
.slider-row input[type="range"] { flex: 1; }

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
  background: linear-gradient(to right, #2ecc71, #f1c40f, #e74c3c);
  margin: 6px 0 4px;
}
.legend-ticks { display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; color: #475569; }
.legend-note { font-size: 11px; color: #64748b; margin-top: 6px; display: flex; align-items: center; gap: 6px; }
.dot-grey { width: 12px; height: 12px; background: #94a3b8; border-radius: 3px; display: inline-block; }

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
  width: 280px;
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
</style>
</head>
<body>
<div id="map"></div>

<!-- Hexagon Inspector -->
<div id="inspector" class="inspector">
  <div class="inspector-head">
    <span class="inspector-title">Hexagon Inspection</span>
    <button class="inspector-close" onclick="closeInspector()">&times;</button>
  </div>
  <div id="inspectorContent"></div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var DATA = __DATA__;
var THRESHOLD = __THRESHOLD__;
var MIN_ORDERS = __MINORD__;
var LABEL_OFFSET = __LOFF__;

var layerKey = 'source';
var res = DATA.default;
var autoRes = false;
var opacity = 0.65;
var labelsOn = false;
var items = [];

// Clean tile providers (No API key expiration bugs)
var TILE_PROVIDERS = {
  voyager: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  positron: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
};

var map = L.map('map', {zoomControl: false});
L.control.zoom({position: 'topright'}).addTo(map);

var currentTile = L.tileLayer(TILE_PROVIDERS.voyager, {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

var hexGroup = L.layerGroup().addTo(map);
var labelGroup = L.layerGroup().addTo(map);

function curLayer() { return DATA.layers[layerKey].res[res]; }

function getStatusBadge(status, pct) {
  if (status === 'optimal') return '<span class="badge badge-optimal">Optimal (&lt;15%)</span>';
  if (status === 'acceptable') return '<span class="badge badge-acceptable">Acceptable</span>';
  if (status === 'warning') return '<span class="badge badge-warning">High Risk</span>';
  if (status === 'critical') return '<span class="badge badge-critical">Critical SLA Breach</span>';
  return '<span class="badge badge-low">Low Sample (&lt;' + MIN_ORDERS + ')</span>';
}

function tooltipHtml(h) {
  var breachText = '<b>HA' + THRESHOLD + '%: ' + h.pct.toFixed(1) + '%</b> (' + h.slow + ' slow of ' + h.with_value + ')';
  var ordText = 'Total Orders: <b>' + h.orders + '</b>';
  var meanText = 'Mean Duration: <b>' + h.mean.toFixed(1) + 's</b>';
  var idText = '<span style="font-size:10px;color:#94a3b8">Hex: ' + h.hex + '</span>';
  return '<div style="font-family:Inter,sans-serif;font-size:12px;line-height:1.4">' +
         breachText + '<br>' + ordText + '<br>' + meanText + '<br>' + idText + '</div>';
}

function openInspector(h) {
  var el = document.getElementById('inspector');
  var content = document.getElementById('inspectorContent');
  var fast = h.with_value - h.slow;
  var statusBadge = getStatusBadge(h.status, h.pct);
  
  content.innerHTML =
    '<div style="margin-bottom:8px">' + statusBadge + '</div>' +
    '<div class="metric-row"><span class="metric-label">HA' + THRESHOLD + '% Breach Rate</span><span class="metric-val" style="color:#e11d48">' + h.pct.toFixed(1) + '%</span></div>' +
    '<div class="metric-row"><span class="metric-label">Total Orders</span><span class="metric-val">' + h.orders + '</span></div>' +
    '<div class="metric-row"><span class="metric-label">Slow Orders (&ge;' + THRESHOLD + 's)</span><span class="metric-val">' + h.slow + '</span></div>' +
    '<div class="metric-row"><span class="metric-label">Fast Orders (&lt;' + THRESHOLD + 's)</span><span class="metric-val">' + fast + '</span></div>' +
    '<div class="metric-row"><span class="metric-label">Mean Duration</span><span class="metric-val">' + h.mean.toFixed(1) + 's</span></div>' +
    '<div class="metric-row"><span class="metric-label">H3 Hex ID</span><span class="metric-val" style="font-size:10px">' + h.hex + '</span></div>' +
    '<div class="metric-row"><span class="metric-label">Coordinates</span><span class="metric-val" style="font-size:10px">' + h.center[0] + ', ' + h.center[1] + '</span></div>';
  el.classList.add('open');
}

function closeInspector() {
  document.getElementById('inspector').classList.remove('open');
}

function labelHtml(h) {
  return '<div class="lbl-ha">HA' + THRESHOLD + ': ' + h.pct.toFixed(0) + '%</div><div class="lbl-ord">' + h.orders + ' orders</div>';
}

function updateLabels() {
  labelGroup.clearLayers();
  var want = labelsOn && map.getZoom() >= (res + 4);
  if (want) {
    items.forEach(function(it) {
      var icon = L.divIcon({className: 'lbl', html: labelHtml(it.h), iconSize: [84, 28], iconAnchor: [42, 14]});
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
    var p = L.polygon(h.ring, {
      color: '#ffffff',
      weight: 1.2,
      fillColor: h.color,
      fillOpacity: opacity
    });
    p.bindTooltip(tooltipHtml(h), {sticky: true});
    p.on('mouseover', function() {
      this.setStyle({weight: 2.8, color: '#0f172a'});
      this.bringToFront();
    });
    p.on('mouseout', function() {
      this.setStyle({weight: 1.2, color: '#ffffff'});
    });
    p.on('click', function() {
      openInspector(h);
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
      '<input type="checkbox" id="lblToggle" onchange="toggleLabels(this.checked)"> Show Values on Hexagons' +
    '</label>' +
    '<hr>' +
    '<div class="section-title">Basemap</div>' +
    '<div class="radio-group">' +
      '<button class="radio-btn active" onclick="switchBase(this, \'voyager\')">Voyager</button>' +
      '<button class="radio-btn" onclick="switchBase(this, \'positron\')">Light</button>' +
      '<button class="radio-btn" onclick="switchBase(this, \'dark\')">Dark</button>' +
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
  var vmin = lData ? lData.scale.vmin : 0;
  var vmax = lData ? lData.scale.vmax : 100;
  el.innerHTML =
    '<div style="font-weight:700;margin-bottom:2px">HA' + THRESHOLD + '% SLA Breach Rate</div>' +
    '<div style="font-size:11px;color:#64748b">Orders exceeding ' + THRESHOLD + 's contractual accept</div>' +
    '<div class="bar-ha"></div>' +
    '<div class="legend-ticks"><span>' + vmin.toFixed(0) + '% (Best)</span><span>' + vmax.toFixed(0) + '% (Worst)</span></div>' +
    '<div class="legend-note"><span class="dot-grey"></span> Fewer than ' + MIN_ORDERS + ' orders (Low sample)</div>';
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
  renderMap();
};

window.toggleAuto = function(val) {
  autoRes = val;
  if (autoRes) setRes(Math.round(map.getZoom() - 4));
};

window.changeOpacity = function(val) {
  opacity = parseFloat(val);
  document.getElementById('opVal').textContent = Math.round(opacity * 100) + '%';
  items.forEach(function(it) { it.p.setStyle({fillOpacity: opacity}); });
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

// Initial Render
renderMap();
if (items.length) {
  map.fitBounds(L.latLngBounds(items.map(function(it) { return it.h.center; })));
} else {
  map.setView([32.65, 51.67], 12);
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
    
    # Format data for embedding
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
        "__LOFF__": "4",
    }
    for k, v in replacements.items():
        page = page.replace(k, v)
    return page
