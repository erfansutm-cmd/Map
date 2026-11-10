"""
KML Export Service.
Generates OGC KML 2.2 documents containing just the boundary polygons of selected H3 cells.
"""
from typing import Iterable, List
import h3


def build_kml_boundaries(cells: Iterable[str], document_name: str = "Selected Cell Boundaries") -> str:
    """
    Generate valid OGC KML 2.2 containing just the boundaries of the specified H3 cells.
    Each cell is represented as a Placemark with a closed LinearRing Polygon,
    styled with no fill (fill=0) and crisp boundary outlines (outline=1).
    """
    placemarks: List[str] = []
    seen = set()

    for raw_cell in cells:
        cell = str(raw_cell).strip().lower()
        if not cell or cell in seen:
            continue
        seen.add(cell)

        try:
            # h3.cell_to_boundary returns tuple of (lat, lng)
            boundary = h3.cell_to_boundary(cell)
            if not boundary or len(boundary) < 3:
                continue

            # KML coordinates must be formatted as "longitude,latitude,altitude"
            coord_pairs = [f"{round(lng, 6)},{round(lat, 6)},0" for lat, lng in boundary]

            # Ensure LinearRing is closed (first point matches last point)
            first_lng, first_lat = boundary[0][1], boundary[0][0]
            last_lng, last_lat = boundary[-1][1], boundary[-1][0]
            if round(first_lng, 6) != round(last_lng, 6) or round(first_lat, 6) != round(last_lat, 6):
                coord_pairs.append(f"{round(first_lng, 6)},{round(first_lat, 6)},0")

            coords_str = " ".join(coord_pairs)
            placemarks.append(f"""    <Placemark>
      <name>{cell}</name>
      <styleUrl>#cellBoundary</styleUrl>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>{coords_str}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>""")
        except Exception:
            continue

    placemarks_xml = "\n".join(placemarks)

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>{document_name}</name>
    <description>H3 cell boundaries exported from Fleet HexMap</description>
    <Style id="cellBoundary">
      <LineStyle>
        <color>ffd4b606</color>
        <width>2.5</width>
      </LineStyle>
      <PolyStyle>
        <fill>0</fill>
        <outline>1</outline>
      </PolyStyle>
    </Style>
{placemarks_xml}
  </Document>
</kml>"""
