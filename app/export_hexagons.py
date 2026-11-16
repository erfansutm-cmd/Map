"""
Export selected H3 hexagons list by resolution (CSV, TXT, JSON).
Converts cells to parent (coarser) or children (finer) resolutions using H3.
"""
from typing import List, Dict, Any, Tuple
import h3


def resolve_hexagons_by_resolution(
    cells: List[str],
    target_res: str = "current"
) -> List[Dict[str, Any]]:
    """
    Resolves input H3 cells to the target resolution.
    target_res can be 'current', '6', '7', '8', '9', '10', or 'all'.
    Returns a list of dicts with cell details.
    """
    results: List[Dict[str, Any]] = []
    if not cells:
        return results

    if target_res == "all":
        # Multi-resolution mapping for each cell
        for c in cells:
            try:
                c_clean = str(c).strip().lower()
                c_res = h3.get_resolution(c_clean)
                lat, lng = h3.cell_to_latlng(c_clean)
                p6 = h3.cell_to_parent(c_clean, 6) if c_res >= 6 else ""
                p7 = h3.cell_to_parent(c_clean, 7) if c_res >= 7 else ""
                p8 = h3.cell_to_parent(c_clean, 8) if c_res >= 8 else ""
                results.append({
                    "hex_id": c_clean,
                    "resolution": c_res,
                    "parent_res6": p6,
                    "parent_res7": p7,
                    "parent_res8": p8,
                    "latitude": round(lat, 6),
                    "longitude": round(lng, 6),
                })
            except Exception:
                continue
        return results

    req_res = None
    if target_res != "current":
        try:
            req_res = int(target_res)
        except ValueError:
            req_res = None

    unique_cells = set()
    cell_sources: Dict[str, str] = {}

    for c in cells:
        try:
            c_clean = str(c).strip().lower()
            c_res = h3.get_resolution(c_clean)
            if req_res is None or req_res == c_res:
                unique_cells.add(c_clean)
                cell_sources[c_clean] = c_clean
            elif req_res < c_res:
                parent = h3.cell_to_parent(c_clean, req_res)
                unique_cells.add(parent)
                cell_sources[parent] = c_clean
            else:  # req_res > c_res
                children = h3.cell_to_children(c_clean, req_res)
                for child in children:
                    unique_cells.add(child)
                    cell_sources[child] = c_clean
        except Exception:
            continue

    for h in sorted(unique_cells):
        try:
            r = h3.get_resolution(h)
            lat, lng = h3.cell_to_latlng(h)
            results.append({
                "hex_id": h,
                "resolution": r,
                "latitude": round(lat, 6),
                "longitude": round(lng, 6),
                "source_cell": cell_sources.get(h, h)
            })
        except Exception:
            continue

    return results


def generate_hexagons_csv(
    cells: List[str],
    target_res: str = "current",
    city: str = ""
) -> Tuple[str, int]:
    """Generates CSV text of hexagons resolved at target resolution."""
    items = resolve_hexagons_by_resolution(cells, target_res)
    if not items:
        return "", 0

    if target_res == "all":
        lines = ["hex_id,resolution,parent_res6,parent_res7,parent_res8,latitude,longitude,city"]
        for it in items:
            lines.append(
                f"{it['hex_id']},{it['resolution']},{it['parent_res6']},{it['parent_res7']},"
                f"{it['parent_res8']},{it['latitude']},{it['longitude']},{city}"
            )
    else:
        lines = ["hex_id,resolution,latitude,longitude,city"]
        for it in items:
            lines.append(f"{it['hex_id']},{it['resolution']},{it['latitude']},{it['longitude']},{city}")

    return "\n".join(lines), len(items)


def generate_hexagons_txt(
    cells: List[str],
    target_res: str = "current"
) -> Tuple[str, int]:
    """Generates simple newline-delimited text list of hexagon IDs."""
    items = resolve_hexagons_by_resolution(cells, target_res)
    if not items:
        return "", 0
    lines = [it["hex_id"] for it in items]
    return "\n".join(lines), len(items)
