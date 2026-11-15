import unittest
import pandas as pd
import h3
from fastapi.testclient import TestClient

from app.export_biker_csv import compute_biker_boundary_rides, generate_biker_rides_csv
from app.main import app


class TestBikerCsvExport(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        # Create sample dataframe with 2 bikers
        self.cell_a = h3.latlng_to_cell(32.65, 51.66, 8)
        self.cell_b = h3.latlng_to_cell(35.70, 51.40, 8)

        self.df = pd.DataFrame({
            "order_id": ["o1", "o2", "o3", "o4", "o5", "o6"],
            "biker_id": ["B101", "B101", "B101", "B102", "B102", "B102"],
            "source_latitude": [32.65, 32.65, 35.70, 35.70, 35.70, 35.70],
            "source_longitude": [51.66, 51.66, 51.40, 51.40, 51.40, 51.40],
        })

    def test_compute_biker_boundary_rides_more(self):
        # Cell A: B101 has 2 of 3 rides (66.7%), B102 has 0 of 3 (0%)
        res = compute_biker_boundary_rides(
            self.df,
            cells=[self.cell_a],
            min_rides=2,
            toggle="more",
            percentage=50.0,
            layer="source"
        )
        self.assertEqual(len(res), 1)
        row = res.iloc[0]
        self.assertEqual(row["biker_id"], "B101")
        self.assertEqual(row["total_rides_in_period"], 3)
        self.assertEqual(row["total_rides_in_boundary"], 2)
        self.assertEqual(row["percentage_of_rides_in_boundary"], 66.67)

    def test_compute_biker_boundary_rides_less(self):
        res = compute_biker_boundary_rides(
            self.df,
            cells=[self.cell_a],
            min_rides=2,
            toggle="less",
            percentage=20.0,
            layer="source"
        )
        self.assertEqual(len(res), 1)
        row = res.iloc[0]
        self.assertEqual(row["biker_id"], "B102")
        self.assertEqual(row["total_rides_in_period"], 3)
        self.assertEqual(row["total_rides_in_boundary"], 0)
        self.assertEqual(row["percentage_of_rides_in_boundary"], 0.0)

    def test_min_rides_filter(self):
        # Requiring min 4 rides filters both bikers out
        res = compute_biker_boundary_rides(
            self.df,
            cells=[self.cell_a],
            min_rides=4,
            toggle="less",
            percentage=100.0,
        )
        self.assertEqual(len(res), 0)

    def test_generate_biker_rides_csv_format(self):
        csv_text, count = generate_biker_rides_csv(
            self.df,
            cells=[self.cell_a],
            min_rides=1,
            toggle="more",
            percentage=10.0,
        )
        self.assertEqual(count, 1)
        lines = csv_text.strip().split("\n")
        self.assertEqual(lines[0], "biker_id,total_rides_in_period,total_rides_in_boundary,percentage_of_rides_in_boundary")
        self.assertIn("B101,3,2,66.67%", lines[1])

    def test_api_export_biker_rides_csv_endpoint(self):
        res = self.client.post("/api/export-biker-rides-csv", json={
            "city": "isfahan",
            "start_date": "2026-10-22",
            "end_date": "2026-10-24",
            "cells": [self.cell_a],
            "min_rides": 1,
            "toggle": "less",
            "percentage": 100.0
        })
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/csv", res.headers.get("content-type"))
        self.assertIn("attachment; filename=", res.headers.get("content-disposition"))
        lines = res.text.strip().split("\n")
        self.assertEqual(lines[0], "biker_id,total_rides_in_period,total_rides_in_boundary,percentage_of_rides_in_boundary")

    def test_api_export_biker_rides_csv_empty_cells_error(self):
        res = self.client.post("/api/export-biker-rides-csv", json={
            "city": "isfahan",
            "cells": []
        })
        self.assertEqual(res.status_code, 400)

    def test_customer_id_filtering_in_boundary_rides(self):
        # Create df where B101 has orders under customer_id 2 and customer_id 1
        mixed_df = pd.DataFrame({
            "order_id": ["o1", "o2", "o3", "o4"],
            "biker_id": ["B201", "B201", "B201", "B201"],
            "customer_id": [2, 2, 1, 1],
            "source_latitude": [32.65, 32.65, 32.65, 32.65],
            "source_longitude": [51.66, 51.66, 51.66, 51.66],
        })
        res = compute_biker_boundary_rides(
            mixed_df,
            cells=[self.cell_a],
            min_rides=1,
            toggle="more",
            percentage=0.0
        )
        self.assertEqual(len(res), 1)
        # B201 should only have 2 rides counted (the ones with customer_id=2)
        self.assertEqual(res.iloc[0]["total_rides_in_period"], 2)
        self.assertEqual(res.iloc[0]["total_rides_in_boundary"], 2)


if __name__ == "__main__":
    unittest.main()
