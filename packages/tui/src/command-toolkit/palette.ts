import type { TuiCommandWinner } from "./host"

/** The palette only de-duplicates the host's resolved route view; it never resolves collisions itself. */
export function commandPaletteWinners(commands: readonly TuiCommandWinner[]) {
  const winners = new Map<string, TuiCommandWinner>()
  for (const command of commands) if (!winners.has(command.identity)) winners.set(command.identity, command)
  return [...winners.values()]
}
