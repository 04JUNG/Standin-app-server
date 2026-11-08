// 개발자(팀원) 설치 표시.
//
// 걸러내기는 관리자 뷰(quality_review_installations, ops_count_installations)가 한다
// (installations/qualityConsent.ts). 표시한 설치는 목록·숫자·모아 보기에서 늘 빠지고,
// 그 Job은 작업 탭의 개발자 Job에서 본다. 여기는 표를 읽고 쓰기만 한다.
import { execute, query } from "../db.js";

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
