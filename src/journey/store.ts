import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { query, transaction } from '../db.js';
import { JOURNEY_VERSION, type WebEvent } from './contract.js';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function createVisitor() {
  const token=randomBytes(32).toString('base64url');
  const [row]=await query<{expiresAt:string}>(`INSERT INTO journey_visitors(id,token_hash,expires_at,consent_version)
    VALUES($1,$2,now()+interval '90 days',$3) RETURNING expires_at::text AS "expiresAt"`,[randomUUID(),hash(token),JOURNEY_VERSION]);
  return {token,expiresAt:new Date(row.expiresAt).toISOString()};
}
export async function ingestWeb(token:string,events:WebEvent[]) {
  return transaction(async db=>{
    const {rows:[visitor]}=await db.query(`SELECT id,created_at,event_count FROM journey_visitors
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`,[hash(token)]);
    if(!visitor) return null;
    if(visitor.event_count+events.length>10000) return -1;
    if(events.some(e=>Date.parse(e.at)<Date.parse(visitor.created_at)-1000)) return null;
    let accepted=0;
    for(const e of events) {
      const r=await db.query(`INSERT INTO journey_web_events(event_id,visitor_id,page_id,sequence,event_name,occurred_at,path,section,target,creative,source,device,elapsed_ms,depth)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
      [e.id,visitor.id,e.page,e.sequence,e.name,e.at,e.path,e.section,e.target,e.creative,e.source,e.device,e.elapsedMs,e.depth]);
      accepted+=r.rowCount??0;
    }
    await db.query('UPDATE journey_visitors SET event_count=event_count+$2 WHERE id=$1',[visitor.id,accepted]);
    return accepted;
  });
}
export async function revokeVisitor(token:string) {
  await transaction(async db=>{
    const {rows:[v]}=await db.query('SELECT id FROM journey_visitors WHERE token_hash=$1 FOR UPDATE',[hash(token)]);
    if(!v)return;
    await db.query('UPDATE journey_visitors SET revoked_at=now() WHERE id=$1',[v.id]);
    await db.query('DELETE FROM journey_web_events WHERE visitor_id=$1',[v.id]);
    await db.query('DELETE FROM journey_handoffs WHERE visitor_id=$1',[v.id]);
    await db.query('DELETE FROM journey_app_events WHERE link_id IN (SELECT id FROM journey_links WHERE visitor_id=$1)',[v.id]);
    await db.query('UPDATE journey_links SET revoked_at=now(),visitor_id=NULL WHERE visitor_id=$1',[v.id]);
  });
}
export async function issueHandoff(token:string) {
  return transaction(async db=>{
    const {rows:[v]}=await db.query(`SELECT id FROM journey_visitors WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`,[hash(token)]);
    if(!v)return null;
    // Only one unconsumed link per visitor, bounded even if the button is repeatedly opened.
    await db.query('DELETE FROM journey_handoffs WHERE visitor_id=$1',[v.id]);
    const handoff=randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO journey_handoffs(token_hash,visitor_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')`,[hash(handoff),v.id]);
    return {token:handoff,expiresInSeconds:1800};
  });
}
export async function readLink(installationId:string) {
  const [r]=await query<{id:string;consentedAt:string;expiresAt:string}>(`SELECT l.id,l.consented_at::text AS "consentedAt",l.expires_at::text AS "expiresAt"
    FROM journey_links l JOIN journey_visitors v ON v.id=l.visitor_id WHERE l.installation_id=$1
      AND l.revoked_at IS NULL AND l.expires_at>now() AND v.revoked_at IS NULL AND v.expires_at>now()`,[installationId]);
  return r??null;
}
export async function claimHandoff(installationId:string,token:string) {
  return transaction(async db=>{
    // Visitor first, then installation/link: same order as web withdrawal and event ingestion.
    const {rows:[v]}=await db.query(`SELECT v.id FROM journey_visitors v WHERE v.expires_at>now() AND v.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM journey_handoffs h WHERE h.visitor_id=v.id AND h.token_hash=$1 AND h.expires_at>now()) FOR UPDATE`,[hash(token)]);
    if(!v)return null;
    const {rows:[h]}=await db.query(`SELECT token_hash,visitor_id,used_at FROM journey_handoffs
      WHERE token_hash=$1 AND visitor_id=$2 AND expires_at>now() FOR UPDATE`,[hash(token),v.id]);
    if(!h)return null;
    const {rows:[i]}=await db.query(`SELECT id FROM installations WHERE id=$1 AND revoked_at IS NULL AND deletion_requested_at IS NULL FOR UPDATE`,[installationId]);
    if(!i)return null;
    const {rows:[prior]}=await db.query('SELECT * FROM journey_links WHERE installation_id=$1 FOR UPDATE',[installationId]);
    if(prior && !prior.revoked_at && Date.parse(prior.expires_at)>Date.now()) return prior.visitor_id===h.visitor_id ? prior.id as string : null;
    if(h.used_at)return null;
    if(prior)await db.query('DELETE FROM journey_links WHERE id=$1',[prior.id]);
    const id=randomUUID();
    await db.query(`INSERT INTO journey_links(id,visitor_id,installation_id,expires_at,consent_version)
      SELECT $1,id,$2,LEAST(expires_at,now()+interval '90 days'),$3 FROM journey_visitors WHERE id=$4`,[id,installationId,JOURNEY_VERSION,h.visitor_id]);
    await db.query('UPDATE journey_handoffs SET used_at=now() WHERE token_hash=$1',[hash(token)]);
    return id;
  });
}
export async function revokeLink(installationId:string) {
  await transaction(async db=>{
    await db.query('SELECT id FROM installations WHERE id=$1 FOR UPDATE',[installationId]);
    const {rows:[l]}=await db.query('SELECT id FROM journey_links WHERE installation_id=$1 FOR UPDATE',[installationId]);
    if(!l)return;
    await db.query('DELETE FROM journey_app_events WHERE link_id=$1',[l.id]);
    await db.query('UPDATE journey_links SET revoked_at=now(),visitor_id=NULL WHERE id=$1',[l.id]);
  });
}
export type AppEvent={id:string;name:string;at:string};
export async function ingestApp(installationId:string,receipt:string,events:AppEvent[]) {
  return transaction(async db=>{
    const {rows:[visitor]}=await db.query(`SELECT v.id FROM journey_visitors v JOIN journey_links l ON l.visitor_id=v.id
      WHERE l.installation_id=$1 AND l.id=$2 AND v.revoked_at IS NULL AND v.expires_at>now() FOR UPDATE OF v`,[installationId,receipt]);
    if(!visitor)return null;
    const {rows:[installation]}=await db.query(`SELECT id FROM installations WHERE id=$1 AND revoked_at IS NULL AND deletion_requested_at IS NULL FOR UPDATE`,[installationId]);
    if(!installation)return null;
    const {rows:[link]}=await db.query(`SELECT l.id,l.consented_at FROM journey_links l
      WHERE l.installation_id=$1 AND l.id=$2 AND l.revoked_at IS NULL AND l.expires_at>now()
      FOR UPDATE`,[installationId,receipt]);
    if(!link || events.some(e=>Date.parse(e.at)<Date.parse(link.consented_at)))return null;
    const {rows:[count]}=await db.query('SELECT count(*)::int AS n FROM journey_app_events WHERE link_id=$1',[receipt]);
    if(count.n+events.length>10000)return -1;
    let accepted=0;
    for(const e of events) { const r=await db.query(`INSERT INTO journey_app_events(event_id,link_id,event_name,occurred_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[e.id,receipt,e.name,e.at]); accepted+=r.rowCount??0; }
    return accepted;
  });
}
