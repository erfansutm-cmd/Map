"""
City database with coordinates, default bounds, and metadata for Iranian and international cities.
"""
from typing import Dict, Any, Optional, Tuple
import hashlib

KNOWN_CITIES: Dict[str, Dict[str, Any]] = {
    "isfahan": {
        "name": "Isfahan",
        "fa_name": "اصفهان",
        "lat": 32.6546,
        "lng": 51.6680,
        "zoom": 12,
        "radius_km": 14,
        "description": "Historic metropolis and industrial logistics hub in central Iran"
    },
    "tehran": {
        "name": "Tehran",
        "fa_name": "تهران",
        "lat": 35.6892,
        "lng": 51.3890,
        "zoom": 11,
        "radius_km": 25,
        "description": "Capital city with dense urban logistics and high delivery volume"
    },
    "shiraz": {
        "name": "Shiraz",
        "fa_name": "شیراز",
        "lat": 29.5918,
        "lng": 52.5837,
        "zoom": 12,
        "radius_km": 15,
        "description": "Major southern cultural and economic commercial center"
    },
    "mashhad": {
        "name": "Mashhad",
        "fa_name": "مشهد",
        "lat": 36.2972,
        "lng": 59.6067,
        "zoom": 12,
        "radius_km": 18,
        "description": "Second-largest city in northeastern Iran with active courier fleet"
    },
    "tabriz": {
        "name": "Tabriz",
        "fa_name": "تبریز",
        "lat": 38.0800,
        "lng": 46.2919,
        "zoom": 12,
        "radius_km": 14,
        "description": "Northwestern industrial hub and commercial trade corridor"
    },
    "karaj": {
        "name": "Karaj",
        "fa_name": "کرج",
        "lat": 35.8400,
        "lng": 50.9391,
        "zoom": 12,
        "radius_km": 16,
        "description": "Major urban center adjacent to Tehran metropolitan area"
    },
    "ahvaz": {
        "name": "Ahvaz",
        "fa_name": "اهواز",
        "lat": 31.3183,
        "lng": 48.6706,
        "zoom": 12,
        "radius_km": 15,
        "description": "Southwestern industrial center with Karun river logistics divisions"
    },
    "qom": {
        "name": "Qom",
        "fa_name": "قم",
        "lat": 34.6401,
        "lng": 50.8764,
        "zoom": 12,
        "radius_km": 12,
        "description": "Central transit intersection and high-density commercial city"
    },
    "rasht": {
        "name": "Rasht",
        "fa_name": "رشت",
        "lat": 37.2808,
        "lng": 49.5832,
        "zoom": 13,
        "radius_km": 10,
        "description": "Caspian Sea coastal hub with dense culinary and retail delivery"
    },
    "kermanshah": {
        "name": "Kermanshah",
        "fa_name": "کرمانشاه",
        "lat": 34.3142,
        "lng": 47.0650,
        "zoom": 12,
        "radius_km": 12,
        "description": "Western trade crossroads and regional logistics anchor"
    },
    "yazd": {
        "name": "Yazd",
        "fa_name": "یزد",
        "lat": 31.8974,
        "lng": 54.3569,
        "zoom": 12,
        "radius_km": 12,
        "description": "Central desert regional distribution center"
    },
    "urmia": {
        "name": "Urmia",
        "fa_name": "ارومیه",
        "lat": 37.5527,
        "lng": 45.0761,
        "zoom": 12,
        "radius_km": 12,
        "description": "West Azerbaijan provincial capital"
    },
    "kerman": {
        "name": "Kerman",
        "fa_name": "کرمان",
        "lat": 30.2839,
        "lng": 57.0788,
        "zoom": 12,
        "radius_km": 12,
        "description": "Southeastern mining and trade center"
    },
    "hamadan": {
        "name": "Hamadan",
        "fa_name": "همدان",
        "lat": 34.7989,
        "lng": 48.5146,
        "zoom": 12,
        "radius_km": 11,
        "description": "Historical western transit point"
    },
    "qazvin": {
        "name": "Qazvin",
        "fa_name": "قزوین",
        "lat": 36.2688,
        "lng": 50.0041,
        "zoom": 12,
        "radius_km": 10,
        "description": "Industrial highway connecting Tehran to the Caspian and Tabriz"
    },
    "bandar_abbas": {
        "name": "Bandar Abbas",
        "fa_name": "بندر عباس",
        "lat": 27.1832,
        "lng": 56.2666,
        "zoom": 12,
        "radius_km": 12,
        "description": "Primary southern seaport on the Persian Gulf"
    },
    "sari": {
        "name": "Sari",
        "fa_name": "ساری",
        "lat": 36.5659,
        "lng": 53.0586,
        "zoom": 13,
        "radius_km": 9,
        "description": "Mazandaran coastal provincial center"
    },
    "kish": {
        "name": "Kish",
        "fa_name": "کیش",
        "lat": 26.5325,
        "lng": 53.9786,
        "zoom": 13,
        "radius_km": 8,
        "description": "Free trade commercial island"
    },
    # Global major cities
    "dubai": {
        "name": "Dubai",
        "fa_name": "دبی",
        "lat": 25.2048,
        "lng": 55.2708,
        "zoom": 11,
        "radius_km": 20,
        "description": "Global logistics and e-commerce capital"
    },
    "istanbul": {
        "name": "Istanbul",
        "fa_name": "استانبول",
        "lat": 41.0082,
        "lng": 28.9784,
        "zoom": 11,
        "radius_km": 25,
        "description": "Bosphorus transcontinental trade center"
    },
    "london": {
        "name": "London",
        "fa_name": "لندن",
        "lat": 51.5074,
        "lng": -0.1278,
        "zoom": 11,
        "radius_km": 22,
        "description": "Global financial center with high density on-demand delivery"
    },
    "frankfurt": {
        "name": "Frankfurt",
        "fa_name": "فرانکفورت",
        "lat": 50.1109,
        "lng": 8.6821,
        "zoom": 12,
        "radius_km": 14,
        "description": "European transport and logistics crossroads"
    }
}

# Aliases
ALIASES: Dict[str, str] = {
    "esfahan": "isfahan",
    "ispahan": "isfahan",
    "اصفهان": "isfahan",
    "تهران": "tehran",
    "شیراز": "shiraz",
    "مشهد": "mashhad",
    "تبریز": "tabriz",
    "کرج": "karaj",
    "اهواز": "ahvaz",
    "قم": "qom",
    "رشت": "rasht",
    "کرمانشاه": "kermanshah",
    "یزد": "yazd",
    "ارومیه": "urmia",
    "کرمان": "kerman",
    "همدان": "hamadan",
    "hamedan": "hamadan",
    "قزوین": "qazvin",
    "بندرعباس": "bandar_abbas",
    "bandar abbas": "bandar_abbas",
    "ساری": "sari",
    "کیش": "kish",
}


def normalize_city_name(raw: str) -> str:
    cleaned = raw.strip().lower().replace("-", "_").replace(" ", "_")
    return ALIASES.get(cleaned, cleaned)


def get_city_info(raw: str) -> Dict[str, Any]:
    """Retrieve city coordinates and metadata; fall back deterministically for unknown cities."""
    key = normalize_city_name(raw)
    if key in KNOWN_CITIES:
        data = KNOWN_CITIES[key].copy()
        data["key"] = key
        return data

    # Check case-insensitive key prefix
    for k, info in KNOWN_CITIES.items():
        if k in key or key in k:
            data = info.copy()
            data["key"] = k
            return data

    # Fallback deterministic pseudo-location based on hash if user typed an unlisted city
    h = int(hashlib.md5(raw.lower().encode("utf-8")).hexdigest()[:8], 16)
    # Default around central Iran (lat 31..36, lng 48..59)
    lat = 32.0 + (h % 500) / 100.0
    lng = 50.0 + ((h >> 4) % 900) / 100.0
    return {
        "key": raw.lower(),
        "name": raw.strip().title(),
        "fa_name": raw.strip(),
        "lat": round(lat, 4),
        "lng": round(lng, 4),
        "zoom": 12,
        "radius_km": 12,
        "description": f"Custom city query: {raw.strip().title()}"
    }


def get_popular_cities():
    """List of popular presets for UI buttons."""
    return [
        {"key": "isfahan", "name": "Isfahan", "fa": "اصفهان"},
        {"key": "tehran", "name": "Tehran", "fa": "تهران"},
        {"key": "shiraz", "name": "Shiraz", "fa": "شیراز"},
        {"key": "mashhad", "name": "Mashhad", "fa": "مشهد"},
        {"key": "tabriz", "name": "Tabriz", "fa": "تبریز"},
        {"key": "karaj", "name": "Karaj", "fa": "کرج"},
        {"key": "ahvaz", "name": "Ahvaz", "fa": "اهواز"},
        {"key": "qom", "name": "Qom", "fa": "قم"},
        {"key": "rasht", "name": "Rasht", "fa": "رشت"},
        {"key": "kermanshah", "name": "Kermanshah", "fa": "کرمانشاه"},
    ]
