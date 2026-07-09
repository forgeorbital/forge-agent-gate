import { existsSync } from "node:fs";

/**
 * The filesystem kill-file is a dead-simple, out-of-band circuit breaker: if
 * the file exists, every write is hard-blocked, no matter what the mandate or
 * agent says. `touch`-ing the file halts trading instantly; deleting it
 * resumes. Checked fresh on every write (never cached).
 */
export function isKillFileEngaged(killFilePath: string): boolean {
  try {
    return existsSync(killFilePath);
  } catch {
    // If we cannot even stat the path, fail closed.
    return true;
  }
}
