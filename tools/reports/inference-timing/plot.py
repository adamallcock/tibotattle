"""Static local research plot. Input is the allowlisted timing export, never raw logs."""
import argparse
import collections
import datetime as dt
import json
import os
from pathlib import Path
import statistics

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered or not 0 <= fraction <= 1:
        raise ValueError('Invalid percentile input')
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def trend_bins(rows, metric, hours=24):
    width = hours * 3600 * 1000
    grouped = collections.defaultdict(list)
    for row in rows:
        if metric == 'tps':
            if row['duration'] is None or row['duration'] <= 0 or row['tokens'] is None:
                continue
            value = row['tokens'] * 1000 / row['duration']
        else:
            if row['ttft'] is None or row['ttft'] < 0:
                continue
            value = row['ttft'] / 1000
        grouped[int(row['at'] // width) * width].append(value)
    if not grouped:
        return []
    result = []
    for at in range(min(grouped), max(grouped) + width, width):
        values = grouped.get(at, [])
        low, middle, high = [percentile(values, p) if values else None for p in [.1, .5, .9]]
        q1, q3 = [percentile(values, p) if values else None for p in [.25, .75]]
        result.append({'at': at + width / 2, 'start': at, 'n': len(values),
            'p10': low, 'p25': q1,
            'median': middle, 'p75': q3, 'p90': high,
            'outside_p10_p90': sum(x < low or x > high for x in values) if values else 0,
            'outside_iqr': sum(x < q1 or x > q3 for x in values) if values else 0})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True, help='New output prefix; existing files are refused')
    parser.add_argument('--since', required=True)
    parser.add_argument('--style', choices=['trend', 'scatter'], default='trend')
    parser.add_argument('--bin-hours', type=int, choices=[6, 12, 24, 48, 168], default=24)
    parser.add_argument('--band', choices=['iqr', 'p10-p90'], default='iqr')
    parser.add_argument('--min-bin', type=int, default=5)
    args = parser.parse_args()
    if args.min_bin < 2:
        raise ValueError('Minimum bin size must be at least two')
    low_key, high_key, band_label = ('p25', 'p75', 'P25–P75 (middle 50%)') if args.band == 'iqr' else ('p10', 'p90', 'P10–P90 (middle 80%)')
    os.umask(0o077)
    since = dt.datetime.fromisoformat(args.since).replace(tzinfo=dt.timezone.utc)
    with open(args.input) as handle:
        data = json.load(handle)
    rows = [r for r in data['turns'] if r['at'] >= since.timestamp() * 1000]
    names = {'gpt-5.6-luna': 'Luna', 'gpt-5.6-terra': 'Terra', 'gpt-6-astra': 'Astra', 'gpt-5.6-sol': 'Sol'}
    colors = {'gpt-5.6-luna': '#3267a4', 'gpt-5.6-terra': '#b38324', 'gpt-6-astra': '#c66035', 'gpt-5.6-sol': '#717a40'}
    # Facets identify models even in greyscale; color is a secondary cue.
    fig, axes = plt.subplots(2, 4, figsize=(17.5, 9), sharex='row', sharey='row')
    fig.patch.set_facecolor('#fafafa')
    fig.suptitle('Output speed and recorded turn TTFT over time', x=.065, ha='left', fontsize=22, fontweight='bold')
    subtitle = (f'{args.bin_hours}-hour median · shaded {band_label} of turns · bands require n ≥ {args.min_bin} · all reasoning efforts · UTC'
        if args.style == 'trend' else 'One point per completed turn · all reasoning efforts · UTC')
    fig.text(.065, .918, subtitle, fontsize=11, color='#555555')
    plotted_values = {'tps': [], 'ttft': []}
    summaries = []
    for col, (model, label) in enumerate(names.items()):
        model_rows = [r for r in rows if r['model'] == model]
        speed = [r for r in model_rows if r['duration'] is not None and r['tokens'] is not None]
        ttft = [r for r in model_rows if r['ttft'] is not None and r['ttft'] >= 0]
        bins_by_metric = {}
        for i, (subset, field) in enumerate([(speed, 'tps'), (ttft, 'ttft')]):
            ax = axes[i, col]
            times = [dt.datetime.fromtimestamp(r['at'] / 1000, dt.timezone.utc) for r in subset]
            values = [r['tokens'] * 1000 / r['duration'] if field == 'tps' else r['ttft'] / 1000 for r in subset]
            if not subset:
                ax.text(.5, .5, 'No supported measurements', transform=ax.transAxes, ha='center', color='#666666', fontsize=10)
            bins = trend_bins(model_rows, field, args.bin_hours)
            bins_by_metric[field] = bins
            if args.style == 'trend':
                dense = [b for b in bins if b['n'] >= args.min_bin]
                sparse = [b for b in bins if 0 < b['n'] < args.min_bin]
                x = [dt.datetime.fromtimestamp(b['at'] / 1000, dt.timezone.utc) for b in bins]
                y = [b['median'] if b['n'] >= args.min_bin else float('nan') for b in bins]
                lower = [b[low_key] if b['n'] >= args.min_bin else float('nan') for b in bins]
                upper = [b[high_key] if b['n'] >= args.min_bin else float('nan') for b in bins]
                ax.fill_between(x, lower, upper, color=colors[model], alpha=.17, linewidth=0)
                ax.plot(x, y, color=colors[model], marker='o', markersize=4, linewidth=1.6)
                # Vertical percentile bars also show isolated supported bins.
                if dense:
                    dx = [dt.datetime.fromtimestamp(b['at'] / 1000, dt.timezone.utc) for b in dense]
                    ax.vlines(dx, [b[low_key] for b in dense], [b[high_key] for b in dense], color=colors[model], alpha=.45, linewidth=2)
                if sparse:
                    ax.scatter([dt.datetime.fromtimestamp(b['at'] / 1000, dt.timezone.utc) for b in sparse],
                        [b['median'] for b in sparse], facecolors='none', edgecolors=colors[model], s=30)
                plotted_values[field].extend(b[high_key] for b in dense)
                plotted_values[field].extend(b['median'] for b in sparse)
            else:
                ax.scatter(times, values, s=27, color=colors[model], alpha=.72, edgecolors='white', linewidths=.35)
                plotted_values[field].extend(values)
            ax.set_title(f'{label}  ·  n = {len(subset)}', loc='left', fontsize=12, pad=10)
            ax.set_facecolor('#fafafa')
            ax.grid(axis='y', color='#dddddd', linewidth=.6)
            ax.set_axisbelow(True)
            ax.spines[['top', 'right']].set_visible(False)
            ax.spines[['bottom', 'left']].set_color('#bbbbbb')
            ax.tick_params(labelsize=9)
            ax.xaxis.set_major_locator(mdates.AutoDateLocator(minticks=3, maxticks=5))
            ax.xaxis.set_major_formatter(mdates.DateFormatter('%b %d' if args.bin_hours >= 24 else '%b %d\n%H:%M', tz=dt.timezone.utc))
            if i == 0:
                ax.set_ylim(bottom=0)
            else:
                if args.style == 'scatter':
                    ax.set_yscale('symlog', linthresh=1)
                else:
                    ax.set_ylim(bottom=0)
            ax.set_xlabel('Turn completion (UTC)', fontsize=10)
        summaries.append({'model': model, 'turns': len(model_rows), 'tps_turns': len(speed),
            'ttft_turns': len(ttft), 'output_tokens': sum(r['tokens'] for r in speed),
            'response_ms': sum(r['duration'] for r in speed),
            'weighted_tps': sum(r['tokens'] for r in speed) * 1000 / sum(r['duration'] for r in speed) if speed else None,
            'median_ttft_seconds': statistics.median(r['ttft'] / 1000 for r in ttft) if ttft else None,
            'median_tps': statistics.median(r['tokens'] * 1000 / r['duration'] for r in speed) if speed else None,
            'ttft_over_30_seconds': sum(r['ttft'] > 30000 for r in ttft),
            'bins': bins_by_metric,
            'efforts': dict(collections.Counter(r['effort'] for r in model_rows))})
    # Each metric row uses its actual supported period, shared across models.
    # Older missing TPS is never padded with zero or bridged into recent data.
    axes[0, 0].set_ylim(0, max(1, max(plotted_values['tps'], default=1)) * 1.12)
    if args.style == 'trend':
        axes[1, 0].set_ylim(0, max(1, max(plotted_values['ttft'], default=1)) * 1.12)
    axes[0, 0].set_ylabel('Estimated output speed (tokens/s)', fontsize=11)
    axes[1, 0].set_ylabel('Recorded turn TTFT (seconds)' + ('; symlog scale' if args.style == 'scatter' else ''), fontsize=11)
    plotted_tps = sum(s['tps_turns'] for s in summaries)
    plotted_ttft = sum(s['ttft_turns'] for s in summaries)
    other = sum(r['model'] not in names for r in rows)
    fig.text(.065, .105, f'{len(rows):,} completed turns in date range · {plotted_tps} supported TPS observations · {plotted_ttft} recorded TTFT observations · {other:,} other/unknown-model turns omitted', fontsize=9, color='#444444')
    notes = (f'All values enter percentiles; values outside {band_label} are hidden only by this summary. Hollow dots: sparse bins without a band. Bands show spread, not confidence intervals.'
        if args.style == 'trend' else 'All supported observations are shown; missing evidence stays unavailable.')
    fig.text(.065, .045, notes + '\nTPS includes reasoning and excludes tool gaps. TTFT is Codex’s turn metric. Workload and reasoning-effort mixes differ across models.', fontsize=9, color='#555555', linespacing=1.6)
    fig.subplots_adjust(left=.065, right=.98, top=.86, bottom=.20, hspace=.44, wspace=.16)
    prefix = Path(args.output)
    for suffix in ['.png', '.svg', '.json']:
        if prefix.with_suffix(suffix).exists():
            raise ValueError('Output already exists')
    fig.savefig(prefix.with_suffix('.png'), dpi=170, facecolor=fig.get_facecolor())
    fig.savefig(prefix.with_suffix('.svg'), facecolor=fig.get_facecolor())
    with open(prefix.with_suffix('.json'), 'x') as handle:
        json.dump({'since': args.since, 'style': args.style, 'bin_hours': args.bin_hours, 'minimum_bin': args.min_bin, 'band': args.band, 'models': summaries, 'quality': dict(collections.Counter(r['quality'] for r in rows))}, handle, indent=2)
    print(json.dumps({'models': [{k: v for k, v in s.items() if k != 'bins'} for s in summaries], 'completed_in_range': len(rows), 'omitted_models': other}))


if __name__ == '__main__':
    main()
