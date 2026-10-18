type EmitWarning = (warning: string | Error, ...rest: unknown[]) => void

/** drops Node's one-time ExperimentalWarning for node:sqlite, which the broker uses; every other warning is still printed */
export function quietSqliteWarning(): void {
  const emit = process.emitWarning as EmitWarning
  const filtered: EmitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: unknown } | undefined)?.type
    if (type === "ExperimentalWarning" && /sqlite/i.test(String(warning instanceof Error ? warning.message : warning))) return
    emit.call(process, warning, ...rest)
  }
  process.emitWarning = filtered as typeof process.emitWarning
}
