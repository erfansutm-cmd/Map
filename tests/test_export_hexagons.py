import unittest
import h3
from app.export_hexagons import (
    resolve_hexagons_by_resolution,
    generate_hexagons_csv,
    generate_hexagons_txt,
)


class TestExportHexagons(unittest.TestCase):
    def setUp(self):
        # Create 2 test cells at resolution 8
        self.cell_1 = h3.latlng_to_cell(32.65, 51.66, 8)
        self.cell_2 = h3.latlng_to_cell(32.655, 51.665, 8)
        self.cells = [self.cell_1, self.cell_2]

    def test_current_resolution(self):
        items = resolve_hexagons_by_resolution(self.cells, "current")
        self.assertGreater(len(items), 0)
        for it in items:
            self.assertEqual(it["resolution"], 8)
            self.assertIn("hex_id", it)
            self.assertIn("latitude", it)
            self.assertIn("longitude", it)

    def test_parent_resolution_7(self):
        items = resolve_hexagons_by_resolution(self.cells, "7")
        self.assertGreater(len(items), 0)
        for it in items:
            self.assertEqual(it["resolution"], 7)

    def test_parent_resolution_6(self):
        items = resolve_hexagons_by_resolution(self.cells, "6")
        self.assertGreater(len(items), 0)
        for it in items:
            self.assertEqual(it["resolution"], 6)

    def test_children_resolution_9(self):
        items = resolve_hexagons_by_resolution(self.cells, "9")
        # Each res 8 cell has 7 res 9 children
        self.assertGreaterEqual(len(items), 7)
        for it in items:
            self.assertEqual(it["resolution"], 9)

    def test_all_resolutions(self):
        items = resolve_hexagons_by_resolution(self.cells, "all")
        self.assertEqual(len(items), len(self.cells))
        for it in items:
            self.assertIn("parent_res6", it)
            self.assertIn("parent_res7", it)
            self.assertIn("parent_res8", it)

    def test_generate_csv(self):
        csv_text, count = generate_hexagons_csv(self.cells, "8", "isfahan")
        self.assertGreater(count, 0)
        lines = csv_text.strip().split("\n")
        self.assertEqual(lines[0], "hex_id,resolution,latitude,longitude,city")
        self.assertIn("isfahan", lines[1])

    def test_generate_txt(self):
        txt_text, count = generate_hexagons_txt(self.cells, "current")
        self.assertGreater(count, 0)
        lines = txt_text.strip().split("\n")
        self.assertEqual(len(lines), count)
        self.assertTrue(lines[0].startswith("88"))

    def test_api_export_hexagons_csv(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        res = client.post("/api/export-hexagons", json={
            "city": "isfahan",
            "cells": self.cells,
            "target_res": "8",
            "format": "csv"
        })
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/csv", res.headers.get("content-type"))
        self.assertIn("attachment; filename=", res.headers.get("content-disposition"))
        lines = res.text.strip().split("\n")
        self.assertEqual(lines[0], "hex_id,resolution,latitude,longitude,city")

    def test_api_export_hexagons_txt(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        res = client.post("/api/export-hexagons", json={
            "city": "isfahan",
            "cells": self.cells,
            "target_res": "7",
            "format": "txt"
        })
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/plain", res.headers.get("content-type"))
        self.assertIn("attachment; filename=", res.headers.get("content-disposition"))

    def test_api_export_hexagons_json(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        res = client.post("/api/export-hexagons", json={
            "city": "isfahan",
            "cells": self.cells,
            "target_res": "all",
            "format": "json"
        })
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["count"], len(self.cells))


    def test_api_export_hexagons_with_aliases(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        res = client.post("/api/export-hexagons", json={
            "city": "isfahan",
            "hex_ids": self.cells,
            "target_resolution": "9",
            "format": "txt"
        })
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/plain", res.headers.get("content-type"))
        self.assertGreater(int(res.headers.get("x-hexagons-count", 0)), 0)

    def test_template_elements_present(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        res = client.get("/")
        self.assertEqual(res.status_code, 200)
        html = res.text
        # Verify hexagon export card elements (without unnecessary resolution selector)
        self.assertNotIn('id="selectHexExportRes"', html)
        self.assertNotIn('id="mergedCellsList"', html)
        self.assertIn('id="btnExportHexCsv"', html)
        self.assertIn('id="btnExportHexTxt"', html)
        self.assertIn('id="btnCopyHexList"', html)
        # Verify compact merged KPI grid
        self.assertIn('class="merged-kpi-grid"', html)
        # Verify prominent top biker buttons (and only one set of buttons)
        self.assertIn('id="btnOpenBikerModal"', html)
        self.assertIn('id="btnExportBikersCsv"', html)
        self.assertNotIn('id="btnOpenBikerModalBottom"', html)
        self.assertNotIn('id="btnExportBikersCsvBottom"', html)
        # Verify sticky modal footer class
        self.assertIn('class="biker-modal-footer"', html)


if __name__ == "__main__":
    unittest.main()
