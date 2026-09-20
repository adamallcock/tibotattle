"""Static local research plot. Input is the allowlisted timing export, never raw logs."""
import argparse
import collections
import datetime as dt
import json
import math
import os
from pathlib import Path
import statistics
import textwrap

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates


def tps_samples(rows, method='covered'):
    """Select matched numerator/denominator pairs without filling missing v2 evidence."""
    if method not in {'covered', 'strict', 'receipt', 'legacy'}:
        raise ValueError('Unknown TPS method')
    result = []
    for row in rows:
        modern = 'sample_method' in row
        if method == 'strict' or not modern:
            if method == 'legacy':
                continue
            tokens, duration, source = row.get('tokens'), row.get('duration'), 'receipt'
            responses, total = row.get('responses'), row.get('responses')
        else:
            source = row.get('sample_method')
            if source not in {'receipt', 'legacy'} or (method != 'covered' and method != source):
                continue
            tokens, duration = row.get('sample_tokens'), row.get('sample_duration')
            responses, total = row.get('sample_responses'), row.get('sample_total_responses')
        if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in [tokens, duration]):
            continue
        if tokens < 0 or duration <= 0:
            continue
        result.append({**row, 'tokens': tokens, 'duration': duration, 'tps_method': source,
                       'covered_responses': responses, 'total_responses': total})
    return result


def speed_summary(rows):
    """Response coverage is reported only when its denominator is known."""
    duration = sum(r['duration'] for r in rows)
    response_rows = [r for r in rows if r.get('covered_responses') is not None and r.get('total_responses') is not None]
    covered = sum(r['covered_responses'] for r in response_rows)
    total = sum(r['total_responses'] for r in response_rows)
    return {'turns': len(rows), 'output_tokens': sum(r['tokens'] for r in rows),
        'response_ms': duration, 'weighted_tps': sum(r['tokens'] for r in rows) * 1000 / duration if duration else None,
        'median_tps': statistics.median(r['tokens'] * 1000 / r['duration'] for r in rows) if rows else None,
        'covered_responses': covered if response_rows else None,
        'candidate_responses_in_eligible_turns': total if response_rows else None,
        'response_coverage_in_eligible_turns': covered / total if total else None,
        'turns_with_known_response_counts': len(response_rows)}


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


def median_segments(bins, hours=24, maximum_gap_days=7):
    """Connect measured medians; never create observations or percentile bands."""
    observed = [b for b in bins if b['n'] > 0]
    width = hours * 3600 * 1000
    maximum = max(width, maximum_gap_days * 86400000)
    return [{'left': left, 'right': right,
             'dashed': right['start'] - left['start'] > width}
            for left, right in zip(observed, observed[1:])
            if right['start'] - left['start'] <= maximum]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True, help='New output prefix; existing files are refused')
    parser.add_argument('--since', help='Optional completion-date filter; omitted means all retained history')
    parser.add_argument('--models', help='Comma-separated model labels; default is the four current models')
    parser.add_argument('--connect-gap-days', type=int, default=7)
    parser.add_argument('--style', choices=['trend', 'scatter'], default='trend')
    parser.add_argument('--tps-method', choices=['covered', 'strict', 'receipt', 'legacy'], default='covered')
    parser.add_argument('--bin-hours', type=int, choices=[6, 12, 24, 48, 168], default=24)
    parser.add_argument('--band', choices=['iqr', 'p10-p90'], default='iqr')
    parser.add_argument('--min-bin', type=int, default=5)
    args = parser.parse_args()
    if not 0 <= args.connect_gap_days <= 365:
        raise ValueError('Connection gap must be 0–365 days')
    if args.min_bin < 2:
        raise ValueError('Minimum bin size must be at least two')
    low_key, high_key, band_label = ('p25', 'p75', 'P25–P75 (middle 50%)') if args.band == 'iqr' else ('p10', 'p90', 'P10–P90 (middle 80%)')
    os.umask(0o077)
    since = dt.datetime.fromisoformat(args.since).replace(tzinfo=dt.timezone.utc) if args.since else None
    with open(args.input) as handle:
        data = json.load(handle)
    rows = [r for r in data['turns'] if since is None or r['at'] >= since.timestamp() * 1000]
    names = {'gpt-5.6-luna': 'Luna', 'gpt-5.6-terra': 'Terra', 'gpt-6-astra': 'Astra', 'gpt-5.6-sol': 'Sol'}
    colors = {'gpt-5.6-luna': '#3267a4', 'gpt-5.6-terra': '#b38324', 'gpt-6-astra': '#c66035', 'gpt-5.6-sol': '#717a40'}
    known_names = {**names, 'gpt-5.5': 'GPT-5.5', 'gpt-5.4': 'GPT-5.4', 'gpt-5.4-mini': 'GPT-5.4 mini',
        'gpt-5.3-codex-spark': 'Codex Spark', 'gpt-5.3-codex': 'GPT-5.3 Codex', 'gpt-5.2-codex': 'GPT-5.2 Codex', 'gpt-5.2': 'GPT-5.2'}
    if args.models:
        selected = args.models.split(',')
        if not 1 <= len(selected) <= 4 or len(set(selected)) != len(selected) or any(m not in known_names for m in selected):
            raise ValueError('Select 1–4 distinct known models')
        names = {m: known_names[m] for m in selected}
        colors = dict(zip(selected, ['#3267a4', '#b38324', '#c66035', '#717a40']))
    # Facets identify models even in greyscale; color is a secondary cue.
    fig, axes = plt.subplots(2, len(names), figsize=(max(9, 4.375 * len(names)), 10), sharex='row', sharey='row', squeeze=False)
    fig.patch.set_facecolor('#fafafa')
    fig.suptitle('Covered response speed and recorded turn TTFT' if args.tps_method != 'strict' else 'Strict full-turn response speed and recorded TTFT', x=.065, ha='left', fontsize=20, fontweight='bold')
    subtitle = (f'{args.bin_hours}-hour median · shaded {band_label} of turns · bands require n ≥ {args.min_bin} · all reasoning efforts · UTC'
        if args.style == 'trend' else 'One point per completed turn · all reasoning efforts · UTC')
    fig.text(.065, .918, subtitle, fontsize=11, color='#555555')
    if rows:
        dates = [dt.datetime.fromtimestamp(r['at'] / 1000, dt.timezone.utc).strftime('%b %d, %Y') for r in [min(rows, key=lambda r: r['at']), max(rows, key=lambda r: r['at'])]]
        fig.text(.065, .887, f'Retained completion history: {dates[0]} – {dates[1]} · each metric axis shows its supported period', fontsize=10, color='#555555')
    plotted_values = {'tps': [], 'ttft': []}
    summaries = []
    for col, (model, label) in enumerate(names.items()):
        model_rows = [r for r in rows if r['model'] == model]
        speed = tps_samples(model_rows, args.tps_method)
        ttft = [r for r in model_rows if r['ttft'] is not None and r['ttft'] >= 0]
        bins_by_metric = {}
        for i, (subset, field) in enumerate([(speed, 'tps'), (ttft, 'ttft')]):
            ax = axes[i, col]
            if not subset:
                ax.text(.5, .5, 'No supported measurements', transform=ax.transAxes, ha='center', color='#666666', fontsize=10)
            groups = ({source: [r for r in subset if r['tps_method'] == source]
                       for source in ['receipt', 'legacy']} if field == 'tps' else {'ttft': subset})
            bins_by_metric[field] = {}
            for source, source_rows in groups.items():
                bins = trend_bins(source_rows, field, args.bin_hours)
                bins_by_metric[field][source] = bins
                marker = '^' if source == 'legacy' else 'o'
                if args.style == 'trend':
                    dense = [b for b in bins if b['n'] >= args.min_bin]
                    sparse = [b for b in bins if 0 < b['n'] < args.min_bin]
                    x = [dt.datetime.fromtimestamp(b['at'] / 1000, dt.timezone.utc) for b in bins]
                    lower = [b[low_key] if b['n'] >= args.min_bin else float('nan') for b in bins]
                    upper = [b[high_key] if b['n'] >= args.min_bin else float('nan') for b in bins]
                    ax.fill_between(x, lower, upper, color=colors[model], alpha=.17, linewidth=0,
                                    hatch='//' if source == 'legacy' else None)
                    for segment in median_segments(bins, args.bin_hours, args.connect_gap_days):
                        a, b = segment['left'], segment['right']
                        ax.plot([dt.datetime.fromtimestamp(v['at'] / 1000, dt.timezone.utc) for v in [a, b]],
                            [a['median'], b['median']], color=colors[model], linewidth=1.6,
                            linestyle='--' if segment['dashed'] else '-')
                    ax.scatter([dt.datetime.fromtimestamp(b['at'] / 1000, dt.timezone.utc) for b in dense],
                        [b['median'] for b in dense], color=colors[model], s=18, marker=marker, zorder=3)
                    # Vertical percentile bars also show isolated supported bins.
                    if dense:
                        dx = [dt.datetime.fromtimestamp(b['at'] / 1000, dt.timezone.utc) for b in dense]
                        ax.vlines(dx, [b[low_key] for b in dense], [b[high_key] for b in dense], color=colors[model], alpha=.45, linewidth=2)
                    if sparse:
                        ax.scatter([dt.datetime.fromtimestamp(b['at'] / 1000, dt.timezone.utc) for b in sparse],
                            [b['median'] for b in sparse], facecolors='none', edgecolors=colors[model], s=30, marker=marker)
                    plotted_values[field].extend(b[high_key] for b in dense)
                    plotted_values[field].extend(b['median'] for b in sparse)
                else:
                    source_times = [dt.datetime.fromtimestamp(r['at'] / 1000, dt.timezone.utc) for r in source_rows]
                    source_values = [r['tokens'] * 1000 / r['duration'] if field == 'tps' else r['ttft'] / 1000 for r in source_rows]
                    ax.scatter(source_times, source_values, s=27, color=colors[model], alpha=.72,
                               marker=marker, edgecolors='white', linewidths=.35)
                    plotted_values[field].extend(source_values)
            title = f'{label} · {len(subset):,}/{len(model_rows):,} turns'
            if field == 'tps':
                count = speed_summary(speed)['covered_responses']
                title += f"\n{count:,} timed responses" if count is not None else '\nResponse count unavailable'
            else:
                title += '\nRecorded TTFT available'
            ax.set_title(title, loc='left', fontsize=11, pad=10)
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
        method_summaries = {source: speed_summary([r for r in speed if r['tps_method'] == source]) for source in ['receipt', 'legacy']}
        summaries.append({'model': model, 'turns': len(model_rows), 'tps_turns': len(speed),
            'ttft_turns': len(ttft), 'tps_turn_coverage': len(speed) / len(model_rows) if model_rows else None,
            'ttft_turn_coverage': len(ttft) / len(model_rows) if model_rows else None,
            'tps_and_ttft_turns': sum(r.get('ttft') is not None and r['ttft'] >= 0 for r in speed),
            'tps_summary': speed_summary(speed), 'tps_summary_pools_methods': len({r['tps_method'] for r in speed}) > 1,
            'tps_methods': method_summaries,
            'median_ttft_seconds': statistics.median(r['ttft'] / 1000 for r in ttft) if ttft else None,
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
    if not plotted_tps:
        axes[0, 0].set_xticks([])
    other = sum(r['model'] not in names for r in rows)
    fig.text(.065, .135, f'{len(rows):,} retained turns · {plotted_tps:,} TPS-eligible turns · {plotted_ttft:,} TTFT-eligible turns · {other:,} other/unknown-model turns omitted', fontsize=9, color='#444444')
    notes = (f'Solid: adjacent measured medians. Dashed: gaps ≤ {args.connect_gap_days} days. Hollow markers: sparse bins. Gaps have no invented values or bands.'
        if args.style == 'trend' else 'All supported observations are shown; missing evidence stays unavailable.')
    method_note = 'TPS methods stay separate: circles = receipt endpoint; triangles / hatched band = legacy model-item endpoint.'
    coverage_note = 'TPS uses matched tokens / covered response time per turn, including reasoning. TTFT is recorded once per turn; eligible cohorts differ.'
    if args.tps_method == 'strict':
        coverage_note = 'Strict TPS requires every response in the turn to be covered and reconciled. Recorded turn TTFT has an independent eligibility check.'
    footer_lines = [notes, method_note, coverage_note,
                   'Panel fractions: eligible / retained model turns. Response coverage applies to eligible TPS turns. Workload and effort mixes differ.']
    footer = '\n'.join(textwrap.fill(line, width=int(fig.get_figwidth() * 13)) for line in footer_lines)
    fig.text(.065, .025, footer,
             fontsize=9, color='#555555', linespacing=1.65)
    fig.subplots_adjust(left=.065, right=.98, top=.81, bottom=.24, hspace=.59, wspace=.16)
    prefix = Path(args.output)
    for suffix in ['.png', '.svg', '.json']:
        if prefix.with_suffix(suffix).exists():
            raise ValueError('Output already exists')
    fig.savefig(prefix.with_suffix('.png'), dpi=170, facecolor=fig.get_facecolor())
    fig.savefig(prefix.with_suffix('.svg'), facecolor=fig.get_facecolor())
    with open(prefix.with_suffix('.json'), 'x') as handle:
        json.dump({'since': args.since, 'style': args.style, 'bin_hours': args.bin_hours, 'minimum_bin': args.min_bin, 'band': args.band, 'connect_gap_days': args.connect_gap_days, 'tps_method': args.tps_method, 'tps_methods_plotted_separately': True, 'models': summaries, 'quality': dict(collections.Counter(r['quality'] for r in rows))}, handle, indent=2)
    print(json.dumps({'models': [{k: v for k, v in s.items() if k != 'bins'} for s in summaries], 'completed_in_range': len(rows), 'omitted_models': other}))


if __name__ == '__main__':
    main()
