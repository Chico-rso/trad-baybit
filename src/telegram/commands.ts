export const commands = [
  'status',
  'positions',
  'stats',
  'pause',
  'resume',
  'mode',
  'health',
] as const;
export type Command = (typeof commands)[number];
export function parseCommand(text: string): Command | undefined {
  const match = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?$/.exec(text.trim());
  return match && commands.includes(match[1] as Command) ? (match[1] as Command) : undefined;
}
