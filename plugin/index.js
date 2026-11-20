/** AeroAgent DSH 插件 Host 入口。 */
import { applyHost } from "./src/host/index.js";

export const name = "dsh-plugin-aeroagent";
export const inject = ["tools"];

export function apply(ctx, config) {
  return applyHost(ctx, config);
}
