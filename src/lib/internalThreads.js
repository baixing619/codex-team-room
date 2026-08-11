export function isSubagentThreadSource(source) {
  return Boolean(source?.subagent && typeof source.subagent === "object");
}
