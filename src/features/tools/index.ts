import { registry } from "./registry";
import { echoTool } from "./tools/echo";
import { scheduleLinkTool } from "./tools/schedule-link";
import { scheduleHighLevelTool } from "./tools/schedule-highlevel";
import { checkAvailabilityTool } from "./tools/check-availability";
import { customWebhookTool } from "./tools/custom-webhook";
import { buscarProductoTool } from "./tools/buscar-producto";
import { estadoPedidoTool } from "./tools/estado-pedido";

registry.register(echoTool);
registry.register(scheduleLinkTool);
registry.register(scheduleHighLevelTool);
registry.register(checkAvailabilityTool);
registry.register(customWebhookTool);
registry.register(buscarProductoTool);
registry.register(estadoPedidoTool);

export { registry };
export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSensitivity,
} from "./core/tool";
