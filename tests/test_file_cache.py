import unittest
import pandas as pd
from app.file_cache import (
    save_df_to_file,
    load_df_from_file,
    clear_file_cache,
    get_file_cache_stats,
)


class TestFileCache(unittest.TestCase):
    def setUp(self):
        clear_file_cache()

    def tearDown(self):
        clear_file_cache()

    def test_save_and_load_cache(self):
        df = pd.DataFrame({
            "order_id": ["ord_1", "ord_2"],
            "created_date": ["2026-11-09", "2026-11-09"],
            "create_to_accept_contractual": [12.5, 34.0],
        })
        key = ("tehran", "DELIVERED", 2, "2026-11-09")
        saved = save_df_to_file("test_ch", key, df)
        self.assertTrue(saved)

        stats = get_file_cache_stats()
        self.assertEqual(stats["files_count"], 1)

        loaded = load_df_from_file("test_ch", key)
        self.assertIsNotNone(loaded)
        self.assertEqual(len(loaded), 2)
        self.assertEqual(list(loaded["order_id"]), ["ord_1", "ord_2"])

    def test_clear_file_cache(self):
        df = pd.DataFrame({"x": [1]})
        save_df_to_file("test", ("city", "2026-11-09"), df)
        self.assertEqual(get_file_cache_stats()["files_count"], 1)

        count = clear_file_cache()
        self.assertEqual(count, 1)
        self.assertEqual(get_file_cache_stats()["files_count"], 0)
        self.assertIsNone(load_df_from_file("test", ("city", "2026-11-09")))


if __name__ == "__main__":
    unittest.main()
