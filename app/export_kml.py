"""
KML Export Service.
Generates OGC KML 2.2 documents containing just the boundary polygons of selected H3 cells,
including dissolved black outer boundary export and HA30 breach rates per hexagon.
"""
from typing import Any, Dict, Iterable, List, Optional, Union
import html
import h3


def build_kml_outer_boundary(
    cells: Iterable[Union[str, Dict[str, Any]]],
    document_name: str = "Selected Region Outer Boundary",
    summary: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Generate OGC KML 2.2 containing ONLY the dissolved outer boundaries of the selected H3 cells
    (no internal per-cell dividing lines), styled in crisp solid black (#000000).
    """
    cell_ids: List[str] = []
    seen = set()
    total_orders = 0
    total_slow = 0
    vsum = 0.0
    total_fare = 0.0
    total_inc = 0.0

    for item in cells:
        if isinstance(item, dict):
            c = str(item.get("hex") or "").strip().lower()
            if c and c not in seen:
                seen.add(c)
                cell_ids.append(c)
                o = int(item.get("orders") or 0)
                s = int(item.get("ha30_count", item.get("slow") or 0))
                m = float(item.get("mean") or 0.0)
                f = float(item.get("avg_fare") or 0.0)
                inc = float(item.get("avg_incentive") or 0.0)
                total_orders += o
                total_slow += s
                vsum += m * o
                total_fare += f * o
                total_inc += inc * o
        else:
            c = str(item).strip().lower()
            if c and c not in seen:
                seen.add(c)
                cell_ids.append(c)

    if not cell_ids:
        raise ValueError("No cell IDs provided")

    # Use H3 cells_to_geo to dissolve cells into outer boundary Polygon / MultiPolygon
    geo = h3.cells_to_geo(cell_ids)
    geom_type = geo.get("type")
    coords = geo.get("coordinates", [])

    poly_list = [coords] if geom_type == "Polygon" else (coords if geom_type == "MultiPolygon" else [])

    polygons_xml: List[str] = []
    for poly in poly_list:
        if not poly:
            continue
        outer = poly[0]
        coord_pairs = [f"{round(lng, 6)},{round(lat, 6)},0" for lng, lat in outer]
        if coord_pairs and coord_pairs[0] != coord_pairs[-1]:
            coord_pairs.append(coord_pairs[0])
        outer_str = " ".join(coord_pairs)

        holes_xml: List[str] = []
        for inner in poly[1:]:
            inner_pairs = [f"{round(lng, 6)},{round(lat, 6)},0" for lng, lat in inner]
            if inner_pairs and inner_pairs[0] != inner_pairs[-1]:
                inner_pairs.append(inner_pairs[0])
            inner_str = " ".join(inner_pairs)
            holes_xml.append(f"""        <innerBoundaryIs>
          <LinearRing>
            <coordinates>{inner_str}</coordinates>
          </LinearRing>
        </innerBoundaryIs>""")

        inner_xml_str = ("\n" + "\n".join(holes_xml)) if holes_xml else ""
        polygons_xml.append(f"""      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>{outer_str}</coordinates>
          </LinearRing>
        </outerBoundaryIs>{inner_xml_str}
      </Polygon>""")

    if len(polygons_xml) == 1:
        geom_xml = polygons_xml[0]
    else:
        geom_xml = "      <MultiGeometry>\n" + "\n".join(polygons_xml) + "\n      </MultiGeometry>"

    ha_pct = (total_slow / total_orders * 100.0) if total_orders > 0 else 0.0
    mean_dur = (vsum / total_orders) if total_orders > 0 else 0.0
    avg_fare = (total_fare / total_orders) if total_orders > 0 else 0.0
    avg_inc = (total_inc / total_orders) if total_orders > 0 else 0.0

    fare_row = f"""    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Mean Biker Fare:</b></td><td style="padding:2px 0;font-weight:700;">{avg_fare:,.0f} Toman</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Mean Incentive:</b></td><td style="padding:2px 0;color:#059669;font-weight:700;">+{avg_inc:,.0f} Toman</td></tr>""" if avg_fare > 0 else ""

    desc_html = f"""<![CDATA[
<div style="font-family:sans-serif;font-size:12px;line-height:1.5;">
  <h4 style="margin:0 0 6px 0;color:#000000;">Merged Region Outer Boundary ({len(cell_ids)} Cells)</h4>
  <table style="border-collapse:collapse;width:100%;font-size:12px;">
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Combined HA30% Breach:</b></td><td style="padding:2px 0;font-weight:700;color:{'#dc2626' if ha_pct > 25 else '#16a34a'};">{ha_pct:.1f}%</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Total Orders:</b></td><td style="padding:2px 0;font-weight:700;">{total_orders:,}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>HA30 Orders Count:</b></td><td style="padding:2px 0;">{total_slow:,}</td></tr>
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Weighted Mean Duration:</b></td><td style="padding:2px 0;">{mean_dur:.1f} min</td></tr>
    {fare_row}
    <tr><td style="padding:2px 6px 2px 0;color:#64748b;"><b>Cell Count:</b></td><td style="padding:2px 0;">{len(cell_ids)}</td></tr>
  </table>
</div>
]]>"""

    placemark_name = f"{document_name} ({len(cell_ids)} Cells)"
    cells_str = ",".join(cell_ids)

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>{html.escape(document_name)}</name>
    <description>Black outer boundaries of selected H3 cells exported from Fleet HexMap</description>
    <Style id="blackOuterBoundary">
      <LineStyle>
        <color>ff000000</color>
        <width>3.0</width>
      </LineStyle>
      <PolyStyle>
        <fill>0</fill>
        <outline>1</outline>
      </PolyStyle>
    </Style>
    <Placemark>
      <name>{html.escape(placemark_name)}</name>
      <description>{desc_html}</description>
      <styleUrl>#blackOuterBoundary</styleUrl>
      <ExtendedData>
        <Data name="cell_count"><value>{len(cell_ids)}</value></Data>
        <Data name="h3_cells"><value>{cells_str}</value></Data>
        <Data name="ha30_pct"><value>{ha_pct:.1f}</value></Data>
        <Data name="total_orders"><value>{total_orders}</value></Data>
        <Data name="ha30_orders"><value>{total_slow}</value></Data>
        <Data name="mean_duration_min"><value>{mean_dur:.1f}</value></Data>
      </ExtendedData>
{geom_xml}
    </Placemark>
  </Document>
</kml>"""


def build_kml_boundaries(
    cells: Iterable[Union[str, Dict[str, Any]]],
    document_name: str = "Selected Cell Boundaries",
    dissolve: bool = False,
) -> str:
    """
    Generate valid OGC KML 2.2 containing boundaries of the specified H3 cells.
    If dissolve is True, returns only the outer boundary (no per-cell view, colored black).
    If False, represents each cell as an individual placemark.
    """
    if dissolve:
        return build_kml_outer_boundary(cells, document_name)

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
            boundary = h3.cell_to_boundary(cell)
            if not boundary or len(boundary) < 3:
                continue

            coord_pairs = [f"{round(lng, 6)},{round(lat, 6)},0" for lat, lng in boundary]

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
