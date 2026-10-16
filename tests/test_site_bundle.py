from pathlib import Path
import tempfile
import unittest

from scripts.build_site import STATIC_FILES, build_site


class SiteBundleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in STATIC_FILES:
            self.write(name, "asset")
        self.write("forecasting/manifest.csv", (
            "field,field_dir,global_mlp_forecast_months\n"
            "Active,forecasting/fields/active,12\n"
            "Inactive,forecasting/fields/inactive,0\n"
        ))
        self.write("forecasting/fields/active/forecast_global_mlp.csv", "forecast")

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_only_app_inputs_are_published_and_stale_files_are_removed(self):
        for name in [
            ".env", "data/remaining_reserves.xlsx", "data/consumption.csv",
            "server.py", "forecasting/diagnostics/fuel_training_log.csv",
            "forecasting/fields/obsolete/forecast_global_mlp.csv", "_site/stale.csv",
        ]:
            self.write(name, "not for the website")
        output = build_site(self.root)
        actual = {p.relative_to(output).as_posix() for p in output.rglob("*") if p.is_file()}
        self.assertEqual(actual, set(STATIC_FILES) | {"forecasting/fields/active/forecast_global_mlp.csv"})
        self.assertEqual((output / "forecasting/fields/active/forecast_global_mlp.csv").read_text(), "forecast")

    def test_missing_forecast_fails_before_replacing_previous_bundle(self):
        self.write("_site/index.html", "previous site")
        (self.root / "forecasting/fields/active/forecast_global_mlp.csv").unlink()
        with self.assertRaises(FileNotFoundError):
            build_site(self.root)
        self.assertEqual((self.root / "_site/index.html").read_text(), "previous site")

    def test_manifest_cannot_add_arbitrary_files_to_bundle(self):
        for directory in ["forecasting/fields/../../../private", "/tmp/private", "data"]:
            with self.subTest(directory=directory):
                self.write("forecasting/manifest.csv", (
                    "field,field_dir,global_mlp_forecast_months\n"
                    f"Private,{directory},12\n"
                ))
                with self.assertRaisesRegex(ValueError, "Invalid forecast directory"):
                    build_site(self.root)
