#!/usr/bin/env python3
"""
Command-line interface to generate standalone HA30 Hexagon Map HTML files.

Usage:
    python cli.py --city isfahan --threshold 30 --out isfahan_report.html
    python cli.py --city tehran --threshold 30
"""
import argparse
import sys
import os

from app.config import settings
from app.data_source import fetch_orders
from app.engine import analyze_city_orders
from app.export_html import build_standalone_html


def main():
    parser = argparse.ArgumentParser(description="Generate HA30 Hexagon Map HTML report.")
    parser.add_argument("--city", default=settings.DEFAULT_CITY, help="City name (e.g. isfahan, tehran)")
    parser.add_argument("--threshold", type=int, default=settings.DEFAULT_THRESHOLD, help="SLA threshold in minutes (default: 30)")
    parser.add_argument("--min-orders", type=int, default=settings.DEFAULT_MIN_ORDERS, help="Minimum orders for reliability (default: 5)")
    parser.add_argument("--customer-id", type=int, default=settings.DEFAULT_CUSTOMER_ID, help="Customer ID filter")
    parser.add_argument("--start-date", default=settings.DEFAULT_START_DATE, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", default=settings.DEFAULT_END_DATE, help="End date (YYYY-MM-DD)")
    parser.add_argument("--out", default=None, help="Output HTML file path")
    args = parser.parse_args()

    city = args.city.lower()
    out_file = args.out or f"{city}_hexagons_{args.end_date.replace('-', '')}.html"

    print(f"Fetching order data for {city.title()}...")
    df, source, _, _ = fetch_orders(
        city=city,
        status="DELIVERED",
        customer_id=args.customer_id,
        start_date=args.start_date,
        end_date=args.end_date,
        threshold=args.threshold,
    )
    print(f"Loaded {len(df)} orders via {source}")

    print("Computing H3 multi-resolution hexagons (levels 6 to 10)...")
    analysis = analyze_city_orders(
        df=df,
        threshold=args.threshold,
        min_orders=args.min_orders,
        res_min=settings.RES_MIN,
        res_max=settings.RES_MAX,
        res_default=settings.RES_DEFAULT,
    )

    kpis = analysis["kpis"]
    ha_count = kpis.get("ha30_count", kpis.get("total_slow", 0))
    print(f"Overall HA{args.threshold}%: {kpis['overall_ha_pct']}% ({ha_count} HA{args.threshold} orders of {kpis['total_orders']})")
    print(f"Average accept duration: {kpis['overall_mean_duration']} min")

    print(f"Writing standalone HTML to {out_file}...")
    html_content = build_standalone_html(
        data=analysis,
        city=city,
        customer_id=args.customer_id,
        start_date=args.start_date,
        end_date=args.end_date,
        threshold=args.threshold,
        min_orders=args.min_orders,
    )

    with open(out_file, "w", encoding="utf-8") as f:
        f.write(html_content)

    print(f"Done! Open {out_file} in any web browser.")


if __name__ == "__main__":
    main()
