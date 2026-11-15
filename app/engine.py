"""
H3 Hexagon and HA30 Analysis Engine.
Implements multi-resolution aggregation (H3 6-10), SLA breach rate calculations (HA30%),
mean accept duration scaling, and operational bottleneck detection.
"""
import math
from typing import Dict, Any, List, Tuple, Optional
import h3
import numpy as np
import pandas as pd
from app.config import settings

# Optimized modern color palette: Soft Emerald Green -> Warm Amber Yellow -> Crimson Coral Red
GREEN = (46, 204, 113)    # 0% breach / fast SLA
YELLOW = (241, 196, 15)   # Mid breach / moderate duration
RED = (231, 76, 60)       # High breach / severe delay
GREY = (148, 163, 184)    # Slate grey for low-sample / unreliable (< MIN_ORDERS)


def hexcolor(rgb: Tuple[int, int, int]) -> str:
    return "#%02x%02x%02x" % rgb


def ha_ramp(t: float) -> Tuple[int, int, int]:
    """Color interpolation: 0.0 (best/green) to 1.0 (worst/red)."""
    t = min(max(t, 0.0), 1.0)
    if t < 0.5:
        a, b, f = GREEN, YELLOW, t / 0.5
    else:
        a, b, f = YELLOW, RED, (t - 0.5) / 0.5
    return tuple(round(a[i] + (b[i] - a[i]) * f) for i in range(3))


def to_cell(lat: Any, lng: Any, res: int) -> Optional[str]:
    """Convert latitude/longitude to an H3 cell at resolution `res`."""
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return None
    if math.isnan(lat) or math.isnan(lng) or (lat == 0 and lng == 0):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    return h3.latlng_to_cell(lat, lng, res)


def compute_biker_active_vendors_avg(df: pd.DataFrame) -> float:
    """
    Calculate average active vendors per biker:
    1. Filter orders where biker_id and vendor_id are present and valid (not null, not 0, not empty).
    2. For each biker, count the number of unique vendors they fulfilled orders for.
    3. Compute and return the average across all active bikers, rounded to 1 decimal place.
    """
    if df is None or len(df) == 0:
        return 0.0

    biker_col = None
    for c in df.columns:
        if c.lower() in ("biker_id", "courier_id", "driver_id", "rider_id", "biker", "courier"):
            biker_col = c
            break

    vendor_col = None
    for c in df.columns:
        if c.lower() in ("vendor_id", "vendor", "store_id", "shop_id", "merchant_id"):
            vendor_col = c
            break

    if biker_col is None or vendor_col is None:
        return 0.0

    bikers = df[biker_col]
    vendors = df[vendor_col]

    b_series = pd.Series(bikers.values, index=df.index)
    v_series = pd.Series(vendors.values, index=df.index)

    b_str = b_series.astype(str).str.strip()
    v_str = v_series.astype(str).str.strip()

    invalid_biker = b_series.isna() | (b_str == "") | (b_str == "0") | (b_str == "0.0") | b_str.str.lower().isin(["nan", "none", "null"])
    invalid_vendor = v_series.isna() | (v_str == "") | (v_str == "0") | (v_str == "0.0") | v_str.str.lower().isin(["nan", "none", "null"])

    valid_mask = (~invalid_biker) & (~invalid_vendor)

    # Strictly filter customer_id = 2 if customer_id column is present
    cust_col = None
    for c in df.columns:
        if c.lower() in ("customer_id", "customer"):
            cust_col = c
            break
    if cust_col is not None:
        c_str = df[cust_col].astype(str).str.strip()
        valid_mask = valid_mask & (c_str == "2")

    if not valid_mask.any():
        return 0.0

    clean_df = pd.DataFrame({
        "biker_id": b_str[valid_mask],
        "vendor_id": v_str[valid_mask]
    })

    vendors_per_biker = clean_df.groupby("biker_id")["vendor_id"].nunique()
    if len(vendors_per_biker) == 0:
        return 0.0

    return round(float(vendors_per_biker.mean()), 1)


def prepare_base(df: pd.DataFrame, lat_col: str, lng_col: str, threshold: int, res_max: int = 10) -> pd.DataFrame:
    """Aggregate orders per finest-level hexagon (RES_MAX)."""
    d = df.copy()
    d["hex"] = [to_cell(a, b, res_max) for a, b in zip(d[lat_col], d[lng_col])]
    d = d.dropna(subset=["hex"])
    if len(d) == 0:
        return pd.DataFrame(columns=["orders", "with_value", "slow", "vsum", "fare_sum", "inc_sum"])

    v = pd.Series(
        d["create_to_accept_contractual"].to_numpy(dtype="float64", na_value=float("nan")),
        index=d.index,
    )
    d["has"] = v.notna().astype(int)
    d["slow"] = (v >= threshold).astype(int)
    d["value"] = v.fillna(0)

    # Final biker fare extraction
    fare_col = "final_biker_fare" if "final_biker_fare" in d.columns else None
    if fare_col is None:
        for c in ["biker_fare", "fare"]:
            if c in d.columns:
                fare_col = c
                break

    if fare_col:
        fares = pd.to_numeric(d[fare_col], errors="coerce").fillna(0)
    else:
        fares = pd.Series(0.0, index=d.index)

    # Incentive extraction
    inc_col = "incentive" if "incentive" in d.columns else None
    if inc_col is None:
        for c in ["biker_incentive", "incentives", "bonus"]:
            if c in d.columns:
                inc_col = c
                break

    if inc_col:
        inc = pd.to_numeric(d[inc_col], errors="coerce").fillna(0)
    else:
        inc = pd.Series(0.0, index=d.index)

    d["fare_val"] = fares
    d["inc_val"] = inc

    base = d.groupby("hex").agg(
        orders=("order_id", "nunique"),
        with_value=("has", "sum"),
        slow=("slow", "sum"),
        vsum=("value", "sum"),
        fare_sum=("fare_val", "sum"),
        inc_sum=("inc_val", "sum"),
    )
    return base


def rollup(base: pd.DataFrame, res: int, min_orders: int, res_max: int = 10) -> pd.DataFrame:
    """Hexagon table at resolution `res`, summed up from the finest level."""
    if len(base) == 0:
        return pd.DataFrame(
            columns=[
                "hex", "orders", "with_value", "slow", "fast", "mean", "pct_slow",
                "avg_fare", "total_fare", "avg_incentive", "total_incentive",
                "reliable", "status"
            ]
        )

    if res == res_max:
        g = base.copy()
    else:
        parents = [h3.cell_to_parent(c, res) for c in base.index]
        g = base.groupby(parents).sum()

    g = g[g["with_value"] > 0].copy()
    g["fast"] = g["with_value"] - g["slow"]
    g["mean"] = g["vsum"] / g["with_value"]
    g["pct_slow"] = 100.0 * g["slow"] / g["with_value"]
    g["avg_fare"] = np.where(g["orders"] > 0, g["fare_sum"] / g["orders"], 0.0)
    g["total_fare"] = g["fare_sum"]
    g["avg_incentive"] = np.where(g["orders"] > 0, g["inc_sum"] / g["orders"], 0.0)
    g["total_incentive"] = g["inc_sum"]
    g["reliable"] = g["orders"] >= min_orders
    g.index.name = "hex"

    def get_status(row):
        if not row["reliable"]:
            return "low_sample"
        if row["pct_slow"] < 15.0:
            return "healthy"
        if row["pct_slow"] < 25.0:
            return "acceptable"
        if row["pct_slow"] < 35.0:
            return "warning"
        return "critical"

    g["status"] = g.apply(get_status, axis=1)
    return g.reset_index()


def compute_ha_scale(tables: List[pd.DataFrame], low_q: float = 0.05, high_q: float = 0.95) -> Tuple[float, float]:
    """Compute 5th and 95th percentiles of HA30% across reliable hexagons."""
    valid_tables = [t for t in tables if len(t) > 0]
    if not valid_tables:
        return 0.0, 100.0
    both = pd.concat(valid_tables)
    ok = both.loc[both["reliable"], "pct_slow"]
    if len(ok) >= 2:
        vmin = max(0.0, float(ok.quantile(low_q)))
        vmax = min(100.0, float(ok.quantile(high_q)))
        if vmax <= vmin:
            vmax = min(100.0, vmin + 10.0)
    elif len(ok) == 1:
        v = float(ok.iloc[0])
        vmin = max(0.0, v - 5.0)
        vmax = min(100.0, v + 5.0)
    else:
        vmin, vmax = 0.0, 50.0
    return round(vmin, 1), round(vmax, 1)


def compute_mean_scale(tables: List[pd.DataFrame], low_q: float = 0.05, high_q: float = 0.95) -> Tuple[float, float]:
    """Compute 5th and 95th percentiles of Mean duration across reliable hexagons."""
    valid_tables = [t for t in tables if len(t) > 0]
    if not valid_tables:
        return 10.0, 45.0
    both = pd.concat(valid_tables)
    ok = both.loc[both["reliable"], "mean"]
    if len(ok) >= 2:
        mmin = max(0.0, float(ok.quantile(low_q)))
        mmax = float(ok.quantile(high_q))
        if mmax <= mmin:
            mmax = mmin + 12.0
    elif len(ok) == 1:
        v = float(ok.iloc[0])
        mmin = max(0.0, v - 5.0)
        mmax = v + 12.0
    else:
        mmin, mmax = 12.0, 40.0
    return round(mmin, 1), round(mmax, 1)


def compute_share_scale(tables: List[pd.DataFrame], total_slow: int, high_q: float = 0.95) -> Tuple[float, float]:
    """Compute share scale (0.0 to 95th percentile of citywide HA order share across cells)."""
    if total_slow <= 0:
        return 0.0, 5.0
    shares = []
    for t in tables:
        if len(t) > 0 and "slow" in t.columns:
            s = (t["slow"].to_numpy(dtype=float) / total_slow) * 100.0
            shares.append(s)
    if not shares:
        return 0.0, 5.0
    all_shares = np.concatenate(shares)
    pos = all_shares[all_shares > 0]
    if len(pos) >= 2:
        smax = float(np.quantile(pos, high_q))
        smax = round(max(smax, 1.0), 1)
    elif len(pos) == 1:
        smax = round(max(float(pos[0]) * 1.2, 1.0), 1)
    else:
        smax = 5.0
    return 0.0, smax


def compute_fare_scale(tables: List[pd.DataFrame], low_q: float = 0.05, high_q: float = 0.95) -> Tuple[float, float]:
    """Compute 5th and 95th percentiles of avg_fare across reliable hexagons."""
    valid_tables = [t for t in tables if len(t) > 0]
    if not valid_tables:
        return 0.0, 60000.0

    frames = [t[t["reliable"]]["avg_fare"] for t in valid_tables if "reliable" in t.columns and "avg_fare" in t.columns]
    ok_fares = pd.concat(frames, ignore_index=True) if frames else pd.Series(dtype=float)

    if len(ok_fares) < 3:
        all_frames = [t["avg_fare"] for t in valid_tables if "avg_fare" in t.columns]
        ok_fares = pd.concat(all_frames, ignore_index=True) if all_frames else pd.Series(dtype=float)

    if len(ok_fares) == 0:
        return 0.0, 60000.0

    fmin = max(0.0, float(ok_fares.quantile(low_q)))
    fmax = float(ok_fares.quantile(high_q))
    if fmax <= fmin:
        fmax = fmin + 1000.0
    return round(fmin, 0), round(fmax, 0)


def hexes_to_dict(
    g: pd.DataFrame,
    vmin: float,
    vmax: float,
    mmin: float,
    mmax: float,
    threshold: int,
    total_city_slow: int = 0,
    smin: float = 0.0,
    smax: float = 5.0,
    fmin: float = 0.0,
    fmax: float = 60000.0,
) -> List[Dict[str, Any]]:
    """Convert hexagon DataFrame into rich JSON objects with multiple colors (HA30, Mean, City Share, and Biker Fare)."""
    if len(g) == 0:
        return []

    span_ha = (vmax - vmin) or 1.0
    span_mean = (mmax - mmin) or 1.0
    span_share = (smax - smin) or 1.0
    span_fare = (fmax - fmin) or 1.0

    orders_arr = g["orders"].to_numpy()
    p80_orders = np.percentile(orders_arr, 80) if len(orders_arr) else 10
    p20_orders = np.percentile(orders_arr, 20) if len(orders_arr) else 2

    out = []
    for row in g.itertuples():
        cell = row.hex
        pct = float(row.pct_slow)
        reliable = bool(row.reliable)
        orders = int(row.orders)
        slow = int(row.slow)
        fast = int(row.fast)
        with_value = int(row.with_value)
        mean_val = float(row.mean)
        status = str(row.status)
        share_pct = round((slow / total_city_slow * 100.0), 2) if total_city_slow > 0 else 0.0

        avg_fare = round(float(row.avg_fare), 0) if hasattr(row, "avg_fare") else 0.0
        total_fare = round(float(row.total_fare), 0) if hasattr(row, "total_fare") else 0.0
        avg_inc = round(float(row.avg_incentive), 0) if hasattr(row, "avg_incentive") else 0.0
        total_inc = round(float(row.total_incentive), 0) if hasattr(row, "total_incentive") else 0.0

        # Ramped Colors
        if reliable:
            t_ha = (pct - vmin) / span_ha
            color_ha = hexcolor(ha_ramp(t_ha))
            t_mean = (mean_val - mmin) / span_mean
            color_mean = hexcolor(ha_ramp(t_mean))
            t_share = (share_pct - smin) / span_share
            color_share = hexcolor(ha_ramp(t_share))
            t_fare = (avg_fare - fmin) / span_fare
            color_fare = hexcolor(ha_ramp(t_fare))
        else:
            color_ha = hexcolor(GREY)
            color_mean = hexcolor(GREY)
            color_share = hexcolor(GREY)
            color_fare = hexcolor(GREY)

        if orders >= p80_orders:
            vol_tier = "high"
        elif orders <= p20_orders:
            vol_tier = "low"
        else:
            vol_tier = "medium"

        lat, lng = h3.cell_to_latlng(cell)
        boundary = h3.cell_to_boundary(cell)

        out.append({
            "hex": cell,
            "center": [round(lat, 5), round(lng, 5)],
            "ring": [[round(a, 5), round(b, 5)] for a, b in boundary],
            "orders": orders,
            "ha30_count": slow,
            "slow": slow,
            "with_value": with_value,
            "pct": round(pct, 2),
            "mean": round(mean_val, 1),
            "share_pct": share_pct,
            "avg_fare": avg_fare,
            "total_fare": total_fare,
            "avg_incentive": avg_inc,
            "total_incentive": total_inc,
            "color": color_ha,        # Default to HA30
            "color_ha": color_ha,     # Color by HA30%
            "color_mean": color_mean, # Color by Mean duration
            "color_share": color_share, # Color by Share of citywide HA orders
            "color_fare": color_fare,   # Color by average final biker fare
            "reliable": reliable,
            "status": status,
            "vol_tier": vol_tier,
        })
    return out


def analyze_city_orders(
    df: pd.DataFrame,
    threshold: int = 30,
    min_orders: int = 5,
    res_min: int = 6,
    res_max: int = 10,
    res_default: int = 8,
    low_q: float = 0.05,
    high_q: float = 0.95,
) -> Dict[str, Any]:
    """
    Main entry point for calculating multi-resolution H3 hexagon data for Source and Destination.
    Provides dual color schemes (HA30% and Mean Duration) and citywide summary metrics.
    """
    total_orders = int(df["order_id"].nunique())
    v_series = pd.Series(df["create_to_accept_contractual"].dropna())
    total_slow = int((v_series >= threshold).sum())
    total_with_value = int(len(v_series))
    overall_ha_pct = round((total_slow / total_with_value * 100), 2) if total_with_value > 0 else 0.0
    overall_mean = round(float(v_series.mean()), 1) if total_with_value > 0 else 0.0
    p50_duration = round(float(v_series.median()), 1) if total_with_value > 0 else 0.0
    p90_duration = round(float(v_series.quantile(0.90)), 1) if total_with_value > 0 else 0.0
    p95_duration = round(float(v_series.quantile(0.95)), 1) if total_with_value > 0 else 0.0

    # Overall city status
    if overall_ha_pct < 15.0:
        sla_health = "HEALTHY"
    elif overall_ha_pct < 25.0:
        sla_health = "ACCEPTABLE"
    elif overall_ha_pct < 35.0:
        sla_health = "ELEVATED RISK"
    else:
        sla_health = "CRITICAL BREACH"

    # Base aggregations at RES_MAX
    base_src = prepare_base(df, "source_latitude", "source_longitude", threshold, res_max)
    base_dest = prepare_base(df, "destination_latitude", "destination_longitude", threshold, res_max)

    layers_dict = {
        "source": {"title": "Source Hexagons (Pickup Origin)", "res": {}},
        "destination": {"title": "Destination Hexagons (Dropoff Delivery)", "res": {}},
    }
    areas = {}

    for r in range(res_min, res_max + 1):
        tbl_src = rollup(base_src, r, min_orders, res_max)
        tbl_dest = rollup(base_dest, r, min_orders, res_max)

        vmin, vmax = compute_ha_scale([tbl_src, tbl_dest], low_q, high_q)
        mmin, mmax = compute_mean_scale([tbl_src, tbl_dest], low_q, high_q)
        smin, smax = compute_share_scale([tbl_src, tbl_dest], total_slow, high_q)
        fmin, fmax = compute_fare_scale([tbl_src, tbl_dest], low_q, high_q)

        scale_info = {
            "vmin": vmin,
            "vmax": vmax,
            "mmin": mmin,
            "mmax": mmax,
            "smin": smin,
            "smax": smax,
            "fmin": fmin,
            "fmax": fmax,
            "threshold": threshold,
            "min_orders": min_orders,
            "total_city_slow": total_slow,
        }

        layers_dict["source"]["res"][str(r)] = {
            "scale": scale_info,
            "hexes": hexes_to_dict(tbl_src, vmin, vmax, mmin, mmax, threshold, total_slow, smin, smax, fmin, fmax),
            "count": len(tbl_src),
            "reliable_count": int(tbl_src["reliable"].sum()) if len(tbl_src) else 0,
        }
        layers_dict["destination"]["res"][str(r)] = {
            "scale": scale_info,
            "hexes": hexes_to_dict(tbl_dest, vmin, vmax, mmin, mmax, threshold, total_slow, smin, smax, fmin, fmax),
            "count": len(tbl_dest),
            "reliable_count": int(tbl_dest["reliable"].sum()) if len(tbl_dest) else 0,
        }
        areas[str(r)] = f"~{h3.average_hexagon_area(r, 'km^2'):.2g} km\u00b2"

    # Identify critical operational bottlenecks at default resolution ranked by share of hyperact orders in city
    default_src_tbl = rollup(base_src, res_default, min_orders, res_max)
    bottlenecks = []
    best_performers = []
    if len(default_src_tbl) > 0:
        reliable_src = default_src_tbl[default_src_tbl["reliable"]].copy()
        if len(reliable_src) > 0:
            reliable_src["share_pct"] = (reliable_src["slow"] / total_slow * 100.0) if total_slow > 0 else 0.0
            sorted_bottlenecks = reliable_src.sort_values(by=["share_pct", "slow", "orders"], ascending=[False, False, False]).head(8)
            for row in sorted_bottlenecks.itertuples():
                c_lat, c_lng = h3.cell_to_latlng(row.hex)
                share_pct = round(float(row.slow) / float(total_slow) * 100.0, 2) if total_slow > 0 else 0.0
                bottlenecks.append({
                    "hex": row.hex,
                    "orders": int(row.orders),
                    "slow": int(row.slow),
                    "pct": round(float(row.pct_slow), 1),
                    "share_pct": share_pct,
                    "mean": round(float(row.mean), 1),
                    "center": [round(c_lat, 5), round(c_lng, 5)],
                    "status": row.status,
                })

            sorted_best = reliable_src.sort_values(by=["pct_slow", "orders"], ascending=[True, False]).head(5)
            for row in sorted_best.itertuples():
                c_lat, c_lng = h3.cell_to_latlng(row.hex)
                share_pct = round(float(row.slow) / float(total_slow) * 100.0, 2) if total_slow > 0 else 0.0
                best_performers.append({
                    "hex": row.hex,
                    "orders": int(row.orders),
                    "slow": int(row.slow),
                    "pct": round(float(row.pct_slow), 1),
                    "share_pct": share_pct,
                    "mean": round(float(row.mean), 1),
                    "center": [round(c_lat, 5), round(c_lng, 5)],
                    "status": row.status,
                })

    center_lat = float(df["source_latitude"].mean()) if len(df) else 32.6546
    center_lng = float(df["source_longitude"].mean()) if len(df) else 51.6680
    avg_vendors_per_biker = compute_biker_active_vendors_avg(df)

    fare_col = "final_biker_fare" if "final_biker_fare" in df.columns else None
    if fare_col is None:
        for c in ["biker_fare", "fare"]:
            if c in df.columns:
                fare_col = c
                break
    if fare_col:
        fares_numeric = pd.to_numeric(df[fare_col], errors="coerce").dropna()
        avg_city_fare = round(float(fares_numeric.mean()), 0) if len(fares_numeric) else 0.0
    else:
        avg_city_fare = 0.0

    inc_col = "incentive" if "incentive" in df.columns else None
    if inc_col is None:
        for c in ["biker_incentive", "incentives", "bonus"]:
            if c in df.columns:
                inc_col = c
                break
    if inc_col:
        inc_numeric = pd.to_numeric(df[inc_col], errors="coerce").dropna()
        avg_city_inc = round(float(inc_numeric.mean()), 0) if len(inc_numeric) else 0.0
    else:
        avg_city_inc = 0.0

    return {
        "kpis": {
            "total_orders": total_orders,
            "overall_ha_pct": overall_ha_pct,
            "ha30_count": total_slow,
            "total_slow": total_slow,
            "overall_mean_duration": overall_mean,
            "p50_duration": p50_duration,
            "p90_duration": p90_duration,
            "p95_duration": p95_duration,
            "sla_health": sla_health,
            "threshold": threshold,
            "min_orders": min_orders,
            "avg_vendors_per_biker": avg_vendors_per_biker,
            "avg_biker_fare": avg_city_fare,
            "avg_fare": avg_city_fare,
            "avg_incentive": avg_city_inc,
        },
        "center": [round(center_lat, 5), round(center_lng, 5)],
        "res_min": res_min,
        "res_max": res_max,
        "res_default": res_default,
        "areas": areas,
        "layers": layers_dict,
        "bottlenecks": bottlenecks,
        "best_performers": best_performers,
    }
