import { AUTO_SEND_MODES, type AutoSendMode } from './types.js';

/** Effektiver Modus = restriktiverer Wert aus Env und properties.json (off < shadow < live). */
export function resolveAutoSendMode(envMode: AutoSendMode, propertyMode: AutoSendMode | undefined): AutoSendMode {
  if (!propertyMode) return envMode;
  const rank = (m: AutoSendMode) => AUTO_SEND_MODES.indexOf(m);
  return rank(propertyMode) < rank(envMode) ? propertyMode : envMode;
}
