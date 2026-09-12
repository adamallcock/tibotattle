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

    def test_covered_uses_matching_partial_numerator_not_full_turn_tokens(self):
        row = {**self.row(tokens=1000, duration=None), 'sample_method': 'receipt',
            'sample_tokens': 100, 'sample_duration': 1000, 'sample_responses': 1, 'sample_total_responses': 4}
        before = row.copy()
        samples = plot.tps_samples([row])
        self.assertEqual(plot.trend_bins(samples, 'tps')[0]['median'], 100)
        self.assertEqual(plot.speed_summary(samples)['response_coverage_in_eligible_turns'], .25)
        self.assertEqual(plot.tps_samples([row], 'strict'), [])
        self.assertEqual(row, before)

    def test_null_v2_evidence_never_falls_back_and_v1_remains_supported(self):
        self.assertEqual(plot.tps_samples([{**self.row(), 'sample_method': None}]), [])
        samples = plot.tps_samples([self.row()])
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0]['tps_method'], 'receipt')
        self.assertIsNone(plot.speed_summary(samples)['covered_responses'])
        self.assertEqual(plot.tps_samples([self.row()], 'legacy'), [])

    def test_method_filter_preserves_independent_receipt_and_legacy_samples(self):
        rows = [{**self.row(), 'sample_method': method, 'sample_tokens': tokens,
                 'sample_duration': 1000, 'sample_responses': 1, 'sample_total_responses': 1}
                for method, tokens in [('receipt', 100), ('legacy', 10)]]
        self.assertEqual(len(plot.tps_samples(rows)), 2)
        for method, expected in [('receipt', 100), ('legacy', 10)]:
            samples = plot.tps_samples(rows, method)
            self.assertEqual(len(samples), 1)
            self.assertEqual(plot.trend_bins(samples, 'tps')[0]['median'], expected)

    def test_invalid_timing_is_unavailable_not_zero_or_infinite_speed(self):
        self.assertEqual(plot.tps_samples([self.row(duration=0), self.row(duration=-1),
                                         self.row(tokens=float('nan')), self.row(tokens=True)]), [])


if __name__ == '__main__':
    unittest.main()
