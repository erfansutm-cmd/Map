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


def prepare_base(df: pd.DataFrame, lat_col: str, lng_col: str, threshold: int, res_max: int = 10) -> pd.DataFrame:
    """Aggregate orders per finest-level hexagon (RES_MAX)."""
    d = df.copy()
    d["hex"] = [to_cell(a, b, res_max) for a, b in zip(d[lat_col], d[lng_col])]
    d = d.dropna(subset=["hex"])
    if len(d) == 0:
        return pd.DataFrame(columns=["orders", "with_value", "slow", "vsum"])

    v = pd.Series(
        d["create_to_accept_contractual"].to_numpy(dtype="float64", na_value=float("nan")),
        index=d.index,
    )
    d["has"] = v.notna().astype(int)
    d["slow"] = (v >= threshold).astype(int)
    d["value"] = v.fillna(0)

    base = d.groupby("hex").agg(
        orders=("order_id", "nunique"),
        with_value=("has", "sum"),
        slow=("slow", "sum"),
        vsum=("value", "sum"),
    )
    return base


def rollup(base: pd.DataFrame, res: int, min_orders: int, res_max: int = 10) -> pd.DataFrame:
    """Hexagon table at resolution `res`, summed up from the finest level."""
    if len(base) == 0:
        return pd.DataFrame(
            columns=["hex", "orders", "with_value", "slow", "fast", "mean", "pct_slow", "reliable", "status"]
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
    g["reliable"] = g["orders"] >= min_orders
    g.index.name = "hex"

    def get_status(row):
        if not row["reliable"]:
            return "low_sample"
        if row["pct_slow"] < 15.0:
            return "optimal"
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


def hexes_to_dict(
    g: pd.DataFrame,
    vmin: float,
    vmax: float,
    mmin: float,
    mmax: float,
    threshold: int,
) -> List[Dict[str, Any]]:
    """Convert hexagon DataFrame into rich JSON objects with dual colors (HA30 and Mean)."""
    if len(g) == 0:
        return []

    span_ha = (vmax - vmin) or 1.0
    span_mean = (mmax - mmin) or 1.0

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

        # HA30 Color Ramp
        if reliable:
            t_ha = (pct - vmin) / span_ha
            color_ha = hexcolor(ha_ramp(t_ha))
            t_mean = (mean_val - mmin) / span_mean
            color_mean = hexcolor(ha_ramp(t_mean))
        else:
            color_ha = hexcolor(GREY)
            color_mean = hexcolor(GREY)

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
            "color": color_ha,        # Default to HA30
            "color_ha": color_ha,     # Color by HA30%
            "color_mean": color_mean, # Color by Mean duration
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
        sla_health = "OPTIMAL"
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

        scale_info = {
            "vmin": vmin,
            "vmax": vmax,
            "mmin": mmin,
            "mmax": mmax,
            "threshold": threshold,
            "min_orders": min_orders,
        }

        layers_dict["source"]["res"][str(r)] = {
            "scale": scale_info,
            "hexes": hexes_to_dict(tbl_src, vmin, vmax, mmin, mmax, threshold),
            "count": len(tbl_src),
            "reliable_count": int(tbl_src["reliable"].sum()) if len(tbl_src) else 0,
        }
        layers_dict["destination"]["res"][str(r)] = {
            "scale": scale_info,
            "hexes": hexes_to_dict(tbl_dest, vmin, vmax, mmin, mmax, threshold),
            "count": len(tbl_dest),
            "reliable_count": int(tbl_dest["reliable"].sum()) if len(tbl_dest) else 0,
        }
        areas[str(r)] = f"~{h3.average_hexagon_area(r, 'km^2'):.2g} km\u00b2"

    # Identify critical operational bottlenecks at default resolution
    default_src_tbl = rollup(base_src, res_default, min_orders, res_max)
    bottlenecks = []
    best_performers = []
    if len(default_src_tbl) > 0:
        reliable_src = default_src_tbl[default_src_tbl["reliable"]].copy()
        if len(reliable_src) > 0:
            reliable_src["bottleneck_score"] = reliable_src["orders"] * (reliable_src["pct_slow"] ** 1.3)
            sorted_bottlenecks = reliable_src.sort_values(by="bottleneck_score", ascending=False).head(8)
            for row in sorted_bottlenecks.itertuples():
                c_lat, c_lng = h3.cell_to_latlng(row.hex)
                bottlenecks.append({
                    "hex": row.hex,
                    "orders": int(row.orders),
                    "slow": int(row.slow),
                    "pct": round(float(row.pct_slow), 1),
                    "mean": round(float(row.mean), 1),
                    "center": [round(c_lat, 5), round(c_lng, 5)],
                    "status": row.status,
                })

            sorted_best = reliable_src.sort_values(by=["pct_slow", "orders"], ascending=[True, False]).head(5)
            for row in sorted_best.itertuples():
                c_lat, c_lng = h3.cell_to_latlng(row.hex)
                best_performers.append({
                    "hex": row.hex,
                    "orders": int(row.orders),
                    "slow": int(row.slow),
                    "pct": round(float(row.pct_slow), 1),
                    "mean": round(float(row.mean), 1),
                    "center": [round(c_lat, 5), round(c_lng, 5)],
                    "status": row.status,
                })

    center_lat = float(df["source_latitude"].mean()) if len(df) else 32.6546
    center_lng = float(df["source_longitude"].mean()) if len(df) else 51.6680

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
