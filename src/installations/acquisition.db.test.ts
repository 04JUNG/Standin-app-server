import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pool,SCHEMA} from '../db.js';
import {acquisitionRoutes,acquisitionSummary} from './acquisition.js';

test('PostgreSQL: atomic first touch, cohort deduplication, no pre-consent use, revocation', {skip:process.env.ACQUISITION_TEST_DB !== 'true'},async()=>{
  // Dedicated disposable CI database only. Never run this fixture against production.
  assert.match(process.env.DATABASE_URL ?? '', /localhost:5432\/acquisition_test$/);
  try {
    await pool.query(SCHEMA);
    const token='test-device-token';
    const hash=createHash('sha256').update(token).digest('hex');
    const current=new Date().toISOString();
    const old=new Date(Date.now()-2*86_400_000).toISOString();
    for(const [id,date] of [['inst_acq_p',current],['inst_acq_v',current],['inst_acq_old',old],['inst_acq_unknown',current]]){
      await pool.query(`INSERT INTO installations(id,token_hash,consent_version,consented_at,created_at,last_seen_at,app_version,os_name,os_version,architecture,locale)
        VALUES($1,$2,'2026-08-02',$3,$3,$3,'test','windows','test','x64','ko')`,[id,hash,date]);
    }
    const request=(id:string,method:string,creative='meta-poster-a')=>acquisitionRoutes.request('/',{method,headers:{'Content-Type':'application/json','X-Installation-Id':id,'X-Device-Token':token},...(method==='POST'?{body:JSON.stringify({creative,consent:true,version:'2026-10-29'})}:{})});
    assert.equal((await request('inst_acq_old','POST')).status,409);
    const races=await Promise.all([request('inst_acq_p','POST'),request('inst_acq_p','POST','meta-hook-a')]);
    assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
    // Establish deterministic separate fixtures for the aggregate assertions.
    await pool.query("UPDATE installations SET acquisition_creative='meta-poster-a' WHERE id='inst_acq_p'");
    assert.equal((await request('inst_acq_v','POST','meta-hook-a')).status,200);
    const later=new Date(Date.now()+1000).toISOString();
    for(const [id,owner,date] of [['job_acq_1','inst_acq_p',later],['job_acq_2','inst_acq_p',later],['job_acq_before','inst_acq_v',old],['job_acq_unknown','inst_acq_unknown',later]]){
      await pool.query("INSERT INTO jobs(id,status,created_at,updated_at,installation_id) VALUES($1,'completed',$3,$3,$2)",[id,owner,date]);
    }
    let rows=await acquisitionSummary(7);
    assert.equal(rows.find(r=>r.creative==='meta-poster-a')?.analyzed,1);
    assert.equal(rows.find(r=>r.creative==='meta-hook-a')?.analyzed,0);
    assert.equal(rows.find(r=>r.creative==='unknown')?.analyzed,0);
    assert.equal((await request('inst_acq_p','DELETE')).status,200);
    rows=await acquisitionSummary(7);
    assert.equal(rows.some(r=>r.creative==='meta-poster-a'),false);
    assert.equal((await request('inst_acq_p','POST')).status,409);
  } finally { await pool.end(); }
});
