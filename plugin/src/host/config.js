/** AeroAgent 插件配置解析：只接受已知字段，并提供可跑的默认值。 */
export const DEFAULTS = Object.freeze({
  backendUrl: "http://127.0.0.1:8000",
  requestTimeoutMs: 10000,
  identityMode: "demo",
  demoUserId: "u_zhang",
  accessToken: "",
  enableAdminTools: false,
  allowedProfiles: ["web"],
});

export function resolveConfig(input = {}) {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") config[key] = input[key];
  }
  if (!/^https?:\/\//.test(String(config.backendUrl))) {
    throw new Error("AeroAgent backendUrl 必须是 http(s) 地址");
  }
  config.backendUrl = String(config.backendUrl).replace(/\/+$/, "");
  config.requestTimeoutMs = Math.max(1000, Math.min(60000, Number(config.requestTimeoutMs) || 10000));
  if (!["demo", "token"].includes(config.identityMode)) {
    throw new Error("AeroAgent identityMode 只能是 demo 或 token");
  }
  if (!Array.isArray(config.allowedProfiles) || config.allowedProfiles.length === 0) {
    throw new Error("AeroAgent allowedProfiles 必须是非空数组");
  }
  return Object.freeze(config);
}
