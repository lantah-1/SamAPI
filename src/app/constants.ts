import {
  Activity,
  Braces,
  KeyRound,
  Map,
  Route,
  Server,
  Settings,
  ShieldCheck,
  Upload
} from "lucide-react";
import type {
  AppThemeId,
  EndpointKind,
  GroupRouteStrategy,
  RouteProxyConfig,
  RouteType,
  SiteAddress,
  SiteType,
  TemporaryAccountAvailability,
  TemporaryAccountImportSource,
  TemporaryAccountProviderType
} from "../../shared/types";
import type { HeaderKeyValue, Section } from "./types";

export const blankAddress: SiteAddress = {
  id: "",
  label: "主地址",
  baseUrl: "",
  enabled: true,
  models: []
};

export const blankHeaderRow: HeaderKeyValue = {
  key: "",
  value: ""
};

export const endpointLabels: Record<EndpointKind, string> = {
  messages: "message",
  "chat/completions": "chat/complete",
  responses: "response"
};

export const siteTypeLabels: Record<SiteType, string> = {
  newapi: "NewApi",
  unknown: "未知"
};

export const routeTypeLabels: Record<RouteType, string> = {
  switch: "切换型",
  group: "分组型"
};

export const groupStrategyLabels: Record<GroupRouteStrategy, string> = {
  "stable-first": "稳定优先",
  sequential: "顺序执行",
  random: "随机调用",
  priority: "优先级顺序"
};

export const routeProxyModeLabels: Record<RouteProxyConfig["mode"], string> = {
  direct: "直连",
  system: "系统代理",
  custom: "自定义代理"
};

export const temporaryAccountSourceLabels: Record<TemporaryAccountImportSource, string> = {
  cpa: "CPA",
  subapi: "Sub2API"
};

export const temporaryAccountProviderLabels: Record<TemporaryAccountProviderType, string> = {
  gpt: "GPT",
  grok: "Grok",
  claude: "Claude",
  gemini: "Gemini"
};

export const temporaryAccountAvailabilityLabels: Record<TemporaryAccountAvailability, string> = {
  available: "可用",
  unavailable: "不可用",
  unknown: "未检查"
};

export const themeOptions = [
  {
    id: "fresh",
    name: "清泉",
    description: "冷白底色配青绿色状态，清爽、安静、适合默认使用。",
    swatches: ["#f6f8fb", "#0f766e", "#99f6e4"]
  },
  {
    id: "salt",
    name: "海盐蓝",
    description: "蓝灰与海水蓝，界面更冷静，长时间查看日志也舒服。",
    swatches: ["#f5f9ff", "#2563eb", "#67e8f9"]
  },
  {
    id: "citrus",
    name: "青柚绿",
    description: "偏自然的绿色和浅柠色，轻快但不刺眼。",
    swatches: ["#f7faf3", "#3f7d20", "#d9f99d"]
  },
  {
    id: "rose",
    name: "雾玫瑰",
    description: "冷灰底上加一点玫瑰红，柔和、干净、有识别度。",
    swatches: ["#fbf7f9", "#be185d", "#fbcfe8"]
  },
  {
    id: "midnight",
    name: "深海夜",
    description: "深色模式，适合夜间调试和低光环境。",
    swatches: ["#0b1220", "#22d3ee", "#134e4a"]
  }
] satisfies Array<{ id: AppThemeId; name: string; description: string; swatches: string[] }>;

export const navItems = [
  { id: "routes", label: "模型路由", icon: Route },
  { id: "sites", label: "上游站点", icon: Server },
  { id: "providerKeys", label: "上游密钥", icon: KeyRound },
  { id: "temporaryAccounts", label: "临时账号", icon: Upload },
  { id: "keys", label: "客户端密钥", icon: ShieldCheck },
  { id: "headers", label: "请求头模板", icon: Braces },
  { id: "logs", label: "请求日志", icon: Activity },
  { id: "docs", label: "接入指南", icon: Map }
] satisfies Array<{ id: Section; label: string; icon: typeof Route }>;

export const settingsNavItem = { id: "settings", label: "系统设置", icon: Settings } satisfies { id: Section; label: string; icon: typeof Route };
export const allNavItems = [...navItems, settingsNavItem];
export const LOGS_PAGE_SIZE = 3;
