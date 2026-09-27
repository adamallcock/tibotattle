// Review-only policy core. This module cannot execute commands, grant a launch
// capability, or qualify an installed app. The root launchd adapter and hosted
// containment/recovery canary must be reviewed before a workflow can use it.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const fail = () => { throw new Error('MACOS_PF_QUALIFICATION_REFUSED'); };
const freeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};
function closed(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.keys(value).sort().join() !== [...keys].sort().join()
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))) fail();
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail();
}
function truths(value, keys) { if (keys.some(key => value[key] !== true)) fail(); }

export function macOSPfQualificationPlan(operationId) {
  if (typeof operationId !== 'string' || !UUID.test(operationId)) fail();
  const anchor = `com.apple/tibotattle-credential-${operationId}`;
  const label = suffix => `ttc-${operationId}-${suffix}`;
  const probes = ['tcp4', 'tcp6', 'udp4', 'udp6'];
  const lines = probes.map(kind => `block drop out quick ${kind.endsWith('4') ? 'inet' : 'inet6'} proto ${kind.slice(0, 3)} from any to ${kind.endsWith('4') ? '192.0.2.1' : '2001:db8::1'} port 9 label "${label(kind)}"`);
  // Blanket rules deny every other non-loopback packet. The preceding labels
  // count only fixed synthetic destinations/port, excluding runner traffic.
  lines.push(...[4, 6].map(family => `block drop out quick ${family === 4 ? 'inet' : 'inet6'} from any to ! ${family === 4 ? '127.0.0.0/8' : '::1'} label "${label('other' + family)}"`));
  return freeze({ schemaVersion: 'macos-pf-qualification-plan-v1', executable: false,
    operationId, anchor, labels: Object.fromEntries(probes.map(key => [key, label(key)])),
    rules: lines.join('\n') + '\n',
    // Descriptors only. A future root adapter must validate the exact live
    // topology and own durable recovery before issuing any of these commands.
    commands: {
      checkSudo: ['/usr/bin/sudo', '-n', '/usr/bin/true'],
      loadOwnedAnchor: ['/sbin/pfctl', '-a', anchor, '-f', '-'],
      inspectOwnedAnchor: ['/sbin/pfctl', '-a', anchor, '-v', '-s', 'rules'],
      acquireEnableReference: ['/sbin/pfctl', '-E'],
      // Empty stdin replaces only the exact owned anchor's rules, never -F.
      emptyOwnedAnchor: ['/sbin/pfctl', '-a', anchor, '-f', '-'],
    },
  });
}

// The token stays private to the root supervisor journal, never a public receipt.
export function macOSPfReleaseReferenceArguments(token) {
  if (typeof token !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(token)
    || BigInt(token) > 18446744073709551615n) fail();
  return Object.freeze(['/sbin/pfctl', '-X', token]);
}

export function validateMacOSPfPreflight(value) {
  const positive = ['disposableHostedArmMac', 'passwordlessSudo', 'prefetchComplete',
    'anchorAbsent', 'wildcardReachable', 'noEarlierQuickPass', 'noSkippedInterfaces',
    'noPreexistingOwnedProcesses', 'rootSupervisorReady', 'launchRegistrationClosed',
    'rootJournalDurable', 'hostedRecoveryCanaryPassed'];
  closed(value, [...positive, 'pfEnabled', 'stateCount', 'referenceCount', 'topologySha256']);
  truths(value, positive);
  if (value.pfEnabled !== false || value.stateCount !== 0 || value.referenceCount !== 0
    || typeof value.topologySha256 !== 'string' || !HEX.test(value.topologySha256)) fail();
  return freeze({ ...value });
}

// Socket outcomes alone (including EPERM, timeout and no route) are insufficient.
// Require exact installed rules and increasing matching kernel packet counters
// for every protocol/family and the independently spawned descendant probe.
export function validateMacOSPfProbeEvidence(value) {
  closed(value, ['enabled', 'exactOwnedRules', 'topologyUnchanged', 'noExternalStates',
    'loopback4', 'loopback6', 'tcp4', 'tcp6', 'udp4', 'udp6', 'descendant']);
  truths(value, ['enabled', 'exactOwnedRules', 'topologyUnchanged', 'noExternalStates', 'loopback4', 'loopback6']);
  const result = { enabled: true, exactOwnedRules: true, topologyUnchanged: true,
    noExternalStates: true, loopback4: true, loopback6: true };
  for (const kind of ['tcp4', 'tcp6', 'udp4', 'udp6', 'descendant']) {
    const observation = value[kind];
    closed(observation, ['matchedOwnedRule', 'packetsBefore', 'packetsAfter', 'externalConnectionSucceeded']);
    integer(observation.packetsBefore); integer(observation.packetsAfter);
    if (observation.matchedOwnedRule !== true || observation.externalConnectionSucceeded !== false
      || observation.packetsAfter <= observation.packetsBefore) fail();
    result[kind] = { ...observation };
  }
  return freeze(result);
}

// This reducer specifies root-supervisor ordering. It deliberately exposes no
// runnable backend. A coordinator's finally block cannot satisfy watchdog or
// process-ownership evidence; only the independent privileged owner may do so.
export function createMacOSPfQualificationReview(operationId) {
  const plan = macOSPfQualificationPlan(operationId);
  let phase = 'planned', failure = null, topology = null;
  const snapshot = () => Object.freeze({ operationId: plan.operationId, phase, failure,
    executable: false, credentialContinuityQualified: false });
  const transition = (event, evidence) => {
    switch (event) {
      case 'admit': {
        if (phase !== 'planned') fail();
        const checked = validateMacOSPfPreflight(evidence);
        topology = checked.topologySha256; phase = 'admitted'; break;
      }
      case 'contain': {
        if (phase !== 'admitted') fail();
        closed(evidence, ['enabled', 'stateCountBeforeEnable', 'exactOwnedRules',
          'enableTokenJournaled', 'topologySha256', 'rootSupervisorReady']);
        truths(evidence, ['enabled', 'exactOwnedRules', 'enableTokenJournaled', 'rootSupervisorReady']);
        if (evidence.stateCountBeforeEnable !== 0 || evidence.topologySha256 !== topology) fail();
        phase = 'contained'; break;
      }
      case 'prove':
        if (!['contained', 'qualified'].includes(phase)) fail();
        validateMacOSPfProbeEvidence(evidence); phase = 'qualified'; break;
      case 'finish':
        if (phase !== 'qualified') fail();
        closed(evidence, ['rootOwnerRequestedCleanup']); truths(evidence, ['rootOwnerRequestedCleanup']);
        phase = 'stopping'; break;
      case 'coordinator_crash':
      case 'ci_disconnect':
      case 'timeout':
      case 'containment_changed':
        if (!['admitted', 'contained', 'qualified', 'stopping', 'blocked'].includes(phase)) fail();
        closed(evidence, ['rootSupervisorAlive']); truths(evidence, ['rootSupervisorAlive']);
        failure ??= event; phase = 'stopping'; break;
      case 'stopped': {
        if (!['stopping', 'blocked'].includes(phase)) fail();
        closed(evidence, ['launchGateClosed', 'coordinatorStopped', 'ownedProcessesRemaining',
          'ownershipInventoryComplete', 'fixtureScopeRestored']);
        integer(evidence.ownedProcessesRemaining);
        if (typeof evidence.fixtureScopeRestored !== 'boolean'
          || typeof evidence.launchGateClosed !== 'boolean' || typeof evidence.coordinatorStopped !== 'boolean'
          || typeof evidence.ownershipInventoryComplete !== 'boolean') fail();
        if (evidence.launchGateClosed !== true || evidence.coordinatorStopped !== true
          || evidence.ownershipInventoryComplete !== true || evidence.ownedProcessesRemaining !== 0) {
          failure ??= 'owned_processes_unverified'; phase = 'blocked'; break;
        }
        if (!evidence.fixtureScopeRestored) failure ??= 'fixture_cleanup_unverified';
        phase = 'safe_to_restore'; break;
      }
      case 'restore':
        if (phase !== 'safe_to_restore') fail();
        closed(evidence, ['ownedAnchorEmpty', 'ownReferenceReleased', 'topologySha256', 'pfDisabled']);
        truths(evidence, ['ownedAnchorEmpty', 'ownReferenceReleased', 'pfDisabled']);
        if (evidence.topologySha256 !== topology) fail();
        phase = 'restored'; break;
      default: fail();
    }
    return snapshot();
  };
  return Object.freeze({ plan, snapshot, transition });
}
