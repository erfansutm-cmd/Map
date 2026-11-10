import unittest
import pandas as pd
import numpy as np

from app.cities import get_city_info, normalize_city_name
from app.data_source import generate_realistic_orders, fetch_orders, get_dates_between
from app.engine import to_cell, prepare_base, rollup, compute_ha_scale, compute_mean_scale, analyze_city_orders
from app.export_html import build_standalone_html


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

    def test_day_filtering_and_daily_stats(self):
        dates = get_dates_between("2026-10-22", "2026-10-25")
        self.assertEqual(len(dates), 4)

        df, src, daily_stats, all_dates = fetch_orders("isfahan", start_date="2026-10-22", end_date="2026-10-25")
        self.assertEqual(len(all_dates), 4)
        self.assertEqual(len(daily_stats), 4)

        # Test selecting subset of dates
        subset = ["2026-10-22", "2026-10-23"]
        df_sub, _, _, _ = fetch_orders("isfahan", start_date="2026-10-22", end_date="2026-10-25", selected_dates=subset)
        self.assertTrue(df_sub["created_date"].isin(subset).all())
        self.assertTrue(len(df_sub) < len(df))

    def test_dual_color_metrics_and_citywide_stats(self):
        df = generate_realistic_orders("isfahan", n_orders=500)
        self.assertEqual(len(df), 500)
        self.assertIn("created_date", df.columns)

        analysis = analyze_city_orders(df, threshold=30, min_orders=3, res_min=6, res_max=8, res_default=7)
        kpis = analysis["kpis"]

        # Citywide SLA stats
        self.assertIn("overall_ha_pct", kpis)
        self.assertIn("sla_health", kpis)
        self.assertIn("p50_duration", kpis)
        self.assertIn("p90_duration", kpis)
        self.assertIn("p95_duration", kpis)

        # Dual colors on hexagons
        hexes = analysis["layers"]["source"]["res"]["7"]["hexes"]
        self.assertTrue(len(hexes) > 0)
        first_hex = hexes[0]
        self.assertIn("color_ha", first_hex)
        self.assertIn("color_mean", first_hex)
        self.assertIn("pct", first_hex)
        self.assertIn("mean", first_hex)

    def test_export_html(self):
        df = generate_realistic_orders("shiraz", n_orders=200)
        analysis = analyze_city_orders(df, threshold=30, min_orders=3, res_min=7, res_max=8, res_default=8)
        html = build_standalone_html(analysis, "shiraz", 2, "2026-10-22", "2026-11-05", 30, 3)
        self.assertIn("<!DOCTYPE html>", html)
        self.assertIn("Shiraz", html)
        self.assertIn("HA30", html)
        self.assertIn("leaflet", html)
        self.assertIn("Citywide HA", html)


if __name__ == "__main__":
    unittest.main()
