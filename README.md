# Fleet HexMap &bull; HA30 Hexagonal Fleet SLA Analytics

A modern, high-performance geospatial analytics product designed to analyze, visualize, and inspect on-demand courier and fleet delivery performance across cities using **Uber's H3 hexagonal spatial index**.

This project expands and elevates the standalone `isfahan_hex_html.py` script into a full-featured web product with a responsive dashboard, multi-basemap engine, interactive city search, day-level filtering, multi-cell zone merging, and dual color metrics.

---

## Key Enhancements & Features

### 1. Dedicated HA30 SLA Focus & Citywide Performance
* **Orders layer removed**: Per user request, the redundant "orders layer" / "color by total orders" mode has been eliminated to keep the map focused on service-level agreement (SLA) health.
* **Orders shown better in HA30**: Order volume is deeply integrated into the HA30 layer:
  * **On-hex badges**: Shows breach percentage and order volume side-by-side (`28% · 142 ord`).
  * **Interactive Tooltips**: Instant view of total orders, slow orders (≥30s), fast orders (<30s), and average duration.
  * **Hexagon Inspector Card**: Click any hexagon to inspect exact order breakdown with progress bars, coordinates, and H3 cell ID.
  * **Low-Sample Indicator**: Hexagons with fewer than 5 orders are distinguished as low-sample (`< 5 orders`), preventing statistical distortion.
* **Whole City HA30 Performance Overview**:
  * Prominent **Citywide HA30 Card** on top of the map showing overall SLA breach rate (`%`), total delivered orders, slow vs on-time order counts, and SLA health badge (*Optimal*, *Acceptable*, *Elevated Risk*, *Critical Breach*).
  * **Proportional SLA Track**: Visual progress bar showing citywide on-time vs breached order share.
  * **Citywide Report Modal**: Click the citywide card or "Citywide HA30" button to inspect detailed duration distributions (Median P50, Mean, P90, P95) and the full daily SLA trend table.

### 2. Interactive Day Selector (Filter Specific Days)
* **Select or Deselect Any Days**: An interactive day selector strip below the city chips displays every day in the time range with its order volume and breach rate badge.
* **Instant Dynamic Filtering**: Toggle individual days on or off to analyze SLA health across specific dates.
* **Quick Presets**: 1-click buttons for `All Days`, `Weekdays`, `Weekends`, and `Invert`.

### 3. Shift + Click Multi-Cell Merged Analytics
* **Merge Multiple Hexagons**: Hold <kbd>Shift</kbd> and click any number of hexagons on the map (or enable the "Multi-Select" toggle) to select multiple zones.
* **Glowing Cyan Highlight**: Selected cells are highlighted with an unmistakable high-contrast cyan border.
* **Merged Analytics Drawer**:
  * **Combined HA30%**: Exact merged SLA breach rate across all selected cells.
  * **Combined Order Counts**: Total combined orders, slow orders, and on-time orders.
  * **Weighted Mean Duration**: Mathematically sound weighted average create-to-accept duration.
  * **Comparison to City Average**: Live benchmark delta (e.g. `+3.4% vs City Avg`).
  * **Selected Cells Chips**: Removable tags for each cell with 1-click `(×)` deselect and a `Zoom Selection` button.

### 4. Toggle Colors by HA30% or Mean Duration
* **Dual Hexagon Color Metric**: Toggle between:
  * **HA30% Breach**: Colored by SLA failure percentage (Green = fast SLA, Yellow = moderate, Red = severe breach).
  * **Mean Duration**: Colored by average create-to-accept duration in minutes (Green = fast <15 min, Yellow = 15-30 min, Red = >30 min delay).
* **Dynamic Legend**: Automatically updates the gradient bar and tick ranges between HA30 percentages and duration minutes.

### 5. High-Fidelity Map Visualization ("See the Map Better")
* **Multiple Basemaps**:
  * **CARTO Voyager** (default clean street map)
  * **CARTO Positron Light** (minimalist gray, maximum contrast for hexagons)
  * **CARTO Dark Matter** (stunning dark mode, neon hex glow)
  * **Esri World Satellite** (real ground imagery and roads)
  * **OpenStreetMap** (standard local street detail)
* **Opacity Slider**: Smoothly adjust hexagon fill transparency from 10% to 100% to view underlying street names, intersections, and landmarks clearly.
* **Multi-Resolution Stepper**: Toggle between H3 resolution 6 (~36 km² city overview), 7 (~5.2 km² district), 8 (~0.74 km² neighborhood), 9 (~0.1 km² street cluster), and 10 (~0.015 km² block level).
* **Auto-Resolution Mode**: Dynamically follows your map zoom level as you zoom in and out.
* **Pickup vs Dropoff**: Toggle between **Source (Pickup)** and **Destination (Dropoff)** hexagonal heatmaps with 1 click.

### 6. City Search & Data Pipeline
* **Search any city**: Type any city name (e.g. *Isfahan*, *Tehran*, *Shiraz*, *Tabriz*, *Mashhad*, *Karaj*, *Ahvaz*, *Qom*, *Rasht*, *Kermanshah*, *Dubai*, *Istanbul*, *London*...) in the header search bar.
* **Instant City Chips**: 1-click popular city quick selectors.
* **Flexible Data Sources**:
  * **Live ClickHouse**: Directly connects to ClickHouse (`dwh_box.fact_ka`) if `connect.py` or `CLICKHOUSE_HOST` environment variables are provided.
  * **Built-in High-Fidelity Engine**: Realistic citywide courier simulation with spatial commercial clustering and congestion delay hotspots when offline or in demo mode.
  * **Custom CSV Upload**: Upload any custom delivery orders CSV (`source_latitude`, `source_longitude`, `destination_latitude`, `destination_longitude`, `create_to_accept_contractual`) to visualize your own fleet data instantly.

### 7. Critical Bottlenecks & Operational Hotspots
* Automatically flags top operational bottlenecks (hexagons with high order volume combined with high SLA breach rates).
* Click any bottleneck to fly directly to the hexagon on the map.

### 8. Standalone Offline HTML Export
* Export a 100% self-contained single-file HTML hover map for any city with a single click — perfect for offline sharing via Slack, email, or client reports.

---

## Running with Docker

Run the entire application in a container with a single command:

```bash
docker compose up --build
```

The application will be available at **`http://localhost:8000`**.

### Docker Configuration
In `docker-compose.yml`, you can configure ClickHouse credentials or change default parameters:

```yaml
services:
  fleet-hexmap:
    build: .
    ports:
      - "8000:8000"
    environment:
      - DEFAULT_CITY=isfahan
      - DEFAULT_THRESHOLD=30
      - DEFAULT_MIN_ORDERS=5
      # Optional ClickHouse Connection
      - CLICKHOUSE_HOST=clickhouse.internal
      - CLICKHOUSE_PORT=8123
      - CLICKHOUSE_USER=default
      - CLICKHOUSE_PASSWORD=secret
      - CLICKHOUSE_DATABASE=dwh_box
```

Or build and run directly with `docker run`:

```bash
docker build -t fleet-hexmap .
docker run -p 8000:8000 fleet-hexmap
```

---

## Running Locally (Without Docker)

1. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Start the server**:
   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
   ```

3. Open **`http://localhost:8000`** in your browser.

---

## Command-Line Interface (CLI)

To generate a standalone self-contained HTML report without starting the web server:

```bash
# Generate report for Isfahan
python cli.py --city isfahan --threshold 30 --out isfahan_hexagons.html

# Generate report for Tehran with custom threshold
python cli.py --city tehran --threshold 25 --out tehran_hexagons.html
```

---

## Running Unit Tests

```bash
python -m unittest discover -s tests
```
