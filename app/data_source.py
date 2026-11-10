"""
Data Source abstraction layer.
Connects to ClickHouse (if configured via connect.py or environment variables),
or generates realistic high-fidelity order distribution for any requested city,
or loads custom uploaded CSV files.
"""
import io
import math
import os
import sys
from typing import Optional, Tuple, Dict, Any
import numpy as np
import pandas as pd

from app.config import settings
from app.cities import get_city_info, normalize_city_name


def try_get_clickhouse_client():
    """Try to obtain a ClickHouse client from connect.py or settings."""
    # 1. Try local connect.py if present
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

    # 2. Try clickhouse-connect using env vars
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
                connect_timeout=5,
            )
            return client, "clickhouse_connect"
        except Exception as e:
            print(f"ClickHouse connection failed ({settings.CLICKHOUSE_HOST}): {e}")

    return None, None


def generate_realistic_orders(
    city: str,
    status: str = "DELIVERED",
    customer_id: int = 2,
    start_date: str = "2026-10-22",
    end_date: str = "2026-11-05",
    threshold: int = 30,
    n_orders: int = 3200,
) -> pd.DataFrame:
    """
    Generate realistic high-fidelity order distribution for any given city.
    Produces spatially clustered pickup & dropoff coordinates with realistic
    create_to_accept_contractual durations (SLA breach hotspots in congested areas).
    """
    city_info = get_city_info(city)
    center_lat = city_info["lat"]
    center_lng = city_info["lng"]
    radius_km = city_info.get("radius_km", 14)

    # 1 km in degrees approximately
    deg_lat_km = 1.0 / 111.0
    deg_lng_km = 1.0 / (111.0 * math.cos(math.radians(center_lat)))

    # Seed deterministically by city name and params
    seed_str = f"{city_info['key']}_{customer_id}_{start_date}_{end_date}"
    seed = sum(ord(c) * (i + 1) for i, c in enumerate(seed_str)) % (2**32 - 1)
    rng = np.random.default_rng(seed)

    # 4-6 pickup commercial cluster centers in the city
    n_clusters = rng.integers(4, 7)
    cluster_centers = []
    for _ in range(n_clusters):
        c_lat = center_lat + rng.normal(0, radius_km * 0.4 * deg_lat_km)
        c_lng = center_lng + rng.normal(0, radius_km * 0.4 * deg_lng_km)
        weight = rng.uniform(0.1, 0.4)
        cluster_centers.append((c_lat, c_lng, weight))

    # Normalize weights
    total_w = sum(c[2] for c in cluster_centers)
    weights = [c[2] / total_w for c in cluster_centers]

    # Assign orders to clusters
    cluster_indices = rng.choice(len(cluster_centers), size=n_orders, p=weights)

    s_lats = np.zeros(n_orders)
    s_lngs = np.zeros(n_orders)
    for idx, (c_lat, c_lng, _) in enumerate(cluster_centers):
        mask = cluster_indices == idx
        count = int(np.sum(mask))
        if count > 0:
            s_lats[mask] = c_lat + rng.normal(0, radius_km * 0.12 * deg_lat_km, count)
            s_lngs[mask] = c_lng + rng.normal(0, radius_km * 0.12 * deg_lng_km, count)

    # Destinations: trip distance 1km to 8km
    trip_distance_km = rng.gamma(shape=2.5, scale=1.5, size=n_orders)
    trip_angles = rng.uniform(0, 2 * math.pi, n_orders)

    d_lats = s_lats + trip_distance_km * np.sin(trip_angles) * deg_lat_km
    d_lngs = s_lngs + trip_distance_km * np.cos(trip_angles) * deg_lng_km

    # Accept durations: contractual create_to_accept in seconds
    # Downtown / center zones have higher congestion -> higher SLA breach rate
    dist_to_center_km = np.sqrt(
        ((s_lats - center_lat) / deg_lat_km) ** 2 + ((s_lngs - center_lng) / deg_lng_km) ** 2
    )

    # Base duration ~ 12-18 seconds, plus congestion factor near center and cluster 0
    congestion_factor = np.exp(-((dist_to_center_km) / (radius_km * 0.45)) ** 2)
    slowdown = congestion_factor * 16.0  # extra seconds in congested downtown

    # Lognormal distribution to simulate dispatch queuing
    base_mu = np.log(14.0 + slowdown)
    base_sigma = 0.55
    durations = rng.lognormal(mean=base_mu, sigma=base_sigma, size=n_orders)
    # Clip to realistic bounds [2s .. 180s]
    durations = np.clip(durations, 2.0, 180.0)

    # Add ~1.5% missing/unreported duration values to match real dwh_box data behavior
    missing_mask = rng.uniform(0, 1, n_orders) < 0.015
    durations[missing_mask] = np.nan

    order_ids = [f"ORD-{city[:3].upper()}-{100000 + i}" for i in range(n_orders)]

    df = pd.DataFrame({
        "order_id": order_ids,
        "source_latitude": np.round(s_lats, 6),
        "source_longitude": np.round(s_lngs, 6),
        "destination_latitude": np.round(d_lats, 6),
        "destination_longitude": np.round(d_lngs, 6),
        "create_to_accept_contractual": durations,
    })
    return df


def fetch_orders(
    city: str,
    status: str = "DELIVERED",
    customer_id: int = 2,
    start_date: str = "2026-10-22",
    end_date: str = "2026-11-05",
    threshold: int = 30,
    force_simulated: bool = False,
) -> Tuple[pd.DataFrame, str]:
    """
    Fetch orders for the requested city.
    Returns (DataFrame, data_source_description).
    """
    clean_city = normalize_city_name(city)

    if not force_simulated:
        client, client_type = try_get_clickhouse_client()
        if client is not None:
            sql = f"""
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
            try:
                print(f"Executing ClickHouse query for city '{clean_city}'...")
                if hasattr(client, "query_df"):
                    df = client.query_df(sql)
                else:
                    result = client.query(sql)
                    df = pd.DataFrame(result.result_rows, columns=result.column_names)

                if len(df) > 0:
                    return df, f"ClickHouse Live ({len(df)} orders via {client_type})"
                else:
                    print(f"ClickHouse returned 0 rows for {clean_city}. Falling back to simulation.")
            except Exception as e:
                print(f"ClickHouse query error: {e}. Falling back to realistic simulation.")

    # High-fidelity realistic dataset for this city
    df = generate_realistic_orders(
        city=clean_city,
        status=status,
        customer_id=customer_id,
        start_date=start_date,
        end_date=end_date,
        threshold=threshold,
    )
    return df, "Simulated High-Fidelity Dataset"


def parse_csv_orders(content: bytes) -> pd.DataFrame:
    """Parse an uploaded CSV file containing order coordinates and duration."""
    df = pd.read_csv(io.BytesIO(content))
    # Standardize column names (lowercase and strip)
    df.columns = [c.strip().lower() for c in df.columns]

    # Map possible column synonyms
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
    }
    df = df.rename(columns={c: col_map[c] for c in df.columns if c in col_map})

    if "order_id" not in df.columns:
        df["order_id"] = [f"CSV-{i+1}" for i in range(len(df))]

    required = ["source_latitude", "source_longitude", "destination_latitude", "destination_longitude"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Uploaded CSV is missing required columns: {missing}")

    if "create_to_accept_contractual" not in df.columns:
        df["create_to_accept_contractual"] = 20.0  # default duration if missing

    return df
