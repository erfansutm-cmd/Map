"""
Data Source abstraction layer.
Directly connects to ClickHouse (fact_ka) with single-execution per-day query caching,
or parses custom uploaded CSV files.
Mock data generation has been completely removed.
"""
import io
import math
import os
import sys
from datetime import datetime, timedelta
from typing import Optional, Tuple, Dict, Any, List, Set
import pandas as pd

from app.config import settings
from app.cities import normalize_city_name
from app.file_cache import save_df_to_file, load_df_from_file, clear_file_cache
from app.engine import compute_biker_active_cells_avg, get_order_cells_series

# Daily in-memory partition cache: (clean_city, status, customer_id, date_str) -> pd.DataFrame
DAY_CACHE: Dict[Tuple[str, str, int, str], pd.DataFrame] = {}

# Set of dates that have been queried against ClickHouse: (clean_city, status, customer_id, date_str)
QUERIED_DATES: Set[Tuple[str, str, int, str]] = set()


def clear_day_cache():
    """Clear both in-memory cache and disk file cache."""
    DAY_CACHE.clear()
    QUERIED_DATES.clear()
    clear_file_cache()


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
    """Compute daily HA30, orders, duration statistics, and avg active cells per biker for each date."""
    if len(df) == 0:
        return []

    day_name_map = {0: "Mon", 1: "Tue", 2: "Wed", 3: "Thu", 4: "Fri", 5: "Sat", 6: "Sun"}
    daily_stats = []

    if "created_date" not in df.columns:
        return []

    # Pre-compute order cells once for fast daily aggregation
    df = df.copy()
    df["_active_cell"] = get_order_cells_series(df)

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
        avg_cells = compute_biker_active_cells_avg(g)
        agg_dict[d_key] = {
            "orders": total,
            "ha30_count": ha30_count,
            "with_value": with_val,
            "pct": pct,
            "mean": mean,
            "avg_cells_per_biker": avg_cells,
        }

    for d_str in all_dates:
        try:
            dt = datetime.strptime(d_str, "%Y-%m-%d")
            day_name = day_name_map.get(dt.weekday(), "")
            short_label = dt.strftime("%b %d")
        except Exception:
            day_name = ""
            short_label = d_str

        info = agg_dict.get(d_str, {
            "orders": 0,
            "ha30_count": 0,
            "with_value": 0,
            "pct": 0.0,
            "mean": 0.0,
            "avg_cells_per_biker": 0.0,
        })
        daily_stats.append({
            "date": d_str,
            "day_name": day_name,
            "label": f"{day_name} {short_label}",
            "orders": info["orders"],
            "ha30_count": info["ha30_count"],
            "pct": info["pct"],
            "mean": info["mean"],
            "avg_cells_per_biker": info.get("avg_cells_per_biker", 0.0),
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
    Saves data per day in memory.
    If requested days (or other days not in last 2 weeks) are not in cache,
    queries ClickHouse specifically for the missing days, caches them, and returns.
    If days are already cached, serves from memory in 0ms without hitting ClickHouse.
    """
    clean_city = normalize_city_name(city)
    all_range_dates = get_dates_between(start_date, end_date)

    if selected_dates:
        all_target_dates = sorted(list(set(all_range_dates + selected_dates)))
    else:
        all_target_dates = all_range_dates

    # If force refresh requested, invalidate cache for all target dates first
    if force_refresh:
        for d in all_target_dates:
            DAY_CACHE.pop((clean_city, status, customer_id, d), None)
            QUERIED_DATES.discard((clean_city, status, customer_id, d))
    else:
        # Check disk cache for any dates not in memory (must contain biker_id)
        for d in all_target_dates:
            key = (clean_city, status, customer_id, d)
            if key in DAY_CACHE and "biker_id" not in DAY_CACHE[key].columns:
                DAY_CACHE.pop(key, None)
                QUERIED_DATES.discard(key)

            if key not in DAY_CACHE:
                cached_file_df = load_df_from_file("clickhouse", key)
                if cached_file_df is not None:
                    if "biker_id" in cached_file_df.columns:
                        DAY_CACHE[key] = cached_file_df
                        QUERIED_DATES.add(key)
                    else:
                        try:
                            from app.file_cache import _cache_filename, CACHE_DIR
                            fn = _cache_filename("clickhouse", key)
                            fp = os.path.join(CACHE_DIR, fn)
                            if os.path.exists(fp):
                                os.remove(fp)
                        except Exception:
                            pass

    # Identify which of the requested dates do not have data in cache
    missing_dates = [
        d for d in all_target_dates
        if (clean_city, status, customer_id, d) not in QUERIED_DATES
    ]

    data_source_label = ""

    if missing_dates:
        client, client_desc = try_get_clickhouse_client()
        if client is None:
            err_msg = (
                f"ClickHouse connection error ({client_desc}). "
                f"Host: {settings.CLICKHOUSE_HOST}:{settings.CLICKHOUSE_PORT}, User: {settings.CLICKHOUSE_USER}. "
                "Please verify ClickHouse credentials in .env or upload an orders CSV."
            )
            raise RuntimeError(err_msg)

        missing_dates = sorted(missing_dates)
        min_d = missing_dates[0]
        max_d = missing_dates[-1]

        # Contiguous range check
        contiguous_dates = get_dates_between(min_d, max_d)
        if len(missing_dates) == 1:
            date_clause = f"created_date = toDate('{missing_dates[0]}')"
        elif len(contiguous_dates) == len(missing_dates):
            date_clause = f"created_date >= toDate('{min_d}') AND created_date <= toDate('{max_d}')"
        else:
            dates_sql = ", ".join(f"toDate('{d}')" for d in missing_dates)
            date_clause = f"created_date IN ({dates_sql})"

        sql = f"""
SELECT
    order_id,
    biker_id,
    source_latitude,
    source_longitude,
    source_hexagon,
    destination_latitude,
    destination_longitude,
    create_to_accept_contractual,
    created_date
FROM dwh_box.fact_ka
WHERE city = '{clean_city}'
  AND status = '{status}'
  AND customer_id = {customer_id}
  AND {date_clause}
LIMIT 1 BY order_id
"""
        print(f"Querying ClickHouse for {clean_city} ({len(missing_dates)} missing days: {min_d} to {max_d})...")
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
            sql_fallback = f"""
SELECT
    order_id,
    biker_id,
    source_latitude,
    source_longitude,
    destination_latitude,
    destination_longitude,
    create_to_accept_contractual
FROM dwh_box.fact_ka
WHERE city = '{clean_city}'
  AND status = '{status}'
  AND customer_id = {customer_id}
  AND created_date >= toDate('{min_d}')
  AND created_date <= toDate('{max_d}')
LIMIT 1 BY order_id
"""
            if hasattr(client, "query_df"):
                raw_df = client.query_df(sql_fallback)
            else:
                result = client.query(sql_fallback)
                raw_df = pd.DataFrame(result.result_rows, columns=result.column_names)

            if len(raw_df) > 0 and "created_date" not in raw_df.columns:
                raw_df["created_date"] = max_d

        # Partition returned rows into DAY_CACHE and file cache
        if len(raw_df) > 0 and "created_date" in raw_df.columns:
            for d_val, grp in raw_df.groupby("created_date"):
                d_key = str(d_val)[:10]
                day_copy = grp.copy()
                DAY_CACHE[(clean_city, status, customer_id, d_key)] = day_copy
                QUERIED_DATES.add((clean_city, status, customer_id, d_key))
                save_df_to_file("clickhouse", (clean_city, status, customer_id, d_key), day_copy)

        # Mark missing dates with no orders as queried with empty DataFrame
        for d in missing_dates:
            if (clean_city, status, customer_id, d) not in DAY_CACHE:
                empty_df = pd.DataFrame(columns=[
                    "order_id", "source_latitude", "source_longitude",
                    "destination_latitude", "destination_longitude",
                    "create_to_accept_contractual", "created_date"
                ])
                DAY_CACHE[(clean_city, status, customer_id, d)] = empty_df
                save_df_to_file("clickhouse", (clean_city, status, customer_id, d), empty_df)
            QUERIED_DATES.add((clean_city, status, customer_id, d))

        if force_refresh:
            data_source_label = f"ClickHouse Live Refreshed ({len(raw_df)} orders fetched for {len(missing_dates)} days)"
        elif len(missing_dates) < len(all_target_dates):
            cached_count = len(all_target_dates) - len(missing_dates)
            data_source_label = f"ClickHouse Live ({len(raw_df)} orders for {len(missing_dates)} missing days, {cached_count} from cache)"
        else:
            data_source_label = f"ClickHouse Live ({len(raw_df)} orders fetched for {len(missing_dates)} days)"
    else:
        data_source_label = f"⚡ File & Memory Cached ({len(all_target_dates)} days cached)"

    # Combine all target dates from DAY_CACHE
    day_frames = [
        DAY_CACHE[(clean_city, status, customer_id, d)]
        for d in all_target_dates
        if (clean_city, status, customer_id, d) in DAY_CACHE and len(DAY_CACHE[(clean_city, status, customer_id, d)]) > 0
    ]
    if day_frames:
        target_full_df = pd.concat(day_frames, ignore_index=True)
    else:
        target_full_df = pd.DataFrame(columns=[
            "order_id", "biker_id", "source_latitude", "source_longitude",
            "source_hexagon", "destination_latitude", "destination_longitude",
            "create_to_accept_contractual", "created_date"
        ])

    # Compute daily breakdown across all target dates
    daily_breakdown = compute_daily_breakdown(target_full_df, all_target_dates, threshold)

    # Filter for active/selected dates
    if selected_dates and len(selected_dates) > 0 and len(selected_dates) < len(all_target_dates):
        filtered_df = target_full_df[target_full_df["created_date"].isin(selected_dates)].copy()
    else:
        filtered_df = target_full_df

    return filtered_df, data_source_label, daily_breakdown, all_target_dates


def parse_csv_orders(csv_bytes: bytes) -> pd.DataFrame:
    """Parse uploaded custom orders CSV into required DataFrame format."""
    df = pd.read_csv(io.BytesIO(csv_bytes))
    required = ["source_latitude", "source_longitude"]
    for col in required:
        if col not in df.columns:
            raise ValueError(f"Uploaded CSV must contain '{col}' column")

    if "order_id" not in df.columns:
        df["order_id"] = [f"CSV-{i}" for i in range(len(df))]

    if "biker_id" not in df.columns:
        for alias in ["courier_id", "driver_id", "rider_id", "biker", "courier"]:
            if alias in df.columns:
                df["biker_id"] = df[alias]
                break

    if "source_hexagon" not in df.columns:
        for alias in ["hex", "hexagon", "h3", "source_hex"]:
            if alias in df.columns:
                df["source_hexagon"] = df[alias]
                break

    if "destination_latitude" not in df.columns:
        df["destination_latitude"] = df["source_latitude"]
    if "destination_longitude" not in df.columns:
        df["destination_longitude"] = df["source_longitude"]

    if "create_to_accept_contractual" not in df.columns:
        candidates = ["duration", "create_to_accept", "accept_time", "time_to_accept"]
        found = False
        for c in candidates:
            if c in df.columns:
                df["create_to_accept_contractual"] = df[c]
                found = True
                break
        if not found:
            df["create_to_accept_contractual"] = 15.0

    df["source_latitude"] = pd.to_numeric(df["source_latitude"], errors="coerce")
    df["source_longitude"] = pd.to_numeric(df["source_longitude"], errors="coerce")
    df["create_to_accept_contractual"] = pd.to_numeric(df["create_to_accept_contractual"], errors="coerce")
    df = df.dropna(subset=["source_latitude", "source_longitude"]).copy()

    if "created_date" not in df.columns:
        df["created_date"] = "2026-10-22"

    return df
