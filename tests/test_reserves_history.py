from pathlib import Path
import tempfile
import unittest

from openpyxl import Workbook

from scripts.build_reserves_history import build_reserves_history


class ReservesHistoryTests(unittest.TestCase):
    def test_workbook_units_dates_duplicates_and_missing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workbook = Workbook()
            sheet = workbook.active
            sheet.append(["Field name", "Updated date", "Remaining oil eq. [mill Sm3 o.e]"])
            for row in [
                ["  Frøy ", "2025-12-31T00:00:00Z", 17.914],
                ["FRØY", "2024-12-31T00:00:00Z", -0.5],
                ["FRØY", "2025-12-31T00:00:00Z", 18.25],
                ["FRØY", "2023-12-31T00:00:00Z", None],
                ["FRØY", "invalid date", 42],
                ["UNMODELED", "2025-12-31T00:00:00Z", 100],
            ]:
                sheet.append(row)
            workbook.save(root / "remaining_reserves.xlsx")
            workbook.close()
            self.assertEqual(build_reserves_history(root, {"FRØY", "MISSING"}), {
                "FRØY": [
                    {"month": "2024-12", "reserves": 0.0},
                    {"month": "2025-12", "reserves": 18.25},
                ],
                "MISSING": [],
            })

    def test_missing_or_invalid_workbook_fails_instead_of_erasing_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                build_reserves_history(root, {"FRØY"})
            workbook = Workbook()
            workbook.active.append(["Wrong column"])
            workbook.save(root / "remaining_reserves.xlsx")
            workbook.close()
            with self.assertRaisesRegex(ValueError, "No usable reserve history"):
                build_reserves_history(root, {"FRØY"})
