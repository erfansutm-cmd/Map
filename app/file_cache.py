"""
Disk / File Cache Service.
Persists partitioned daily DataFrames to disk (data/file_cache)
to ensure 0ms cache hits across server restarts.
"""
import os
import hashlib
from typing import Optional, Tuple, Dict, Any
import pandas as pd

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "file_cache")


def ensure_cache_dir() -> str:
    """Ensure cache directory exists."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    return CACHE_DIR


def _cache_filename(namespace: str, key_tuple: Tuple) -> str:
    """Generate safe, readable filename for cached day DataFrame."""
    safe_parts = [str(p).replace("/", "_").replace("\\", "_").replace(" ", "_").lower() for p in key_tuple]
    key_str = "_".join(safe_parts)
    if len(key_str) > 80:
        h = hashlib.md5(key_str.encode("utf-8")).hexdigest()[:8]
        key_str = f"{key_str[:60]}_{h}"
    return f"{namespace}_{key_str}.pkl"


def save_df_to_file(namespace: str, key_tuple: Tuple, df: pd.DataFrame) -> bool:
    """Save a DataFrame to disk cache atomically."""
    if df is None:
        return False
    try:
        ensure_cache_dir()
        filename = _cache_filename(namespace, key_tuple)
        filepath = os.path.join(CACHE_DIR, filename)
        tmppath = f"{filepath}.tmp_{os.getpid()}"
        df.to_pickle(tmppath)
        os.replace(tmppath, filepath)
        return True
    except Exception:
        return False


def load_df_from_file(namespace: str, key_tuple: Tuple) -> Optional[pd.DataFrame]:
    """Load a DataFrame from disk cache if present."""
    try:
        filename = _cache_filename(namespace, key_tuple)
        filepath = os.path.join(CACHE_DIR, filename)
        if os.path.exists(filepath):
            return pd.read_pickle(filepath)
    except Exception:
        pass
    return None


def clear_file_cache() -> int:
    """Remove all cached files from disk."""
    count = 0
    if os.path.exists(CACHE_DIR):
        for f in os.listdir(CACHE_DIR):
            if f.endswith(".pkl") or ".tmp_" in f:
                try:
                    os.remove(os.path.join(CACHE_DIR, f))
                    count += 1
                except Exception:
                    pass
    return count


def get_file_cache_stats() -> Dict[str, Any]:
    """Return count and total size of files stored in cache."""
    count = 0
    total_bytes = 0
    if os.path.exists(CACHE_DIR):
        for f in os.listdir(CACHE_DIR):
            if f.endswith(".pkl"):
                count += 1
                try:
                    total_bytes += os.path.getsize(os.path.join(CACHE_DIR, f))
                except OSError:
                    pass
    return {
        "files_count": count,
        "total_mb": round(total_bytes / (1024 * 1024), 2)
    }
