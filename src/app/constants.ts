import {
  Activity,
  Boxes,
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
  models: [],
  proxy: { mode: "direct" }
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
  priority: "优先级顺序",
  specified: "指定"
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
  { id: "routes", label: "路由管理", icon: Route },
  { id: "sites", label: "站点管理", icon: Server },
  { id: "providerKeys", label: "密钥管理", icon: KeyRound },
  { id: "models", label: "模型管理", icon: Boxes },
  { id: "temporaryAccounts", label: "临时账号", icon: Upload },
  { id: "keys", label: "客户端密钥", icon: ShieldCheck },
  { id: "headers", label: "请求头模板", icon: Braces },
  { id: "logs", label: "请求日志", icon: Activity },
  { id: "docs", label: "接入指南", icon: Map }
] satisfies Array<{ id: Section; label: string; icon: typeof Route }>;

export const settingsNavItem = { id: "settings", label: "系统设置", icon: Settings } satisfies { id: Section; label: string; icon: typeof Route };
export const allNavItems = [...navItems, settingsNavItem];

export const sectionMeta: Record<Section, { category: string; description: string; addLabel?: string }> = {
  routes: { category: "流量编排", description: "配置模型名称、转发目标与故障切换策略。", addLabel: "新建路由" },
  sites: { category: "上游资源", description: "管理供应商地址、代理方式与可用状态。", addLabel: "添加站点" },
  providerKeys: { category: "上游资源", description: "集中维护供应商凭据与密钥分组。", addLabel: "添加密钥组" },
  models: { category: "上游资源", description: "同步并控制各供应商对外开放的模型。" },
  temporaryAccounts: { category: "账号资源", description: "导入、检查和调度临时模型账号。", addLabel: "导入账号" },
  keys: { category: "访问控制", description: "签发下游客户端使用的访问密钥。", addLabel: "创建密钥" },
  headers: { category: "访问控制", description: "复用转发请求所需的请求头配置。", addLabel: "新建模板" },
  logs: { category: "运行状态", description: "查看请求链路、耗时与失败原因。" },
  docs: { category: "开发接入", description: "复制代理地址、客户端配置与调用示例。" },
  settings: { category: "系统", description: "调整界面、日志保留与安全配置。" }
};

export const mobilePrimarySections: Section[] = ["routes", "sites", "temporaryAccounts", "logs"];
export const LOGS_PAGE_SIZE = 3;
