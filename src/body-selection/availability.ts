/** One gate for new preferences, candidate UX and body-bound final export. */
import { config } from "../config.js";
import { converterEnabled } from "../converter/client.js";
export function bodyUxAvailable(): boolean {
  return (
    config.bodySelectionEnabled && config.bodyUxEnabled && converterEnabled()
  );
}
