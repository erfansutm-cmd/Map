import unittest
import xml.etree.ElementTree as ET
from fastapi.testclient import TestClient

from app.export_kml import build_kml_boundaries
from app.main import app


class TestKmlExport(unittest.TestCase):
    def setUp(self):
        self.sample_cells = ["881f18b321fffff", "881f18b323fffff"]
        self.client = TestClient(app)

    def test_build_kml_boundaries_valid_xml(self):
        kml = build_kml_boundaries(self.sample_cells, "Test Document")
        root = ET.fromstring(kml)

        # XML namespace for KML 2.2
        ns = {"kml": "http://www.opengis.net/kml/2.2"}
        self.assertTrue(root.tag.endswith("kml"))

        doc = root.find("kml:Document", ns)
        self.assertIsNotNone(doc)

        name = doc.find("kml:name", ns)
        self.assertEqual(name.text, "Test Document")

        # Check Style contains fill=0 and outline=1 (just boundaries)
        style = doc.find("kml:Style", ns)
        self.assertIsNotNone(style)
        poly_style = style.find("kml:PolyStyle", ns)
        self.assertIsNotNone(poly_style)
        self.assertEqual(poly_style.find("kml:fill", ns).text, "0")
        self.assertEqual(poly_style.find("kml:outline", ns).text, "1")

        # Check Placemarks
        placemarks = doc.findall("kml:Placemark", ns)
        self.assertEqual(len(placemarks), 2)

        for pm in placemarks:
            p_name = pm.find("kml:name", ns).text
            self.assertIn(p_name, self.sample_cells)

            polygon = pm.find("kml:Polygon", ns)
            self.assertIsNotNone(polygon)
            coords = polygon.find("kml:outerBoundaryIs/kml:LinearRing/kml:coordinates", ns).text.strip()
            coord_list = coords.split()

            # Hexagon has 6 vertices + 1 closing vertex = 7 points
            self.assertEqual(len(coord_list), 7)
            # LinearRing must be closed
            self.assertEqual(coord_list[0], coord_list[-1])

            # Coordinates must be lng,lat,0
            lng, lat, alt = coord_list[0].split(",")
            self.assertEqual(alt, "0")
            self.assertTrue(float(lng) > 0)
            self.assertTrue(float(lat) > 0)

    def test_api_export_kml_get(self):
        res = self.client.get("/api/export-kml?cells=881f18b321fffff,881f18b323fffff")
        self.assertEqual(res.status_code, 200)
        self.assertIn("application/vnd.google-earth.kml+xml", res.headers.get("content-type"))
        self.assertIn("selected_2_cells_boundaries.kml", res.headers.get("content-disposition"))

        root = ET.fromstring(res.text)
        self.assertTrue(root.tag.endswith("kml"))

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


if __name__ == "__main__":
    unittest.main()
