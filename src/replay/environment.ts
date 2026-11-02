/** Missing deployment classification must not grant development replay authorization. */
export function resolveReplayEnvironment(values: {
  REPLAY_ENVIRONMENT?: string;
  NODE_ENV?: string;
}): string {
  return (
    (values.REPLAY_ENVIRONMENT ?? values.NODE_ENV)?.trim() || "unclassified"
  );
}
