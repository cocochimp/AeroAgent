/** Host 半装配：配置、网关、工具、提示与同源路由。 */
import { resolveConfig } from "./config.js";
import { AeroAgentGateway } from "./gateway.js";
import { registerPrompt } from "./prompt.js";
import { registerRoutes } from "./routes.js";
import { registerTools } from "./tools.js";

export function applyHost(ctx, config) {
  const resolved = resolveConfig(config || {});
  // DSH 插件按 profile 安装；AeroAgent 只在允许的 profile 启用，避免污染 Desktop。
  const profile = process.env.DSH_PROFILE;
  const enabled = !profile || resolved.allowedProfiles.includes(profile);
  ctx.inject(["webServer"], (scope) => {
    if (!scope.webServer) return;
    scope.effect(() => scope.webServer.tapIndex((html) => html.replace("</head>",
      `<script>window.__AEROAGENT_ENABLED__=${enabled}</script></head>`)), "aeroagent: profile flag");
  });
  if (!enabled) {
    return { skipped: true, profile };
  }
  const gateway = new AeroAgentGateway(resolved);
  ctx.effect(() => registerTools(ctx, gateway, resolved), "aeroagent: tools");
  ctx.inject(["systemPrompt"], (scope) => {
    scope.effect(() => registerPrompt(scope, resolved), "aeroagent: prompt");
  });
  ctx.inject(["connection"], (scope) => {
    scope.effect(() => registerRoutes(scope, gateway), "aeroagent: routes");
  });
  return { gateway, config: resolved };
}
