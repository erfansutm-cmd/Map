import unittest
import xml.etree.ElementTree as ET
from fastapi.testclient import TestClient

from app.export_kml import build_kml_boundaries, build_kml_two_layers, build_kml_outer_boundary
from app.main import app


class TestKmlExport(unittest.TestCase):
    def setUp(self):
        self.sample_cells = ["881f18b321fffff", "881f18b323fffff"]
        self.client = TestClient(app)

    def test_build_kml_two_layers_structure(self):
        kml = build_kml_boundaries(self.sample_cells, "Test Document")
        root = ET.fromstring(kml)

        # XML namespace for KML 2.2
        ns = {"kml": "http://www.opengis.net/kml/2.2"}
        self.assertTrue(root.tag.endswith("kml"))

        doc = root.find("kml:Document", ns)
        self.assertIsNotNone(doc)

        name = doc.find("kml:name", ns)
        self.assertEqual(name.text, "Test Document")

        # Check 2 distinct layers (Folders) exist
        folders = doc.findall("kml:Folder", ns)
        self.assertEqual(len(folders), 2)
        folder_names = [f.find("kml:name", ns).text for f in folders]
        self.assertIn("Per-Cell Boundaries", folder_names)
        self.assertIn("Outer Boundary (Black)", folder_names)

        # Check Layer 1 (Per-Cell Boundaries) has 2 hexagon placemarks
        cell_folder = folders[0]
        cell_placemarks = cell_folder.findall("kml:Placemark", ns)
        self.assertEqual(len(cell_placemarks), 2)

        for pm in cell_placemarks:
            p_name = pm.find("kml:name", ns).text
            self.assertIn(p_name, self.sample_cells)

            polygon = pm.find("kml:Polygon", ns)
            self.assertIsNotNone(polygon)
            coords = polygon.find("kml:outerBoundaryIs/kml:LinearRing/kml:coordinates", ns).text.strip()
            coord_list = coords.split()

            # Hexagon has 6 vertices + 1 closing vertex = 7 points
            self.assertEqual(len(coord_list), 7)
            self.assertEqual(coord_list[0], coord_list[-1])

            lng, lat, alt = coord_list[0].split(",")
            self.assertEqual(alt, "0")
            self.assertTrue(float(lng) > 0)
            self.assertTrue(float(lat) > 0)

        # Check Layer 2 (Outer Boundary) has 1 dissolved placemark with black styling
        outer_folder = folders[1]
        outer_placemarks = outer_folder.findall("kml:Placemark", ns)
        self.assertEqual(len(outer_placemarks), 1)
        outer_pm = outer_placemarks[0]
        style_url = outer_pm.find("kml:styleUrl", ns).text
        self.assertEqual(style_url, "#blackOuterBoundary")

    def test_build_kml_individual_mode(self):
        kml = build_kml_boundaries(self.sample_cells, "Test Document", mode="individual")
        root = ET.fromstring(kml)
        ns = {"kml": "http://www.opengis.net/kml/2.2"}
        doc = root.find("kml:Document", ns)
        placemarks = doc.findall("kml:Placemark", ns)
        self.assertEqual(len(placemarks), 2)

    def test_api_export_kml_get(self):
        res = self.client.get("/api/export-kml?cells=881f18b321fffff,881f18b323fffff")
        self.assertEqual(res.status_code, 200)
        self.assertIn("application/vnd.google-earth.kml+xml", res.headers.get("content-type"))
        self.assertIn("selected_2_cells_boundaries.kml", res.headers.get("content-disposition"))

        root = ET.fromstring(res.text)
        self.assertTrue(root.tag.endswith("kml"))
        ns = {"kml": "http://www.opengis.net/kml/2.2"}
        folders = root.findall(".//kml:Folder", ns)
        self.assertEqual(len(folders), 2)

    def test_api_export_kml_post(self):
        res = self.client.post(
            "/api/export-kml",
            json={"cells": self.sample_cells, "filename": "tehran_cells.kml"}
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn("tehran_cells.kml", res.headers.get("content-disposition"))

        root = ET.fromstring(res.text)
        self.assertTrue(root.tag.endswith("kml"))

    def test_api_export_kml_post_with_stats(self):
        cells_with_stats = [
            {"hex": "881f18b321fffff", "pct": 28.5, "orders": 1250, "ha30_count": 356, "mean": 21.4},
            {"hex": "881f18b323fffff", "pct": 14.2, "orders": 890, "ha30_count": 126, "mean": 17.8},
        ]
        res = self.client.post(
            "/api/export-kml",
            json={"cells": cells_with_stats, "filename": "stats_cells.kml"}
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn("HA30: 28.5%", res.text)
        self.assertIn("1,250 ord", res.text)
        self.assertIn("stats_cells.kml", res.headers.get("content-disposition"))

    def test_api_export_kml_empty_cells_error(self):
        res = self.client.get("/api/export-kml?cells=")
        self.assertEqual(res.status_code, 400)

    def test_build_kml_outer_boundary_black_style(self):
        cells_with_stats = [
            {"hex": "881f18b321fffff", "pct": 28.5, "orders": 1000, "slow": 285, "mean": 21.4},
            {"hex": "881f18b323fffff", "pct": 14.2, "orders": 500, "slow": 71, "mean": 17.8},
        ]
        kml = build_kml_outer_boundary(cells_with_stats, "Merged Zone")
        root = ET.fromstring(kml)
        ns = {"kml": "http://www.opengis.net/kml/2.2"}

        # Verify single merged placemark (no per-cell view)
        placemarks = root.findall(".//kml:Placemark", ns)
        self.assertEqual(len(placemarks), 1)

        # Verify black color styling
        style = root.find(".//kml:Style[@id='blackOuterBoundary']", ns)
        self.assertIsNotNone(style)
        line_color = style.find(".//kml:LineStyle/kml:color", ns)
        self.assertEqual(line_color.text, "ff000000")

    def test_api_cells_outer_boundary_endpoint(self):
        res = self.client.post("/api/cells/outer-boundary", json={"cells": self.sample_cells})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn(data["type"], ["Polygon", "MultiPolygon"])
        self.assertTrue(len(data["coordinates"]) > 0)

    def test_api_export_kml_outer_mode(self):
        res = self.client.post(
            "/api/export-kml",
            json={"cells": self.sample_cells, "filename": "merged_zone.kml", "mode": "outer"}
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn("ff000000", res.text)
        self.assertIn("Merged Region Outer Boundary", res.text)


if __name__ == "__main__":
    unittest.main()
