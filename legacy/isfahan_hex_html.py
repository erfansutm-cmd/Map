"""
Hover map (single self-contained HTML file) of delivered orders per H3 hexagon.

Needs only connect.py next to this file (and: pip install h3 pandas).
Hexagons are built from source / destination latitude and longitude.

On the map you can:
  - switch between source and destination hexagons
  - toggle the color: HA30% (green = best, red = worst) or total orders (grey = few, red = many)
  - increase / decrease the hexagon resolution (or let it follow the zoom: "Auto")
  - hover a hexagon to see its data and ID

Run:   python isfahan_hex_html.py
Open the .html file in a browser.
"""
import html
import json
import math
from datetime import date

import h3
import pandas as pd

import connect  # your existing connect.py

# ----------------------------- settings ------------------------------------
CITY = "isfahan"
STATUS = "DELIVERED"
CUSTOMER_ID = 2
START_DATE = "2026-10-22"   # two weeks before 5 Nov (inclusive)
END_DATE = "2026-11-05"     # inclusive
THRESHOLD = 30              # create_to_accept_contractual >= THRESHOLD counts as slow (column's unit)
RES_MIN, RES_MAX = 6, 10    # resolutions you can switch between on the map (bigger number = smaller hexagons)
RES_DEFAULT = 8             # resolution shown first
MIN_ORDERS = 5              # hexagons with fewer orders are grey in HA30% mode (too few to judge)
LOW_Q, HIGH_Q = 0.05, 0.95  # relative color scales: 5th percentile .. 95th percentile
LABEL_OFFSET = 6            # text inside hexagons appears from zoom = resolution + LABEL_OFFSET
OUT_HTML = f"isfahan_hexagons_{END_DATE.replace('-', '')}.html"

# ----------------------------- map background (needs an API key) -------------
API_KEY = "cb1_5558_1_345367a66619045ea57fcdba"
# Any XYZ raster tile URL works. {key} is replaced by API_KEY; keep {z}/{x}/{y} as they are.
TILE_URL = "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key={key}"
TILE_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO"   # use your provider's text

# ----------------------------- colors --------------------------------------
GREEN, YELLOW, RED = (125, 205, 140), (255, 232, 150), (238, 120, 105)   # HA30%: soft pastel ramp
ORDERS_LOW, ORDERS_HIGH = (222, 222, 222), (226, 70, 62)                 # orders: grey -> red
GREY = (153, 153, 153)

SQL = f"""
SELECT
    order_id,
    source_latitude,
    source_longitude,
    destination_latitude,
    destination_longitude,
    create_to_accept_contractual
FROM dwh_box.fact_ka
WHERE city = '{CITY}'
  AND status = '{STATUS}'
  AND customer_id = {CUSTOMER_ID}
  AND created_date >= toDate('{START_DATE}')
  AND created_date <= toDate('{END_DATE}')
LIMIT 1 BY order_id
"""


# ----------------------------- data ----------------------------------------
def fetch(sql: str) -> pd.DataFrame:
    """
    Adapt THIS function to whatever connect.py exposes.
    It must return a pandas DataFrame.
    Default assumes a clickhouse-connect client named `client` (or get_client()).
    """
    client = connect.get_client() if hasattr(connect, "get_client") else connect.client
    return client.query_df(sql)


def to_cell(lat, lng):
    """Latitude/longitude -> H3 cell at RES_MAX (finest level), or None if missing/invalid."""
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return None
    if math.isnan(lat) or math.isnan(lng) or (lat == 0 and lng == 0):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    return h3.latlng_to_cell(lat, lng, RES_MAX)


def prepare(df: pd.DataFrame, lat_col: str, lng_col: str, label: str) -> pd.DataFrame:
    """Aggregate orders per finest-level hexagon; coarser levels are rolled up from this."""
    d = df.copy()
    d["hex"] = [to_cell(a, b) for a, b in zip(d[lat_col], d[lng_col])]
    skipped = int(d["hex"].isna().sum())
    d = d.dropna(subset=["hex"])
    # plain float column (missing -> NaN); works even if ClickHouse returned a nullable pandas dtype
    v = pd.Series(
        d["create_to_accept_contractual"].to_numpy(dtype="float64", na_value=float("nan")),
        index=d.index,
    )
    d["has"] = v.notna().astype(int)
    d["slow"] = (v >= THRESHOLD).astype(int)
    d["value"] = v.fillna(0)
    base = d.groupby("hex").agg(
        orders=("order_id", "nunique"),
        with_value=("has", "sum"),
        slow=("slow", "sum"),
        vsum=("value", "sum"),
    )
    print(f"{label}: {len(d)} orders with a valid position ({skipped} skipped, no valid latitude/longitude)")
    return base


def rollup(base: pd.DataFrame, res: int) -> pd.DataFrame:
    """Hexagon table at resolution `res`, summed up from the finest level."""
    if res == RES_MAX:
        g = base.copy()
    else:
        parents = [h3.cell_to_parent(c, res) for c in base.index]
        g = base.groupby(parents).sum()
    g = g[g["with_value"] > 0].copy()
    g["mean"] = g["vsum"] / g["with_value"]
    g["pct_slow"] = 100 * g["slow"] / g["with_value"]
    g["reliable"] = g["orders"] >= MIN_ORDERS
    g.index.name = "hex"
    return g.reset_index()


# ----------------------------- colors --------------------------------------
def hexcolor(rgb):
    return "#%02x%02x%02x" % rgb


def ramp(t: float):
    """HA30%: 0 = best (green) ... 1 = worst (red)."""
    t = min(max(t, 0.0), 1.0)
    if t < 0.5:
        a, b, f = GREEN, YELLOW, t / 0.5
    else:
        a, b, f = YELLOW, RED, (t - 0.5) / 0.5
    return tuple(round(a[i] + (b[i] - a[i]) * f) for i in range(3))


def orders_rgb(n: float, lo: float, hi: float):
    """Orders: grey (few) -> red (many), log scale between lo and hi."""
    lo, hi, n = max(lo, 1.0), max(hi, 1.0), max(n, 1.0)
    t = 0.0 if hi <= lo else (math.log(n) - math.log(lo)) / (math.log(hi) - math.log(lo))
    t = min(max(t, 0.0), 1.0)
    return tuple(round(ORDERS_LOW[i] + (ORDERS_HIGH[i] - ORDERS_LOW[i]) * t) for i in range(3))


def color_scales(tables):
    """Relative scales for one resolution, shared by the source and destination layers."""
    both = pd.concat(tables)
    ok = both.loc[both["reliable"], "pct_slow"]
    if len(ok):
        vmin, vmax = float(ok.quantile(LOW_Q)), float(ok.quantile(HIGH_Q))
    else:
        vmin, vmax = 0.0, 100.0
    olo, ohi = float(both["orders"].quantile(LOW_Q)), float(both["orders"].quantile(HIGH_Q))
    return vmin, vmax, olo, ohi


def hexes_json(g: pd.DataFrame, vmin, vmax, olo, ohi):
    span = (vmax - vmin) or 1.0
    out = []
    for cell, orders, with_value, slow, mean, pct, reliable in zip(
        g["hex"], g["orders"], g["with_value"], g["slow"], g["mean"], g["pct_slow"], g["reliable"]
    ):
        rgb = ramp((pct - vmin) / span) if reliable else GREY
        lat, lng = h3.cell_to_latlng(cell)
        out.append({
            "ring": [[round(a, 5), round(b, 5)] for a, b in h3.cell_to_boundary(cell)],
            "center": [round(lat, 5), round(lng, 5)],
            "hex": cell,
            "color": hexcolor(rgb),
            "color_o": hexcolor(orders_rgb(orders, olo, ohi)),
            "orders": int(orders),
            "slow": int(slow),
            "with_value": int(with_value),
            "pct": round(float(pct), 2),
            "mean": round(float(mean), 1),
        })
    return out


# ----------------------------- HTML ----------------------------------------
HTML_TEMPLATE = r"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>__TITLE__</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
html, body, #map { height: 100%; margin: 0; }
.lbl { font: 600 11px/1.15 sans-serif; color: #222; text-align: center; white-space: nowrap;
       text-shadow: 0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff; pointer-events: none; }
.legend { background: #fff; padding: 8px 10px; font: 12px sans-serif; border-radius: 4px;
          box-shadow: 0 0 6px rgba(0,0,0,.3); }
.legend label { cursor: pointer; }
.legend hr { border: 0; border-top: 1px solid #ddd; margin: 6px 0; }
.legend button { width: 28px; height: 24px; font: 700 15px/1 sans-serif; cursor: pointer; }
.leaflet-container .leaflet-interactive:focus, .leaflet-container path:focus { outline: none !important; }
.bar { height: 10px; width: 190px; margin: 4px 0; }
.bar-ha { background: linear-gradient(to right, __C0__, __C1__, __C2__); }
.bar-o { background: linear-gradient(to right, __O0__, __O1__); }
</style></head>
<body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var DATA = __DATA__;
var LABEL_OFFSET = __LOFF__;
var metric = 'ha';          // 'ha' or 'orders'
var layerIdx = 0;           // 0 = source, 1 = destination
var res = DATA.default;
var auto = false;
var map = L.map('map');
L.tileLayer('__TILE_URL__', {maxZoom: 20, attribution: '__ATTR__'}).addTo(map);

var polysGroup = L.layerGroup().addTo(map);
var labelsGroup = L.layerGroup().addTo(map);
var items = [], labelsOn = false;

function cur() { return DATA.layers[layerIdx].res[res]; }

function tip(h) {
  var ha = 'HA__THRESHOLD__% ' + h.pct.toFixed(2) + '% (' + h.slow + ' of ' + h.with_value + ')';
  var od = 'Total orders: ' + h.orders;
  if (metric === 'ha') { ha = '<b>' + ha + '</b>'; } else { od = '<b>' + od + '</b>'; }
  return ha + '<br>' + od + '<br>Mean: ' + h.mean.toFixed(1) + '<br>Hexagon ID: ' + h.hex;
}
function labelHtml(h) {
  return metric === 'ha' ? h.pct.toFixed(2) + '%<br>' + h.orders : h.orders + '<br>' + h.pct.toFixed(2) + '%';
}
function labelIcon(h) {
  return L.divIcon({className: 'lbl', html: labelHtml(h), iconSize: [64, 26], iconAnchor: [32, 13]});
}

function updateLabels(force) {
  var want = map.getZoom() >= res + LABEL_OFFSET;
  if (want === labelsOn && !force) { return; }
  labelsGroup.clearLayers();
  labelsOn = want;
  items.forEach(function (it) { it.m = null; });
  if (want) {
    items.forEach(function (it) {
      it.m = L.marker(it.h.center, {interactive: false, icon: labelIcon(it.h)});
      labelsGroup.addLayer(it.m);
    });
  }
}

var legendEl = null, panelEl = null;
function renderLegend() {
  if (!legendEl) { return; }
  var s = cur().scale;
  var lz = res + LABEL_OFFSET;
  var grey = '<div style="margin-top:4px"><span style="display:inline-block;width:12px;height:10px;background:#999;opacity:.6"></span> fewer than __MINORD__ orders</div>';
  if (metric === 'ha') {
    legendEl.innerHTML = '<b>HA__THRESHOLD__%</b> = share of orders &gt;= __THRESHOLD__<div class="bar bar-ha"></div>' +
      '<div style="display:flex;justify-content:space-between"><span>' + s.vmin.toFixed(0) + '%</span><span>' + s.vmax.toFixed(0) + '%</span></div>' + grey +
      '<div style="margin-top:4px">Label: HA__THRESHOLD__% and total orders<br>(shown from zoom ' + lz + ')</div>';
  } else {
    legendEl.innerHTML = '<b>Total orders</b> per hexagon<div class="bar bar-o"></div>' +
      '<div style="display:flex;justify-content:space-between"><span>' + s.olo.toFixed(0) + '</span><span>' + s.ohi.toFixed(0) + '</span></div>' +
      '<div style="margin-top:4px">Label: total orders and HA__THRESHOLD__%<br>(shown from zoom ' + lz + ')</div>';
  }
}
function renderPanel() {
  if (!panelEl) { return; }
  panelEl.querySelector('#resVal').textContent = res;
  panelEl.querySelector('#resInfo').textContent = DATA.areas[res] + ' per hexagon';
  panelEl.querySelector('#resMinus').disabled = res <= DATA.min;
  panelEl.querySelector('#resPlus').disabled = res >= DATA.max;
}

function build() {
  polysGroup.clearLayers();
  items = [];
  cur().hexes.forEach(function (h) {
    var p = L.polygon(h.ring, {color: '#ffffff', weight: 1, fillOpacity: 0.55,
                               fillColor: metric === 'ha' ? h.color : h.color_o});
    p.bindTooltip(tip(h), {sticky: true});
    p.on('mouseover', function () { this.setStyle({weight: 3, color: '#333333'}); });
    p.on('mouseout', function () { this.setStyle({weight: 1, color: '#ffffff'}); });
    polysGroup.addLayer(p);
    items.push({h: h, p: p, m: null});
  });
  updateLabels(true);
  renderLegend();
  renderPanel();
}

function applyMetric() {
  items.forEach(function (it) {
    it.p.setStyle({fillColor: metric === 'ha' ? it.h.color : it.h.color_o});
    it.p.setTooltipContent(tip(it.h));
    if (it.m) { it.m.setIcon(labelIcon(it.h)); }
  });
  renderLegend();
}

function setRes(r) {
  r = Math.max(DATA.min, Math.min(DATA.max, r));
  if (r === res) { return; }
  res = r;
  build();
}

// first draw: fit the map to the hexagons
build();
if (items.length) {
  map.fitBounds(L.latLngBounds(items.map(function (it) { return it.h.center; })));
} else {
  map.setView([32.65, 51.67], 11);
}
updateLabels(false);
map.on('zoomend', function () {
  if (auto) { setRes(map.getZoom() - 4); }
  updateLabels(false);
});

var panel = L.control({position: 'topleft'});
panel.onAdd = function () {
  var d = L.DomUtil.create('div', 'legend');
  d.innerHTML =
    '<b>Show</b><br>' +
    '<label><input type="radio" name="layer" value="0" checked> Source hexagons</label><br>' +
    '<label><input type="radio" name="layer" value="1"> Destination hexagons</label>' +
    '<hr><b>Color by</b><br>' +
    '<label><input type="radio" name="metric" value="ha" checked> HA__THRESHOLD__%</label><br>' +
    '<label><input type="radio" name="metric" value="orders"> Total orders</label>' +
    '<hr><b>Resolution</b><br>' +
    '<button id="resMinus" title="Bigger hexagons">-</button> <b id="resVal"></b> ' +
    '<button id="resPlus" title="Smaller hexagons">+</button><br>' +
    '<span id="resInfo"></span><br>' +
    '<label><input type="checkbox" id="auto"> Auto (follow zoom)</label>';
  L.DomEvent.disableClickPropagation(d);
  L.DomEvent.disableScrollPropagation(d);
  d.querySelectorAll('input[name=layer]').forEach(function (i) {
    i.addEventListener('change', function () { layerIdx = parseInt(this.value, 10); build(); });
  });
  d.querySelectorAll('input[name=metric]').forEach(function (i) {
    i.addEventListener('change', function () { metric = this.value; applyMetric(); });
  });
  d.querySelector('#resMinus').addEventListener('click', function () { setRes(res - 1); });
  d.querySelector('#resPlus').addEventListener('click', function () { setRes(res + 1); });
  d.querySelector('#auto').addEventListener('change', function () {
    auto = this.checked;
    if (auto) { setRes(map.getZoom() - 4); }
  });
  panelEl = d;
  renderPanel();
  return d;
};
panel.addTo(map);

var legend = L.control({position: 'bottomright'});
legend.onAdd = function () {
  legendEl = L.DomUtil.create('div', 'legend');
  renderLegend();
  return legendEl;
};
legend.addTo(map);
</script></body></html>
"""


def build_html(data: dict) -> str:
    title = f"{CITY.title()} delivered orders, customer {CUSTOMER_ID}, {START_DATE} to {END_DATE}"
    page = HTML_TEMPLATE
    for key, val in {
        "__TITLE__": html.escape(title),
        "__DATA__": json.dumps(data, separators=(",", ":")),
        "__TILE_URL__": TILE_URL.replace("{key}", API_KEY),
        "__ATTR__": TILE_ATTRIBUTION,
        "__C0__": hexcolor(GREEN), "__C1__": hexcolor(YELLOW), "__C2__": hexcolor(RED),
        "__O0__": hexcolor(ORDERS_LOW), "__O1__": hexcolor(ORDERS_HIGH),
        "__THRESHOLD__": str(THRESHOLD), "__MINORD__": str(MIN_ORDERS), "__LOFF__": str(LABEL_OFFSET),
    }.items():
        page = page.replace(key, val)
    return page


# ----------------------------- main ----------------------------------------
def main():
    df = fetch(SQL)
    print(f"{len(df)} distinct delivered orders fetched ({START_DATE} to {END_DATE})")

    titles = ["Source hexagons", "Destination hexagons"]
    bases = [
        prepare(df, "source_latitude", "source_longitude", "source"),
        prepare(df, "destination_latitude", "destination_longitude", "destination"),
    ]
    layers = [{"title": t, "res": {}} for t in titles]
    areas = {}
    for r in range(RES_MIN, RES_MAX + 1):
        tables = [rollup(b, r) for b in bases]
        vmin, vmax, olo, ohi = color_scales(tables)
        scale = {"vmin": vmin, "vmax": vmax, "olo": olo, "ohi": ohi}
        for lay, g in zip(layers, tables):
            lay["res"][str(r)] = {"scale": scale, "hexes": hexes_json(g, vmin, vmax, olo, ohi)}
        areas[str(r)] = f"~{h3.average_hexagon_area(r, 'km^2'):.2g} km\u00b2"
        print(f"resolution {r}: {len(tables[0])} source hexagons, {len(tables[1])} destination hexagons")

    data = {"min": RES_MIN, "max": RES_MAX, "default": RES_DEFAULT, "areas": areas, "layers": layers}
    with open(OUT_HTML, "w", encoding="utf-8") as f:
        f.write(build_html(data))
    print(f"Wrote {OUT_HTML}  (open in a browser; use - / + to change the resolution)")


if __name__ == "__main__":
    main()
