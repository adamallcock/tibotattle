"""Disposable hosted-runner canary only. Never imports or launches product code.

Root launchd owns PF and synthetic child groups. No command accepts an app path,
credential, address, arbitrary argv, or firewall override. Unknown PF output
refuses qualification. stdout/stderr are not copied into the public receipt.
"""
import hashlib
import json
import os
import pathlib
import platform
import plistlib
import pwd
import re
import signal
import select
import socket
import subprocess
import sys
import time

CONFIRM = 'RUN_DISPOSABLE_MAC_PF_CANARY'
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
KINDS = ('tcp4', 'tcp6', 'udp4', 'udp6', 'descendant')
PF = '/sbin/pfctl'
PYTHON = '/usr/bin/python3'
BASE = pathlib.Path('/private/var/tmp')


class Refused(Exception):
    pass


def require(value, code):
    if not value:
        raise Refused(code)


def operation_root(operation):
    require(isinstance(operation, str) and UUID.fullmatch(operation), 'operation')
    return BASE / ('tibotattle-pf-canary-' + operation)


def root_file(path):
    info = path.lstat()
    require(path.is_file() and not path.is_symlink() and info.st_uid == 0
            and info.st_nlink == 1 and info.st_mode & 0o022 == 0
            and info.st_size <= 131072, 'root_file')
    return path.read_bytes()


def durable(path, value):
    temporary = path.with_name(path.name + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def command(argv, data=None):
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=5, env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C'})
    require(result.returncode == 0 and len(result.stdout) <= 65536
            and len(result.stderr) <= 65536, 'command')
    return result.stdout.decode('ascii'), result.stderr.decode('ascii')


def pf(*args, data=None):
    return command([PF, *args], data)[0]


def enabled(text):
    matches = re.findall(r'^Status: (Enabled|Disabled)\b', text, re.M)
    require(len(matches) == 1, 'pf_status')
    return matches[0] == 'Enabled'


def reference_token(text):
    matches = re.findall(r'^Token\s*:\s*([1-9][0-9]{0,19})\s*$', text, re.M)
    require(len(matches) == 1 and int(matches[0]) <= 2**64 - 1, 'enable_token')
    return matches[0]


def require_no_references(text):
    # Native DIOCGETSTARTERS empty success: puts(), then return 0. The
    # different 'No pf_enabled references' literal is an errx(1) error path.
    require(text.strip() == 'No pf starter references held', 'preexisting_references')


def labels(text, expected):
    result = {}
    for line in text.splitlines():
        words = line.split()
        require(len(words) == 8 and words[0] in expected and words[0] not in result
                and all(re.fullmatch('[0-9]+', value) for value in words[1:]), 'pf_labels')
        result[words[0]] = int(words[2])
    require(set(result) == set(expected), 'pf_labels')
    return result


def rules(operation):
    result = []
    for kind in KINDS[:4]:
        version = kind[-1]
        result.append('block drop out quick %s proto %s from any to %s port 9 label "ttc-%s-%s"' % (
            'inet' if version == '4' else 'inet6', kind[:3],
            '192.0.2.1' if version == '4' else '2001:db8::1', operation, kind))
    for version in ('4', '6'):
        result.append('block drop out quick %s from any to ! %s label "ttc-%s-other%s"' % (
            'inet' if version == '4' else 'inet6', '127.0.0.0/8' if version == '4' else '::1', operation, version))
    return '\n'.join(result) + '\n'


def anchor_names(parent=''):
    arguments = ['-a', parent] if parent else []
    text = pf(*arguments, '-s', 'Anchors')
    names = [line.strip() for line in text.splitlines() if line.strip()]
    require(len(names) <= 64 and len(names) == len(set(names))
            and all(re.fullmatch('[a-zA-Z0-9_.-]+', value) for value in names), 'anchors')
    return names


def topology(owned):
    # Deliberately narrower than all valid PF configurations. An unfamiliar
    # layout must be reviewed; never reload /etc/pf.conf to manufacture a pass.
    root_rules = pf('-s', 'rules').strip()
    require(root_rules == 'anchor "com.apple/*" all', 'root_anchor')
    require(anchor_names() == ['com.apple'], 'root_anchors')
    require(not pf('-a', 'com.apple', '-s', 'rules').strip()
            and not pf('-a', 'com.apple', '-s', 'nat').strip(), 'parent_rules')
    children = anchor_names('com.apple')
    for name in children:
        full = 'com.apple/' + name
        if full == owned:
            continue
        require(not pf('-a', full, '-s', 'rules').strip()
                and not pf('-a', full, '-s', 'nat').strip() and not anchor_names(full), 'other_anchor_rules')
    interfaces = pf('-v', '-s', 'Interfaces')
    require(interfaces.strip() and not re.search(r'\bskip\b', interfaces, re.I), 'skipped_interface')
    # Preserve existing translation/shaping configuration; qualification refuses
    # any configured redirection or shaping rather than changing it.
    nat = pf('-s', 'nat').strip()
    allowed_nat = {'nat-anchor "com.apple/*" all', 'rdr-anchor "com.apple/*" all'}
    require(set(nat.splitlines()) <= allowed_nat, 'translation_rules')
    canonical = json.dumps({'root': root_rules, 'otherChildren': sorted(name for name in children
                          if 'com.apple/' + name != owned), 'nat': nat}, sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def groups(group):
    text = command(['/bin/ps', '-axo', 'pid=,pgid=,stat='])[0]
    rows = [line.split() for line in text.splitlines()]
    require(all(len(row) == 3 and row[0].isdigit() and row[1].isdigit()
                and re.fullmatch('[A-Za-z+<>=sNEXL?]+', row[2]) for row in rows), 'process_inventory')
    # Zombies cannot execute; retain the child leader unreaped until all live
    # members are gone, so its identity cannot be recycled between signals.
    return [int(pid) for pid, pgid, status in rows if int(pgid) == group and not status.startswith('Z')]


def stop_group(group, birth=None):
    if group is None:
        return
    require(isinstance(group, int) and group > 1 and group != os.getpgrp()
            and isinstance(birth, str) and birth, 'owned_group')
    def complete():
        if groups(group):
            return False
        try:
            os.waitpid(group, os.WNOHANG)
        except ChildProcessError:
            pass
        return True
    for selected in (signal.SIGTERM, signal.SIGKILL):
        if complete():
            return
        leader = subprocess.run(['/bin/ps', '-p', str(group), '-o', 'lstart='],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
        require(leader.returncode == 0 and leader.stdout.decode().strip() == birth, 'group_identity_changed')
        try:
            os.killpg(group, selected)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if complete():
                return
            time.sleep(0.05)
    require(complete(), 'owned_processes_alive')


def fork_probe(root, config, journal, kind):
    # The fixed child cannot execute until its process group is durably recorded.
    # Parent death before the release byte closes the pipe; the child exits.
    gate_read, gate_write = os.pipe()
    ready_read, ready_write = os.pipe()
    output = os.open(root / 'probe-output.json', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    pid = os.fork()
    if pid == 0:
        try:
            os.close(gate_write); os.close(ready_read)
            os.setsid()
            os.write(ready_write, b'R'); os.close(ready_write)
            if os.read(gate_read, 1) != b'G':
                os._exit(1)
            os.close(gate_read)
            os.dup2(output, 1)
            null = os.open('/dev/null', os.O_RDWR)
            os.dup2(null, 0); os.dup2(null, 2)
            os.execve('/bin/launchctl', ['/bin/launchctl', 'asuser', '501', '/usr/bin/sudo', '-n', '-u', '#501',
                      PYTHON, '-I', '-B', str(root / 'supervisor.py'), '--probe', kind],
                      {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': '/Users/runner', 'LC_ALL': 'C'})
        finally:
            os._exit(1)
    os.close(gate_read); os.close(ready_write); os.close(output)
    try:
        require(select.select([ready_read], [], [], 3)[0] and os.read(ready_read, 1) == b'R', 'probe_ready')
        journal['group'] = pid
        journal['groupBirth'] = command(['/bin/ps', '-p', str(pid), '-o', 'lstart='])[0].strip()
        require(journal['groupBirth'], 'group_birth')
        durable(root / 'journal.json', journal)
        os.write(gate_write, b'G')
    finally:
        os.close(ready_read); os.close(gate_write)
    deadline = min(config['deadline'], time.time() + (3 if kind == 'timeout' else 5))
    exit_status = None
    while time.time() < deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited:
            exit_status = status
            break
        time.sleep(0.05)
    stop_group(pid, journal['groupBirth'])
    journal['group'] = None
    journal['groupBirth'] = None
    durable(root / 'journal.json', journal)
    if kind == 'timeout':
        require(exit_status is None, 'timeout_not_exercised')
        return {'timedOut': True}
    require(exit_status == 0, 'probe_exit')
    data = root_file(root / 'probe-output.json')
    require(len(data) <= 1024, 'probe_output')
    result = json.loads(data)
    require(set(result) == {'connected', 'guiBootstrap', 'uid'} and isinstance(result['connected'], bool)
            and result['guiBootstrap'] is True and result['uid'] == 501, 'probe_output')
    return result


def probe(kind):
    require(kind in (*KINDS, 'loop4', 'loop6', 'timeout'), 'probe_kind')
    require(os.getuid() == 501 and pwd.getpwuid(501).pw_name == 'runner', 'probe_identity')
    # Proves this child can address the existing GUI bootstrap, not native UI.
    require(subprocess.run(['/bin/launchctl', 'print', 'gui/501'], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=2).returncode == 0, 'gui_bootstrap')
    if kind == 'timeout':
        while True:
            time.sleep(1)
    if kind == 'descendant':
        result = subprocess.run([PYTHON, '-I', '-B', __file__, '--probe', 'tcp4'],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
        require(result.returncode == 0, 'descendant')
        sys.stdout.buffer.write(result.stdout)
        return
    family = socket.AF_INET if kind.endswith('4') else socket.AF_INET6
    stream = not kind.startswith('udp')
    listener = None
    host = ('127.0.0.1' if family == socket.AF_INET else '::1') if kind.startswith('loop') else (
        '192.0.2.1' if family == socket.AF_INET else '2001:db8::1')
    port = 9
    if kind.startswith('loop'):
        listener = socket.socket(family, socket.SOCK_STREAM)
        listener.bind((host, 0)); listener.listen(1)
        port = listener.getsockname()[1]
    connected = False
    with socket.socket(family, socket.SOCK_STREAM if stream else socket.SOCK_DGRAM) as client:
        client.settimeout(0.5)
        try:
            if stream:
                client.connect((host, port)); connected = True
            else:
                client.sendto(b'synthetic', (host, port))
        except OSError:
            pass
    if listener:
        listener.close()
    print(json.dumps({'connected': connected, 'guiBootstrap': True, 'uid': os.getuid()}))


def supervise(root):
    require(os.getuid() == 0 and root.parent == BASE and not root.is_symlink()
            and pathlib.Path(__file__).absolute() == root / 'supervisor.py', 'root_identity')
    config = json.loads(root_file(root / 'config.json'))
    require(set(config) == {'operationId', 'scenario', 'runnerRevision', 'copiedSupervisorSha256',
                            'deadline', 'installerPid', 'installerBirth'}
            and config['scenario'] in ('network', 'probe-timeout')
            and re.fullmatch('[a-f0-9]{40}', config['runnerRevision'])
            and hashlib.sha256(root_file(root / 'supervisor.py')).hexdigest() == config['copiedSupervisorSha256'], 'config_binding')
    operation = config['operationId']
    require(root == operation_root(operation), 'root_binding')
    anchor = 'com.apple/tibotattle-credential-' + operation
    receipt = {'schemaVersion': 'macos-pf-canary-v1', 'operationId': operation,
               'scenario': config['scenario'], 'runnerRevision': config['runnerRevision'],
               'copiedSupervisorSha256': config['copiedSupervisorSha256'], 'status': 'failed', 'failure': None,
               'networkQualified': False, 'recoveryQualified': False, 'guiBootstrap': False, 'coordinatorExited': False,
               'ownedProcessesStopped': False, 'pfRestored': False, 'credentialContinuityQualified': False}
    journal_path = root / 'journal.json'
    journal = json.loads(root_file(journal_path)) if journal_path.exists() else {
        'phase': 'preflight', 'token': None, 'group': None, 'groupBirth': None, 'topology': None, 'loaded': False}
    def terminated(_signal, _frame):
        raise Refused('supervisor_interrupted')
    signal.signal(signal.SIGTERM, terminated)
    signal.signal(signal.SIGINT, terminated)
    try:
        require(journal['phase'] == 'preflight', 'supervisor_restarted')
        require(time.time() < config['deadline'], 'deadline')
        for _ in range(100):
            observed = subprocess.run(['/bin/ps', '-p', str(config['installerPid']), '-o', 'lstart='],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
            if observed.returncode != 0 or observed.stdout.decode().strip() != config['installerBirth']:
                receipt['coordinatorExited'] = True
                break
            time.sleep(0.05)
        require(receipt['coordinatorExited'], 'coordinator_not_exited')
        require(not enabled(pf('-s', 'info')) and not pf('-s', 'states').strip(), 'preexisting_pf')
        # No reference tokens may predate this operation, including tokens left
        # behind by a separately disabled PF instance. Unknown headers refuse.
        require_no_references(pf('-s', 'References'))
        require(anchor.split('/')[-1] not in anchor_names('com.apple'), 'preexisting_anchor')
        journal['topology'] = topology(anchor)
        if config['scenario'] == 'network':
            try:
                command(['/sbin/route', '-n', 'get', '-inet', '192.0.2.1'])
            except Refused:
                raise Refused('ipv4_route_unavailable')
            try:
                command(['/sbin/route', '-n', 'get', '-inet6', '2001:db8::1'])
            except Refused:
                raise Refused('ipv6_route_unavailable')
        durable(journal_path, journal)
        pf('-a', anchor, '-n', '-f', '-', data=rules(operation).encode())
        journal['loaded'] = True
        durable(journal_path, journal)
        pf('-a', anchor, '-f', '-', data=rules(operation).encode())
        baseline_rules = pf('-a', anchor, '-s', 'rules')
        require(baseline_rules.strip(), 'owned_rules')
        require(not enabled(pf('-s', 'info')) and not pf('-s', 'states').strip()
                and topology(anchor) == journal['topology'], 'pre_enable_changed')
        journal['phase'] = 'enabling'
        durable(journal_path, journal)
        out, err = command([PF, '-E'])
        journal['token'] = reference_token(out + '\n' + err)
        journal['phase'] = 'contained'
        durable(journal_path, journal)
        expected_labels = ['ttc-' + operation + '-' + kind for kind in (*KINDS[:4], 'other4', 'other6')]
        require(enabled(pf('-s', 'info')), 'not_enabled')
        if config['scenario'] == 'probe-timeout':
            fork_probe(root, config, journal, 'timeout')
        else:
            for kind in ('loop4', 'loop6', *KINDS):
                require(time.time() < config['deadline'] and enabled(pf('-s', 'info'))
                        and topology(anchor) == journal['topology']
                        and pf('-a', anchor, '-s', 'rules') == baseline_rules
                        and not pf('-s', 'states').strip(), 'containment_changed')
                before = labels(pf('-a', anchor, '-s', 'labels'), expected_labels)
                result = fork_probe(root, config, journal, kind)
                after = labels(pf('-a', anchor, '-s', 'labels'), expected_labels)
                if kind.startswith('loop'):
                    require(result['connected'], 'loopback_failed')
                else:
                    label = 'ttc-' + operation + '-' + ('tcp4' if kind == 'descendant' else kind)
                    require(not result['connected'] and after[label] > before[label], 'denial_counter_absent')
                receipt['guiBootstrap'] = True
            receipt['networkQualified'] = True
        journal['phase'] = 'stopping'
        durable(journal_path, journal)
    except Refused as error:
        receipt['failure'] = str(error)
    except Exception:
        receipt['failure'] = 'internal'
    finally:
        try:
            stop_group(journal['group'], journal['groupBirth'])
            receipt['ownedProcessesStopped'] = True
            journal['group'] = None
            journal['groupBirth'] = None
            durable(journal_path, journal)
            if journal['loaded']:
                # Uncertain -E completion cannot justify disabling PF globally
                # or releasing somebody else's reference. Leave fail-closed.
                require(journal['phase'] != 'enabling' or journal['token'] is not None, 'enable_reference_uncertain')
                require(topology(anchor) == journal['topology'], 'topology_changed')
                pf('-a', anchor, '-f', '-', data=b'')
                require(not pf('-a', anchor, '-s', 'rules').strip(), 'anchor_not_empty')
            if journal['token'] is not None:
                require(re.fullmatch('[1-9][0-9]{0,19}', journal['token']), 'journal_token')
                pf('-X', journal['token'])
            require(not enabled(pf('-s', 'info')) and not pf('-s', 'states').strip(), 'restore_failed')
            if journal['topology'] is not None:
                require(topology(anchor) == journal['topology'], 'restore_topology')
            receipt['pfRestored'] = True
            receipt['recoveryQualified'] = journal['phase'] not in ('preflight', 'enabling')
        except Refused as error:
            receipt['failure'] = str(error)
        except Exception:
            receipt['failure'] = 'cleanup_internal'
        if receipt['failure'] is None and receipt['recoveryQualified']:
            receipt['status'] = 'passed'
        durable(root / 'receipt.json', receipt)
        # The public result is terminal, but unresolved enable ownership is not.
        # A restart must not turn an unknown -E token into permission to unblock.
        if receipt['pfRestored']:
            journal['phase'] = 'terminal'
        durable(journal_path, journal)
    return receipt


def install(operation, scenario, revision):
    require(os.getuid() == 0 and os.environ.get('SUDO_UID') == '501'
            and os.environ.get('SUDO_USER') == 'runner' and sys.platform == 'darwin'
            and platform.machine() == 'arm64' and pwd.getpwuid(501).pw_dir == '/Users/runner', 'disposable_host')
    require(scenario in ('network', 'probe-timeout') and re.fullmatch('[a-f0-9]{40}', revision), 'intake')
    source = pathlib.Path(__file__).absolute()
    require(not source.is_symlink() and source.resolve() == source, 'source_link')
    require(str(source).startswith('/Users/runner/work/'), 'source_location')
    info = source.lstat()
    require(info.st_uid == 501 and info.st_nlink == 1 and info.st_mode & 0o022 == 0
            and not source.is_symlink() and info.st_size <= 65536, 'source_file')
    for parent in source.parents:
        require(not parent.is_symlink() and parent.stat().st_mode & 0o002 == 0, 'source_ancestor')
    contents = source.read_bytes()
    root = operation_root(operation)
    root.mkdir(mode=0o755)  # Exclusive; the unsigned synthetic probe is public code.
    fd = os.open(root / 'supervisor.py', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(contents); stream.flush(); os.fsync(stream.fileno())
    label = 'com.tibotattle.pf-canary.' + operation
    config = {'operationId': operation, 'scenario': scenario, 'runnerRevision': revision,
              'copiedSupervisorSha256': hashlib.sha256(contents).hexdigest(),
              'deadline': time.time() + 90, 'installerPid': os.getpid(),
              'installerBirth': command(['/bin/ps', '-p', str(os.getpid()), '-o', 'lstart='])[0].strip()}
    durable(root / 'config.json', config)
    plist = {'Label': label, 'ProgramArguments': [PYTHON, '-I', '-B', str(root / 'supervisor.py'), '--supervise', operation],
             'RunAtLoad': True, 'KeepAlive': {'SuccessfulExit': False}, 'ThrottleInterval': 10,
             'AbandonProcessGroup': False, 'ProcessType': 'Background',
             'EnvironmentVariables': {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C'},
             'StandardOutPath': '/dev/null', 'StandardErrorPath': '/dev/null'}
    fd = os.open(root / 'supervisor.plist', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(plistlib.dumps(plist)); stream.flush(); os.fsync(stream.fileno())
    command(['/bin/launchctl', 'bootstrap', 'system', str(root / 'supervisor.plist')])


def collect(operation):
    require(os.getuid() == 0 and os.environ.get('SUDO_UID') == '501'
            and os.environ.get('SUDO_USER') == 'runner' and sys.platform == 'darwin', 'disposable_host')
    root = operation_root(operation)
    data = root_file(root / 'receipt.json')
    receipt = json.loads(data)
    require(receipt['operationId'] == operation, 'receipt_operation')
    # The coordinator never changes PF. It can unload only its exact daemon after
    # the daemon has independently proved every probe stopped and PF restored.
    if receipt['pfRestored'] and receipt['ownedProcessesStopped']:
        service = 'system/com.tibotattle.pf-canary.' + operation
        present = subprocess.run(['/bin/launchctl', 'print', service], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, timeout=5)
        if present.returncode == 0:
            command(['/bin/launchctl', 'bootout', service])
    sys.stdout.buffer.write(data + b'\n')


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--probe':
            probe(sys.argv[2])
        elif len(sys.argv) == 5 and sys.argv[1] == '--install':
            install(*sys.argv[2:])
        elif len(sys.argv) == 3 and sys.argv[1] == '--collect':
            collect(sys.argv[2])
        elif len(sys.argv) == 3 and sys.argv[1] == '--supervise':
            supervise(operation_root(sys.argv[2]))
        else:
            raise Refused('arguments')
    except Exception:
        sys.stderr.write('MACOS_PF_CANARY_REFUSED\n')
        sys.exit(1)
