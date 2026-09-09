import importlib.util
from pathlib import Path
import unittest
import sys
sys.dont_write_bytecode = True

path = Path(__file__).resolve().parents[1] / 'tools/reports/inference-timing/plot.py'
spec = importlib.util.spec_from_file_location('timing_plot', path)
plot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plot)


class TimingTrendTests(unittest.TestCase):
    def row(self, at=0, tokens=100, duration=1000, ttft=1000):
        return {'at': at, 'tokens': tokens, 'duration': duration, 'ttft': ttft}

    def test_median_retains_outlier_without_becoming_mean(self):
        rows = [self.row(ttft=n * 1000) for n in [1, 2, 3, 4, 1000]]
        before = [r.copy() for r in rows]
        result = plot.trend_bins(rows, 'ttft')[0]
        self.assertEqual(result['n'], 5)
        self.assertEqual(result['median'], 3)
        self.assertEqual(result['p10'], 1.4)
        self.assertEqual(result['p25'], 2)
        self.assertEqual(result['p75'], 4)
        self.assertEqual(result['outside_iqr'], 2)
        self.assertAlmostEqual(result['p90'], 601.6)
        self.assertEqual(rows, before)

    def test_tps_is_median_of_turn_rates_not_weighted_average(self):
        rows = [self.row(tokens=100, duration=1000), self.row(tokens=300, duration=10000)]
        self.assertEqual(plot.trend_bins(rows, 'tps')[0]['median'], 65)

    def test_missing_day_breaks_trend_and_missing_metric_is_not_zero(self):
        result = plot.trend_bins([self.row(), self.row(at=2 * 86400000), self.row(ttft=None)], 'ttft')
        self.assertEqual([b['n'] for b in result], [1, 0, 1])
        self.assertIsNone(result[1]['median'])
        self.assertEqual(plot.trend_bins([self.row(duration=None)], 'tps'), [])

    def test_sparse_medians_join_and_missing_days_are_dashed(self):
        rows = [self.row(), self.row(at=86400000), self.row(at=3 * 86400000), self.row(at=20 * 86400000)]
        bins = plot.trend_bins(rows, 'ttft')
        before = [b.copy() for b in bins]
        segments = plot.median_segments(bins)
        self.assertEqual(len(segments), 2)
        self.assertEqual([s['dashed'] for s in segments], [False, True])
        self.assertEqual(bins, before)
        self.assertIsNone(bins[2]['median'])
        self.assertEqual(len(plot.median_segments(bins, maximum_gap_days=0)), 1)

    def test_zero_ttft_is_valid_and_day_boundary_is_exact(self):
        result = plot.trend_bins([self.row(at=86400000 - 1, ttft=0), self.row(at=86400000, ttft=1000)], 'ttft')
        self.assertEqual([b['median'] for b in result], [0, 1])
        self.assertEqual(result[0]['start'], 0)


if __name__ == '__main__':
    unittest.main()
