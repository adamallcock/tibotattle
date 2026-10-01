import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleWeek } from '../public/feature-week.js';
import { presentationSegments, sampleAt, advanceHorizonTime } from '../public/trends-horizon.js';

test('example week is bounded and splits the allowance trace at its reset',()=>{
 const {points,domain,events}=exampleWeek();
 assert.equal(domain.endMs-domain.startMs,7*86400000);
 assert.equal(points.length,169);
 assert.ok(points.every(p=>p.allowanceRemaining>=0&&p.allowanceRemaining<=100));
 const segments=presentationSegments(points,['allowanceRemaining'],{segmentKey:'cycle'});
 assert.equal(segments.length,2);
 assert.equal(segments[1][0].timestampMs,events[0].timestampMs);
 assert.equal(sampleAt(points,events[0].timestampMs).allowanceRemaining,100);
 assert.equal(advanceHorizonTime(domain.startMs,40000,domain),domain.startMs);
});
