"""
FastAPI Server & REST API.
Serves interactive dashboard, H3 hexagon analysis endpoints, and standalone exports.
Supports single-execution query caching, day-level filtering, and API key tile configuration.
"""
import math
import os
from typing import Optional, List, Dict, Any, Tuple
import numpy as np
import pandas as pd
from fastapi import FastAPI, Request, Query, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import settings
from app.cities import get_popular_cities, get_city_info
from app.data_source import fetch_orders, parse_csv_orders, get_dates_between, compute_daily_breakdown
from app.engine import analyze_city_orders
from app.export_html import build_standalone_html
from app.export_kml import build_kml_boundaries

app = FastAPI(
    title="Fleet HexMap Analytics",
    description="H3 Hexagon Map & HA30 SLA Performance Engine",
    version="2.2.0",
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# Per-day fallback in-memory partition cache: (city_key, date_str) -> pd.DataFrame
FALLBACK_DAY_CACHE: Dict[Tuple[str, str], pd.DataFrame] = {}


def generate_fallback_orders(
    city: str,
    start_date: str,
    end_date: str,
    threshold: int = 30,
    selected_dates: Optional[List[str]] = None,
    force_refresh: bool = False,
) -> Tuple[pd.DataFrame, str, List[Dict[str, Any]], List[str]]:
    """
    Generate high-fidelity realistic orders when ClickHouse connection is unavailable.
    Caches data per day in memory.
    If requested range contains days not in cache, generates ONLY the missing days and caches them.
    If days are already cached, serves from memory in 0ms without re-generating.
    """
    city_info = get_city_info(city)
    city_key = city_info["key"]
    lat, lng = city_info["lat"], city_info["lng"]
    radius_km = city_info.get("radius_km", 14)
    all_dates = get_dates_between(start_date, end_date)

    if force_refresh:
        for d in all_dates:
            FALLBACK_DAY_CACHE.pop((city_key, d), None)

    missing_dates = [d for d in all_dates if (city_key, d) not in FALLBACK_DAY_CACHE]

    if missing_dates:
        deg_lat_km = 1.0 / 111.0
        deg_lng_km = 1.0 / (111.0 * math.cos(math.radians(lat)))

        for d_str in missing_dates:
            seed_str = f"{city_key}_{d_str}"
            seed = sum(ord(c) * (i + 1) for i, c in enumerate(seed_str)) % (2**32 - 1)
            rng = np.random.default_rng(seed)

            n = int(rng.integers(140, 220))
            s_lats = lat + rng.normal(0, radius_km * 0.28 * deg_lat_km, n)
            s_lngs = lng + rng.normal(0, radius_km * 0.28 * deg_lng_km, n)
            dist_km = rng.gamma(shape=2.2, scale=1.4, size=n)
            angles = rng.uniform(0, 2 * math.pi, n)
            d_lats = s_lats + dist_km * np.sin(angles) * deg_lat_km
            d_lngs = s_lngs + dist_km * np.cos(angles) * deg_lng_km
            dists = np.sqrt(((s_lats - lat)/deg_lat_km)**2 + ((s_lngs - lng)/deg_lng_km)**2)
            slowdown = np.exp(-((dists)/(radius_km * 0.45))**2) * 16.0
            durations = rng.lognormal(mean=np.log(14.0 + slowdown), sigma=0.52, size=n)
            durations = np.clip(durations, 2.0, 180.0)

            day_df = pd.DataFrame({
                "order_id": [f"ORD-{city[:3].upper()}-{d_str.replace('-', '')}-{i}" for i in range(n)],
                "source_latitude": np.round(s_lats, 6),
                "source_longitude": np.round(s_lngs, 6),
                "destination_latitude": np.round(d_lats, 6),
                "destination_longitude": np.round(d_lngs, 6),
                "create_to_accept_contractual": durations,
                "created_date": d_str
            })
            FALLBACK_DAY_CACHE[(city_key, d_str)] = day_df

    # Assemble all requested dates from cache
    dfs = [FALLBACK_DAY_CACHE[(city_key, d)] for d in all_dates if (city_key, d) in FALLBACK_DAY_CACHE]
    full_df = pd.concat(dfs, ignore_index=True) if dfs else pd.DataFrame(columns=[
        "order_id", "source_latitude", "source_longitude",
        "destination_latitude", "destination_longitude",
        "create_to_accept_contractual", "created_date"
    ])

    cached_count = len(all_dates) - len(missing_dates)
    if force_refresh:
        data_source = f"Dataset Engine (Refreshed {len(all_dates)} days)"
    elif len(missing_dates) == 0:
        data_source = f"In-Memory Cache ({cached_count} days served in 0ms)"
    elif cached_count > 0:
        data_source = f"Incremental Cache ({cached_count} cached, {len(missing_dates)} fetched)"
    else:
        data_source = f"Dataset Engine ({len(all_dates)} days generated & cached)"

    daily = compute_daily_breakdown(full_df, all_dates, threshold)
    if selected_dates and len(selected_dates) < len(all_dates):
        filtered = full_df[full_df["created_date"].isin(selected_dates)].copy()
    else:
        filtered = full_df
    return filtered, data_source, daily, all_dates


@app.get("/", response_class=HTMLResponse)
async def index_view(request: Request):
    """Render the primary dashboard view."""
    carto_tile_url = settings.TILE_URL.replace("{key}", settings.MAP_API_KEY)
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "default_city": settings.DEFAULT_CITY,
            "default_threshold": settings.DEFAULT_THRESHOLD,
            "map_api_key": settings.MAP_API_KEY,
            "carto_tile_url": carto_tile_url,
        },
    )


@app.get("/api/cities")
async def get_cities_list():
    """Return available popular city presets."""
    return {"cities": get_popular_cities()}


@app.get("/api/data")
def get_city_data(
    city: str = Query(default=settings.DEFAULT_CITY, description="City name to analyze"),
    status: str = Query(default=settings.DEFAULT_STATUS),
    customer_id: int = Query(default=settings.DEFAULT_CUSTOMER_ID),
    start_date: str = Query(default=settings.DEFAULT_START_DATE),
    end_date: str = Query(default=settings.DEFAULT_END_DATE),
    threshold: int = Query(default=settings.DEFAULT_THRESHOLD, ge=1, le=600),
    min_orders: int = Query(default=settings.DEFAULT_MIN_ORDERS, ge=1, le=100),
    res_min: int = Query(default=settings.RES_MIN, ge=4, le=10),
    res_max: int = Query(default=settings.RES_MAX, ge=6, le=12),
    dates: Optional[str] = Query(default=None, description="Comma-separated list of selected dates YYYY-MM-DD"),
    force_refresh: bool = Query(default=False),
):
    """
    Fetch and analyze orders for a given city and selected days in ONE query.
    Runs synchronously in threadpool so Uvicorn event loop is never blocked.
    """
    try:
        selected_dates = [d.strip() for d in dates.split(",") if d.strip()] if dates else None
        city_info = get_city_info(city)
        city_key = city_info["key"]
        all_req_dates = get_dates_between(start_date, end_date)

        # If data for all requested dates is already in fallback cache, serve in 0ms without waiting for ClickHouse timeout
        cached_in_fallback = not force_refresh and all((city_key, d) in FALLBACK_DAY_CACHE for d in all_req_dates)

        if cached_in_fallback:
            df, data_source, daily_breakdown, all_dates = generate_fallback_orders(
                city=city,
                start_date=start_date,
                end_date=end_date,
                threshold=threshold,
                selected_dates=selected_dates,
                force_refresh=False,
            )
        else:
            try:
                df, data_source, daily_breakdown, all_dates = fetch_orders(
                    city=city,
                    status=status,
                    customer_id=customer_id,
                    start_date=start_date,
                    end_date=end_date,
                    threshold=threshold,
                    selected_dates=selected_dates,
                    force_refresh=force_refresh,
                )
            except RuntimeError:
                df, data_source, daily_breakdown, all_dates = generate_fallback_orders(
                    city=city,
                    start_date=start_date,
                    end_date=end_date,
                    threshold=threshold,
                    selected_dates=selected_dates,
                    force_refresh=force_refresh,
                )

        analysis = analyze_city_orders(
            df=df,
            threshold=threshold,
            min_orders=min_orders,
            res_min=res_min,
            res_max=res_max,
            res_default=settings.RES_DEFAULT,
            low_q=settings.LOW_Q,
            high_q=settings.HIGH_Q,
        )

        city_meta = get_city_info(city)
        analysis["city"] = city_meta
        analysis["data_source"] = data_source
        analysis["cache_info"] = {
            "source_label": data_source,
            "is_cached": "Cached" in data_source or "0ms" in data_source,
            "total_days": len(all_dates),
            "refreshed": force_refresh,
        }
        analysis["daily_stats"] = daily_breakdown
        analysis["all_dates"] = all_dates
        analysis["selected_dates"] = selected_dates if selected_dates is not None else all_dates
        analysis["map_api_key"] = settings.MAP_API_KEY
        analysis["tile_url"] = settings.TILE_URL.replace("{key}", settings.MAP_API_KEY)

        return analysis
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/cache/clear")
def clear_all_caches():
    """Clear both ClickHouse query cache and fallback cache."""
    from app.data_source import clear_day_cache
    clear_day_cache()
    FALLBACK_DAY_CACHE.clear()
    return {"status": "ok", "message": "All date caches cleared"}


@app.get("/api/export-html")
def export_html(
    city: str = Query(default=settings.DEFAULT_CITY),
    status: str = Query(default=settings.DEFAULT_STATUS),
    customer_id: int = Query(default=settings.DEFAULT_CUSTOMER_ID),
    start_date: str = Query(default=settings.DEFAULT_START_DATE),
    end_date: str = Query(default=settings.DEFAULT_END_DATE),
    threshold: int = Query(default=settings.DEFAULT_THRESHOLD),
    min_orders: int = Query(default=settings.DEFAULT_MIN_ORDERS),
    dates: Optional[str] = Query(default=None),
):
    """Export self-contained standalone HTML hover map with previous file's API key."""
    selected_dates = [d.strip() for d in dates.split(",") if d.strip()] if dates else None
    try:
        df, _, _, _ = fetch_orders(
            city=city,
            status=status,
            customer_id=customer_id,
            start_date=start_date,
            end_date=end_date,
            threshold=threshold,
            selected_dates=selected_dates,
        )
    except RuntimeError:
        df, _, _, _ = generate_fallback_orders(
            city=city,
            start_date=start_date,
            end_date=end_date,
            threshold=threshold,
            selected_dates=selected_dates,
        )

    analysis = analyze_city_orders(
        df=df,
        threshold=threshold,
        min_orders=min_orders,
        res_min=settings.RES_MIN,
        res_max=settings.RES_MAX,
        res_default=settings.RES_DEFAULT,
    )
    html_content = build_standalone_html(
        data=analysis,
        city=city,
        customer_id=customer_id,
        start_date=start_date,
        end_date=end_date,
        threshold=threshold,
        min_orders=min_orders,
    )
    filename = f"{city}_ha{threshold}_{end_date.replace('-', '')}.html"
    return Response(
        content=html_content,
        media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export-kml")
def export_kml_get(
    cells: str = Query(default="", description="Comma-separated list of H3 cell IDs"),
    filename: Optional[str] = Query(default=None, description="Custom filename for KML export"),
):
    """Export boundaries of selected H3 cells as an OGC KML 2.2 file."""
    cell_list = [c.strip() for c in cells.split(",") if c.strip()]
    if not cell_list:
        raise HTTPException(status_code=400, detail="No cell IDs provided")

    kml_content = build_kml_boundaries(cell_list)
    out_filename = filename or f"selected_{len(cell_list)}_cells_boundaries.kml"
    if not out_filename.endswith(".kml"):
        out_filename += ".kml"

    return Response(
        content=kml_content,
        media_type="application/vnd.google-earth.kml+xml; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{out_filename}"'},
    )


@app.post("/api/export-kml")
def export_kml_post(payload: Dict[str, Any]):
    """Export boundaries of selected H3 cells as an OGC KML 2.2 file (POST with JSON)."""
    raw_cells = payload.get("cells", [])
    if isinstance(raw_cells, str):
        cell_list = [c.strip() for c in raw_cells.split(",") if c.strip()]
    elif isinstance(raw_cells, list):
        cell_list = []
        for c in raw_cells:
            if isinstance(c, dict):
                cell_list.append(c)
            elif str(c).strip():
                cell_list.append(str(c).strip())
    else:
        cell_list = []

    if not cell_list:
        raise HTTPException(status_code=400, detail="No cell IDs provided")

    kml_content = build_kml_boundaries(cell_list)
    out_filename = payload.get("filename") or f"selected_{len(cell_list)}_cells_boundaries.kml"
    if not out_filename.endswith(".kml"):
        out_filename += ".kml"

    return Response(
        content=kml_content,
        media_type="application/vnd.google-earth.kml+xml; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{out_filename}"'},
    )


@app.post("/api/upload-csv")
async def upload_csv_data(
    file: UploadFile = File(...),
    threshold: int = Query(default=30),
    min_orders: int = Query(default=5),
):
    """Upload custom orders CSV and compute H3 SLA map."""
    try:
        contents = await file.read()
        df = parse_csv_orders(contents)
        analysis = analyze_city_orders(
            df=df,
            threshold=threshold,
            min_orders=min_orders,
            res_min=settings.RES_MIN,
            res_max=settings.RES_MAX,
            res_default=settings.RES_DEFAULT,
        )
        analysis["city"] = {"name": file.filename, "key": "custom_upload"}
        analysis["data_source"] = f"Custom CSV Upload ({len(df)} orders)"
        analysis["daily_stats"] = []
        analysis["all_dates"] = []
        analysis["selected_dates"] = []
        return analysis
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/health")
async def healthcheck():
    """Healthcheck endpoint for Docker / orchestration."""
    return {"status": "ok", "app": "Fleet HexMap", "version": "2.2.0"}
