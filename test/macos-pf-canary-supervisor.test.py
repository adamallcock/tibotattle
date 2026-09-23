"""No live PF, launchd, sudo, sockets or process signals in these tests."""
import importlib.util
import hashlib
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts/lib/macos-pf-canary/supervisor.py'
spec = importlib.util.spec_from_file_location('pf_canary', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
OP = '4a5361b7-dc54-49cc-92c5-a3e7d42b9a6f'


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = pathlib.Path(self.temporary.name)
        self.root = self.base / ('tibotattle-pf-canary-' + OP)
        self.root.mkdir()
        self.config = {'operationId': OP, 'scenario': 'network', 'runnerRevision': 'a' * 40,
                       'copiedSupervisorSha256': hashlib.sha256(b'synthetic source').hexdigest(),
                       'deadline': module.time.time() + 90, 'installerPid': 88888, 'installerBirth': 'synthetic birth'}
        (self.root / 'supervisor.py').write_bytes(b'synthetic source')
        (self.root / 'config.json').write_text(json.dumps(self.config))
        self.calls = []
        self.enabled = False
        self.loaded = False
        self.count = 0
        self.counter_delta = True
        self.enable_uncertain = False
        self.anchor = 'com.apple/tibotattle-credential-' + OP

    def pf(self, *args, data=None):
        self.calls.append(args)
        if args == ('-s', 'info'):
            return 'Status: ' + ('Enabled' if self.enabled else 'Disabled') + ' for 0 days\n'
        if args == ('-s', 'states'):
            return ''
        if args == ('-s', 'References'):
            return 'No pf starter references held\n'
        if args == ('-a', self.anchor, '-f', '-'):
            self.loaded = bool(data)
            return ''
        if args == ('-a', self.anchor, '-n', '-f', '-'):
            return ''
        if args == ('-a', self.anchor, '-s', 'rules'):
            return module.rules(OP) if self.loaded else ''
        if args == ('-a', self.anchor, '-s', 'labels'):
            return '\n'.join('ttc-' + OP + '-' + kind + ' 1 ' + str(self.count) + ' 1 0 0 1 1'
                             for kind in (*module.KINDS[:4], 'other4', 'other6'))
        if args == ('-X', '123'):
            self.enabled = False
            return ''
        raise AssertionError('Unexpected mock command')

    def command(self, argv, data=None):
        self.calls.append(tuple(argv))
        if argv in (['/sbin/route', '-n', 'get', '-inet6', '2001:db8::1'],
                    ['/sbin/route', '-n', 'get', '-inet', '192.0.2.1']):
            return 'synthetic route', ''
        if argv == [module.PF, '-E']:
            self.enabled = True
            if self.enable_uncertain:
                raise module.Refused('command')
            return '', 'Token : 123\n'
        raise AssertionError('Unexpected mock command')

    def probe(self, root, config, journal, kind):
        self.calls.append(('probe', kind))
        if self.counter_delta:
            self.count += 1
        return {'connected': kind.startswith('loop'), 'guiBootstrap': True, 'uid': 501}

    def run_supervisor(self, *, stop=None, probe=None, topology=None):
        with patch.object(module, 'BASE', self.base), patch.object(module, '__file__', str(self.root / 'supervisor.py')), \
             patch.object(module.os, 'getuid', return_value=0), \
             patch.object(module, 'root_file', side_effect=lambda p: p.read_bytes()), \
             patch.object(module, 'pf', side_effect=self.pf), patch.object(module, 'command', side_effect=self.command), \
             patch.object(module, 'anchor_names', return_value=[]), \
             patch.object(module, 'topology', side_effect=topology or (lambda _: 'a' * 64)), \
             patch.object(module, 'fork_probe', side_effect=probe or self.probe), \
             patch.object(module, 'stop_group', side_effect=stop or (lambda *_: self.calls.append(('stop',)))), \
             patch.object(module.signal, 'signal'), \
             patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'')):
            return module.supervise(self.root)

    def test_normal_and_disconnected_coordinator_restore_only_after_stop(self):
        receipt = self.run_supervisor()
        self.assertEqual(receipt['status'], 'passed')
        self.assertTrue(receipt['networkQualified'] and receipt['coordinatorExited'])
        self.assertFalse(receipt['credentialContinuityQualified'])
        self.assertLess(self.calls.index(('stop',)), len(self.calls) - 1)
        self.assertLess(self.calls.index(('stop',)), self.calls.index(('-X', '123')))
        self.assertEqual(self.calls.count(('-a', self.anchor, '-f', '-')), 2)
        self.assertFalse(self.enabled or self.loaded)

    def test_existing_pf_never_mutates_rules(self):
        self.enabled = True
        receipt = self.run_supervisor()
        self.assertEqual(receipt['status'], 'failed')
        self.assertTrue(self.enabled)
        self.assertFalse(any('-f' in call or '-X' in call or '-E' in call for call in self.calls))

    def test_unreachable_anchor_fails_without_enable_or_load(self):
        def refused(_):
            raise module.Refused('root_anchor')
        receipt = self.run_supervisor(topology=refused)
        self.assertEqual(receipt['failure'], 'root_anchor')
        self.assertFalse(any('-f' in call or '-E' in call for call in self.calls))

    def test_timeout_without_matching_packet_counter_is_not_denial(self):
        self.counter_delta = False
        receipt = self.run_supervisor()
        self.assertEqual(receipt['failure'], 'denial_counter_absent')
        self.assertFalse(receipt['networkQualified'])
        self.assertTrue(receipt['pfRestored'])

    def test_unverified_live_probe_blocks_unblock(self):
        def alive(*_):
            raise module.Refused('owned_processes_alive')
        receipt = self.run_supervisor(stop=alive)
        self.assertFalse(receipt['pfRestored'])
        self.assertTrue(self.enabled and self.loaded)
        self.assertFalse(any('-X' in call for call in self.calls))
        self.assertEqual(self.calls.count(('-a', self.anchor, '-f', '-')), 1)

    def test_uncertain_enable_result_keeps_containment_and_never_disables_globally(self):
        self.enable_uncertain = True
        receipt = self.run_supervisor()
        self.assertEqual(receipt['failure'], 'enable_reference_uncertain')
        self.assertTrue(self.enabled and self.loaded)
        self.assertFalse(any('-X' in call or '-d' in call or '-F' in call for call in self.calls))
        self.assertEqual(json.loads((self.root / 'journal.json').read_text())['phase'], 'enabling')
        self.calls.clear()
        second = self.run_supervisor()
        self.assertEqual(second['failure'], 'enable_reference_uncertain')
        self.assertTrue(self.enabled and self.loaded)
        self.assertFalse(any('-f' in call or '-X' in call or '-d' in call or '-F' in call for call in self.calls))

    def test_restarted_daemon_cleans_journaled_group_and_token_without_relaunch(self):
        self.enabled = self.loaded = True
        journal = {'phase': 'contained', 'token': '123', 'group': 9999, 'groupBirth': 'synthetic birth',
                   'topology': 'a' * 64, 'loaded': True}
        (self.root / 'journal.json').write_text(json.dumps(journal))
        receipt = self.run_supervisor()
        self.assertEqual(receipt['failure'], 'supervisor_restarted')
        self.assertTrue(receipt['pfRestored'])
        self.assertFalse(any(call[0] == 'probe' for call in self.calls))

    def test_hung_probe_scenario_proves_cleanup_but_never_network(self):
        self.config['scenario'] = 'probe-timeout'
        (self.root / 'config.json').write_text(json.dumps(self.config))
        receipt = self.run_supervisor()
        self.assertEqual(receipt['status'], 'passed')
        self.assertFalse(receipt['networkQualified'])
        self.assertTrue(receipt['recoveryQualified'])

    def test_changed_topology_does_not_clear_anchor(self):
        calls = 0
        def topology(_):
            nonlocal calls
            calls += 1
            return ('a' if calls < 3 else 'b') * 64
        receipt = self.run_supervisor(topology=topology)
        self.assertFalse(receipt['pfRestored'])
        self.assertEqual(receipt['failure'], 'topology_changed')
        self.assertTrue(self.loaded and self.enabled)

    def test_group_identity_change_is_not_signalled(self):
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'new birth', b'')), \
             patch.object(module.os, 'killpg') as kill, patch.object(module, 'groups', return_value=[88888]):
            with self.assertRaises(module.Refused):
                module.stop_group(88888, 'old birth')
            kill.assert_not_called()



    def test_process_observation_error_is_not_permission_to_signal(self):
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'')), \
             patch.object(module.os, 'killpg') as kill, patch.object(module, 'groups', return_value=[88888]):
            with self.assertRaises(module.Refused):
                module.stop_group(88888, 'old birth')
            kill.assert_not_called()

    def test_group_identity_is_rechecked_before_second_signal(self):
        observations = [subprocess.CompletedProcess([], 0, b'old birth', b''),
                        subprocess.CompletedProcess([], 0, b'new birth', b'')]
        with patch.object(module.subprocess, 'run', side_effect=observations), \
             patch.object(module.os, 'killpg') as kill, patch.object(module, 'groups', return_value=[88888]), \
             patch.object(module.time, 'monotonic', side_effect=[0, 3]):
            with self.assertRaises(module.Refused):
                module.stop_group(88888, 'old birth')
            kill.assert_called_once_with(88888, module.signal.SIGTERM)

    def test_missing_ipv6_route_refuses_before_firewall_mutation(self):
        original = self.command
        def command(argv, data=None):
            if argv == ['/sbin/route', '-n', 'get', '-inet6', '2001:db8::1']:
                raise module.Refused('command')
            return original(argv, data)
        self.command = command
        receipt = self.run_supervisor()
        self.assertEqual(receipt['failure'], 'ipv6_route_unavailable')
        self.assertFalse(any('-f' in call or '-E' in call for call in self.calls))


    def test_child_gate_is_never_released_when_durable_registration_fails(self):
        journal = {'group': None, 'groupBirth': None}
        with patch.object(module.os, 'pipe', side_effect=[(10, 11), (12, 13)]), \
             patch.object(module.os, 'open', return_value=14), patch.object(module.os, 'close') as close, \
             patch.object(module.os, 'fork', return_value=88888), patch.object(module.os, 'read', return_value=b'R'), \
             patch.object(module.select, 'select', return_value=([12], [], [])), \
             patch.object(module, 'command', return_value=('birth', '')), \
             patch.object(module, 'durable', side_effect=module.Refused('journal')), \
             patch.object(module.os, 'write') as write:
            with self.assertRaises(module.Refused):
                module.fork_probe(self.root, self.config, journal, 'tcp4')
            write.assert_not_called()
            self.assertIn(unittest.mock.call(11), close.call_args_list)

    def test_durable_group_registration_precedes_probe_release(self):
        events = []
        journal = {'group': None, 'groupBirth': None}
        output = json.dumps({'connected': False, 'guiBootstrap': True, 'uid': 501}).encode()
        with patch.object(module.os, 'pipe', side_effect=[(10, 11), (12, 13)]), \
             patch.object(module.os, 'open', return_value=14), patch.object(module.os, 'close'), \
             patch.object(module.os, 'fork', return_value=88888), patch.object(module.os, 'read', return_value=b'R'), \
             patch.object(module.select, 'select', return_value=([12], [], [])), \
             patch.object(module, 'command', return_value=('birth', '')), \
             patch.object(module, 'durable', side_effect=lambda *_: events.append(('journal', journal['group']))), \
             patch.object(module.os, 'write', side_effect=lambda *_: events.append(('release', journal['group']))), \
             patch.object(module.os, 'waitpid', return_value=(88888, 0)), \
             patch.object(module, 'stop_group', side_effect=lambda *_: events.append(('stop', journal['group']))), \
             patch.object(module, 'root_file', return_value=output):
            module.fork_probe(self.root, self.config, journal, 'tcp4')
            self.assertEqual(events, [('journal', 88888), ('release', 88888), ('stop', 88888), ('journal', None)])

    def test_native_zero_reference_message_is_exact_and_tables_or_mixed_output_refuse(self):
        module.require_no_references('No pf starter references held\n')
        for value in ('', 'References:', 'TOKENS:', 'No pf_enabled references',
                      'No pf starter references held\nTOKENS:',
                      'PID Process Name TOKEN TIMESTAMP\n1 service 123 0 days 00:00:01',
                      'No pf starter references held\n1 service 123 0 days 00:00:01',
                      'No PF_enabled references', 'PRIVATE_SENTINEL'):
            with self.subTest(value=value), self.assertRaises(module.Refused):
                module.require_no_references(value)

    def test_reference_admission_never_uses_error_exit_or_stderr_as_empty_success(self):
        for code, out, err in [
                (1, b'', b'pfctl: No pf_enabled references\n'),
                (1, b'No pf starter references held\n', b'failed'),
                (0, b'', b'No pf starter references held\n'),
                (0, b'TOKENS:\n1 service 123 0 days 00:00:01', b'No pf starter references held\n')]:
            with self.subTest(code=code, out=out), patch.object(module.subprocess, 'run',
                    return_value=subprocess.CompletedProcess([], code, out, err)), self.assertRaises(module.Refused):
                module.require_no_references(module.pf('-s', 'References'))
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 0, b'No pf starter references held\n', b'')):
            module.require_no_references(module.pf('-s', 'References'))

    def test_strict_label_and_enable_token_parsers(self):
        self.assertEqual(module.labels('owned 1 2 3 4 5 6 7\n', ['owned']), {'owned': 2})
        for value in ('owned 1 2\n', 'other 1 2 3 4 5 6 7\n', 'owned 1 PRIVATE 3 4 5 6 7\n'):
            with self.assertRaises(module.Refused):
                module.labels(value, ['owned'])
        self.assertEqual(module.reference_token('Token : 123\n'), '123')
        for value in ('Token : -1', 'Token : 0', 'Token : 18446744073709551616', 'Token : 1\nToken : 2'):
            with self.assertRaises(module.Refused):
                module.reference_token(value)


class InspectionTest(unittest.TestCase):
    def test_inspection_is_fixed_read_only_queries_with_strict_child_paths(self):
        for kind in module.INSPECT_FIXED:
            argv = module.inspect_argv(kind, '')
            self.assertNotIn('-f', argv); self.assertNotIn('-E', argv)
            self.assertIn(argv[0], ('/sbin/pfctl', '/sbin/route'))
        for kind in ('anchors', 'rules', 'nat'):
            self.assertEqual(module.inspect_argv(kind, 'com.apple/synthetic')[1:3], ['-a', 'com.apple/synthetic'])
        for kind, parent in [('enable', ''), ('rules', '../other'), ('rules', '*'), ('rules', '/absolute'),
                             ('rules', 'a/b/c/d'), ('route4', 'private'), ('rules', 'a/../b')]:
            with self.assertRaises(module.Refused): module.inspect_argv(kind, parent)

    def test_anchor_format_observation_normalizes_only_direct_children_without_execution_policy_change(self):
        for text, category, paths in [('', 'empty', []), ('  com.apple/synthetic\n', 'qualified', ['com.apple/synthetic']),
                ('synthetic', 'components', ['com.apple/synthetic']),
                ('first\ncom.apple/second', 'mixed', ['com.apple/first', 'com.apple/second'])]:
            self.assertEqual(module.inspect_anchor_list(text, 'com.apple'), (category, paths))
        for text in ('other/child', 'com.apple/a/b', 'com.apple/../other', 'first\nfirst',
                     'first\ncom.apple/first', 'x' * 129, '\n'.join('a' + str(i) for i in range(65))):
            self.assertEqual(module.inspect_anchor_list(text, 'com.apple'), ('unknown', None))
        with patch.object(module, 'pf', return_value='com.apple/synthetic'):
            with self.assertRaises(module.Refused): module.anchor_names('com.apple')

    def test_all_prerequisites_continue_after_failure_and_receipt_contains_no_raw_values(self):
        calls = []
        def read(kind, parent, deadline):
            calls.append((kind, parent)); module.inspect_argv(kind, parent)
            if kind == 'route6': return 'nonzero', b'', b'PRIVATE_SENTINEL'
            if kind == 'anchors':
                text = 'com.apple' if not parent else 'com.apple/PRIVATE_SENTINEL' if parent == 'com.apple' else ''
            else:
                text = {'status': 'Status: Disabled for 0 days', 'references': 'No pf starter references held',
                        'states': '', 'interfaces': 'synthetic (skip)', 'route4': 'interface: PRIVATE_SENTINEL',
                        'rules': 'anchor "com.apple/*" all' if not parent else '', 'nat': ''}[kind]
            return 'success', text.encode(), b''
        result = module.inspection(OP, 'a' * 40, 'b' * 64, read)
        self.assertTrue(result['anchorTreeComplete']); self.assertTrue(result['readOnly'])
        self.assertFalse(result['networkQualified']); self.assertFalse(result['credentialContinuityQualified'])
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(result))
        self.assertEqual(result['checks'][5]['outcome'], 'nonzero')
        self.assertEqual(result['checks'][5]['classification'], 'unobserved')
        self.assertEqual(result['checks'][3]['classification'], 'skip-present')
        self.assertEqual([c['kind'] for c in result['checks'][-3:]], ['status', 'states', 'references'])
        self.assertIn(('rules', 'com.apple/PRIVATE_SENTINEL'), calls)

    def test_unknown_and_large_anchor_trees_stay_explicit_and_bounded(self):
        for unknown in (False, True):
            calls = []
            def read(kind, parent, deadline):
                calls.append((kind, parent))
                if kind != 'anchors': return 'success', b'', b''
                if unknown: return 'success', b'not/within/requested/parent', b''
                return 'success', '\n'.join((parent + '/' if parent else '') + 'a' + str(i) for i in range(64)).encode(), b''
            result = module.inspection(OP, 'a' * 40, 'b' * 64, read)
            self.assertFalse(result['anchorTreeComplete']); self.assertLessEqual(len(calls), 57)
            self.assertLessEqual(len(json.dumps(result)), 65536)

    def test_read_capture_caps_both_streams_and_kills_only_its_owned_command(self):
        class Pipe:
            def __init__(self, fd): self.fd = fd
            def fileno(self): return self.fd
        class Child:
            stdout = Pipe(10); stderr = Pipe(11)
            def __init__(self): self.killed = False
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def kill(self): self.killed = True
            def wait(self, timeout): return -9 if self.killed else 0
        for noisy_fd in (10, 11):
            child = Child()
            with patch.object(module.subprocess, 'Popen', return_value=child), \
                    patch.object(module.select, 'select', side_effect=lambda fds, *args: ([noisy_fd], [], [])), \
                    patch.object(module.os, 'read', return_value=b'x' * 4096):
                result, out, err = module.inspect_read('states', '', module.time.monotonic() + 10)
            self.assertEqual(result, 'oversize'); self.assertTrue(child.killed)
            self.assertLessEqual(len(out), 65536); self.assertLessEqual(len(err), 65536)
        child = Child()
        with patch.object(module.subprocess, 'Popen', return_value=child), \
                patch.object(module.time, 'monotonic', side_effect=[1, 1, 7, 7]):
            self.assertEqual(module.inspect_read('states', '', 10)[0], 'timeout')
        self.assertTrue(child.killed)
        child = Child()
        with patch.object(module.subprocess, 'Popen', return_value=child), \
                patch.object(module.select, 'select', side_effect=lambda fds, *args: (fds, [], [])), \
                patch.object(module.os, 'read', return_value=b''), patch.object(child, 'wait', return_value=1):
            self.assertEqual(module.inspect_read('states', '', module.time.monotonic() + 10)[0], 'nonzero')
        self.assertFalse(child.killed)
        child = Child()
        with patch.object(module.subprocess, 'Popen', return_value=child), \
                patch.object(module.select, 'select', side_effect=OSError):
            self.assertEqual(module.inspect_read('states', '', module.time.monotonic() + 10)[0], 'unavailable')
        self.assertTrue(child.killed)
        with patch.object(module.subprocess, 'Popen') as popen:
            self.assertEqual(module.inspect_read('states', '', 0), ('budget', b'', b''))
            popen.assert_not_called()

    def test_inspection_does_not_reach_install_cleanup_probe_or_pf_mutations(self):
        with patch.object(module, 'install', side_effect=AssertionError), patch.object(module, 'collect', side_effect=AssertionError), \
                patch.object(module, 'probe', side_effect=AssertionError), patch.object(module, 'pf', side_effect=AssertionError), \
                patch.object(module, 'durable', side_effect=AssertionError):
            module.inspection(OP, 'a' * 40, 'b' * 64, lambda *args: ('success', b'', b''))


if __name__ == '__main__':
    unittest.main()
