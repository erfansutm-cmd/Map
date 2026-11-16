"""
Biker Boundary Rides Analysis & CSV Export Service.
Computes biker rides within designated H3 boundary cells versus total rides in period,
filtering by minimum rides and boundary ride percentage (more or less).
"""
import io
import csv
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union
import numpy as np
import pandas as pd
import h3


def compute_biker_boundary_rides(
    df: pd.DataFrame,
    cells: Iterable[Union[str, Dict[str, Any]]],
    min_rides: int = 0,
    toggle: str = "less",
    percentage: float = 20.0,
    layer: str = "source",
) -> pd.DataFrame:
    """
    Compute biker ride metrics inside vs outside designated boundary cells.

    Returns DataFrame with columns:
    - biker_id
    - total_rides_in_period
    - total_rides_in_boundary
    - percentage_of_rides_in_boundary
    """
    empty_df = pd.DataFrame(columns=[
        "biker_id",
        "total_rides_in_period",
        "total_rides_in_boundary",
        "percentage_of_rides_in_boundary",
    ])

    if len(df) == 0:
        return empty_df

    # Extract cell IDs
    cell_ids = set()
    for item in cells:
        if isinstance(item, dict):
            c = str(item.get("hex") or "").strip().lower()
            if c:
                cell_ids.add(c)
        else:
            c = str(item).strip().lower()
            if c:
                cell_ids.add(c)

    if not cell_ids:
        return empty_df

    # Determine coordinate columns
    lat_col = "destination_latitude" if layer == "destination" and "destination_latitude" in df.columns else "source_latitude"
    lng_col = "destination_longitude" if layer == "destination" and "destination_longitude" in df.columns else "source_longitude"

    if lat_col not in df.columns or lng_col not in df.columns:
        return empty_df

    # Standardize biker_id column
    biker_col = "biker_id" if "biker_id" in df.columns else None
    if not biker_col:
        for alias in ["courier_id", "driver_id", "rider_id", "biker"]:
            if alias in df.columns:
                biker_col = alias
                break
    if not biker_col:
        return empty_df

    # Filter out missing coordinates and null bikers
    valid = df[df[lat_col].notnull() & df[lng_col].notnull() & df[biker_col].notnull()].copy()
    if len(valid) == 0:
        return empty_df

    # Strictly filter customer_id = 2 if customer_id column exists
    cust_col = None
    for c in df.columns:
        if c.lower() in ("customer_id", "customer"):
            cust_col = c
            break
    if cust_col is not None:
        valid = valid[valid[cust_col].astype(str).str.strip() == "2"]
    if len(valid) == 0:
        return empty_df

    # Ensure biker_id is clean string or integer
    valid["biker_clean"] = valid[biker_col].astype(str).str.strip()
    valid = valid[valid["biker_clean"] != ""]
    if len(valid) == 0:
        return empty_df

    # Group target cells by resolution
    res_groups: Dict[int, set] = {}
    for c in cell_ids:
        try:
            r = h3.get_resolution(c)
            res_groups.setdefault(r, set()).add(c)
        except Exception:
            continue

    if not res_groups:
        return empty_df

    lats = valid[lat_col].to_numpy(dtype=float)
    lngs = valid[lng_col].to_numpy(dtype=float)

    in_boundary_mask = np.zeros(len(valid), dtype=bool)
    for r, r_cells in res_groups.items():
        cell_arr = [h3.latlng_to_cell(lat, lng, r) for lat, lng in zip(lats, lngs)]
        r_mask = np.array([c in r_cells for c in cell_arr], dtype=bool)
        in_boundary_mask |= r_mask

    valid["in_boundary"] = in_boundary_mask

    # Order ID column
    order_col = "order_id" if "order_id" in valid.columns else valid.columns[0]

    stats = valid.groupby("biker_clean").agg(
        total_rides=(order_col, "count"),
        boundary_rides=("in_boundary", "sum"),
    ).reset_index()

    stats["percentage_of_rides_in_boundary"] = np.where(
        stats["total_rides"] > 0,
        np.round((stats["boundary_rides"] / stats["total_rides"]) * 100.0, 2),
        0.0,
    )

    # Filter 1: minimum total rides in period (>= 0)
    effective_min_rides = max(0, int(min_rides))
    filtered = stats[stats["total_rides"] >= effective_min_rides].copy()

    # Filter 2: percentage toggle (more or less)
    norm_toggle = str(toggle).strip().lower()
    target_pct = float(percentage)

    if norm_toggle == "more":
        filtered = filtered[filtered["percentage_of_rides_in_boundary"] >= target_pct]
        filtered = filtered.sort_values(by=["percentage_of_rides_in_boundary", "total_rides"], ascending=[False, False])
    else:  # default 'less'
        filtered = filtered[filtered["percentage_of_rides_in_boundary"] <= target_pct]
        filtered = filtered.sort_values(by=["percentage_of_rides_in_boundary", "total_rides"], ascending=[True, False])

    filtered = filtered.rename(columns={
        "biker_clean": "biker_id",
        "total_rides": "total_rides_in_period",
        "boundary_rides": "total_rides_in_boundary",
    })

    return filtered[["biker_id", "total_rides_in_period", "total_rides_in_boundary", "percentage_of_rides_in_boundary"]]


def generate_biker_rides_csv(
    df: pd.DataFrame,
    cells: Iterable[Union[str, Dict[str, Any]]],
    min_rides: int = 0,
    toggle: str = "less",
    percentage: float = 20.0,
    layer: str = "source",
    sample_size: Optional[int] = None,
) -> Tuple[str, int]:
    """
    Generate CSV content and matched row count for filtered bikers in boundary.
    Supports random sampling (e.g. sample_size=100) from all matching bikers.
    Columns: biker_id, total_rides_in_period, total_rides_in_boundary, percentage_of_rides_in_boundary
    """
    filtered = compute_biker_boundary_rides(
        df=df,
        cells=cells,
        min_rides=min_rides,
        toggle=toggle,
        percentage=percentage,
        layer=layer,
    )

    if sample_size is not None and sample_size > 0 and len(filtered) > sample_size:
        filtered = filtered.sample(n=sample_size).reset_index(drop=True)

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow([
        "biker_id",
        "total_rides_in_period",
        "total_rides_in_boundary",
        "percentage_of_rides_in_boundary",
    ])

    for row in filtered.itertuples():
        pct_str = f"{row.percentage_of_rides_in_boundary:.2f}%"
        writer.writerow([
            row.biker_id,
            row.total_rides_in_period,
            row.total_rides_in_boundary,
            pct_str,
        ])

    return buf.getvalue(), len(filtered)
