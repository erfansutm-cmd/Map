"""
FastAPI Server & REST API.
Serves interactive dashboard, H3 hexagon analysis endpoints, and standalone exports.
Supports single-execution query caching, day-level filtering, and API key tile configuration.
"""
import os
from typing import Optional, List
from fastapi import FastAPI, Request, Query, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import settings
from app.cities import get_popular_cities, get_city_info
from app.data_source import fetch_orders, parse_csv_orders
from app.engine import analyze_city_orders
from app.export_html import build_standalone_html

app = FastAPI(
    title="Fleet HexMap Analytics",
    description="H3 Hexagon Map & HA30 SLA Performance Engine",
    version="2.2.0",
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))


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
        analysis["daily_stats"] = daily_breakdown
        analysis["all_dates"] = all_dates
        analysis["selected_dates"] = selected_dates if selected_dates is not None else all_dates
        analysis["map_api_key"] = settings.MAP_API_KEY
        analysis["tile_url"] = settings.TILE_URL.replace("{key}", settings.MAP_API_KEY)

        return analysis
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    df, _, _, _ = fetch_orders(
        city=city,
        status=status,
        customer_id=customer_id,
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
