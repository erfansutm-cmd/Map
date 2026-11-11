"""
KML Export Service.
Generates OGC KML 2.2 documents containing just the boundary polygons of selected H3 cells,
including HA30 breach rates and order counts per hexagon.
"""
from typing import Any, Dict, Iterable, List, Union
import html
import h3


def build_kml_boundaries(
    cells: Iterable[Union[str, Dict[str, Any]]],
    document_name: str = "Selected Cell Boundaries"
) -> str:
    """
    Generate valid OGC KML 2.2 containing just the boundaries of the specified H3 cells.
    Each cell is represented as a Placemark with a closed LinearRing Polygon,
    styled with no fill (fill=0) and crisp boundary outlines (outline=1).
    Includes HA30% and orders data in name, description, and ExtendedData.
    """
    placemarks: List[str] = []
    seen = set()

    for item in cells:
        if isinstance(item, dict):
            cell = str(item.get("hex") or "").strip().lower()
            pct = item.get("pct")
            orders = item.get("orders")
            slow = item.get("ha30_count", item.get("slow"))
            mean = item.get("mean")
        else:
            cell = str(item).strip().lower()
            pct = None
            orders = None
            slow = None
            mean = None

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

            safe_cell = html.escape(cell)
            if pct is not None and orders is not None:
                pct_val = float(pct)
                orders_val = int(orders)
                placemark_name = f"{safe_cell} — HA30: {pct_val:.1f}% ({orders_val:,} ord)"
                slow_str = f"{int(slow):,}" if slow is not None else "N/A"
                mean_str = f"{float(mean):.1f} min" if mean is not None else "N/A"
                mean_val_str = f"{float(mean):.1f}" if mean is not None else "0.0"
                slow_val = int(slow) if slow is not None else 0

                desc_html = f"""<![CDATA[
<div style="font-family:sans-serif;font-size:12px;line-height:1.5;">
  <h4 style="margin:0 0 6px 0;color:#0e7490;">H3 Cell: {safe_cell}</h4>
  <table style="border-collapse:collapse;width:100%;font-size:12px;">
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>HA30 Breach Rate:</b></td><td style="padding:2px 0;font-weight:700;">{pct_val:.1f}%</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Total Orders:</b></td><td style="padding:2px 0;font-weight:700;">{orders_val:,}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>HA30 Orders Count:</b></td><td style="padding:2px 0;">{slow_str}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Mean Duration:</b></td><td style="padding:2px 0;">{mean_str}</td></tr>
  </table>
</div>
]]>"""
                extended_data = f"""      <ExtendedData>
        <Data name="h3_index"><value>{safe_cell}</value></Data>
        <Data name="ha30_pct"><value>{pct_val:.1f}</value></Data>
        <Data name="orders"><value>{orders_val}</value></Data>
        <Data name="ha30_orders"><value>{slow_val}</value></Data>
        <Data name="mean_duration_min"><value>{mean_val_str}</value></Data>
      </ExtendedData>"""
            else:
                placemark_name = safe_cell
                desc_html = f"<![CDATA[H3 Cell: {safe_cell}]]>"
                extended_data = f"""      <ExtendedData>
        <Data name="h3_index"><value>{safe_cell}</value></Data>
      </ExtendedData>"""

            placemarks.append(f"""    <Placemark>
      <name>{placemark_name}</name>
      <description>{desc_html}</description>
      <styleUrl>#cellBoundary</styleUrl>
{extended_data}
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
    <name>{html.escape(document_name)}</name>
    <description>H3 cell boundaries with HA30 breach rates and order counts exported from Fleet HexMap</description>
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
