import os
from pathlib import Path
from pydantic import BaseModel

# Automatically load .env file if available
try:
    from dotenv import load_dotenv
    # Look for .env in current directory or parent directory
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        load_dotenv(dotenv_path=env_path)
    else:
        load_dotenv()
except ImportError:
    pass

class Settings(BaseModel):
    # Business Logic Defaults
    DEFAULT_CITY: str = os.getenv("DEFAULT_CITY", "isfahan")
    DEFAULT_STATUS: str = os.getenv("DEFAULT_STATUS", "DELIVERED")
    DEFAULT_CUSTOMER_ID: int = int(os.getenv("DEFAULT_CUSTOMER_ID", "2"))
    DEFAULT_START_DATE: str = os.getenv("DEFAULT_START_DATE", "2026-10-22")
    DEFAULT_END_DATE: str = os.getenv("DEFAULT_END_DATE", "2026-11-05")
    DEFAULT_THRESHOLD: int = int(os.getenv("DEFAULT_THRESHOLD", "30"))
    DEFAULT_MIN_ORDERS: int = int(os.getenv("DEFAULT_MIN_ORDERS", "5"))
    
    # H3 Resolutions
    RES_MIN: int = int(os.getenv("RES_MIN", "6"))
    RES_MAX: int = int(os.getenv("RES_MAX", "10"))
    RES_DEFAULT: int = int(os.getenv("RES_DEFAULT", "8"))
    
    # Percentiles for scale
    LOW_Q: float = float(os.getenv("LOW_Q", "0.05"))
    HIGH_Q: float = float(os.getenv("HIGH_Q", "0.95"))
    
    # ClickHouse Settings
    CLICKHOUSE_HOST: str = os.getenv("CLICKHOUSE_HOST", "")
    CLICKHOUSE_PORT: int = int(os.getenv("CLICKHOUSE_PORT", "8123"))
    CLICKHOUSE_USER: str = os.getenv("CLICKHOUSE_USER", "default")
    CLICKHOUSE_PASSWORD: str = os.getenv("CLICKHOUSE_PASSWORD", "")
    CLICKHOUSE_DATABASE: str = os.getenv("CLICKHOUSE_DB", os.getenv("CLICKHOUSE_DATABASE", "default"))
    CLICKHOUSE_SECURE: bool = os.getenv("CLICKHOUSE_SECURE", "false").lower() in ("true", "1", "yes")

settings = Settings()
