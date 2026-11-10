"""
Data Source abstraction layer.
Directly connects to ClickHouse (fact_ka) with single-execution query caching,
or parses custom uploaded CSV files.
Mock data generation has been completely removed.
"""
import io
import math
import os
import sys
from datetime import datetime, timedelta
from typing import Optional, Tuple, Dict, Any, List
import pandas as pd

from app.config import settings
from app.cities import normalize_city_name

# Global in-memory cache for executed queries to avoid re-running slow ClickHouse queries
QUERY_CACHE: Dict[str, pd.DataFrame] = {}


def try_get_clickhouse_client():
    """Try to obtain a ClickHouse client from connect.py or settings."""
    for path in [os.getcwd(), os.path.dirname(__file__), "/home/user/Map", "/home/user"]:
        if os.path.exists(os.path.join(path, "connect.py")):
            if path not in sys.path:
                sys.path.insert(0, path)
            try:
                import connect  # type: ignore
                client = connect.get_client() if hasattr(connect, "get_client") else getattr(connect, "client", None)
                if client is not None:
                    return client, "connect.py"
            except Exception as e:
                print(f"Failed to load connect.py from {path}: {e}")

    if settings.CLICKHOUSE_HOST:
        try:
            import clickhouse_connect
            client = clickhouse_connect.get_client(
                host=settings.CLICKHOUSE_HOST,
                port=settings.CLICKHOUSE_PORT,
                username=settings.CLICKHOUSE_USER,
                password=settings.CLICKHOUSE_PASSWORD,
                database=settings.CLICKHOUSE_DATABASE,
                secure=settings.CLICKHOUSE_SECURE,
                connect_timeout=4,
            )
            return client, "clickhouse_connect"
        except Exception as e:
            print(f"ClickHouse connection failed ({settings.CLICKHOUSE_HOST}:{settings.CLICKHOUSE_PORT}): {e}")
            return None, str(e)

    return None, "No ClickHouse host configured"


def get_dates_between(start_date: str, end_date: str) -> List[str]:
    """Return list of YYYY-MM-DD date strings inclusive."""
    try:
        s = datetime.strptime(start_date, "%Y-%m-%d")
        e = datetime.strptime(end_date, "%Y-%m-%d")
        if s > e:
            s, e = e, s
        n_days = (e - s).days + 1
        return [(s + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n_days)]
    except Exception:
        return [start_date]


def compute_daily_breakdown(df: pd.DataFrame, all_dates: List[str], threshold: int) -> List[Dict[str, Any]]:
    """Compute daily HA30, orders, and duration statistics for each date in the period."""
    if len(df) == 0:
        return []

    day_name_map = {0: "Mon", 1: "Tue", 2: "Wed", 3: "Thu", 4: "Fri", 5: "Sat", 6: "Sun"}
    daily_stats = []

    if "created_date" not in df.columns:
        return []

    grouped = df.groupby("created_date")
    agg_dict = {}
    for d_str, g in grouped:
        d_key = str(d_str).split(" ")[0].strip()
        total = int(g["order_id"].nunique())
        v = g["create_to_accept_contractual"].dropna()
        with_val = int(len(v))
        ha30_count = int((v >= threshold).sum())
        pct = round(ha30_count / with_val * 100, 1) if with_val > 0 else 0.0
        mean = round(float(v.mean()), 1) if with_val > 0 else 0.0
        agg_dict[d_key] = {
            "orders": total,
            "ha30_count": ha30_count,
            "with_value": with_val,
            "pct": pct,
            "mean": mean,
        }

    for d_str in all_dates:
        try:
            dt = datetime.strptime(d_str, "%Y-%m-%d")
            day_name = day_name_map.get(dt.weekday(), "")
            short_label = dt.strftime("%b %d")
        except Exception:
            day_name = ""
            short_label = d_str

        info = agg_dict.get(d_str, {"orders": 0, "ha30_count": 0, "with_value": 0, "pct": 0.0, "mean": 0.0})
        daily_stats.append({
            "date": d_str,
            "day_name": day_name,
            "label": f"{day_name} {short_label}",
            "orders": info["orders"],
            "ha30_count": info["ha30_count"],
            "pct": info["pct"],
            "mean": info["mean"],
        })

    return daily_stats


def fetch_orders(
    city: str,
    status: str = "DELIVERED",
    customer_id: int = 2,
    start_date: str = "2026-10-22",
    end_date: str = "2026-11-05",
    threshold: int = 30,
    selected_dates: Optional[List[str]] = None,
    force_refresh: bool = False,
) -> Tuple[pd.DataFrame, str, List[Dict[str, Any]], List[str]]:
    """
    Fetch orders directly from ClickHouse (no mock data).
    Executes query once for the date range and caches in-memory per day.
    """
    clean_city = normalize_city_name(city)
    all_dates = get_dates_between(start_date, end_date)
    cache_key = f"{clean_city}_{status}_{customer_id}_{start_date}_{end_date}"

    # 1. Check in-memory query cache
    if not force_refresh and cache_key in QUERY_CACHE:
        raw_df = QUERY_CACHE[cache_key]
        data_source_label = f"Cached In-Memory ({len(raw_df)} orders)"
    else:
        client, client_desc = try_get_clickhouse_client()
        if client is None:
            err_msg = (
                f"ClickHouse connection error ({client_desc}). "
                f"Host: {settings.CLICKHOUSE_HOST}:{settings.CLICKHOUSE_PORT}, User: {settings.CLICKHOUSE_USER}. "
                "Please verify ClickHouse credentials in .env or upload an orders CSV."
            )
            raise RuntimeError(err_msg)

        # Query identical to previous file, with created_date for daily grouping
        sql = f"""
SELECT
    order_id,
    source_latitude,
    source_longitude,
    destination_latitude,
    destination_longitude,
    create_to_accept_contractual,
    created_date
FROM dwh_box.fact_ka
WHERE city = '{clean_city}'
  AND status = '{status}'
  AND customer_id = {customer_id}
  AND created_date >= toDate('{start_date}')
  AND created_date <= toDate('{end_date}')
LIMIT 1 BY order_id
"""
        print(f"Executing ClickHouse query ONCE for {clean_city} ({start_date} to {end_date})...")
        try:
            if hasattr(client, "query_df"):
                raw_df = client.query_df(sql)
            else:
                result = client.query(sql)
                raw_df = pd.DataFrame(result.result_rows, columns=result.column_names)

            if len(raw_df) > 0 and "created_date" in raw_df.columns:
                raw_df["created_date"] = raw_df["created_date"].astype(str).str[:10]
        except Exception as e:
            print(f"ClickHouse query failed with created_date: {e}. Trying fallback exact query...")
            # Fallback to exact 6 columns
            sql_fallback = f"""
SELECT
    order_id,
    source_latitude,
    source_longitude,
    destination_latitude,
    destination_longitude,
    create_to_accept_contractual
FROM dwh_box.fact_ka
WHERE city = '{clean_city}'
  AND status = '{status}'
  AND customer_id = {customer_id}
  AND created_date >= toDate('{start_date}')
  AND created_date <= toDate('{end_date}')
LIMIT 1 BY order_id
"""
            if hasattr(client, "query_df"):
                raw_df = client.query_df(sql_fallback)
            else:
                result = client.query(sql_fallback)
                raw_df = pd.DataFrame(result.result_rows, columns=result.column_names)

            if len(raw_df) > 0 and "created_date" not in raw_df.columns:
                raw_df["created_date"] = end_date

        data_source_label = f"ClickHouse Live ({len(raw_df)} orders via {client_desc})"
        QUERY_CACHE[cache_key] = raw_df

    # Compute daily breakdown
    daily_breakdown = compute_daily_breakdown(raw_df, all_dates, threshold)

    # Filter by selected dates in-memory without re-executing SQL
    if selected_dates and len(selected_dates) > 0 and len(selected_dates) < len(all_dates):
        filtered_df = raw_df[raw_df["created_date"].isin(selected_dates)].copy()
    else:
        filtered_df = raw_df

    return filtered_df, data_source_label, daily_breakdown, all_dates


def parse_csv_orders(content: bytes) -> pd.DataFrame:
    """Parse an uploaded CSV file containing order coordinates and duration."""
    df = pd.read_csv(io.BytesIO(content))
    df.columns = [c.strip().lower() for c in df.columns]

    col_map = {
        "order": "order_id",
        "id": "order_id",
        "src_lat": "source_latitude",
        "source_lat": "source_latitude",
        "src_lng": "source_longitude",
        "source_lon": "source_longitude",
        "source_lng": "source_longitude",
        "dest_lat": "destination_latitude",
        "destination_lat": "destination_latitude",
        "dest_lng": "destination_longitude",
        "destination_lon": "destination_longitude",
        "destination_lng": "destination_longitude",
        "duration": "create_to_accept_contractual",
        "accept_duration": "create_to_accept_contractual",
        "accept_time": "create_to_accept_contractual",
        "create_to_accept": "create_to_accept_contractual",
        "date": "created_date",
        "created": "created_date",
    }
    df = df.rename(columns={c: col_map[c] for c in df.columns if c in col_map})

    if "order_id" not in df.columns:
        df["order_id"] = [f"CSV-{i+1}" for i in range(len(df))]

    required = ["source_latitude", "source_longitude", "destination_latitude", "destination_longitude"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Uploaded CSV is missing required columns: {missing}")

    if "create_to_accept_contractual" not in df.columns:
        df["create_to_accept_contractual"] = 20.0

    if "created_date" not in df.columns:
        df["created_date"] = "2026-11-05"

    return df
