import { type PluginContext } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics } from "./configSchematics";
import { toolsProvider } from "./toolsProvider";

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withGlobalConfigSchematics(globalConfigSchematics);
  context.withToolsProvider(toolsProvider);
}
