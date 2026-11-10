import unittest
import pandas as pd
import numpy as np

from app.cities import get_city_info, normalize_city_name
from app.data_source import generate_realistic_orders, fetch_orders
from app.engine import to_cell, prepare_base, rollup, compute_ha_scale, analyze_city_orders
from app.export_html import build_standalone_html


class TestEngine(unittest.TestCase):
    def test_city_lookup(self):
        isf = get_city_info("isfahan")
        self.assertEqual(isf["name"], "Isfahan")
        self.assertAlmostEqual(isf["lat"], 32.6546, places=2)
        self.assertAlmostEqual(isf["lng"], 51.6680, places=2)

        teh = get_city_info("tehran")
        self.assertEqual(teh["name"], "Tehran")

        # Unknown city fallback
        unknown = get_city_info("atlantis")
        self.assertIn("lat", unknown)
        self.assertIn("lng", unknown)

    def test_to_cell(self):
        cell = to_cell(32.6546, 51.6680, 8)
        self.assertIsNotNone(cell)
        self.assertTrue(len(cell) > 5)

        # Invalid lat/lng
        self.assertIsNone(to_cell("invalid", 51.66, 8))
        self.assertIsNone(to_cell(0, 0, 8))
        self.assertIsNone(to_cell(150, 200, 8))

    def test_generate_and_analyze_orders(self):
        df = generate_realistic_orders("isfahan", n_orders=500)
        self.assertEqual(len(df), 500)
        self.assertIn("source_latitude", df.columns)
        self.assertIn("destination_latitude", df.columns)
        self.assertIn("create_to_accept_contractual", df.columns)

        analysis = analyze_city_orders(df, threshold=30, min_orders=3, res_min=6, res_max=8, res_default=7)
        self.assertIn("kpis", analysis)
        self.assertEqual(analysis["kpis"]["total_orders"], 500)
        self.assertIn("layers", analysis)
        self.assertIn("source", analysis["layers"])
        self.assertIn("destination", analysis["layers"])
        self.assertIn("7", analysis["layers"]["source"]["res"])

        hexes = analysis["layers"]["source"]["res"]["7"]["hexes"]
        self.assertTrue(len(hexes) > 0)
        first_hex = hexes[0]
        self.assertIn("pct", first_hex)
        self.assertIn("orders", first_hex)
        self.assertIn("slow", first_hex)
        self.assertIn("color", first_hex)

    def test_export_html(self):
        df = generate_realistic_orders("shiraz", n_orders=200)
        analysis = analyze_city_orders(df, threshold=30, min_orders=3, res_min=7, res_max=8, res_default=8)
        html = build_standalone_html(analysis, "shiraz", 2, "2026-10-22", "2026-11-05", 30, 3)
        self.assertIn("<!DOCTYPE html>", html)
        self.assertIn("Shiraz", html)
        self.assertIn("HA30", html)
        self.assertIn("leaflet", html)


if __name__ == "__main__":
    unittest.main()
