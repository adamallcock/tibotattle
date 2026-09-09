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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True, help='New output prefix; existing files are refused')
    parser.add_argument('--since', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    since = dt.datetime.fromisoformat(args.since).replace(tzinfo=dt.timezone.utc)
    with open(args.input) as handle:
        data = json.load(handle)
    rows = [r for r in data['turns'] if r['at'] >= since.timestamp() * 1000]
    names = {'gpt-5.6-luna': 'Luna', 'gpt-5.6-terra': 'Terra', 'gpt-6-astra': 'Astra', 'gpt-5.6-sol': 'Sol'}
    colors = {'gpt-5.6-luna': '#3267a4', 'gpt-5.6-terra': '#b38324', 'gpt-6-astra': '#c66035', 'gpt-5.6-sol': '#717a40'}
    # Facets identify models even in greyscale; color is a secondary cue.
    fig, axes = plt.subplots(2, 4, figsize=(17.5, 9), sharex=True, sharey='row')
    fig.patch.set_facecolor('#fafafa')
    fig.suptitle('Output speed and recorded turn TTFT over time', x=.065, ha='left', fontsize=22, fontweight='bold')
    fig.text(.065, .918, 'Local Codex sample · one point per completed turn · all reasoning efforts · UTC', fontsize=11, color='#555555')
    summaries = []
    for col, (model, label) in enumerate(names.items()):
        model_rows = [r for r in rows if r['model'] == model]
        speed = [r for r in model_rows if r['duration'] is not None and r['tokens'] is not None]
        ttft = [r for r in model_rows if r['ttft'] is not None and r['ttft'] > 0]
        for i, (subset, field) in enumerate([(speed, 'tps'), (ttft, 'ttft')]):
            ax = axes[i, col]
            times = [dt.datetime.fromtimestamp(r['at'] / 1000, dt.timezone.utc) for r in subset]
            values = [r['tokens'] * 1000 / r['duration'] if field == 'tps' else r['ttft'] / 1000 for r in subset]
            if not subset:
                ax.text(.5, .5, 'No supported measurements', transform=ax.transAxes, ha='center', color='#666666', fontsize=10)
            ax.scatter(times, values, s=27, color=colors[model], alpha=.72, edgecolors='white', linewidths=.35)
            ax.set_title(f'{label}  ·  n = {len(subset)}', loc='left', fontsize=12, pad=10)
            ax.set_facecolor('#fafafa')
            ax.grid(axis='y', color='#dddddd', linewidth=.6)
            ax.set_axisbelow(True)
            ax.spines[['top', 'right']].set_visible(False)
            ax.spines[['bottom', 'left']].set_color('#bbbbbb')
            ax.tick_params(labelsize=9)
            ax.xaxis.set_major_locator(mdates.HourLocator(byhour=[0, 12]))
            ax.xaxis.set_major_formatter(mdates.DateFormatter('%b %d\n%H:%M', tz=dt.timezone.utc))
            if i == 0:
                ax.set_ylim(bottom=0)
            else:
                ax.set_yscale('log')
                ax.set_xlabel('Turn completion (UTC)', fontsize=10)
        summaries.append({'model': model, 'turns': len(model_rows), 'tps_turns': len(speed),
            'ttft_turns': len(ttft), 'output_tokens': sum(r['tokens'] for r in speed),
            'response_ms': sum(r['duration'] for r in speed),
            'weighted_tps': sum(r['tokens'] for r in speed) * 1000 / sum(r['duration'] for r in speed) if speed else None,
            'median_ttft_seconds': statistics.median(r['ttft'] / 1000 for r in ttft) if ttft else None,
            'efforts': dict(collections.Counter(r['effort'] for r in model_rows))})
    all_speeds = [r['tokens'] * 1000 / r['duration'] for r in rows if r['model'] in names and r['duration'] and r['tokens'] is not None]
    axes[0, 0].set_ylim(0, max(all_speeds, default=1) * 1.12)
    axes[0, 0].set_ylabel('Estimated output speed (tokens/s)', fontsize=11)
    axes[1, 0].set_ylabel('Recorded turn TTFT (seconds; log scale)', fontsize=11)
    plotted_tps = sum(s['tps_turns'] for s in summaries)
    plotted_ttft = sum(s['ttft_turns'] for s in summaries)
    other = sum(r['model'] not in names for r in rows)
    fig.text(.065, .105, f'{len(rows):,} completed turns in date range · {plotted_tps} supported TPS points · {plotted_ttft} positive TTFT points · {other:,} other/unknown-model turns omitted', fontsize=9, color='#444444')
    fig.text(.065, .045, 'TPS includes reasoning; response windows exclude intervening tool waits. Missing evidence stays unavailable.\nTTFT is Codex’s recorded turn metric, not per-request server latency. This observational sample is not a controlled model benchmark.', fontsize=9, color='#555555', linespacing=1.6)
    fig.subplots_adjust(left=.065, right=.98, top=.86, bottom=.20, hspace=.30, wspace=.16)
    prefix = Path(args.output)
    for suffix in ['.png', '.svg', '.json']:
        if prefix.with_suffix(suffix).exists():
            raise ValueError('Output already exists')
    fig.savefig(prefix.with_suffix('.png'), dpi=170, facecolor=fig.get_facecolor())
    fig.savefig(prefix.with_suffix('.svg'), facecolor=fig.get_facecolor())
    with open(prefix.with_suffix('.json'), 'x') as handle:
        json.dump({'since': args.since, 'models': summaries, 'quality': dict(collections.Counter(r['quality'] for r in rows))}, handle, indent=2)
    print(json.dumps({'models': summaries, 'completed_in_range': len(rows), 'omitted_models': other}))


if __name__ == '__main__':
    main()
