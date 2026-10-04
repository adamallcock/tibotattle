import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { linuxFinalHostContainerArguments } from '../scripts/run-electron-linux-final-lifecycle.mjs';
import { LINUX_MOUNT_DIAGNOSIS_SCHEMA, LINUX_MOUNT_DIAGNOSIS_CONFIRMATION, LINUX_MOUNT_KMSG_READER,
  normalizeLinuxMountPolicy, createLinuxMountErrorClassifier, selectLinuxMountProbeMount, buildLinuxAppImageActorGraph, linuxAppImageGateArguments,
  validateLinuxMountDiagnosis, runLinuxMountSequence, linuxMountPreflightEnvironment,
  linuxMountContainerArguments, linuxMountCleanupArguments, linuxMountOwnedProcessGone, linuxMountAuditReaderReason, correlateLinuxMountAudit, projectLinuxMountProbeFacts } from '../scripts/diagnose-electron-linux-appimage-mount.mjs';

import { LINUX_APPARMOR_COMPARISON_SCHEMA, LINUX_APPARMOR_COMPARISON_CONFIRMATION, LINUX_APPARMOR_TEMPLATE_SHA256,
  LINUX_APPARMOR_DAEMON_READER, LINUX_APPARMOR_PROFILE_ACTORS, normalizeLinuxAppArmorMountTuple, validateLinuxAppArmorMountTuple,
  linuxAppArmorProfileName, renderLinuxAppArmorBasis, linuxAppArmorMountRule, deriveLinuxAppArmorProfile,
  validateLinuxAppArmorComparison, runLinuxAppArmorComparison, linuxAppArmorRemovalAllowed, linuxAppArmorPrivilegedArguments,
  readLinuxAppArmorRootImport, readLinuxAppArmorImportBinding, withLinuxAppArmorImportBinding, linuxAppArmorImportFailure } from '../scripts/lib/linux-apparmor-mount-profile.mjs';

const temporary = '/opt/tibotattle-updater-exec/tmp/' + 'a'.repeat(32);
const image = '/opt/tibotattle-updater-exec/TiboTattle.AppImage';
const target = `${temporary}/.mount_TiboTa123456`;
const mountinfo = `91 40 0:82 / ${target} ro,nosuid,nodev,relatime - fuse.squashfuse squashfuse ro,user_id=1000,group_id=1000\n`;
const status = 'NoNewPrivs:\t0\nSeccomp:\t2\nCapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapBnd:\t0000000000200000\n';
const policy = () => normalizeLinuxMountPolicy({ status, appArmor: 'docker-default (enforce)\n' });
function probe() {
  return { environment: { ...policy(), fuseDevice: { characterDevice: true, readable: true, writable: true },
    fusermount: { present: true, regular: true, rootOwned: true, setuid: true, executable: true } },
  startup: { schemaVersion: 'tibotattle-linux-startup-diagnostic-v1',
    process: { state: 'exited', spawnErrno: null, exitCode: 127, signal: null, aliveBeforeCleanup: false },
    stderr: { fuseAccess: false, fuseMount: true, namespaceDenial: false, sandboxHelper: false,
      sandboxUnavailable: false, sharedLibrary: false, unknown: false, truncated: false },
    fuseMount: { state: 'not_sampled', type: null, uid: null, readOnly: null, nosuid: null, nodev: null, noexec: null } },
  mount: 'not_observed', launcherErrors: createLinuxMountErrorClassifier().finish(), cleanup: { childGone: true, mountGone: true } };
}
const pair = { intake: { runnerRevision: 'b'.repeat(40), sourceRevision: 'c'.repeat(40) },
  images: { current: { sha256: 'd'.repeat(64), bytes: 8192 }, next: { sha256: 'e'.repeat(64), bytes: 8193 } } };
function row(role, changes = {}) { return { role, artifactSha256: pair.images[role].sha256, artifactBytes: pair.images[role].bytes,
  probe: probe(), errorCode: 'none', appArmorMountDenial: 'unavailable', appArmorAuditReason: 'no_observed_mount_denial', containerRemoved: true, observerStopped: true,
  actorTrace: { complete: true, reason: 'none', instanceRemoved: true }, ...changes }; }
function actorEvents() {
  return [{ type: 'exec', pid: 76, oldPid: 76, image: true }, { type: 'fork', pid: 77, parent: 76 },
    { type: 'exit', pid: 77 }, { type: 'exit', pid: 76 }];
}
function auditFixture() {
  return { profile: 'docker-default', temporary, containerRemoved: true,
    graph: buildLinuxAppImageActorGraph({ rootPid: 76, events: actorEvents(), complete: true }),
    audit: { ready: true, closed: true, complete: true, reason: 'none', start: 90, end: 210, records: [
      { time: 150, message: `audit: type=1400 audit(1790000000.123:44): apparmor="DENIED" operation="mount" profile="docker-default" name="${target}/" pid=77 comm="fusermount" srcname="${image}" fstype="fuse" flags="rw, nosuid, nodev"` },
    ] } };
}

// The owning native lane already requires Python for exact artifact intake.
// Compile the exact embedded observer without running any of its host reads.
test('the exact embedded private observer compiles without executing it', () => {
  const result = spawnSync('python3', ['-c', "import sys; compile(sys.stdin.buffer.read(), '<mount-observer>', 'exec')"], {
    input: LINUX_MOUNT_KMSG_READER, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000, maxBuffer: 4096,
  });
  assert.equal(result.status, 0); assert.equal(result.signal, null); assert.equal(result.error, undefined);
});

test('kernel actor births retain a fast FUSE child without equating audit delivery with its lifetime', () => {
  const input = auditFixture();
  assert.deepEqual([...input.graph.actors.values()], [
    { pid: 76, birth: 0, parent: null, depth: 0, appImage: true, alive: false },
    { pid: 77, birth: 2, parent: 76, depth: 1, appImage: true, alive: false },
  ]);
  // A queued kernel audit arrives after the complete exit sequence was read.
  // kmsg delivery's clock need not have Python CLOCK_MONOTONIC's offset.
  for (const time of [1, 209, 900000000000]) {
    input.audit.records[0].time = time;
    assert.deepEqual(correlateLinuxMountAudit(input), { denial: true, reason: 'owned_mount_denial' });
  }
  assert.doesNotMatch(JSON.stringify([...input.graph.actors.values()]), /start|first|last|timestamp|comm|filename/u);
  input.containerRemoved = false;
  assert.deepEqual(correlateLinuxMountAudit(input), { denial: 'unavailable', reason: 'probe_cleanup_unproven' });
});

test('actor attribution refuses wrong ancestry, missing exec, ambiguous task mapping and PID reuse', () => {
  for (const events of [
    actorEvents().map(event => event.type === 'fork' ? { ...event, parent: 79 } : event),
    actorEvents().slice(1),
    actorEvents().map(event => event.type === 'exec' ? { ...event, image: false } : event),
    actorEvents().map(event => event.type === 'exec' ? { ...event, oldPid: 75 } : event),
    [...actorEvents().slice(0, 3), { type: 'fork', pid: 77, parent: 76 }, { type: 'exit', pid: 77 }, { type: 'exit', pid: 76 }],
    [...actorEvents(), { type: 'fork', pid: 78, parent: 76 }],
    actorEvents().slice(0, -1),
    actorEvents().map(event => event.type === 'fork' ? { ...event, command: 'synthetic-private-marker' } : event),
  ]) {
    const graph = buildLinuxAppImageActorGraph({ rootPid: 76, events, complete: true });
    assert.equal(graph.complete, false); assert.equal(graph.reason, 'trace_graph_ambiguous'); assert.equal(graph.actors.size, 0);
  }
  const input = auditFixture();
  input.graph = buildLinuxAppImageActorGraph({ rootPid: 76, complete: true, events: [
    { type: 'fork', pid: 77, parent: 76 }, { type: 'exec', pid: 76, oldPid: 76, image: true },
    { type: 'exit', pid: 77 }, { type: 'exit', pid: 76 },
  ] });
  assert.equal(input.graph.complete, true); assert.equal(input.graph.actors.get(77).appImage, false);
  assert.equal(correlateLinuxMountAudit(input).reason, 'owned_actor_not_correlated');
  const priorPids = new Set([77]);
  assert.equal(buildLinuxAppImageActorGraph({ rootPid: 76, events: actorEvents(), complete: true, priorPids }).reason, 'trace_graph_ambiguous');
  assert.deepEqual([...priorPids], [77]);
});

test('actor graph bounds and incomplete capture never turn into a complete ownership claim', () => {
  const build = changes => buildLinuxAppImageActorGraph({ rootPid: 76, events: actorEvents(), complete: true, ...changes });
  for (const reason of ['tracefs_unavailable', 'trace_layout_unavailable', 'gate_identity_unavailable', 'trace_stream_incomplete',
    'trace_cleanup_failed', 'reader_failed', 'reader_timeout']) {
    const graph = build({ complete: false, reason });
    assert.deepEqual(graph, { complete: false, reason, actors: new Map() });
  }
  assert.equal(build({ complete: false }).reason, 'trace_stream_incomplete');
  assert.equal(build({ complete: 'yes' }).reason, 'trace_stream_incomplete');
  assert.equal(build({ complete: false, reason: 'synthetic-private-marker' }).reason, 'trace_stream_incomplete');
  const fan = [{ type: 'exec', pid: 76, oldPid: 76, image: true }, ...Array.from({ length: 128 }, (_, index) => ({ type: 'fork', pid: 1000 + index, parent: 76 }))];
  const deep = [{ type: 'exec', pid: 76, oldPid: 76, image: true }, ...Array.from({ length: 33 }, (_, index) => ({ type: 'fork', pid: 77 + index, parent: 76 + index }))];
  for (const changes of [{ events: Array(4097).fill({ type: 'exit', pid: 76 }) }, { events: fan }, { events: deep },
    { priorPids: new Set(Array.from({ length: 640 }, (_, index) => 1000 + index)) }]) {
    assert.deepEqual(build(changes), { complete: false, reason: 'trace_limits_exceeded', actors: new Map() });
  }
});

test('the stopped launcher replaces itself with exactly the unchanged mount-only image and C environment', () => {
  const environment = { TIBOTATTLE_MOUNT_PROBE_NONCE: 'a'.repeat(32), TMPDIR: temporary,
    LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C', ELECTRON_DISABLE_SANDBOX: '0' };
  assert.deepEqual(linuxAppImageGateArguments(environment), [image, '--appimage-mount']);
  for (const change of [{ TMPDIR: '/private/synthetic-other' }, { TIBOTATTLE_MOUNT_PROBE_NONCE: 'b'.repeat(32) },
    { LC_ALL: 'en_US.UTF-8' }, { LANG: 'en_US.UTF-8' }, { LANGUAGE: 'en_US.UTF-8' },
    { APPIMAGE_EXTRACT_AND_RUN: '1' }, { ELECTRON_DISABLE_SANDBOX: '1' }]) {
    assert.throws(() => linuxAppImageGateArguments({ ...environment, ...change }), /^Error: LINUX_MOUNT_DIAGNOSIS_REFUSED$/u);
  }
});

// Execute only selected pure function definitions from the exact observer. The
// observer's imports, top-level launch, /proc reads and tracefs access never run.
function syntheticObserver(functions, fixture) {
  const driver = String.raw`
import ast, json, re, stat, sys, types
payload = json.loads(sys.stdin.read())
tree = ast.parse(payload['source'])
selected = [item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name in payload['functions']]
if sorted(item.name for item in selected) != sorted(payload['functions']): raise ValueError()
exec(compile(ast.Module(body=selected, type_ignores=[]), '<synthetic-observer>', 'exec'))
` + fixture;
  const result = spawnSync('python3', ['-c', driver], { input: JSON.stringify({ source: LINUX_MOUNT_KMSG_READER, functions }),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000, maxBuffer: 65536 });
  assert.equal(result.status, 0); assert.equal(result.signal, null); assert.equal(result.error, undefined);
  return JSON.parse(result.stdout);
}

test('the actual kernel trace parser projects closed actor events and refuses unknown or over-budget records', () => {
  const result = syntheticObserver(['trace_line'], String.raw`
rows = []
events = 0
exit_format = 'legacy'
emit = rows.append
prefix = 'synthetic-76 [001] .... 1.000001: sched_process_'
trace_line(prefix + 'exec: filename=/opt/tibotattle-updater-exec/TiboTattle.AppImage pid=76 old_pid=76', {1})
trace_line(prefix + 'fork: comm=synthetic pid=76 child_comm=private-marker child_pid=77', {1})
trace_line('private-marker-77 [001] .... 1.000002: sched_process_exit: comm=private-marker pid=77 prio=120', {1})
trace_line(prefix + 'exec: filename=/private/synthetic-other pid=76 old_pid=76', {1})
refused = []
for line in [prefix + 'fork: comm=x pid=75 child_comm=y child_pid=77',
    prefix.replace('[001]', '[002]') + 'exit: comm=x pid=76 prio=120',
    'CPU:1 [LOST 1 EVENTS]', prefix + 'unknown: private-marker',
    prefix + 'exec: filename=' + 'x' * 4097 + ' pid=76 old_pid=76']:
    try: trace_line(line, {1}); refused.append(False)
    except ValueError: refused.append(True)
events = 4096
try: trace_line(prefix + 'exit: comm=x pid=76 prio=120', {1}); refused.append(False)
except OverflowError: refused.append(True)
print(json.dumps({'rows': rows, 'refused': refused}))
`);
  assert.deepEqual(result.rows, [
    { kind: 'actor', event: { type: 'exec', pid: 76, oldPid: 76, image: true } },
    { kind: 'actor', event: { type: 'fork', parent: 76, pid: 77 } },
    { kind: 'actor', event: { type: 'exit', pid: 77 } },
    { kind: 'actor', event: { type: 'exec', pid: 76, oldPid: 76, image: false } },
  ]);
  assert.deepEqual(result.refused, Array(6).fill(true));
  assert.doesNotMatch(JSON.stringify(result), /private|synthetic|filename|comm|\/opt\//u);
});

test('the actual trace drain spans chunks and refuses byte overflow, partial tails and unexpected EOF', () => {
  const result = syntheticObserver(['trace_line', 'drain_trace'], String.raw`
def scenario(chunks, initial=0, final=False):
    global os, trace_fd, used, trace_pending, events, emit
    pending = list(chunks); rows = []
    def consume(handle, size):
        if not pending: raise BlockingIOError()
        return pending.pop(0)
    os = types.SimpleNamespace(read=consume)
    trace_fd = 3; used = initial; trace_pending = b''; events = 0; emit = rows.append
    error = None
    try: drain_trace({1}, final)
    except OverflowError: error = 'bounded'
    except Exception: error = 'incomplete'
    return {'error': error, 'completeLine': not bool(trace_pending), 'rows': rows}
line = b'x-76 [001] .... 1.000001: sched_process_exec: filename=/opt/tibotattle-updater-exec/TiboTattle.AppImage pid=76 old_pid=76\n'
results = [scenario([line[:31], line[31:]]), scenario([b'x' * 8193]), scenario([b'x'], 262144),
    scenario([b'']), scenario([b''], final=True), scenario([line[:-1], b''], final=True), scenario([b'\xff\n'])]
print(json.dumps(results))
`);
  assert.deepEqual(result[0], { error: null, completeLine: true, rows: [{ kind: 'actor', event: { type: 'exec', pid: 76, oldPid: 76, image: true } }] });
  assert.equal(result[1].error, 'bounded'); assert.equal(result[2].error, 'bounded');
  assert.equal(result[3].error, 'incomplete');
  assert.deepEqual(result[4], { error: null, completeLine: true, rows: [] });
  assert.deepEqual(result[5], { error: null, completeLine: false, rows: [] });
  assert.equal(result[6].error, 'incomplete');
  assert.doesNotMatch(JSON.stringify(result), /filename|comm|\/opt\//u);
});

test('trace buffer setup admits kernel-rounded 63 KiB only on the bound 4 KiB layout and original cap', () => {
  const result = syntheticObserver(['configure_trace_buffer'], String.raw`
def scenario(change):
    global os, control, local_read
    writes = []; values = {}; subbuf_reads = [0]
    os = types.SimpleNamespace(sysconf=lambda name: change.get('page', 4096) if name == 'SC_PAGE_SIZE' else None)
    def write(name, value):
        if name != 'buffer_size_kb': raise ValueError()
        writes.append([name, value])
        # Actual reviewed kernel rounding: 4080-byte payload per 4096-byte page.
        pages = (int(value) * 1024 + 4079) // 4080
        values['buffer_size_kb'] = str((pages * 4080) >> 10)
        values['buffer_total_size_kb'] = str(int(values['buffer_size_kb']) * change.get('cpus', 4))
    def read(name):
        if name == 'buffer_subbuf_size_kb':
            subbuf_reads[0] += 1
            return '8' if change.get('drift') and subbuf_reads[0] > 1 else change.get('subbuf', '4')
        return change.get(name, values[name])
    control = write; local_read = read
    try: configure_trace_buffer(); admitted = True
    except Exception: admitted = False
    return {'admitted': admitted, 'writes': writes}
changes = [{}, {'cpus': 8}, {'page': 8192}, {'subbuf': '8'}, {'subbuf': 'synthetic-private-layout'},
    {'buffer_size_kb': '67'}, {'buffer_size_kb': '64'}, {'buffer_total_size_kb': '513'},
    {'buffer_total_size_kb': '0'}, {'buffer_total_size_kb': '-1'}, {'buffer_total_size_kb': 'synthetic-private-layout'}, {'drift': True}]
print(json.dumps([scenario(change) for change in changes]))
`);
  const write = [['buffer_size_kb', '63\n']];
  assert.deepEqual(result.slice(0, 2), [{ admitted: true, writes: write }, { admitted: true, writes: write }]);
  for (const row of result.slice(2)) assert.equal(row.admitted, false);
  for (const row of result.slice(2, 5)) assert.deepEqual(row.writes, []);
  for (const row of result.slice(5)) assert.deepEqual(row.writes, write);
  assert.doesNotMatch(JSON.stringify(result), /private|layout/u);
});

const traceEventFixture = String.raw`
def configure(shape='legacy', changes=None, denied=None):
    global local_read, control, setup_reason
    changes = changes or {}; writes = []
    formats = {'fork': 'comm=%s pid=%d child_comm=%s child_pid=%d',
        'exec': 'filename=%s pid=%d old_pid=%d', 'exit': 'comm=%s pid=%d prio=%d'}
    arguments = {'fork': 'REC->parent_comm, REC->parent_pid, REC->child_comm, REC->child_pid',
        'exec': '__get_str(filename), REC->pid, REC->old_pid', 'exit': 'REC->comm, REC->pid, REC->prio'}
    if shape == 'group_dead':
        formats['exit'] += ' group_dead=%s'
        arguments['exit'] += ', REC->group_dead ? "true" : "false"'
    def read(name):
        match = re.fullmatch(r'events/sched/sched_process_(fork|exec|exit)/(format|filter|trigger|enable)', name)
        if not match: raise ValueError()
        kind, field = match.groups()
        if denied == (kind, 'enable_readback' if field == 'enable' else field): raise PermissionError()
        defaults = {'format': 'name: sched_process_' + kind + '\nID: 42\nformat:\n\nprint fmt: "' + formats[kind] + '", ' + arguments[kind] + '\n',
            'filter': 'none\n', 'trigger': '# Available triggers:\n# traceon traceoff snapshot\n', 'enable': '1\n' if kind in writes else '0\n'}
        return changes.get(kind + '/' + field, defaults[field])
    def write(name, value):
        match = re.fullmatch(r'events/sched/sched_process_(fork|exec|exit)/enable', name)
        if not match or value != '1\n': raise ValueError()
        if denied == (match[1], 'enable_write'): raise PermissionError()
        writes.append(match[1])
    local_read = read; control = write
    try: configure_trace_events(); admitted = True
    except Exception: admitted = False
    return {'admitted': admitted, 'reason': None if admitted else setup_reason, 'selector': exit_format, 'writes': writes}
`;

test('live event admission binds exit parsing to exactly the legacy or group-dead format', () => {
  const result = syntheticObserver(['configure_trace_events', 'trace_line'], traceEventFixture + String.raw`
results = []
prefix = 'private-marker-76 [001] .... 1.000001: sched_process_exit: comm=private-marker pid=76 prio=120'
for shape in ('legacy', 'group_dead'):
    admission = configure(shape)
    rows = []; events = 0; emit = rows.append
    accepted = [prefix] if shape == 'legacy' else [prefix + ' group_dead=true', prefix + ' group_dead=false']
    for line in accepted: trace_line(line, {1})
    invalid = ([prefix + ' group_dead=true', prefix + ' group_dead=false'] if shape == 'legacy' else [prefix]) + [
        prefix + ' group_dead=1', prefix + ' group_dead=True', prefix + ' group_dead=unknown',
        prefix + ' group_dead=true trailing', prefix + ' group_dead=true group_dead=false', prefix + ' trailing',
        accepted[0] + ' ', accepted[0].replace('pid=76', 'pid=75')]
    refused = []
    for line in invalid:
        try: trace_line(line, {1}); refused.append(False)
        except ValueError: refused.append(True)
    results.append({'admission': admission, 'rows': rows, 'refused': refused})
# A second setup that fails must clear the previous successful selector.
failed = configure('legacy', {'exit/filter': 'pid == 76\n'})
try: trace_line(prefix, {1}); refused_after_failure = False
except ValueError: refused_after_failure = True
print(json.dumps({'results': results, 'failed': failed, 'refusedAfterFailure': refused_after_failure}))
`);
  for (const [index, selector] of ['legacy', 'group_dead'].entries()) {
    const value = result.results[index];
    assert.deepEqual(value.admission, { admitted: true, reason: null, selector, writes: ['fork', 'exec', 'exit'] });
    assert.deepEqual(value.rows, Array(index + 1).fill({ kind: 'actor', event: { type: 'exit', pid: 76 } }));
    assert.deepEqual(value.refused, Array(index === 0 ? 10 : 9).fill(true));
  }
  assert.deepEqual(result.failed, { admitted: false, reason: 'trace_exit_filter_unavailable', selector: null, writes: ['fork', 'exec'] });
  assert.equal(result.refusedAfterFailure, true);
  assert.doesNotMatch(JSON.stringify(result), /private|comm|prio|true trailing|filename/u);
});

test('event setup refuses unknown or ambiguous formats and identifies each exact failed operation', () => {
  const result = syntheticObserver(['configure_trace_events'], traceEventFixture + String.raw`
legacy = 'print fmt: "comm=%s pid=%d prio=%d", REC->comm, REC->pid, REC->prio\n'
modern = 'print fmt: "comm=%s pid=%d prio=%d group_dead=%s", REC->comm, REC->pid, REC->prio, REC->group_dead ? "true" : "false"\n'
formats = ['', 'private-format-marker\n', legacy + legacy, legacy + modern,
    legacy.replace('prio=%d"', 'prio=%d extra=%s"'), modern.replace('group_dead=%s', 'group_dead=%d'),
    legacy.replace('print fmt:', 'print fmt :'), legacy.rstrip() + ' PRIVATE\nprint fmt: broken\n']
refused_formats = [configure('legacy', {'exit/format': value}) for value in formats]
boundaries = []
for kind in ('fork', 'exec', 'exit'):
    for operation in ('format', 'filter', 'trigger', 'enable_write', 'enable_readback'):
        denied = (kind, operation) if operation == 'enable_write' else None
        values = {'format': 'print fmt: "private-format-marker", REC->pid\n', 'filter': 'pid == 76\n',
            'trigger': '# Available triggers:\ntraceon:unlimited\n', 'enable_readback': '1*\n'}
        field = 'enable' if operation == 'enable_readback' else operation
        changes = {} if denied else {kind + '/' + field: values[operation]}
        boundaries.append(configure('group_dead', changes, denied))
# A read failure also stays at its own operation rather than becoming a format guess.
denied_read = configure('legacy', denied=('exec', 'filter'))
print(json.dumps({'formats': refused_formats, 'boundaries': boundaries, 'deniedRead': denied_read}))
`);
  for (const value of result.formats) {
    assert.deepEqual(value, { admitted: false, reason: 'trace_exit_format_unavailable', selector: null, writes: ['fork', 'exec'] });
  }
  const operations = ['format', 'filter', 'trigger', 'enable_write', 'enable_readback'];
  for (const [index, value] of result.boundaries.entries()) {
    const eventIndex = Math.floor(index / operations.length), operation = operations[index % operations.length];
    const writes = ['fork', 'exec', 'exit'].slice(0, eventIndex + Number(operation === 'enable_readback'));
    assert.deepEqual(value, { admitted: false, reason: `trace_${['fork', 'exec', 'exit'][eventIndex]}_${operation}_unavailable`, selector: null, writes });
  }
  assert.deepEqual(result.deniedRead, { admitted: false, reason: 'trace_exec_filter_unavailable', selector: null, writes: ['fork'] });
  assert.doesNotMatch(JSON.stringify(result), /private|PRIVATE|REC|pid ==|traceon|1\*/u);
});

test('every trace setup boundary has a fixed closed refusal reason without exposing native readbacks', () => {
  const reasons = ['trace_instance_setup_unavailable', 'trace_initial_controls_unavailable', 'trace_cpu_layout_unavailable',
    'trace_buffer_layout_unavailable', 'trace_options_unavailable', 'trace_clock_unavailable',
    ...['fork', 'exec', 'exit'].flatMap(event => ['format', 'filter', 'trigger', 'enable_write', 'enable_readback'].map(operation => `trace_${event}_${operation}_unavailable`)),
    'trace_pid_filter_unavailable', 'trace_pipe_unavailable', 'trace_gate_recheck_unavailable', 'trace_start_unavailable'];
  assert.match(LINUX_MOUNT_KMSG_READER, /        configure_trace_events\(\)\n        setup_reason = 'trace_pid_filter_unavailable'/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /except Exception: incomplete\(setup_reason, True\); raise/u);
  for (const reason of reasons) {
    const graph = buildLinuxAppImageActorGraph({ complete: false, reason });
    assert.deepEqual(graph, { complete: false, reason, actors: new Map() });
    const value = { schemaVersion: LINUX_MOUNT_DIAGNOSIS_SCHEMA, purpose: 'diagnostic_only', qualifiesRelease: false,
      ...pair.intake, cases: [row('current', { probe: null, errorCode: 'container_failed', appArmorAuditReason: 'reader_failed',
        actorTrace: { complete: false, reason, instanceRemoved: true } })] };
    assert.equal(validateLinuxMountDiagnosis(value), value);
    value.cases[0].actorTrace.reason += '/synthetic-private-readback';
    assert.equal(validateLinuxMountDiagnosis(value), null);
  }
});

test('the actual trace completeness check refuses loss, missing counters, CPU drift and undrained events', () => {
  const result = syntheticObserver(['no_loss'], String.raw`
text = 'entries: 0\noverrun: 0\ncommit overrun: 0\ndropped events: 0\n'
cpus = lambda: {0, 1}
local_read = lambda name, limit: text
values = [no_loss({0, 1}, True)]
for text in ['entries: 1\noverrun: 0\ncommit overrun: 0\ndropped events: 0\n',
    'entries: 0\noverrun: 1\ncommit overrun: 0\ndropped events: 0\n',
    'entries: 0\noverrun: 0\ncommit overrun: 1\ndropped events: 0\n',
    'entries: 0\noverrun: 0\ncommit overrun: 0\ndropped events: 1\n',
    'entries: 0\noverrun: 0\ncommit overrun: 0\n',
    'entries: 0\noverrun: 0\ncommit overrun: 0\ndropped events: 0\noverrun: 0\n']:
    values.append(no_loss({0, 1}, True))
text = 'entries: 0\noverrun: 0\ncommit overrun: 0\ndropped events: 0\n'
values.append(no_loss({0}, True))
print(json.dumps(values))
`);
  assert.deepEqual(result, [true, ...Array(7).fill(false)]);
});

test('trace recovery removes only a journaled inode after both owned processes are gone', () => {
  const result = syntheticObserver(['cleanup_record'], String.raw`
record = {'observerPid': 91, 'observerStart': '111', 'initPid': 92, 'initStart': '222',
    'rootKind': 'tracing', 'instance': 'tibotattle-synthetic', 'device': '7', 'inode': '8'}
base = types.SimpleNamespace(st_mode=0o40700, st_uid=0, st_dev=7, st_ino=8)
expected = '/synthetic-tracefs/instances/tibotattle-synthetic'
def scenario(change):
    global owned_journal, gone, trace_root, os, control, local_read, instance_fd
    calls = []; exists = [not change.get('absent', False)]
    def journal(intent=False):
        if change.get('denied'): raise PermissionError()
        if change.get('no_journal') or change.get('intent_only') and not intent: raise FileNotFoundError()
        return dict(record, rootKind='debug' if change.get('wrong_root') else 'tracing')
    def info(path):
        if path != expected: raise ValueError()
        if not exists[0]: raise FileNotFoundError()
        return types.SimpleNamespace(**{**vars(base), **({'st_ino': 9} if change.get('wrong_inode') else {})})
    def remove(path):
        if path != expected: raise ValueError()
        calls.append('remove'); exists[0] = False
    def write(name, value):
        calls.append(name)
        if change.get('write_denied'): raise PermissionError()
    owned_journal = journal
    gone = lambda pid, ticks: not (change.get('observer_alive') and pid == 91 or change.get('init_alive') and pid == 92)
    trace_root = lambda: ('/synthetic-tracefs', 'tracing')
    os = types.SimpleNamespace(lstat=info, open=lambda *args, **kwargs: 3,
        fstat=lambda handle: types.SimpleNamespace(**{**vars(base), **({'st_ino': 99} if change.get('changed_descriptor') else {})}), close=lambda handle: None, rmdir=remove,
        O_RDONLY=0, O_DIRECTORY=0, O_NOFOLLOW=0,
        path=types.SimpleNamespace(realpath=lambda path: path, lexists=lambda path: exists[0]))
    control = write
    local_read = lambda name: '1' if change.get('still_tracing') else '0'
    instance_fd = None
    try: removed = cleanup_record()
    except Exception: removed = False
    return {'removed': removed, 'calls': calls}
changes = [{}, {'observer_alive': True}, {'init_alive': True}, {'wrong_inode': True}, {'wrong_root': True},
    {'intent_only': True}, {'denied': True}, {'write_denied': True}, {'still_tracing': True}, {'changed_descriptor': True},
    {'no_journal': True}, {'intent_only': True, 'absent': True}]
print(json.dumps([scenario(change) for change in changes]))
`);
  assert.deepEqual(result[0], { removed: true, calls: ['tracing_on', 'events/enable', 'options/event-fork', 'remove'] });
  for (const item of result.slice(1, 10)) { assert.equal(item.removed, false); assert.ok(!item.calls.includes('remove')); }
  assert.deepEqual(result.slice(10), [{ removed: true, calls: [] }, { removed: true, calls: [] }]);
});

test('mount diagnosis requires its own explicit confirmation without altering lifecycle admission', () => {
  const input = { SELECTED_MODE: 'execute', SELECTED_CONFIRMATION: LINUX_MOUNT_DIAGNOSIS_CONFIRMATION, LINUX_FINAL_INTAKE: 'unchanged' };
  assert.equal(linuxMountPreflightEnvironment(input).SELECTED_CONFIRMATION, 'RUN_DISPOSABLE_FINAL_LINUX_LIFECYCLE');
  assert.equal(input.SELECTED_CONFIRMATION, LINUX_MOUNT_DIAGNOSIS_CONFIRMATION);
  assert.equal(linuxMountPreflightEnvironment({ SELECTED_MODE: 'plan', SELECTED_CONFIRMATION: '' }).SELECTED_CONFIRMATION, '');
  for (const changed of [{ ...input, SELECTED_CONFIRMATION: 'RUN_DISPOSABLE_FINAL_LINUX_LIFECYCLE' },
    { ...input, SELECTED_MODE: 'arbitrary' }, { SELECTED_MODE: 'plan', SELECTED_CONFIRMATION: LINUX_MOUNT_DIAGNOSIS_CONFIRMATION }]) assert.throws(() => linuxMountPreflightEnvironment(changed));
});

test('actual capability bits and policy availability remain independent of requested Docker flags', () => {
  assert.deepEqual(policy(), { appArmor: { profile: 'docker_default', enforcement: 'enforce' }, seccomp: 'filter', noNewPrivileges: false,
    sysAdmin: { effective: false, permitted: false, bounding: true } });
  const unavailable = normalizeLinuxMountPolicy({ status: null, appArmor: null });
  assert.deepEqual(unavailable.sysAdmin, { effective: 'unavailable', permitted: 'unavailable', bounding: 'unavailable' });
  assert.equal(unavailable.noNewPrivileges, 'unavailable'); assert.equal(unavailable.seccomp, 'unavailable');
  const privateProfile = normalizeLinuxMountPolicy({ status: status.replace('Seccomp:\t2', 'Seccomp:\tconstructor'), appArmor: 'private-profile-marker (complain)\n' });
  assert.deepEqual(privateProfile.appArmor, { profile: 'other', enforcement: 'complain' });
  assert.equal(privateProfile.seccomp, 'unavailable'); assert.doesNotMatch(JSON.stringify(privateProfile), /private-profile-marker/u);
  assert.equal(normalizeLinuxMountPolicy({ status: `${status}CapEff:\t00200000\n`, appArmor: 'docker-default' }).sysAdmin.effective, 'unavailable');
  assert.equal(normalizeLinuxMountPolicy({ status, appArmor: 'docker-default' }).appArmor.enforcement, 'unavailable');
});

test('C-locale error classes span chunks but never retain private stderr or classify discarded text', () => {
  const classifier = createLinuxMountErrorClassifier(); classifier.feed('fusermount: mount failed: Operation not '); classifier.feed('permitted\nprivate-command-marker\n');
  const result = classifier.finish(); assert.equal(result.operationNotPermitted, true); assert.equal(result.unknown, true);
  assert.doesNotMatch(JSON.stringify(result), /private-command-marker|fusermount:|Operation not/u);
  for (const text of ['x'.repeat(2047) + '😀Operation not permitted\n', 'x'.repeat(65536) + '\nPermission denied\n']) {
    const bounded = createLinuxMountErrorClassifier(); bounded.feed(text); const result = bounded.finish();
    assert.equal(result.operationNotPermitted, false); assert.equal(result.permissionDenied, false); assert.equal(result.truncated, true);
  }
});

test('known C-locale templates pair the originating component with its own errno across every chunk split', () => {
  const templates = {
    directFuseMount: 'fuse: mount failed: ', fusermountExec: 'fuse: failed to exec fusermount: ',
    fusermountMount: 'fusermount: mount failed: ', runtimeMountDirectoryOpen: 'open dir error: ',
  };
  for (const [stage, prefix] of Object.entries(templates)) {
    for (const [text, expected] of [['Permission denied', 'EACCES'], ['Operation not permitted', 'EPERM'], ['No such file or directory', 'ENOENT'], ['Bad file descriptor', 'other']]) {
      const line = `${prefix}${text}\n`;
      for (let boundary = 1; boundary < line.length; boundary++) {
        const classifier = createLinuxMountErrorClassifier();
        classifier.feed(Buffer.from(line.slice(0, boundary))); classifier.feed(Buffer.from(line.slice(boundary)));
        assert.deepEqual(classifier.finish().stages, Object.fromEntries(Object.keys(templates).map(key => [key, key === stage ? expected : 'not_observed'])));
      }
    }
  }
});

test('identical generic flags remain distinguishable without mistaking secondary directory failure for mount errno', () => {
  const classify = prefix => {
    const classifier = createLinuxMountErrorClassifier();
    classifier.feed(`${prefix}Permission denied\nopen dir error: No such file or directory\n`);
    return classifier.finish();
  };
  const direct = classify('fuse: mount failed: '), exec = classify('fuse: failed to exec fusermount: ');
  for (const value of [direct, exec]) {
    assert.equal(value.permissionDenied, true); assert.equal(value.missingFile, true);
    assert.equal(value.stages.runtimeMountDirectoryOpen, 'ENOENT');
    assert.equal(value.stages.fusermountMount, 'not_observed');
  }
  assert.equal(direct.stages.directFuseMount, 'EACCES'); assert.equal(direct.stages.fusermountExec, 'not_observed');
  assert.equal(exec.stages.fusermountExec, 'EACCES'); assert.equal(exec.stages.directFuseMount, 'not_observed');
  const repeated = createLinuxMountErrorClassifier();
  repeated.feed('fuse: mount failed: Operation not permitted\nfuse: mount failed: Operation not permitted\n');
  assert.equal(repeated.finish().stages.directFuseMount, 'EPERM');
  repeated.feed('fuse: mount failed: Permission denied\nfuse: mount failed: Operation not permitted\n');
  assert.equal(repeated.finish().stages.directFuseMount, 'ambiguous');
});

test('stage recognition refuses unrelated, incomplete, oversized or over-budget templates and retains no captures', () => {
  for (const text of ['prefix fuse: mount failed: Permission denied\n', 'fuse: failed to exec /private/helper-marker: Permission denied\n',
    'fuse: mount failed:\nPermission denied\n', 'open dir error:\nNo such file or directory\n',
    'x'.repeat(2047) + '😀fuse: mount failed: Permission denied\n', '\n'.repeat(65536) + 'fuse: mount failed: Permission denied\n']) {
    const classifier = createLinuxMountErrorClassifier(); classifier.feed(text);
    const result = classifier.finish();
    assert.ok(Object.values(result.stages).every(value => value === 'not_observed'));
    assert.doesNotMatch(JSON.stringify(result), /private|helper-marker|Permission denied|No such file/u);
  }
  const suffix = 'fuse: mount failed: Permission denied', cut = createLinuxMountErrorClassifier();
  cut.feed('\n'.repeat(65536 - Buffer.byteLength(suffix)) + suffix + ' private-unseen-tail\n');
  assert.equal(cut.finish().stages.directFuseMount, 'not_observed'); assert.equal(cut.finish().truncated, true);
  const unknown = createLinuxMountErrorClassifier(); unknown.feed('fuse: mount failed: private-errno-marker\n');
  const result = unknown.finish(); assert.equal(result.stages.directFuseMount, 'other'); assert.equal(result.unknown, true);
  assert.doesNotMatch(JSON.stringify(result), /private-errno-marker/u);
});

test('only one exact owned nonce-directory FUSE mount can be selected for cleanup', () => {
  assert.deepEqual(selectLinuxMountProbeMount(mountinfo, temporary), { state: 'observed', mount: target });
  assert.equal(selectLinuxMountProbeMount(mountinfo.replace(temporary, temporary.replace(/a/gu, 'b')), temporary).state, 'not_observed');
  for (const altered of [mountinfo + mountinfo, mountinfo.replace('fuse.squashfuse', 'tmpfs'), mountinfo.replace('user_id=1000', 'user_id=0'),
    mountinfo.replace('.mount_TiboTa123456', '.mount_TiboTa/../outside'), mountinfo.replace('squashfuse ro,', '/private/source ro,')]) {
    const result = selectLinuxMountProbeMount(altered, temporary); assert.equal(result.state, 'ambiguous'); assert.equal(result.mount, null);
  }
  assert.deepEqual(selectLinuxMountProbeMount('x'.repeat(262145), temporary), { state: 'unavailable', mount: null });
  assert.equal(selectLinuxMountProbeMount(mountinfo, '/tmp/unowned').state, 'unavailable');
});

test('an AppArmor positive requires an owned PID identity, bounded window, active profile and exact nonce/source', () => {
  assert.deepEqual(correlateLinuxMountAudit(auditFixture()), { denial: true, reason: 'owned_mount_denial' });
  for (const [fstype, source] of [['fuse.squashfuse', 'squashfuse'], ['fuse.TiboTattle.AppImage', 'TiboTattle.AppImage']]) {
    const input = auditFixture();
    input.audit.records[0].message = input.audit.records[0].message.replace('fstype="fuse"', `fstype="${fstype}"`).replace(`srcname="${image}"`, `srcname="${source}"`);
    assert.equal(correlateLinuxMountAudit(input).denial, true);
  }
  for (const mutate of [
    v => { v.audit.ready = false; }, v => { v.audit.closed = false; }, v => { v.audit.complete = false; },
    v => { v.audit.records = []; }, v => { v.audit.start = 211; }, v => { v.audit.end = 89; },
    v => { v.audit.records[0].time = -1; }, v => { v.audit.records[0].time = 'private-time-marker'; },
    v => { v.graph.actors.clear(); }, v => { v.graph.actors.get(77).appImage = false; }, v => { v.graph.actors.get(77).alive = true; },
    v => { v.graph.complete = false; }, v => { delete v.graph.actors.get(77).birth; }, v => { v.graph.actors.get(77).pid = 78; },
    v => { v.profile = null; }, v => { v.profile = 'another-profile'; },
    ...['pid=77 pid=77', 'pid="77"broken', 'pid=78'].map(text => v => { v.audit.records[0].message = v.audit.records[0].message.replace('pid=77', text); }),
    v => { v.audit.records[0].message = v.audit.records[0].message.replace('operation="mount"', 'operation="open"'); },
    v => { v.audit.records[0].message = v.audit.records[0].message.replace('fstype="fuse"', 'fstype="tmpfs"'); },
    v => { v.audit.records[0].message = v.audit.records[0].message.replace('srcname="' + image, 'srcname="/unrelated.AppImage'); },
    v => { v.audit.records[0].message = v.audit.records[0].message.replace(temporary, temporary.replace(/a/gu, 'b')); },
    v => { v.audit.records[0].message = v.audit.records[0].message.replace('.mount_TiboTa123456', '.mount_TiboTa\\040123456'); },
  ]) { const input = auditFixture(); mutate(input); assert.equal(correlateLinuxMountAudit(input).denial, 'unavailable'); }
});

test('reader failure reasons come from concrete closed observer boundaries and cannot report raw failures', () => {
  const base = { spawnFailed: false, stopped: true, exitCode: 0, valid: true, ready: true, closed: true, complete: true, readerReason: 'none' };
  assert.equal(linuxMountAuditReaderReason(base), 'none');
  for (const [changes, expected] of [
    [{ spawnFailed: true }, 'observer_start_failed'], [{ stopped: false }, 'reader_timeout'],
    [{ exitCode: 124 }, 'reader_timeout'], [{ exitCode: 137 }, 'reader_failed'],
    [{ valid: false }, 'reader_failed'], [{ closed: false }, 'reader_failed'],
    [{ ready: false, closed: false }, 'observer_start_failed'], [{ exitCode: 1 }, 'reader_failed'],
    [{ complete: false }, 'reader_failed'], [{ readerReason: 'private-reader-marker' }, 'reader_failed'],
  ]) assert.equal(linuxMountAuditReaderReason({ ...base, ...changes }), expected);
  for (const reason of ['kmsg_open_denied', 'kmsg_open_unavailable', 'reader_failed', 'reader_timeout', 'stream_incomplete']) {
    assert.equal(linuxMountAuditReaderReason({ ...base, ready: false, complete: false, readerReason: reason }), reason);
  }
});

test('unavailable audit reasons preserve uncertainty and require actor ownership before naming unknown source shape', () => {
  for (const [mutate, expected] of [
    [v => { v.audit.ready = false; v.audit.complete = false; v.audit.reason = 'kmsg_open_denied'; }, 'kmsg_open_denied'],
    [v => { v.audit.complete = false; v.audit.reason = 'stream_incomplete'; }, 'stream_incomplete'],
    [v => { v.audit.reason = 'reader_failed'; }, 'reader_failed'],
    [v => { v.profile = null; }, 'profile_unavailable'],
    [v => { v.containerRemoved = false; }, 'probe_cleanup_unproven'],
    [v => { v.graph.actors.clear(); }, 'probe_identity_unavailable'],
    [v => { v.audit.start = 211; }, 'audit_window_incomplete'],
    [v => { v.graph.complete = false; v.graph.reason = 'trace_stream_incomplete'; }, 'trace_stream_incomplete'],
    [v => { v.audit.records = []; }, 'no_observed_mount_denial'],
    [v => { v.profile = 'unrelated-profile'; }, 'no_correlated_mount_denial'],
    [v => { v.graph.actors.get(77).appImage = false; }, 'owned_actor_not_correlated'],
    [v => { v.audit.records[0].message = v.audit.records[0].message.replace(image, '/private/source-marker'); }, 'owned_target_source_unrecognized'],
    [v => { v.graph.actors.get(77).appImage = false; v.audit.records[0].message = v.audit.records[0].message.replace(image, '/private/source-marker'); }, 'owned_actor_not_correlated'],
    [v => { v.audit.records[0].message += ' pid=77'; }, 'match_ambiguous'],
  ]) {
    const input = auditFixture(); mutate(input); const result = correlateLinuxMountAudit(input);
    assert.deepEqual(result, { denial: 'unavailable', reason: expected });
    assert.doesNotMatch(JSON.stringify(result), /private|unrelated-profile|docker-default|\.mount_|\/opt\/|"pid"|"start"/u);
  }
});

test('serial exact-byte comparison stops before the second image when owned container cleanup is unproven', async () => {
  const order = [];
  const result = await runLinuxMountSequence(pair, async (role, expected) => { order.push(role); assert.equal(expected, pair.images[role]); return row(role); });
  assert.deepEqual(order, ['current', 'next']); assert.equal(result.qualifiesRelease, false); assert.equal(result.schemaVersion, LINUX_MOUNT_DIAGNOSIS_SCHEMA);
  const stopped = [];
  const partial = await runLinuxMountSequence(pair, async role => { stopped.push(role); return row(role, { containerRemoved: false, errorCode: 'cleanup_failed' }); });
  assert.deepEqual(stopped, ['current']); assert.equal(partial.cases.length, 1);
  const observer = await runLinuxMountSequence(pair, async role => row(role, { observerStopped: false, errorCode: 'cleanup_failed' }));
  assert.equal(observer.cases.length, 1);
  await assert.rejects(runLinuxMountSequence(pair, async role => row(role, { artifactSha256: 'f'.repeat(64) })), /REFUSED/u);
  for (const mutate of [
    v => { v.qualifiesRelease = true; }, v => { v.schemaVersion = 'tibotattle-linux-final-lifecycle-v1'; }, v => { v.schemaVersion = 'tibotattle-linux-appimage-mount-diagnosis-v1'; }, v => { v.schemaVersion = 'tibotattle-linux-appimage-mount-diagnosis-v2'; }, v => { v.schemaVersion = 'tibotattle-linux-appimage-mount-diagnosis-v3'; }, v => { v.schemaVersion = 'tibotattle-linux-appimage-mount-diagnosis-v4'; },
    v => { v.cases[0].probe.environment.appArmor.profile = 'private-profile-marker'; },
    v => { v.cases[0].actorTrace.pid = 77; }, v => { v.cases[0].actorTrace.reason = '/private/trace-marker'; },
    v => { v.cases[0].actorTrace.instanceRemoved = false; }, v => { v.cases[0].actorTrace = { complete: false, reason: 'trace_stream_incomplete', instanceRemoved: true }; },
    v => { v.cases[0].probe.environment.pid = 77; }, v => { v.cases[0].probe.mount = target; },
    v => { v.cases[0].probe.launcherErrors.raw = 'private-stderr-marker'; }, v => { v.cases[0].probe.startup.process.pid = 77; },
    v => { v.cases[0].appArmorMountDenial = 'possibly'; }, v => { v.cases[0].appArmorMountDenial = false; },
    v => { v.cases[0].appArmorAuditReason = 'private-audit-marker'; }, v => { v.cases[0].appArmorAuditReason = 'owned_mount_denial'; },
    v => { v.cases[0].probe.launcherErrors.stages.fusermountExec = 'private-error-marker'; },
    v => { v.cases[0].probe.launcherErrors.stages.path = '/private/unowned'; }, v => { v.cases[0].containerRemoved = false; }, v => { v.cases[0].observerStopped = false; },
  ]) { const changed = structuredClone(result); mutate(changed); assert.equal(validateLinuxMountDiagnosis(changed), null); }
  const unproven = structuredClone(result);
  Object.assign(unproven.cases[0], { errorCode: 'probe_failed', appArmorMountDenial: true, appArmorAuditReason: 'owned_mount_denial',
    actorTrace: { complete: false, reason: 'trace_stream_incomplete', instanceRemoved: true } });
  assert.equal(validateLinuxMountDiagnosis(unproven), null);
  assert.doesNotMatch(JSON.stringify(result), /private-profile-marker|private-stderr-marker|\.mount_|\/opt\/|"pid"|"start"|comm|nonce/u);
});

test('post-removal ownership proof distinguishes missing or replaced identity from unreadable proc evidence', async () => {
  const identity = { pid: 77, start: '123' };
  const stat = start => `77 (probe) ${['S', '1', ...Array(17).fill('0'), start].join(' ')}`;
  assert.equal(await linuxMountOwnedProcessGone(identity, { read: async () => stat('123') }), false);
  assert.equal(await linuxMountOwnedProcessGone(identity, { read: async () => stat('124') }), true);
  assert.equal(await linuxMountOwnedProcessGone(identity, { read: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }), true);
  for (const code of ['EACCES', 'EPERM', 'EIO']) assert.equal(await linuxMountOwnedProcessGone(identity, {
    read: async () => { throw Object.assign(new Error('private-proc-detail'), { code }); },
  }), 'unavailable');
  assert.equal(await linuxMountOwnedProcessGone(identity, { read: async () => 'malformed private-proc-detail' }), 'unavailable');
  let read = false;
  assert.equal(await linuxMountOwnedProcessGone(null, { read: async () => { read = true; return ''; } }), 'unavailable');
  assert.equal(read, false);
});

test('interruption cleanup requires the recorded created ID and all exact ownership labels', () => {
  const owner = { role: 'current', run: '12345', runner: 'b'.repeat(40) }, markerId = 'f'.repeat(64);
  const inspected = { id: markerId, name: '/tibotattle-mount-diagnosis-current-12345', labels: {
    'io.tibotattle.mount-diagnosis.run': owner.run, 'io.tibotattle.mount-diagnosis.runner': owner.runner,
    'io.tibotattle.mount-diagnosis.role': owner.role } };
  assert.deepEqual(linuxMountCleanupArguments({ markerId, inspected }, owner), ['rm', '--force', markerId]);
  for (const mutate of [v => { v.id = 'e'.repeat(64); }, v => { v.name = '/pre-existing'; }, v => { v.labels = {}; },
    v => { v.labels['io.tibotattle.mount-diagnosis.run'] = '12346'; }, v => { v.labels['io.tibotattle.mount-diagnosis.runner'] = 'c'.repeat(40); },
    v => { v.labels['io.tibotattle.mount-diagnosis.role'] = 'next'; }]) {
    const changed = structuredClone(inspected); mutate(changed);
    assert.throws(() => linuxMountCleanupArguments({ markerId, inspected: changed }, owner), /REFUSED/u);
  }
  assert.throws(() => linuxMountCleanupArguments({ markerId: null, inspected }, owner), /REFUSED/u);
});

test('diagnostic Docker security arguments match the existing lifecycle and keep its container source closure', async () => {
  const profile = `tibotattle-mount-candidate-12345-${'a'.repeat(32)}`;
  const words = linuxFinalHostContainerArguments({ run: '12345', runner: 'b'.repeat(40), nonce: 'a'.repeat(32),
    profile, profileSha256: 'f'.repeat(64), profileNameSha256: createHash('sha256').update(profile).digest('hex') });
  const diagnostic = linuxMountContainerArguments({ name: 'tibotattle-mount-diagnosis-current-12345', role: 'current', nonce: 'a'.repeat(32), runnerRevision: 'b'.repeat(40) });
  const select = args => args.flatMap((word, index) => /^(?:--init|--platform=|--cap-add=|--shm-size=)/u.test(word) ? [word]
    : ['--device', '--network', '--add-host', '--tmpfs'].includes(word) ? [`${word} ${args[index + 1]}`]
      : word === '--env' && !/^(?:TIBOTATTLE_MOUNT_PROBE_|TIBOTATTLE_LINUX_FINAL_)/u.test(args[index + 1]) ? [`--env ${args[index + 1]}`] : []).sort();
  assert.deepEqual(select(diagnostic), select(words));
  assert.doesNotMatch(diagnostic.join(' '), /--privileged|--security-opt|--user\b|--entrypoint|--volume|--mount\b|--no-sandbox|unconfined/u);
  assert.deepEqual(diagnostic.slice(-3), ['node', 'scripts/diagnose-electron-linux-appimage-mount.mjs', '--inside']);
  const dockerfile = await readFile(new URL('../containers/electron-linux-installed/Dockerfile', import.meta.url), 'utf8');
  const ignore = await readFile(new URL('../containers/electron-linux-installed/Dockerfile.dockerignore', import.meta.url), 'utf8');
  assert.match(dockerfile, /^COPY scripts \.\/scripts$/mu); assert.match(ignore, /^!scripts\/\*\*$/mu);
  assert.match(dockerfile, /^USER node$/mu); assert.match(dockerfile, /CMD \["node", "scripts\/smoke-electron-linux-final-lifecycle\.mjs"\]/u);
  const source = await readFile(new URL('../scripts/diagnose-electron-linux-appimage-mount.mjs', import.meta.url), 'utf8');
  assert.match(source, /spawn\(process\.execPath, \[SCRIPT, '--gate'\]/u);
  assert.match(source, /process\.execve\(IMAGE, args, process\.env\)/u);
  assert.match(source, /process\.kill\(process\.pid, 'SIGSTOP'\)/u);
  assert.match(source, /LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C'/u);
  assert.doesNotMatch(source, /--appimage-extract|--no-sandbox|--disable-setuid-sandbox|apparmor=unconfined|seccomp=unconfined/u);
  assert.match(source, /'--cidfile'/u);
  assert.match(source, /audit = beginKernelObserver\(context\); row\.observerStopped = false; row\.appArmorAuditReason = 'not_evaluated'/u);
  assert.match(source, /const stopped = await waitUntil\(\(\) => exited, 35000\)/u);
  assert.match(source, /copyFile\(source, IMAGE, constants\.COPYFILE_EXCL\)/u);
  assert.match(source, /installed\.sha256 !== expected\.sha256 \|\| installed\.bytes !== expected\.bytes/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /os\.O_RDONLY \| os\.O_NONBLOCK/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /os\.lseek\(fd, 0, os\.SEEK_END\)/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /sequence != last \+ 1: incomplete\('stream_incomplete'\)/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /used > 262144/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /priority >> 3 == 0/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /trace_pending or not no_loss\(cpu_set, True\)/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /dir_fd=instance_fd/u);
  assert.match(LINUX_MOUNT_KMSG_READER, /journal\(root, root_kind, True\); removed = False\n        os\.mkdir/u);
  assert.doesNotMatch(LINUX_MOUNT_KMSG_READER, /ptrace|set_ftrace_pid|record-cmd|os\.system|subprocess|mount -t|nsenter/u);
  const host = source.slice(source.indexOf('async function runHostProbe('), source.indexOf('export function linuxMountCleanupArguments('));
  assert.ok(host.indexOf('audit.state.ready || audit.state.closed') < host.indexOf("child.stdin.write('go\\n')"));
  assert.ok(host.indexOf("command('docker', ['rm', '--force', id])") < host.indexOf('kernel = await audit.stop()'));
  assert.ok(source.indexOf('await cleanupLinuxAppArmorProfiles') > source.indexOf('async function cleanupRecordedContainers'));
  const workflow = await readFile(new URL('../.github/workflows/electron-linux-appimage-mount-diagnosis.yml', import.meta.url), 'utf8');
  for (const required of ['workflow_dispatch:', 'group: electron-linux-final-qualification', 'persist-credentials: false', 'actions: read',
    LINUX_MOUNT_DIAGNOSIS_CONFIRMATION, 'timeout 180s', 'mount-diagnosis.json', '--test-concurrency=1', 'test/tool-inventory.test.js', 'test/release-workflow-policy.test.js', '--cleanup']) assert.ok(workflow.includes(required), required);
  assert.doesNotMatch(workflow, /contents: write|permissions:\s*write-all|--privileged|--no-sandbox|unconfined|mount-diagnosis-\*|receipts\/\*\.json/u);
});

const tuple = () => ({ type: 'squashfuse', source: 'squashfuse', options: ['ro', 'nosuid', 'nodev'] });
const importBinding = () => ({ parserConfigSha256: '8'.repeat(64), abi40Sha256: '9'.repeat(64) });
const ownedName = stage => linuxAppArmorProfileName({ run: '12345', nonce: 'a'.repeat(32), stage });
const validateRow = value => validateLinuxMountDiagnosis({ schemaVersion: LINUX_MOUNT_DIAGNOSIS_SCHEMA,
  purpose: 'diagnostic_only', qualifiesRelease: false, runnerRevision: pair.intake.runnerRevision,
  sourceRevision: pair.intake.sourceRevision, cases: [{ ...value, role: 'current' }] }) !== null;
function basis() {
  return { dockerVersion: '28.0.4', parserVersion: '4.0.1', parserSha256: '1'.repeat(64),
    templateSha256: LINUX_APPARMOR_TEMPLATE_SHA256, renderedSha256: '2'.repeat(64), expandedSha256: '3'.repeat(64),
    daemonProfileSha256: '4'.repeat(64), globalImport: true, baseImport: true, imports: importBinding(), loadedDefaultPolicyVerified: false };
}
function comparisonResult(stage, role) {
  const value = row(role, { appArmorMountDenial: stage === 'candidate' ? 'unavailable' : true,
    appArmorAuditReason: stage === 'candidate' ? 'no_observed_mount_denial' : 'owned_mount_denial' });
  value.probe.environment.appArmor = { profile: 'other', enforcement: 'enforce' };
  value.probe.launcherErrors.stages.directFuseMount = stage === 'candidate' ? 'not_observed' : 'EACCES';
  if (stage === 'candidate') {
    value.probe.mount = 'observed';
    value.probe.startup.fuseMount = { state: 'observed', type: 'squashfuse', uid: 1000, readOnly: true, nosuid: true, nodev: true, noexec: false };
  }
  return { row: value, tuple: stage === 'candidate' ? null : tuple(), profileApplied: true };
}
function comparisonHarness({ mutate = () => {}, failedCleanup = false } = {}) {
  const calls = [], evidence = { baseline: null, candidate: null };
  const profiles = { basis: basis(), evidence,
    async load(stage) {
      calls.push(`load:${stage}`);
      evidence[stage] = { profileSha256: '5'.repeat(64), profileNameSha256: stage === 'baseline' ? '6'.repeat(64) : '7'.repeat(64), loaded: true, removed: false };
      return { name: ownedName(stage), evidence: evidence[stage] };
    },
    async candidateCheckpoint() {
      calls.push('checkpoint:candidate');
      return { name: ownedName('candidate'), nonce: 'a'.repeat(32),
        profileSha256: evidence.candidate.profileSha256, profileNameSha256: evidence.candidate.profileNameSha256,
        tuple: tuple(), basis: basis() };
    },
    async remove(stage, containersGone) {
      calls.push(`remove:${stage}:${containersGone}`);
      if (!containersGone || failedCleanup) return false;
      if (evidence[stage]) evidence[stage].removed = true;
      return true;
    } };
  return { calls, profiles, adapters: { prepareProfiles: async () => profiles, validateRow,
    runProbe: async (stage, role, expected, name) => {
      calls.push(`probe:${stage}:${role}`);
      assert.equal(expected, pair.images[role]); assert.equal(name, ownedName(stage === 'baseline' ? 'baseline' : 'candidate'));
      const result = comparisonResult(stage, role); mutate(result, stage, role); return result;
    } } };
}

test('verified candidate handoff is immutable, serial, and bracketed by live ownership rechecks', async () => {
  const { calls, adapters } = comparisonHarness();
  const result = await runLinuxAppArmorComparison(pair, { ...adapters, onCandidateVerified: async checkpoint => {
    calls.push('lifecycle');
    assert.equal(checkpoint.name, ownedName('candidate')); assert.deepEqual(checkpoint.tuple, tuple());
    assert.ok(Object.isFrozen(checkpoint)); assert.ok(Object.isFrozen(checkpoint.basis));
    assert.ok(Object.isFrozen(checkpoint.tuple.options));
    assert.throws(() => { checkpoint.name = 'unconfined'; }, TypeError);
    assert.throws(() => { checkpoint.tuple.options.push('rw'); }, TypeError);
    return { containerRemoved: true };
  } });
  assert.equal(result.outcome, 'compared'); assert.equal(result.qualifiesRelease, false);
  assert.deepEqual(calls.slice(calls.indexOf('probe:negative:current')), [
    'probe:negative:current', 'checkpoint:candidate', 'lifecycle', 'checkpoint:candidate',
    'remove:candidate:true', 'remove:baseline:true']);
  const active = structuredClone(result);
  active.profilesRemoved = false; active.profiles.candidate.removed = false;
  assert.equal(validateLinuxAppArmorComparison(active, validateRow), null);
  assert.doesNotMatch(JSON.stringify(result), /"nonce"|"name"|lifecycle|\/opt\//u);
});

test('any incomplete causal case prevents lifecycle handoff even when host cleanup succeeds', async () => {
  for (const mutate of [
    (result, stage) => { if (stage === 'baseline') result.tuple = null; },
    (result, stage) => { if (stage === 'candidate') result.row.probe.startup.fuseMount.nosuid = false; },
    (result, stage) => { if (stage === 'negative') { result.row.appArmorMountDenial = 'unavailable'; result.row.appArmorAuditReason = 'no_observed_mount_denial'; } },
    result => { result.row.probe.environment.sysAdmin.effective = true; },
    result => { result.row.actorTrace.complete = false; result.row.actorTrace.reason = 'trace_stream_incomplete'; result.row.errorCode = 'probe_failed'; },
    result => { result.row.artifactSha256 = '0'.repeat(64); },
  ]) {
    const { adapters } = comparisonHarness({ mutate }); let called = false;
    const result = await runLinuxAppArmorComparison(pair, { ...adapters, onCandidateVerified: async () => { called = true; return { containerRemoved: true }; } });
    assert.equal(called, false); assert.notEqual(result.outcome, 'compared');
  }
});

test('candidate ownership drift or cancellation refuses handoff without inventing a completed comparison', async () => {
  for (const when of ['before', 'after']) {
    const { adapters, profiles } = comparisonHarness(); let reads = 0, called = 0;
    const original = profiles.candidateCheckpoint;
    profiles.candidateCheckpoint = async () => {
      reads++;
      if (reads === (when === 'before' ? 1 : 2)) throw Object.assign(new Error('private-marker'), { code: 'basis_unavailable' });
      return original();
    };
    const result = await runLinuxAppArmorComparison(pair, { ...adapters, onCandidateVerified: async () => { called++; return { containerRemoved: true }; } });
    assert.equal(called, when === 'before' ? 0 : 1); assert.equal(result.outcome, 'candidate_failed');
    assert.equal(result.profilesRemoved, true); assert.doesNotMatch(JSON.stringify(result), /private-marker/u);
  }
  const { adapters, calls } = comparisonHarness();
  const result = await runLinuxAppArmorComparison(pair, { ...adapters,
    interrupted: () => calls.includes('probe:negative:current'), onCandidateVerified: () => assert.fail('must not hand off') });
  assert.equal(result.outcome, 'interrupted'); assert.equal(result.profilesRemoved, true);
});

test('throwing or unclosed lifecycle use prevents profile removal authorization', async () => {
  for (const callback of [async () => { throw new Error('private-failure'); }, async () => null,
    async () => ({ containerRemoved: false }), async () => ({ containerRemoved: 'true' }),
    async () => ({ containerRemoved: true, unexpected: true })]) {
    const { adapters, calls } = comparisonHarness();
    const result = await runLinuxAppArmorComparison(pair, { ...adapters, onCandidateVerified: callback });
    assert.equal(result.outcome, 'cleanup_failed'); assert.equal(result.profilesRemoved, false);
    assert.ok(calls.includes('remove:candidate:false')); assert.doesNotMatch(JSON.stringify(result), /private-failure/u);
  }
  const { adapters, calls } = comparisonHarness();
  await assert.rejects(runLinuxAppArmorComparison(pair, { ...adapters, onCandidateVerified: true }), /REFUSED/u);
  assert.deepEqual(calls, []);
});

test('comparison has a distinct explicit confirmation and closed selection', () => {
  const input = { SELECTED_MODE: 'execute', SELECTED_POLICY: 'apparmor-comparison', SELECTED_CONFIRMATION: LINUX_APPARMOR_COMPARISON_CONFIRMATION };
  assert.equal(linuxMountPreflightEnvironment(input).SELECTED_CONFIRMATION, 'RUN_DISPOSABLE_FINAL_LINUX_LIFECYCLE');
  for (const changed of [{ ...input, SELECTED_POLICY: 'arbitrary' }, { ...input, SELECTED_POLICY: 'default' },
    { ...input, SELECTED_CONFIRMATION: LINUX_MOUNT_DIAGNOSIS_CONFIRMATION }]) assert.throws(() => linuxMountPreflightEnvironment(changed));
});

test('exact owned audit tuples reject every wider or unknown source, type and option set', () => {
  const fields = { fstype: 'fuse.squashfuse', srcname: 'squashfuse', flags: 'ro, nosuid, nodev' };
  assert.deepEqual(normalizeLinuxAppArmorMountTuple(fields), tuple());
  assert.deepEqual(normalizeLinuxAppArmorMountTuple({ ...fields, flags: 'nodev,ro,nosuid' }), tuple());
  for (const flags of ['rw,nosuid,nodev', 'ro,suid,nodev', 'ro,nosuid,dev', 'ro,nosuid,nodev,noexec',
    'ro,nosuid,nodev,relatime', 'ro,nosuid,nodev,nodev', 'ro,nosuid', 'private-option-marker']) {
    assert.equal(normalizeLinuxAppArmorMountTuple({ ...fields, flags }), null);
  }
  for (const changed of [{ ...fields, fstype: 'tmpfs' }, { ...fields, srcname: '/private/source-marker' },
    { ...fields, fstype: 'fuse', srcname: 'squashfuse' }]) assert.equal(normalizeLinuxAppArmorMountTuple(changed), null);
  for (const changed of [{ ...tuple(), extra: true }, { ...tuple(), source: 'image_absolute' }, { ...tuple(), options: ['rw', 'nosuid', 'nodev'] }]) {
    assert.equal(validateLinuxAppArmorMountTuple(changed), null);
    assert.throws(() => linuxAppArmorMountRule(changed, 'a'.repeat(32)));
  }
});

test('the owned audit tuple keeps exact actor correlation and refuses conflicting observed flags', () => {
  const input = auditFixture(); input.collectTuple = true;
  input.audit.records[0].message = input.audit.records[0].message.replace('flags="rw, nosuid, nodev"', 'flags="ro, nosuid, nodev"');
  const expected = { type: 'fuse', source: 'image_absolute', options: ['ro', 'nosuid', 'nodev'] };
  assert.deepEqual(correlateLinuxMountAudit(input), { denial: true, reason: 'owned_mount_denial', tuple: expected });
  input.audit.records.push({ ...input.audit.records[0], message: input.audit.records[0].message.replace('ro, nosuid, nodev', 'rw, nosuid, nodev') });
  assert.equal(correlateLinuxMountAudit(input).tuple, null);
  input.graph.actors.get(77).appImage = false;
  assert.deepEqual(correlateLinuxMountAudit(input), { denial: 'unavailable', reason: 'owned_actor_not_correlated', tuple: null });
});

test('profile generation retains the same Moby policy and changes only identity plus one exact mount rule', async () => {
  const template = await readFile(new URL('../scripts/assets/moby-apparmor-v28.0.4-template.txt', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(template).digest('hex'), LINUX_APPARMOR_TEMPLATE_SHA256);
  const name = ownedName('baseline');
  const rendered = renderLinuxAppArmorBasis(template, { name, daemonProfile: 'unconfined', globalImport: false, baseImport: false });
  assert.match(rendered, /@\{PROC\}=\/proc\//u); assert.doesNotMatch(rendered, /#include|\{\{/u);
  const baseline = deriveLinuxAppArmorProfile(rendered, { baselineName: name, name, stage: 'baseline' });
  const candidate = deriveLinuxAppArmorProfile(rendered, { baselineName: name, name: ownedName('candidate'), stage: 'candidate', tuple: tuple(), nonce: 'a'.repeat(32) });
  assert.equal(baseline, rendered.replace('  deny mount,', '  audit deny mount,'));
  assert.equal(candidate, rendered.replaceAll(name, ownedName('candidate')).replace('  deny mount,', linuxAppArmorMountRule(tuple(), 'a'.repeat(32))));
  assert.match(candidate, /mount fstype=fuse\.squashfuse options=\(ro,nosuid,nodev\) "squashfuse" -> "\/opt\/tibotattle-updater-exec\/tmp\/a{32}\/\.mount_\*\/",/u);
  assert.doesNotMatch(candidate, /deny mount|options in|fstype=\*|--privileged|complain|default_allow/u);
  for (const bad of [rendered.replace('  deny mount,', '  mount,'), rendered + '\nmount /unowned,\n',
    rendered.replace('  file,', '  file, mount,'), rendered.replace('  file,', '  audit { mount, }'),
    rendered.replace('  file,', '  allow { mount, }'), rendered.replace('  file,', '  all,'),
    rendered.replace('  file,', '  audit { all, }'), rendered + '\n#include <private>\n']) {
    assert.throws(() => deriveLinuxAppArmorProfile(bad, { baselineName: name, name, stage: 'baseline' }));
  }
  assert.throws(() => renderLinuxAppArmorBasis(template + '\n', { name, daemonProfile: 'unconfined', globalImport: false, baseImport: false }));
  assert.throws(() => renderLinuxAppArmorBasis(template, { name, daemonProfile: 'x,\nmount,', globalImport: false, baseImport: false }));
  assert.throws(() => linuxAppArmorMountRule(tuple(), '../unowned'));
});

test('comparison mount sampling retains only closed flag facts for the exact owned nonce', () => {
  assert.deepEqual(projectLinuxMountProbeFacts(mountinfo, temporary), { state: 'observed', type: 'squashfuse', uid: 1000,
    readOnly: true, nosuid: true, nodev: true, noexec: false });
  assert.equal(projectLinuxMountProbeFacts(mountinfo + mountinfo, temporary).state, 'ambiguous');
  assert.equal(projectLinuxMountProbeFacts(null, temporary).state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(projectLinuxMountProbeFacts(mountinfo, temporary)), /\/opt\/|\.mount_|a{32}/u);
});

test('one serial baseline/candidate comparison includes both exact images and a negative outside-target probe', async () => {
  const { calls, adapters } = comparisonHarness();
  const result = await runLinuxAppArmorComparison(pair, adapters);
  assert.equal(result.schemaVersion, LINUX_APPARMOR_COMPARISON_SCHEMA); assert.equal(result.outcome, 'compared');
  assert.equal(result.qualifiesRelease, false); assert.equal(result.basis.loadedDefaultPolicyVerified, false);
  assert.deepEqual(calls.filter(call => call.startsWith('probe:')), [
    'probe:baseline:current', 'probe:baseline:next', 'probe:candidate:current', 'probe:candidate:next', 'probe:negative:current']);
  assert.ok(calls.indexOf('remove:baseline:true') < calls.indexOf('load:candidate'));
  assert.equal(result.profilesRemoved, true);
  assert.equal(validateLinuxAppArmorComparison(result, validateRow), result);
  assert.doesNotMatch(JSON.stringify(result), /\/opt\/|\.mount_|unconfined|private|"name"|"pid"|"nonce"|"flags"/u);
  for (const mutate of [v => { v.qualifiesRelease = true; }, v => { v.basis.loadedDefaultPolicyVerified = true; },
    v => { v.basis.templateSha256 = 'f'.repeat(64); }, v => { v.basis.path = '/private/profile'; },
    v => { v.cases[0].tuple.options = ['rw', 'nosuid', 'nodev']; }, v => { v.cases[2].row.probe.startup.fuseMount.nosuid = false; },
    v => { v.cases[4].profileApplied = false; }, v => { v.profiles.candidate.removed = false; }]) {
    const altered = structuredClone(result); mutate(altered); assert.equal(validateLinuxAppArmorComparison(altered, validateRow), null);
  }
});

test('missing audit, uncorrelated actors and tuple disagreement stop before candidate policy is loaded', async () => {
  for (const mutate of [
    result => { result.tuple = null; result.row.appArmorMountDenial = 'unavailable'; result.row.appArmorAuditReason = 'no_observed_mount_denial'; },
    result => { result.tuple = null; result.row.appArmorMountDenial = 'unavailable'; result.row.appArmorAuditReason = 'owned_actor_not_correlated'; },
    (result, stage, role) => { if (role === 'next') result.tuple = { type: 'fuse', source: 'image_absolute', options: ['ro', 'nosuid', 'nodev'] }; },
  ]) {
    const { calls, adapters } = comparisonHarness({ mutate });
    const result = await runLinuxAppArmorComparison(pair, adapters);
    assert.equal(result.outcome, 'tuple_unavailable'); assert.equal(result.cases.length, 2);
    assert.ok(!calls.includes('load:candidate')); assert.equal(result.profilesRemoved, true);
  }
});

test('comparison preserves cleanup and cancellation gates without turning a failed candidate or negative into proof', async () => {
  for (const [mutate, outcome, count] of [
    [(result, stage) => { if (stage === 'candidate') result.row.probe.startup.fuseMount.readOnly = false; }, 'candidate_failed', 3],
    [(result, stage) => { if (stage === 'candidate') result.row.probe.environment.sysAdmin.effective = true; }, 'candidate_failed', 3],
    [(result, stage) => { if (stage === 'negative') { result.row.appArmorMountDenial = 'unavailable'; result.row.appArmorAuditReason = 'no_observed_mount_denial'; } }, 'negative_unproven', 5],
  ]) {
    const { adapters } = comparisonHarness({ mutate }); const result = await runLinuxAppArmorComparison(pair, adapters);
    assert.equal(result.outcome, outcome); assert.equal(result.cases.length, count); assert.equal(result.profilesRemoved, true);
  }
  const unclean = comparisonHarness({ mutate: result => {
    result.row.containerRemoved = false; result.row.errorCode = 'cleanup_failed'; result.tuple = null;
    result.row.appArmorMountDenial = 'unavailable'; result.row.appArmorAuditReason = 'probe_cleanup_unproven';
  } });
  const stopped = await runLinuxAppArmorComparison(pair, unclean.adapters);
  assert.equal(stopped.outcome, 'cleanup_failed'); assert.equal(stopped.cases.length, 1); assert.equal(stopped.profilesRemoved, false);
  assert.ok(!unclean.calls.includes('load:candidate'));
  const cancelled = comparisonHarness();
  cancelled.adapters.interrupted = () => true;
  const interrupted = await runLinuxAppArmorComparison(pair, cancelled.adapters);
  assert.equal(interrupted.outcome, 'interrupted'); assert.ok(!cancelled.calls.some(call => call.startsWith('load:')));
  const missingBasis = await runLinuxAppArmorComparison(pair, { ...comparisonHarness().adapters,
    prepareProfiles: async () => { throw Object.assign(new Error('private-host-details'), { code: 'docker_version_unmatched' }); } });
  assert.equal(missingBasis.outcome, 'basis_unavailable'); assert.equal(missingBasis.basisFailure, 'docker_version_unmatched'); assert.equal(missingBasis.basis, null);
  assert.doesNotMatch(JSON.stringify(missingBasis), /private-host-details/u);
});

function failedSetupResult(result) {
  result.row.probe = null; result.row.errorCode = 'container_failed'; result.tuple = null;
  result.row.appArmorMountDenial = 'unavailable'; result.row.appArmorAuditReason = 'reader_failed';
  result.row.actorTrace = { complete: false, reason: 'trace_buffer_layout_unavailable', instanceRemoved: true };
}

test('a failed setup can remove its owned profile after host closure without qualifying the probe', async () => {
  const harness = comparisonHarness({ mutate: failedSetupResult });
  const result = await runLinuxAppArmorComparison(pair, harness.adapters);
  assert.equal(result.outcome, 'baseline_failed'); assert.equal(result.cases.length, 1); assert.equal(result.cases[0].row.probe, null);
  assert.equal(result.profilesRemoved, true); assert.equal(result.profiles.baseline.removed, true); assert.equal(result.qualifiesRelease, false);
  assert.ok(harness.calls.includes('remove:baseline:true')); assert.ok(!harness.calls.includes('load:candidate'));
  assert.equal(validateLinuxAppArmorComparison(result, validateRow), result);
  const incomplete = comparisonHarness({ mutate: result => { result.row.probe.cleanup.childGone = false; } });
  const unqualified = await runLinuxAppArmorComparison(pair, incomplete.adapters);
  assert.equal(unqualified.outcome, 'baseline_failed'); assert.equal(unqualified.cases.length, 1); assert.equal(unqualified.profilesRemoved, true);
  assert.ok(!incomplete.calls.includes('load:candidate'));
  const removalFailed = comparisonHarness({ mutate: failedSetupResult, failedCleanup: true });
  const failed = await runLinuxAppArmorComparison(pair, removalFailed.adapters);
  assert.equal(failed.outcome, 'cleanup_failed'); assert.equal(failed.profilesRemoved, false);
});

test('absent or unknown host closure never authorizes a profile-removal attempt after setup failure', async () => {
  for (const field of ['containerRemoved', 'observerStopped', 'instanceRemoved']) for (const value of [false, null, 'unavailable', undefined]) {
    const harness = comparisonHarness({ mutate: result => {
      failedSetupResult(result);
      const target = field === 'instanceRemoved' ? result.row.actorTrace : result.row;
      if (value === undefined) delete target[field]; else target[field] = value;
      if (field === 'instanceRemoved') result.row.observerStopped = false;
    } });
    const result = await runLinuxAppArmorComparison(pair, harness.adapters);
    assert.equal(result.outcome, 'cleanup_failed'); assert.equal(result.profilesRemoved, false);
    assert.ok(harness.calls.includes('remove:baseline:false')); assert.ok(!harness.calls.includes('remove:baseline:true'));
    assert.ok(!harness.calls.includes('load:candidate'));
  }
});

test('comparison changes only the explicit AppArmor selector among container security arguments', () => {
  const base = { role: 'current', nonce: 'a'.repeat(32), runnerRevision: 'b'.repeat(40) };
  const original = linuxMountContainerArguments({ ...base, name: 'tibotattle-mount-diagnosis-current-12345' });
  const comparison = linuxMountContainerArguments({ ...base, name: 'tibotattle-mount-diagnosis-baseline-current-12345', stage: 'baseline', profile: ownedName('baseline') });
  assert.deepEqual(comparison.slice(comparison.indexOf('--cap-add=SYS_ADMIN')), original.slice(original.indexOf('--cap-add=SYS_ADMIN')));
  assert.equal(comparison[comparison.indexOf('--security-opt') + 1], `apparmor=${ownedName('baseline')}`);
  for (const profile of ['unconfined', 'docker-default', ownedName('candidate'), ownedName('baseline') + ',unconfined']) {
    assert.throws(() => linuxMountContainerArguments({ ...base, name: 'tibotattle-mount-diagnosis-baseline-current-12345', stage: 'baseline', profile }));
  }
});

test('the exact profile identity readers compile without any process or policy access', () => {
  for (const reader of [LINUX_APPARMOR_DAEMON_READER, LINUX_APPARMOR_PROFILE_ACTORS]) {
    const result = spawnSync('python3', ['-c', "import sys; compile(sys.stdin.buffer.read(), '<profile-reader>', 'exec')"], {
      input: reader, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000, maxBuffer: 4096,
    });
    assert.equal(result.status, 0); assert.equal(result.signal, null); assert.equal(result.error, undefined);
  }
});

test('comparison workflow retains only closed JSON and add-only policy ownership cleanup', async () => {
  const source = await readFile(new URL('../scripts/lib/linux-apparmor-mount-profile.mjs', import.meta.url), 'utf8');
  assert.match(source, /dockerVersion !== LINUX_APPARMOR_DOCKER_VERSION/u);
  assert.match(source, /\['--preprocess', '--skip-cache'\]/u);
  assert.match(source, /PARSER, '--add', '--skip-cache'/u); assert.match(source, /PARSER, '--remove', '--skip-cache'/u);
  assert.doesNotMatch(source, /PARSER, '--replace'|--Complain|--privileged|seccomp=unconfined|apparmor=unconfined/u);
  assert.match(source, /if \(!containersGone\) return false/u); assert.match(source, /!profileActorsGone\(entry.name\)/u);
  const workflow = await readFile(new URL('../.github/workflows/electron-linux-appimage-mount-diagnosis.yml', import.meta.url), 'utf8');
  for (const value of ['options: [default, apparmor-comparison]', LINUX_APPARMOR_COMPARISON_CONFIRMATION,
    'SELECTED_POLICY: ${{ inputs.policy }}', '--kill-after=90s 360s', 'apparmor-comparison.json']) assert.ok(workflow.includes(value), value);
  assert.doesNotMatch(workflow, /\.mount-apparmor|\.profile\s*$|contents: write|--privileged|apparmor=unconfined/mu);
});

test('profile removal requires the exact successful add marker, source digest, owner and no active actor', () => {
  const owner = { run: '12345', runner: 'b'.repeat(40), nonce: 'a'.repeat(32), parserSha256: 'c'.repeat(64), baselineName: ownedName('baseline'), imports: importBinding() };
  const marker = structuredClone({ ...owner, stage: 'baseline', name: ownedName('baseline'), sha256: 'd'.repeat(64) });
  const expected = { run: owner.run, runner: owner.runner, parserSha256: owner.parserSha256, stage: 'baseline' };
  const input = { owner, marker, profileSha256: marker.sha256, currentState: 'enforce', actorsGone: true };
  assert.equal(linuxAppArmorRemovalAllowed(input, expected), true);
  for (const mutate of [v => { v.marker = null; }, v => { v.marker.name = 'docker-default'; },
    v => { v.marker.run = '12346'; }, v => { v.owner.runner = 'e'.repeat(40); }, v => { v.profileSha256 = 'f'.repeat(64); },
    v => { v.currentState = 'complain'; }, v => { v.actorsGone = false; }, v => { v.actorsGone = 'unavailable'; },
    v => { v.marker.path = '/private/profile'; }, v => { v.marker.imports.abi40Sha256 = 'e'.repeat(64); },
    v => { delete v.owner.imports; }]) {
    const changed = structuredClone(input); mutate(changed); assert.equal(linuxAppArmorRemovalAllowed(changed, expected), false);
  }
});

test('enforcement drift and an unresolved negative deny never satisfy the comparison receipt', async () => {
  const complete = await runLinuxAppArmorComparison(pair, comparisonHarness().adapters);
  for (const enforcement of ['complain', 'unconfined', 'unavailable']) {
    const changed = structuredClone(complete); changed.cases[2].row.probe.environment.appArmor.enforcement = enforcement;
    assert.equal(validateLinuxAppArmorComparison(changed, validateRow), null);
  }
  const { calls, adapters } = comparisonHarness({ failedCleanup: true });
  const result = await runLinuxAppArmorComparison(pair, adapters);
  assert.equal(result.outcome, 'cleanup_failed'); assert.equal(result.profilesRemoved, false);
  assert.ok(!calls.includes('load:candidate'));
});


test('each fixed privileged operation has its own root deadline inside the controller timeout', () => {
  for (const args of [['-n', '/usr/sbin/apparmor_parser', '--add', '--skip-cache'], ['-n', '/usr/sbin/apparmor_parser', '--remove', '--skip-cache'],
    ['-n', 'python3', '-c', 'synthetic'], ['-n', 'cat', '/sys/kernel/security/apparmor/profiles']]) {
    assert.deepEqual(linuxAppArmorPrivilegedArguments(args), ['-n', 'timeout', '--signal=TERM', '--kill-after=2s', '10s', ...args.slice(1)]);
  }
  for (const args of [null, [], ['-i', 'python3'], ['-n', 'bash'], ['-n', 'rm']]) assert.throws(() => linuxAppArmorPrivilegedArguments(args));
});


const importRefusal = reason => error => error.code === 'imports_unavailable' && error.importFailure === reason
  && error.message === 'LINUX_APPARMOR_COMPARISON_REFUSED';

test('flattened standard imports preserve the canonical ABI directive and identical duplicates byte for byte', async () => {
  const template = await readFile(new URL('../scripts/assets/moby-apparmor-v28.0.4-template.txt', import.meta.url), 'utf8');
  const name = ownedName('baseline');
  const rendered = renderLinuxAppArmorBasis(template, { name, daemonProfile: 'unconfined', globalImport: false, baseImport: false });
  // Minimal synthetic preprocessed abstraction: ABI remains inside the profile.
  const flattened = rendered.replace('  network,', '  # flattened abstraction\n  abi <abi/4.0>,\n  /usr/lib/synthetic/** mr,\n\tabi <abi/4.0>,\n  network,');
  for (const stage of ['baseline', 'candidate']) {
    const result = deriveLinuxAppArmorProfile(flattened, { baselineName: name, name: ownedName(stage), stage,
      tuple: tuple(), nonce: 'a'.repeat(32), imports: importBinding() });
    assert.equal(result, flattened.replaceAll(name, ownedName(stage)).replace('  deny mount,',
      stage === 'baseline' ? '  audit deny mount,' : linuxAppArmorMountRule(tuple(), 'a'.repeat(32))));
    assert.equal(result.split('abi <abi/4.0>,').length, 3);
  }
  assert.throws(() => deriveLinuxAppArmorProfile(flattened, { baselineName: name, name, stage: 'baseline' }), importRefusal('abi_missing'));
  for (const directive of ['abi <abi/3.0>,', 'abi <kernel>,', 'abi<abi/3.0>,', 'abi "/private/abi-marker",', 'abi <abi/4.0>, abi <abi/3.0>,', 'audit { abi <abi/4.0>, }']) {
    assert.throws(() => deriveLinuxAppArmorProfile(flattened.replace('abi <abi/4.0>,', directive),
      { baselineName: name, name, stage: 'baseline', imports: importBinding() }), importRefusal('abi_directive_unsupported'));
  }
  for (const [extra, reason] of [['#include <unexpanded>', 'include_remaining'], ['# include <unexpanded>', 'include_remaining'], ['audit { mount, }', 'mount_rule_unsupported'],
    ['allow { remount, }', 'mount_rule_unsupported'], ['audit { all, }', 'all_permission_unsupported'], ['profile another {}', 'profile_shape_unsupported']]) {
    assert.throws(() => deriveLinuxAppArmorProfile(`${flattened}\n${extra}\n`,
      { baselineName: name, name, stage: 'baseline', imports: importBinding() }), importRefusal(reason));
  }
});

function rootImportFixture({ kind = 'abi', contents = Buffer.from('synthetic-feature-set\n'), change = () => {} } = {}) {
  const path = kind === 'abi' ? '/etc/apparmor.d/abi/4.0' : '/etc/apparmor/parser.conf';
  const file = { uid: 0n, mode: 0o100644n, nlink: 1n, size: BigInt(contents.length), dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  const directory = { ...file, mode: 0o40755n, isFile: () => false, isDirectory: () => true };
  const calls = []; let reads = 0;
  return { calls, io: {
    async lstat(value) { calls.push(['stat', value]); const stat = { ...(value === path ? file : directory) }; change(stat, value === path ? 'path' : 'parent', reads); return stat; },
    async realpath(value) { return value; },
    async open(value, flags) {
      calls.push(['open', value, flags]);
      return {
        async stat() { const stat = { ...file }; change(stat, 'handle', reads); return stat; },
        async read(buffer, offset, length, position) { reads++; assert.equal(position, 0); assert.equal(length, 65537); contents.copy(buffer, offset); return { bytesRead: contents.length }; },
        async close() { calls.push(['close']); },
      };
    },
  } };
}

test('canonical ABI reads refuse ownership, path, size, link and mutation ambiguity without retaining raw bytes in evidence', async () => {
  const fixture = rootImportFixture();
  const contents = await readLinuxAppArmorRootImport('abi', fixture.io);
  assert.equal(contents.toString('utf8'), 'synthetic-feature-set\n'); assert.equal(fixture.calls.at(-1)[0], 'close');
  for (const change of [stat => { stat.uid = 1000n; }, stat => { stat.mode |= 0o020n; },
    (stat, at) => { if (at === 'path') stat.nlink = 2n; }, (stat, at) => { if (at === 'path') stat.size = 65537n; },
    (stat, at) => { if (at === 'path') stat.isSymbolicLink = () => true; },
    (stat, at, reads) => { if (at === 'handle' && reads) stat.ino++; },
    (stat, at, reads) => { if (at === 'path' && reads) stat.ctimeNs++; },
    (stat, at) => { if (at === 'parent') stat.mode |= 0o002n; }]) {
    await assert.rejects(readLinuxAppArmorRootImport('abi', rootImportFixture({ change }).io), importRefusal('abi_unsafe'));
  }
  const redirected = rootImportFixture(); redirected.io.realpath = async () => '/private/redirect-marker';
  await assert.rejects(readLinuxAppArmorRootImport('abi', redirected.io), importRefusal('abi_unsafe'));
  for (const code of ['ENOENT', 'EACCES']) {
    const missing = rootImportFixture(); const stat = missing.io.lstat;
    missing.io.lstat = async path => { if (path.endsWith('/4.0')) throw Object.assign(new Error('private-file-marker'), { code }); return stat(path); };
    if (code === 'ENOENT') assert.equal(await readLinuxAppArmorRootImport('abi', missing.io), null);
    else await assert.rejects(readLinuxAppArmorRootImport('abi', missing.io), importRefusal('abi_unavailable'));
    assert.ok(!missing.calls.some(call => call[0] === 'open'));
  }
  await assert.rejects(readLinuxAppArmorRootImport('abi', rootImportFixture({ contents: Buffer.alloc(0) }).io), importRefusal('abi_unsafe'));
  assert.equal((await readLinuxAppArmorRootImport('parser_config', rootImportFixture({ kind: 'parser_config', contents: Buffer.alloc(0) }).io)).length, 0);
});

test('only default parser configuration is admitted and receipts bind exact config and ABI bytes', async () => {
  const abi = Buffer.from('synthetic-feature-set\n');
  for (const config of [null, Buffer.alloc(0), Buffer.from('# Include /private/comment-only-marker\n \t# policy-features=example\n\n'), Buffer.from('#' + ' '.repeat(253) + '\n')]) {
    const calls = [];
    const binding = await readLinuxAppArmorImportBinding({ read: async kind => { calls.push(kind); return kind === 'abi' ? abi : config; } });
    assert.deepEqual(calls, ['parser_config', 'abi']);
    assert.deepEqual(binding, { parserConfigSha256: config === null ? null : createHash('sha256').update(config).digest('hex'),
      abi40Sha256: createHash('sha256').update(abi).digest('hex') });
    assert.doesNotMatch(JSON.stringify(binding), /private|Include|feature-set|\/etc/u);
  }
  for (const option of ['Include /private/search-marker', 'base=/private/base-marker', 'override-policy-abi=/private/abi-marker',
    'policy-features=/private/abi-marker', 'config-file=/private/config-marker', 'Complain', 'write-cache', '\0',
    '#' + ' '.repeat(254) + 'Include /private/synthetic', '#' + '😀'.repeat(64)]) {
    let abiRead = false;
    await assert.rejects(readLinuxAppArmorImportBinding({ read: async kind => {
      if (kind === 'abi') { abiRead = true; return abi; } return Buffer.from(`# comment\n${option}\n`);
    } }), importRefusal('parser_config_unsupported'));
    assert.equal(abiRead, false);
  }
  assert.deepEqual(await readLinuxAppArmorImportBinding({ read: async () => null }), { parserConfigSha256: null, abi40Sha256: null });
});

test('parser operations are bracketed by both bindings, including missing files and successful-add ownership before post-check refusal', async () => {
  const expected = importBinding(); const events = [];
  let absentInvoked = false;
  await assert.rejects(withLinuxAppArmorImportBinding({ ...expected, abi40Sha256: null }, () => { absentInvoked = true; },
    { read: async () => expected }), importRefusal('abi_changed'));
  assert.equal(absentInvoked, false);
  assert.equal(await withLinuxAppArmorImportBinding(expected, async () => { events.push('operation'); return 'done'; },
    { read: async () => { events.push('binding'); return structuredClone(expected); } }), 'done');
  assert.deepEqual(events, ['binding', 'operation', 'binding']);
  for (const [field, reason] of [['parserConfigSha256', 'parser_config_changed'], ['abi40Sha256', 'abi_changed']]) {
    for (const next of [null, 'f'.repeat(64)]) {
      let invoked = false;
      await assert.rejects(withLinuxAppArmorImportBinding(expected, () => { invoked = true; },
        { read: async () => ({ ...expected, [field]: next }) }), importRefusal(reason));
      assert.equal(invoked, false);
      let reads = 0, journaled = false;
      await assert.rejects(withLinuxAppArmorImportBinding(expected, async () => { journaled = true; },
        { read: async () => ++reads === 1 ? expected : { ...expected, [field]: next } }), importRefusal(reason));
      assert.equal(reads, 2); assert.equal(journaled, true);
    }
  }
  const failed = [];
  await assert.rejects(withLinuxAppArmorImportBinding(expected, () => { failed.push('operation'); throw new Error('synthetic failure'); },
    { read: async () => { failed.push('binding'); return expected; } }), /synthetic failure/u);
  assert.deepEqual(failed, ['binding', 'operation', 'binding']);
});

test('comparison v5 keeps precise import refusals closed and cannot mislabel an unrelated failure or older receipt', async () => {
  for (const [provided, expected] of [['abi_missing', 'abi_missing'], ['abi_unsafe', 'abi_unsafe'], ['preprocess_failed', 'preprocess_failed'],
    ['include_remaining', 'include_remaining'], ['parser_config_changed', 'parser_config_changed'], ['private-error-marker', 'unknown'], [undefined, 'unknown']]) {
    const harness = comparisonHarness();
    harness.adapters.prepareProfiles = async () => { throw Object.assign(new Error('/private/error-marker'), { code: 'imports_unavailable', importFailure: provided }); };
    const result = await runLinuxAppArmorComparison(pair, harness.adapters);
    assert.equal(result.basisFailure, 'imports_unavailable'); assert.equal(result.importFailure, expected);
    assert.equal(result.basis, null); assert.equal(result.cases.length, 0); assert.equal(result.profilesRemoved, true);
    assert.equal(validateLinuxAppArmorComparison(result, validateRow), result);
    assert.doesNotMatch(JSON.stringify(result), /private|error-marker/u);
    for (const mutate of [v => { v.importFailure = 'none'; }, v => { v.importFailure = '/private/error-marker'; },
      v => { v.basisFailure = 'docker_version_unmatched'; }]) {
      const changed = structuredClone(result); mutate(changed); assert.equal(validateLinuxAppArmorComparison(changed, validateRow), null);
    }
  }
  assert.equal(linuxAppArmorImportFailure({ code: 'parser_unavailable', importFailure: 'abi_missing' }), 'none');
  const complete = await runLinuxAppArmorComparison(pair, comparisonHarness().adapters);
  assert.equal(complete.schemaVersion, 'tibotattle-linux-apparmor-mount-comparison-v5'); assert.equal(complete.importFailure, 'none');
  for (const mutate of [v => { v.schemaVersion = 'tibotattle-linux-apparmor-mount-comparison-v1'; },
    v => { v.schemaVersion = 'tibotattle-linux-apparmor-mount-comparison-v2'; },
    v => { v.schemaVersion = 'tibotattle-linux-apparmor-mount-comparison-v3'; },
    v => { v.schemaVersion = 'tibotattle-linux-apparmor-mount-comparison-v4'; }, v => { delete v.basis.imports; },
    v => { v.basis.imports.path = '/private/abi-marker'; }, v => { v.basis.imports.abi40Sha256 = 'invalid'; },
    v => { v.importFailure = 'abi_missing'; }]) {
    const changed = structuredClone(complete); mutate(changed); assert.equal(validateLinuxAppArmorComparison(changed, validateRow), null);
  }
});


test('import changes during load or cleanup remain precise failures without losing owned-profile evidence', async () => {
  const error = Object.assign(new Error('private-changed-import-marker'), { code: 'imports_unavailable', importFailure: 'abi_changed' });
  const added = { profileSha256: '5'.repeat(64), profileNameSha256: '6'.repeat(64), loaded: true, removed: false };
  const profiles = { basis: basis(), evidence: { baseline: added, candidate: null },
    async load() { throw error; }, async remove(stage) { if (stage === 'baseline') throw error; return true; } };
  const result = await runLinuxAppArmorComparison(pair, { prepareProfiles: async () => profiles, runProbe: async () => assert.fail('must not probe'), validateRow });
  assert.equal(result.outcome, 'cleanup_failed'); assert.equal(result.basisFailure, 'imports_unavailable'); assert.equal(result.importFailure, 'abi_changed');
  assert.equal(result.profiles.baseline.loaded, true); assert.equal(result.profiles.baseline.removed, false); assert.equal(result.profilesRemoved, false);
  assert.doesNotMatch(JSON.stringify(result), /private-changed-import-marker/u);
  const harness = comparisonHarness();
  const prepare = harness.adapters.prepareProfiles;
  harness.adapters.prepareProfiles = async () => {
    const owned = await prepare(); const remove = owned.remove;
    owned.remove = async (stage, gone) => { if (owned.evidence.candidate !== null) throw error; return remove(stage, gone); };
    return owned;
  };
  const cleanup = await runLinuxAppArmorComparison(pair, harness.adapters);
  assert.equal(cleanup.outcome, 'cleanup_failed'); assert.equal(cleanup.importFailure, 'abi_changed'); assert.equal(cleanup.profilesRemoved, false);
});
