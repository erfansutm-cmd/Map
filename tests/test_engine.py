import unittest
import pandas as pd
import numpy as np

from app.cities import get_city_info, normalize_city_name
from app.data_source import (
    get_dates_between,
    compute_daily_breakdown,
    parse_csv_orders,
    fetch_orders,
)
from app.engine import (
    to_cell,
    prepare_base,
    rollup,
    compute_ha_scale,
    compute_mean_scale,
    analyze_city_orders,
)
from app.export_html import build_standalone_html


def make_sample_orders_df(city: str = "isfahan", n_orders: int = 200) -> pd.DataFrame:
    """Create a minimal deterministic DataFrame for unit testing without mock generators."""
    info = get_city_info(city)
    lat, lng = info["lat"], info["lng"]

    np.random.seed(42)
    lats = lat + np.random.uniform(-0.04, 0.04, n_orders)
    lngs = lng + np.random.uniform(-0.04, 0.04, n_orders)
    dest_lats = lats + np.random.uniform(-0.02, 0.02, n_orders)
    dest_lngs = lngs + np.random.uniform(-0.02, 0.02, n_orders)
    durations = np.random.exponential(scale=18.0, size=n_orders)

    dates = ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]
    created_dates = np.random.choice(dates, size=n_orders)

    vendor_ids = [5000 + (i % 8) for i in range(n_orders)]
    biker_ids = [1000 + (i % 12) for i in range(n_orders)]

    fares = np.random.uniform(35000, 65000, size=n_orders)
    incentives = np.random.uniform(0, 15000, size=n_orders)

    return pd.DataFrame({
        "order_id": [f"ord_{i}" for i in range(n_orders)],
        "vendor_id": vendor_ids,
        "biker_id": biker_ids,
        "source_latitude": lats,
        "source_longitude": lngs,
        "destination_latitude": dest_lats,
        "destination_longitude": dest_lngs,
        "create_to_accept_contractual": durations,
        "created_date": created_dates,
        "final_biker_fare": fares,
        "incentive": incentives,
    })


class TestEngine(unittest.TestCase):
    def test_city_lookup(self):
        isf = get_city_info("isfahan")
        self.assertEqual(isf["name"], "Isfahan")
        self.assertAlmostEqual(isf["lat"], 32.6546, places=2)
        self.assertAlmostEqual(isf["lng"], 51.6680, places=2)

        teh = get_city_info("tehran")
        self.assertEqual(teh["name"], "Tehran")

        unknown = get_city_info("atlantis")
        self.assertIn("lat", unknown)
        self.assertIn("lng", unknown)

    def test_to_cell(self):
        cell = to_cell(32.6546, 51.6680, 8)
        self.assertIsNotNone(cell)
        self.assertTrue(len(cell) > 5)

        self.assertIsNone(to_cell("invalid", 51.66, 8))
        self.assertIsNone(to_cell(0, 0, 8))
        self.assertIsNone(to_cell(150, 200, 8))

    def test_daily_breakdown_and_dates(self):
        dates = get_dates_between("2026-10-22", "2026-10-25")
        self.assertEqual(len(dates), 4)

        df = make_sample_orders_df("isfahan", n_orders=100)
        daily_stats = compute_daily_breakdown(df, dates, threshold=30)
        self.assertEqual(len(daily_stats), 4)
        for stat in daily_stats:
            self.assertIn("date", stat)
            self.assertIn("orders", stat)
            self.assertIn("ha30_count", stat)
            self.assertIn("pct", stat)

    def test_parse_csv_orders(self):
        csv_data = b"""order_id,source_latitude,source_longitude,destination_latitude,destination_longitude,create_to_accept_contractual,created_date
101,32.65,51.66,32.66,51.67,35.2,2026-10-22
102,32.652,51.662,32.662,51.672,12.5,2026-10-22
103,32.655,51.665,32.665,51.675,45.0,2026-10-23
"""
        df = parse_csv_orders(csv_data)
        self.assertEqual(len(df), 3)
        self.assertIn("create_to_accept_contractual", df.columns)

    def test_dual_color_metrics_and_citywide_stats(self):
        df = make_sample_orders_df("isfahan", n_orders=250)
        self.assertEqual(len(df), 250)

        analysis = analyze_city_orders(df, threshold=30, min_orders=2, res_min=6, res_max=8, res_default=7)
        kpis = analysis["kpis"]

        # Citywide SLA stats
        self.assertIn("overall_ha_pct", kpis)
        self.assertIn("ha30_count", kpis)
        self.assertIn("sla_health", kpis)
        self.assertIn("p50_duration", kpis)
        self.assertIn("p90_duration", kpis)
        self.assertIn("avg_vendors_per_biker", kpis)
        self.assertGreater(kpis["avg_vendors_per_biker"], 0)

        # Dual colors, City HA share, and HA30 fields on hexagons
        hexes = analysis["layers"]["source"]["res"]["7"]["hexes"]
        self.assertTrue(len(hexes) > 0)
        first_hex = hexes[0]
        self.assertIn("color_ha", first_hex)
        self.assertIn("color_mean", first_hex)
        self.assertIn("color_share", first_hex)
        self.assertIn("share_pct", first_hex)
        self.assertIn("pct", first_hex)
        self.assertIn("mean", first_hex)
        self.assertIn("slow", first_hex)
        self.assertIn("ha30_count", first_hex)

    def test_bottlenecks_ranking_by_city_hyper_share(self):
        df = make_sample_orders_df("isfahan", n_orders=300)
        analysis = analyze_city_orders(df, threshold=30, min_orders=2, res_min=6, res_max=8, res_default=7)
        bottlenecks = analysis["bottlenecks"]
        self.assertTrue(len(bottlenecks) > 0)
        shares = [b["share_pct"] for b in bottlenecks]
        self.assertEqual(shares, sorted(shares, reverse=True))
        for b in bottlenecks:
            self.assertIn("pct", b)
            self.assertIn("share_pct", b)
            self.assertIn("orders", b)
            self.assertIn("slow", b)
            self.assertIn("mean", b)

    def test_export_html(self):
        df = make_sample_orders_df("shiraz", n_orders=150)
        analysis = analyze_city_orders(df, threshold=30, min_orders=2, res_min=7, res_max=8, res_default=8)
        html = build_standalone_html(analysis, "shiraz", 2, "2026-10-22", "2026-11-05", 30, 2)
        self.assertIn("<!DOCTYPE html>", html)
        self.assertIn("Shiraz", html)
        self.assertIn("Orders Count", html)
        self.assertIn("create to accept time", html)
        self.assertIn("leaflet", html)
        self.assertIn("Citywide HA", html)

    def test_no_mock_data_raised_when_clickhouse_unreachable(self):
        # With default settings where ClickHouse is not running, fetch_orders must raise RuntimeError
        # and NEVER silently generate synthetic/mock data.
        with self.assertRaises(RuntimeError) as ctx:
            fetch_orders("tabriz", start_date="2026-10-22", end_date="2026-10-23", force_refresh=True)
        self.assertIn("ClickHouse", str(ctx.exception))

    def test_day_cache_serving_and_db_trigger_for_missing_days(self):
        from app.data_source import DAY_CACHE, QUERIED_DATES, clear_day_cache

        clear_day_cache()
        sample_df = make_sample_orders_df("isfahan", n_orders=50)

        # Pre-cache two days
        DAY_CACHE[("isfahan", "DELIVERED", 2, "2026-10-22")] = sample_df.iloc[:25].copy()
        DAY_CACHE[("isfahan", "DELIVERED", 2, "2026-10-23")] = sample_df.iloc[25:].copy()
        QUERIED_DATES.add(("isfahan", "DELIVERED", 2, "2026-10-22"))
        QUERIED_DATES.add(("isfahan", "DELIVERED", 2, "2026-10-23"))

        # When requesting cached days, it returns immediately with "Cached In-Memory"
        df, src_label, daily_stats, all_dates = fetch_orders(
            "isfahan", start_date="2026-10-22", end_date="2026-10-23"
        )
        self.assertEqual(len(df), 50)
        self.assertIn("Cached", src_label)
        self.assertEqual(len(all_dates), 2)

        # When requesting another day NOT in the cache (e.g. 2026-09-15 outside last 2 weeks),
        # it identifies missing day and triggers DB fetch (raising RuntimeError if DB unreachable)
        with self.assertRaises(RuntimeError) as ctx:
            fetch_orders("isfahan", start_date="2026-09-15", end_date="2026-09-15")
        self.assertIn("ClickHouse", str(ctx.exception))

    def test_biker_active_vendors_calculation(self):
        from app.engine import compute_biker_active_vendors_avg
        # 3 bikers, each visiting specific vendors:
        # Biker 101 visits vendor 501, 502 (2 vendors)
        # Biker 102 visits vendor 501 (1 vendor)
        # Biker 103 visits vendor 503 (1 vendor)
        # Biker 0 is filtered out
        # Avg = (2 + 1 + 1) / 3 = 1.333... -> 1.3
        df = pd.DataFrame({
            "biker_id": [101, 101, 102, 102, 103, 0, None],
            "vendor_id": [501, 502, 501, 501, 503, 501, 502]
        })
        res = compute_biker_active_vendors_avg(df)
        self.assertEqual(res, 1.3)

        # Check daily breakdown incorporates avg_vendors_per_biker
        sample_df = make_sample_orders_df("isfahan", n_orders=100)
        daily_stats = compute_daily_breakdown(sample_df, ["2026-10-22", "2026-10-23"], threshold=30)
        self.assertEqual(len(daily_stats), 2)
        for d in daily_stats:
            self.assertIn("avg_vendors_per_biker", d)
            self.assertGreater(d["avg_vendors_per_biker"], 0)
            self.assertIn("avg_fare", d)
            self.assertGreater(d["avg_fare"], 0)
            self.assertIn("avg_incentive", d)

    def test_fare_and_incentive_aggregation(self):
        from app.engine import prepare_base, rollup

        df = pd.DataFrame({
            "order_id": ["o1", "o2", "o3"],
            "source_latitude": [32.65, 32.65, 32.65],
            "source_longitude": [51.66, 51.66, 51.66],
            "create_to_accept_contractual": [12.0, 18.0, 24.0],
            "final_biker_fare": [40000.0, 50000.0, 60000.0],
            "incentive": [5000.0, 0.0, 10000.0],
        })
        base = prepare_base(df, "source_latitude", "source_longitude", threshold=30, res_max=8)
        self.assertEqual(len(base), 1)
        self.assertEqual(base["fare_sum"].iloc[0], 150000.0)
        self.assertEqual(base["inc_sum"].iloc[0], 15000.0)

        tbl = rollup(base, res=8, min_orders=1, res_max=8)
        self.assertEqual(len(tbl), 1)
        self.assertEqual(tbl["avg_fare"].iloc[0], 50000.0)
        self.assertEqual(tbl["total_fare"].iloc[0], 150000.0)
        self.assertEqual(tbl["avg_incentive"].iloc[0], 5000.0)
        self.assertEqual(tbl["total_incentive"].iloc[0], 15000.0)

    def test_analyze_city_orders_includes_fare(self):
        sample_df = make_sample_orders_df("isfahan", n_orders=200)
        result = analyze_city_orders(sample_df, threshold=30, res_min=8, res_max=8)
        hexes = result["layers"]["source"]["res"]["8"]["hexes"]
        self.assertGreater(len(hexes), 0)
        first_hex = hexes[0]
        self.assertIn("avg_fare", first_hex)
        self.assertIn("total_fare", first_hex)
        self.assertIn("avg_incentive", first_hex)
        self.assertIn("total_incentive", first_hex)
        self.assertIn("color_fare", first_hex)
        self.assertGreater(first_hex["avg_fare"], 0)

        scale = result["layers"]["source"]["res"]["8"]["scale"]
        self.assertIn("fmin", scale)
        self.assertIn("fmax", scale)
        self.assertGreater(scale["fmax"], scale["fmin"])

        kpis = result["kpis"]
        self.assertIn("avg_biker_fare", kpis)
        self.assertIn("avg_incentive", kpis)
        self.assertGreater(kpis["avg_biker_fare"], 0)


if __name__ == "__main__":
    unittest.main()
