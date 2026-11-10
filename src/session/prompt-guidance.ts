import { getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

const conciseRule = "- Be concise in your responses";
const rulesOpening = "<rules>\n";
const rulesClosing = "\n</rules>";

/**
 * Filter Pi-shaped default rules on provider requests, never saved history.
 * Historical sections carry no provenance: an unobserved foreign override with the
 * same wrapper and exact bullet cannot be distinguished from a default section.
 */
export default function registerPromptGuidance(pi: ExtensionAPI): void {
  let runOptions: NormalizedBuildSystemPromptOptions | undefined;
  const explicitRuleSections = new Set<string>();

  // Keep the live object: handlers registered later may supply an explicit override.
  pi.on("before_agent_start", event => { runOptions = event.systemPromptOptions; });
  pi.on("session_shutdown", () => { runOptions = undefined; explicitRuleSections.clear(); });

  pi.on("context_with_system", event => {
    const options = runOptions;
    if (!options) return;
    if (Object.hasOwn(options.sections, "rules")) {
      // Preserve this override even if a later run returns to the default prompt.
      explicitRuleSections.add(`${rulesOpening}${options.sections.rules}${rulesClosing}`);
      return;
    }
    if (options.customPrompt !== undefined || options.forceSystemPrompt !== undefined) return;

    // Pi deduplicates contributed guidelines against its defaults. An explicit copy of
    // this rule is user/tool intent, not a default we can safely distinguish and remove.
    const declaredTools = new Set(getCurrentTools(event.messages).map(tool => tool.name));
    const contributedRules = [
      ...options.promptGuidelines,
      ...Object.entries(options.toolGuidelines).filter(([name]) => declaredTools.has(name))
        .flatMap(([, rules]) => rules),
      ...pi.getAllTools().filter(tool => declaredTools.has(tool.name)).flatMap(tool => tool.promptGuidelines ?? []),
    ];
    if (contributedRules.some(rule => rule.trim() === conciseRule.slice(2) || rule.split("\n").includes(conciseRule))) return;

    let changed = false;
    const messages = event.messages.map(message => {
      if (message.role !== "system") return message;
      const rules = message.sections?.rules;
      if (typeof rules !== "string" || explicitRuleSections.has(rules) ||
        !rules.startsWith(rulesOpening) || !rules.endsWith(rulesClosing)) return message;
      const lines = rules.slice(rulesOpening.length, -rulesClosing.length).split("\n");
      const retained = lines.filter(line => line !== conciseRule);
      if (retained.length === lines.length) return message;
      changed = true;
      return {
        ...message,
        sections: { ...message.sections, rules: `${rulesOpening}${retained.join("\n")}${rulesClosing}` },
      };
    });
    // Keep every message, declaration and section delta in its original position.
    // Only the request-local copy changes; Pi's transcript and prompt options do not.
    if (changed) return { messages };
  });
}
