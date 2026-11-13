import { exportAccessSettings } from "./access-settings.ts";

const outputPath = new URL(
  "../infra/.alchemy/state/PiHardAccess/prod/__stack_output__.json",
  import.meta.url,
);

const settings = exportAccessSettings(outputPath);

console.log(`Exported Access settings for ${settings.hostname}; redeploy the main Worker.`);
