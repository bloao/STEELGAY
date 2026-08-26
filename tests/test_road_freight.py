import unittest

import pandas as pd

from src.analysis import build_road_freight_analysis


class RoadFreightAnalysisTests(unittest.TestCase):
    def test_filters_declared_modes_and_ranks_dispatch_country(self):
        rows = [
            self.row("30", "Road", True, "DE", "Germany", 10, 1000),
            self.row("60", "Roll-on/Roll-off", True, "DE", "Germany", 20, 3000),
            self.row("10", "Sea", True, "DE", "Germany", 70, 7000),
            self.row("30", "Road", False, "FR", "France", 50, 5000),
        ]
        detail, countries = build_road_freight_analysis(pd.DataFrame(rows))

        self.assertEqual(detail["tonnes"].sum(), 30)
        self.assertEqual(
            set(detail["road_freight_class"]),
            {"HMRC-declared Road (code 30; route unverified)", "Ro-Ro"},
        )
        self.assertEqual(countries.iloc[0]["dispatch_country"], "Germany")
        self.assertEqual(countries.iloc[0]["road_freight_tonnes"], 30)
        self.assertAlmostEqual(countries.iloc[0]["road_freight_share_of_country_steel"], 0.3)
        self.assertEqual(countries.iloc[0]["direct_road_active_months"], 1)
        self.assertEqual(countries.iloc[0]["direct_road_steel_products"], 1)
        self.assertEqual(countries.iloc[0]["direct_road_main_origin_country"], "Germany")
        self.assertEqual(countries.iloc[0]["roro_active_months"], 1)
        self.assertEqual(countries.iloc[0]["roro_steel_products"], 1)

    @staticmethod
    def row(mode_code, mode, reliable, dispatch_code, dispatch, tonnes, value):
        return {
            "period": 202601, "year": 2026, "month": 1,
            "commodity_code": "72011019", "commodity_description": "Pig iron",
            "steel_product_group": "Pig iron", "origin_country_code": "DE",
            "origin_country_name": "Germany", "dispatch_country_code": dispatch_code,
            "dispatch_country_name": dispatch, "port_code": "EUT",
            "port_name_if_available": "", "transport_mode_code": mode_code,
            "transport_mode": mode, "transport_mode_reliable": reliable,
            "tonnes": tonnes, "statistical_value_gbp": value,
        }


if __name__ == "__main__":
    unittest.main()
