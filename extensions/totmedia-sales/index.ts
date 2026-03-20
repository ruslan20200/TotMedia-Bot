import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createSalesRoutingTools } from "./src/tools.js";

const plugin = {
  id: "totmedia-sales",
  name: "Tot Media Sales",
  description: "Sales Lead Forwarding and Escalation tools",
  configSchema: emptyPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const tools = createSalesRoutingTools(api);
    for (const tool of tools) {
      api.registerTool(tool);
    }
  },
};

export default plugin;
