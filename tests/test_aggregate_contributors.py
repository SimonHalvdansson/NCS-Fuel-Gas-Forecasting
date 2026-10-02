import csv
from pathlib import Path
import tempfile
import unittest

from scripts.build_aggregate_contributors import build_aggregate_contributors


class ContributorTests(unittest.TestCase):
    def test_quantile_rankings_first_year_and_month_alignment(self):
        with tempfile.TemporaryDirectory() as directory:
            forecasts = []
            for index in range(12):
                path = Path(directory) / f'{index}.csv'
                with path.open('w', newline='') as file:
                    writer = csv.DictWriter(file, fieldnames=[
                        'month', 'production_forecast_msm3oe_q50',
                        'fuel_gas_forecast_msm3_q50', 'production_forecast_msm3oe',
                    ])
                    writer.writeheader()
                    # Reverse order verifies ranking is keyed by month, not row index.
                    for month in reversed(range(13)):
                        writer.writerow({
                            'month': f'{2026 + month // 12}-{month % 12 + 1:02}',
                            'production_forecast_msm3oe_q50': index + (1000 if month == 12 else 0),
                            'fuel_gas_forecast_msm3_q50': 11 - index,
                            'production_forecast_msm3oe': 99999,
                        })
                forecasts.append((f'Field {index:02}', path))
            data = build_aggregate_contributors(forecasts)
            production = data['firstYear']['production']
            fuel = data['months']['2026-01']['fuel']
            self.assertEqual(len(production), 10)
            self.assertEqual(production[0], {'field': 'Field 11', 'value': 132})
            self.assertEqual(fuel[0], {'field': 'Field 00', 'value': 11})
            self.assertTrue(all(row['value'] > 0 for row in fuel))
            self.assertEqual(data['months']['2027-01']['production'][0]['value'], 1011)

    def test_empty_forecasts(self):
        self.assertEqual(build_aggregate_contributors([]), {
            'firstYear': {'production': [], 'fuel': []}, 'months': {},
        })


if __name__ == '__main__':
    unittest.main()
