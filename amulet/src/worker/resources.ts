/**
 * What Pi actually loaded, read from the SDK's own resource loader.
 *
 * Kept separate from the worker because it touches every corner of the loader API, and because the
 * management surface and the reload command both need it.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionSummary, ResourceReport } from "../shared/protocol.js";

/** `builtin:mcp`, `~/.pi/extensions/permissions.ts` -> `mcp`, `permissions`. */
function extensionName(path: string): string {
  const bare = path.replace(/^builtin:/, "");
  const leaf = bare.split(/[\\/]/).pop() ?? bare;
  return leaf.replace(/\.[cm]?[jt]s$/, "").replace(/^index$/, "") || bare;
}

function sourceScope(extension: { sourceInfo?: { scope?: unknown } }): ExtensionSummary["scope"] {
  const scope = extension.sourceInfo?.scope;
  return scope === "user" || scope === "project" || scope === "temporary" ? scope : "unknown";
}

export function readResources(session: AgentSession): ResourceReport {
  const loader = session.resourceLoader;
  const { extensions, errors, warnings } = loader.getExtensions();
  const skills = loader.getSkills();
  const prompts = loader.getPrompts();
  const themes = loader.getThemes();

  const failedByPath = new Map(errors.map(entry => [entry.path, entry.error]));

  return {
    extensions: extensions.map(extension => ({
      path: extension.path,
      name: extensionName(extension.path),
      builtin: extension.path.startsWith("builtin:"),
      scope: sourceScope(extension),
      source: String(extension.sourceInfo?.source ?? extension.path),
      hidden: Boolean(extension.hidden),
      tools: [...extension.tools.keys()],
      commands: [...extension.commands.keys()],
      handlerCount: [...extension.handlers.values()].reduce((sum, handlers) => sum + handlers.length, 0),
      error: failedByPath.get(extension.path),
    })),
    errors,
    warnings: warnings ?? [],
    skills: skills.skills.map(skill => ({ name: skill.name, description: skill.description, path: skill.filePath })),
    prompts: prompts.prompts.map(prompt => ({ name: prompt.name, description: prompt.description, path: prompt.filePath })),
    themes: themes.themes.map(theme => String((theme as { name?: unknown }).name ?? "unnamed")),
    instructionsFiles: loader.getAgentsFiles().agentsFiles.map(file => file.path),
    systemPromptFile: loader.getSystemPromptSource()?.path,
    diagnostics: [...skills.diagnostics, ...prompts.diagnostics, ...themes.diagnostics].map(diagnostic => ({
      severity: diagnostic.type,
      message: diagnostic.message,
      path: diagnostic.path,
    })),
    configuredExtensions: session.settingsManager.getExtensionPaths(),
  };
}
