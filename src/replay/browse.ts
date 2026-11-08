import type { ReplayDb } from "./service.js";
import { checkPolicy, fail, type ReplayPolicy, PROTOCOL } from "./policy.js";

type Filters = Record<string, string | undefined>;
const MAX_RANGE = 90 * 86400000;
const MAX_FACETS = 100;
const bounded = (value: string | undefined, max = 128) => {
  if (value !== undefined && (value.length > max || !value.trim())) fail("REPLAY_INVALID");
  return value?.trim();
};
async function scope(
  db: ReplayDb,
  policy: ReplayPolicy,
  now: number,
  input: Filters,
  omit?: string,
  fixed?: { from: string; to: string; hideInternal: boolean },
) {
  checkPolicy(policy, policy.consentMode);
  const f = { ...input };
  if (omit) delete f[omit];
  const wall = Date.now();
  const to = fixed ? Date.parse(fixed.to) : f.to ? Date.parse(f.to) : wall;
  const from = fixed ? Date.parse(fixed.from) : f.from ? Date.parse(f.from) : to - 7 * 86400000;
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    to - from > MAX_RANGE ||
    to > wall + 300000
  )
    return fail("REPLAY_INVALID");
  // 개발자 세션은 평소 빠지고, 설치 구분에서 내부를 골랐을 때만 보인다. 그 선택지를 세려고
  // 설치 구분 자신의 집계(omit)에서는 빼지 않는다.
  const hideInternal = fixed
    ? fixed.hideInternal
    : omit !== "audience" && input.audience !== "internal";
  const values: unknown[] = [
    policy.environment,
    new Date(now).toISOString(),
    new Date(from).toISOString(),
    new Date(to).toISOString(),
  ];
  const conditions = [
    "s.environment=$1",
    "s.expires_at>$2::timestamptz",
    "s.created_at >= $3::timestamptz",
    "s.created_at < $4::timestamptz",
    "i.revoked_at IS NULL",
    "i.deletion_requested_at IS NULL",
    "i.replay_withdrawn_at IS NULL",
    "COALESCE((SELECT personal_data AND content_license FROM quality_consent_receipts qr WHERE qr.subject_hash=encode(sha256(convert_to(i.id,'UTF8')),'hex') ORDER BY recorded_at DESC,receipt_id DESC LIMIT 1),true)",
  ];
  conditions.push(
    policy.consentMode === "assumed"
      ? "s.authorization_mode='assumed'"
      : "s.authorization_mode='explicit' AND i.quality_personal_data AND i.quality_content_license AND s.consent_id=i.quality_consent_id",
  );
  const internal = "EXISTS(SELECT 1 FROM internal_installations x WHERE x.id=s.installation_id)";
  if (hideInternal) conditions.push(`NOT ${internal}`);
  const add = (sql: string, value: unknown) => {
    values.push(value);
    conditions.push(sql.replaceAll("?", `$${values.length}`));
  };
  for (const [key, column] of Object.entries({
    installationId: "installation_id",
    environment: "environment",
    os: "os",
    appVersion: "app_version",
    appSessionId: "app_session_id",
  }))
    if (f[key]) add(`s.${column}=?`, bounded(f[key], key === "appVersion" ? 64 : 128));
  if (f.jobId)
    add(
      "EXISTS(SELECT 1 FROM replay_job_links l WHERE l.replay_id=s.id AND l.job_id=?)",
      bounded(f.jobId),
    );
  if (f.q) {
    const q = bounded(f.q)!;
    if (!/^[a-zA-Z0-9_.:-]+$/.test(q)) return fail("REPLAY_INVALID");
    add(
      "(strpos(lower(s.id),lower(?))>0 OR strpos(lower(s.installation_id),lower(?))>0 OR strpos(lower(s.app_session_id),lower(?))>0 OR EXISTS(SELECT 1 FROM replay_job_links l WHERE l.replay_id=s.id AND strpos(lower(l.job_id),lower(?))>0))",
      q,
    );
  }
  if (f.audience && !["all", "default", "internal", "unclassified"].includes(f.audience))
    return fail("REPLAY_INVALID");
  if (f.audience === "internal") conditions.push(internal);
  if (f.audience === "unclassified") conditions.push(`NOT ${internal}`);
  for (const key of ["screen", "feature", "saveState"])
    if (f[key]) {
      if (key === "saveState" && !["unknown", "saved", "failed", "cancelled"].includes(f[key]!))
        return fail("REPLAY_INVALID");
      add(
        `EXISTS(SELECT 1 FROM replay_chunks c WHERE c.replay_id=s.id AND c.metadata->>'${key}'=?)`,
        bounded(f[key]),
      );
    }
  if (f.state) {
    if (!["recording", "complete", "incomplete"].includes(f.state)) return fail("REPLAY_INVALID");
    add("s.state=?", f.state);
  }
  if (f.failed) {
    if (!["true", "false"].includes(f.failed)) return fail("REPLAY_INVALID");
    conditions.push(
      `${f.failed === "false" ? "NOT " : ""}EXISTS(SELECT 1 FROM replay_chunks c WHERE c.replay_id=s.id AND c.metadata->>'failed'='true')`,
    );
  }
  if (f.surface) {
    if (!["app", "bar", "capture"].includes(f.surface)) return fail("REPLAY_INVALID");
    add(
      "EXISTS(SELECT 1 FROM replay_streams st WHERE st.replay_id=s.id AND st.surface=?)",
      f.surface,
    );
  }
  return {
    values,
    conditions,
    context: {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      hideInternal,
      environment: policy.environment,
    },
  };
}
const base = "FROM replay_sessions s JOIN installations i ON i.id=s.installation_id";

export async function listReplays(
  db: ReplayDb,
  policy: ReplayPolicy,
  now: number,
  filters: Filters,
) {
  const s = await scope(db, policy, now, filters);
  if (filters.before) {
    if (filters.before.length > 512) return fail("REPLAY_INVALID");
    let cursor: unknown;
    try {
      cursor = JSON.parse(Buffer.from(filters.before, "base64url").toString("utf8"));
    } catch {
      return fail("REPLAY_INVALID");
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 2 ||
      typeof cursor[0] !== "string" ||
      !Number.isFinite(Date.parse(cursor[0])) ||
      typeof cursor[1] !== "string" ||
      !/^[a-f0-9-]{36}$/.test(cursor[1])
    )
      return fail("REPLAY_INVALID");
    s.values.push(cursor[0], cursor[1]);
    s.conditions.push(
      `(s.created_at,s.id)<($${s.values.length - 1}::timestamptz,$${s.values.length}::text)`,
    );
  }
  if (filters.limit && !/^\d{1,3}$/.test(filters.limit)) return fail("REPLAY_INVALID");
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 100));
  s.values.push(limit + 1);
  const rows = (
    await db.query<{
      id: string;
      app_session_id: string;
      installation_id: string;
      authorization_mode: string;
      environment: string;
      app_version: string;
      os: string;
      started_at: number | string;
      expires_at: Date | string;
      state: string;
      total_bytes: number | string;
      created_at: Date | string;
      cursor_at: string;
      job_ids: string[];
      job_count: number;
      surfaces: string[];
      duration_ms: number;
      end_ms: number;
      has_error: boolean;
      save_states: string[];
      preview: { contentHash: string; kind: string; adminUrl: string } | null;
    }>(
      `SELECT s.*,
    to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
    ARRAY(SELECT l.job_id FROM replay_job_links l WHERE l.replay_id=s.id ORDER BY l.job_id LIMIT 4) AS job_ids,
    (SELECT count(*)::int FROM replay_job_links l WHERE l.replay_id=s.id) AS job_count,
    ARRAY(SELECT DISTINCT st.surface FROM replay_streams st WHERE st.replay_id=s.id ORDER BY st.surface) AS surfaces,
    (SELECT COALESCE(max(c.end_ms)-min(c.start_ms),0)::int FROM replay_chunks c WHERE c.replay_id=s.id) AS duration_ms,
    (SELECT COALESCE(max(c.end_ms),0)::int FROM replay_chunks c WHERE c.replay_id=s.id) AS end_ms,
    EXISTS(SELECT 1 FROM replay_chunks c WHERE c.replay_id=s.id AND c.metadata->>'failed'='true') AS has_error,
    ARRAY(SELECT DISTINCT c.metadata->>'saveState' FROM replay_chunks c WHERE c.replay_id=s.id AND c.metadata->>'saveState' IS NOT NULL ORDER BY 1) AS save_states,
    (SELECT jsonb_build_object('contentHash',a.asset_hash,'kind',a.metadata->>'kind','adminUrl','/v1/admin/replays/'||s.id||'/assets/'||a.asset_hash) FROM replay_assets a WHERE a.replay_id=s.id AND a.mime IN ('image/png','image/jpeg','image/webp') AND a.bytes<=262144 AND a.expires_at>$2::timestamptz ORDER BY CASE a.metadata->>'kind' WHEN 'rough' THEN 0 WHEN 'final' THEN 1 WHEN 'thumbnail' THEN 2 ELSE 3 END,a.bytes,a.asset_hash LIMIT 1) AS preview
    ${base} WHERE ${s.conditions.join(" AND ")} ORDER BY s.created_at DESC,s.id DESC LIMIT $${s.values.length}`,
      s.values,
    )
  ).rows;
  return {
    protocolVersion: PROTOCOL,
    scope: s.context,
    items: rows.slice(0, limit).map((r) => ({
      replayId: r.id,
      appSessionId: r.app_session_id,
      installationId: r.installation_id,
      authorizationMode: r.authorization_mode,
      environment: r.environment,
      appVersion: r.app_version,
      os: r.os,
      startedAt: Number(r.started_at),
      expiresAt: new Date(r.expires_at).toISOString(),
      state: r.state,
      totalBytes: Number(r.total_bytes),
      createdAt: new Date(r.created_at).toISOString(),
      jobIds: r.job_ids,
      jobCount: r.job_count,
      surfaces: r.surfaces,
      durationMs: r.duration_ms,
      endedOffsetMs: r.end_ms,
      hasError: r.has_error,
      saveStates: r.save_states,
      preview: r.preview,
    })),
    nextBefore:
      rows.length > limit
        ? Buffer.from(JSON.stringify([rows[limit - 1].cursor_at, rows[limit - 1].id])).toString(
            "base64url",
          )
        : null,
  };
}

export async function replayFacets(
  db: ReplayDb,
  policy: ReplayPolicy,
  now: number,
  filters: Filters,
) {
  const definitions = [
    ["versions", "appVersion", "s.app_version", ""],
    ["os", "os", "s.os", ""],
    ["surfaces", "surface", "st.surface", "JOIN replay_streams st ON st.replay_id=s.id"],
    [
      "saveStates",
      "saveState",
      "c.metadata->>'saveState'",
      "JOIN replay_chunks c ON c.replay_id=s.id",
    ],
    ["states", "state", "s.state", ""],
    [
      "errors",
      "failed",
      "CASE WHEN EXISTS(SELECT 1 FROM replay_chunks c WHERE c.replay_id=s.id AND c.metadata->>'failed'='true') THEN 'true' ELSE 'false' END",
      "",
    ],
    [
      "audiences",
      "audience",
      "CASE WHEN EXISTS(SELECT 1 FROM internal_installations x WHERE x.id=s.installation_id) THEN 'internal' ELSE 'unclassified' END",
      "",
    ],
  ];
  const context = (await scope(db, policy, now, filters)).context;
  const facets: Record<string, { value: string; count: number }[]> = {};
  const truncated: string[] = [];
  // Each facet omits its own selection; all other query/scope filters still apply.
  for (const [name, omit, column, join] of definitions) {
    const s = await scope(db, policy, now, filters, omit, context);
    const rows = (
      await db.query<{ value: string; count: string }>(
        `SELECT ${column} AS value,count(DISTINCT s.id)::text AS count ${base} ${join} WHERE ${s.conditions.join(" AND ")} GROUP BY 1 ORDER BY count(DISTINCT s.id) DESC,1 LIMIT ${MAX_FACETS + 1}`,
        s.values,
      )
    ).rows.filter((r) => r.value !== null);
    if (rows.length > MAX_FACETS) truncated.push(name);
    facets[name] = rows
      .slice(0, MAX_FACETS)
      .map((r) => ({ value: r.value, count: Number(r.count) }));
  }
  return { protocolVersion: PROTOCOL, scope: context, facets, truncated };
}
