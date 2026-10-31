import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pool, SCHEMA } from '../db.js';
import { marketingUsage } from './marketingUsage.js';
import { acquisitionSummary } from '../installations/acquisition.js';
import { HIDE_INTERNAL_FLAG } from '../installations/qualityConsent.js';

test('operational aggregates count non-consenting use, deduplicate installs and respect deletion/internal filters', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(SCHEMA);
  t.mock.method(pool, 'query', (async (sql: string, values?: unknown[]) => {
    const r = await db.query(sql, values);
    return {rows:r.rows,rowCount:r.rows.length || r.affectedRows || 0,fields:[],command:'',oid:0};
  }) as typeof pool.query);
  const now = new Date().toISOString();
  const recent = new Date(Date.parse(now)-3600000).toISOString();
  const old = new Date(Date.parse(now)-10*86400000).toISOString();
  for (const id of ['new','idle','old','internal','revoked','deleting']) {
    await db.query(`INSERT INTO installations(id,token_hash,consent_version,consented_at,created_at,last_seen_at,app_version,os_name,os_version,architecture,locale)
      VALUES($1,'hash','test',$2,$2,$3,'test','windows','test','x64','ko')`, [id,id==='old'?old:recent,recent]);
  }
  await db.query('INSERT INTO internal_installations(id,added_at) VALUES($1,$2)', ['internal',recent]);
  await db.query("UPDATE installations SET revoked_at=$1 WHERE id='revoked'", [recent]);
  await db.query("UPDATE installations SET deletion_requested_at=$1 WHERE id='deleting'", [recent]);
  for (const [id,owner,status,date] of [
    ['one','new','completed',recent],['two','new','completed',recent],['failed','new','failed',recent],
    ['existing','old','completed',recent],['older','old','completed',old],['internal-job','internal','completed',recent],
    ['revoked-job','revoked','completed',recent],['deleting-job','deleting','completed',recent],
  ]) await db.query('INSERT INTO jobs(id,installation_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',[id,owner,status,date]);
  assert.deepEqual(await marketingUsage(7,now), {newInstallations:2,newStarted:1,newCompleted:1,activeInstallations:3,
    startedInstallations:2,completedInstallations:2,jobsStarted:4,jobsCompleted:3,hideInternal:true});
  const attribution = await acquisitionSummary(7);
  assert.equal(attribution.length,1);
  assert.equal(attribution[0].creative,'unknown');
  assert.equal(attribution[0].installations,2);
  assert.equal(attribution[0].analyzed,0,'unconsented use remains unlinked to advertising');
  await db.query('INSERT INTO service_flags(key,value,updated_at) VALUES($1,\'false\',$2)',[HIDE_INTERNAL_FLAG,now]);
  const withInternal=await marketingUsage(7,now);
  assert.equal(withInternal.newInstallations,3); assert.equal(withInternal.newCompleted,2); assert.equal(withInternal.hideInternal,false);
  const empty=await marketingUsage(7,new Date(Date.parse(now)+30*86400000).toISOString());
  assert.equal(empty.newInstallations,0);assert.equal(empty.newCompleted,0);assert.equal(empty.jobsStarted,0);
});
