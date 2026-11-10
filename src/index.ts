import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPromptGuidance from "./session/prompt-guidance.js";
import registerInterface from "./styling/index.js";
import registerWorkers from "./workers/index.js";

/** One package entrypoint; feature modules retain their own state and cleanup. */
export default function registerDankhole(pi: ExtensionAPI): void {
  registerWorkers(pi);
  registerInterface(pi);
  registerPromptGuidance(pi);
}
