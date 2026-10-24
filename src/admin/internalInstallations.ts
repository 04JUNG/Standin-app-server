// 개발자(팀원) 설치 표시와 "개발자 제외" 스위치.
//
// 걸러내기는 관리자 뷰(quality_review_installations, ops_count_installations)가 한다
// (installations/qualityConsent.ts). 여기는 표와 스위치를 읽고 쓰기만 한다. 스위치가 DB에
// 있으므로 바꾸면 다음 조회부터 모든 태스크에 바로 반영된다(재배포 없음).
import { execute, query, queryOne } from "../db.js";
import { HIDE_INTERNAL_FLAG } from "../installations/qualityConsent.js";

export interface InternalInstallation {
  installationId: string;
  label: string | null;
  addedAt: string;
}

export async function listInternalInstallations(): Promise<InternalInstallation[]> {
  const rows = await query<{ id: string; label: string | null; added_at: string }>(
    "SELECT id, label, added_at FROM internal_installations ORDER BY added_at",
  );
  return rows.map((row) => ({ installationId: row.id, label: row.label, addedAt: row.added_at }));
}

export async function setInternalInstallation(
  installationId: string,
  internal: boolean,
  label: string | null,
): Promise<void> {
  if (!internal) {
    await execute("DELETE FROM internal_installations WHERE id = $1", [installationId]);
    return;
  }
  await execute(
    `INSERT INTO internal_installations (id, label, added_at) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET label = coalesce($2, internal_installations.label)`,
    [installationId, label, new Date().toISOString()],
  );
}

/** 행이 없으면 켜진 것(개발자를 뺀다). 뷰의 기본값과 같다. */
export async function hideInternalInstallations(): Promise<boolean> {
  const row = await queryOne<{ value: string }>("SELECT value FROM service_flags WHERE key = $1", [
    HIDE_INTERNAL_FLAG,
  ]);
  return row ? row.value === "true" : true;
}

export async function setHideInternalInstallations(hide: boolean): Promise<void> {
  await execute(
    `INSERT INTO service_flags (key, value, reason, updated_at) VALUES ($1, $2, NULL, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
    [HIDE_INTERNAL_FLAG, String(hide), new Date().toISOString()],
  );
}
