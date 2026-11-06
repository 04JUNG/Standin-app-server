/** Disposable localhost fixture: real Hono + PGlite coordinator, controlled source engine. */
import { serve } from '@hono/node-server';
import { setupFixture } from '../dist/candidate-preparation/fixture.js';
const people = Number(process.env.CANDIDATE_WIRE_PEOPLE ?? '3');
if (![1,2,3].includes(people)) throw new Error('fixture supports 1/2/3 people');
const fixture = await setupFixture(people);
fixture.state.confirmed = true; // Fixture actor; production reuse never records confirmation.
fixture.app.get('/__fixture/state', c => c.json({ kind: 'controlled-source-engine-real-hono-pglite', people,
  calls: fixture.state.solveCalls, reuseCalls: fixture.state.reuseCalls, chunks: fixture.state.chunks,
  rows: fixture.rows.map(r => ({ personIndex: Number(r.person_id), candidateId: r.candidate_id, sourceSha256: r.source_sha256 })),
  base: fixture.base, productionAuthentication: false, targetApplied: false, finalFileVerified: false }));
const stop = fixture.service.start();
const server = serve({ fetch: fixture.app.fetch, hostname: '127.0.0.1', port: Number(process.env.CANDIDATE_WIRE_PORT ?? '18765') }, address => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, base: fixture.base,
    kind: 'controlled-source-engine-real-hono-pglite', people, targetApplied: false }));
});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  stop(); server.close(() => { void fixture.pg.close().then(() => process.exit(0)); });
});
