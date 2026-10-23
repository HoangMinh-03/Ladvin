// Everything produced by a remote agent reaches the local agent inside this envelope (spec §11).
export function wrapRemote(host: string, agent: string, body: string): string {
  const safe = body.replace(/<\/?ladvin-remote-content/gi, (m) => m.replace("<", "&lt;"));
  const attr = (s: string) => s.replace(/[^\w.@:-]/g, "_");
  return `<ladvin-remote-content host="${attr(host)}" agent="${attr(agent)}">\n${safe}\n</ladvin-remote-content>`;
}
