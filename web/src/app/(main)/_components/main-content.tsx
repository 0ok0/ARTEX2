"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import { usePathname, useRouter } from "next/navigation";

import { X } from "lucide-react";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useCurrentUser } from "@/hooks/use-current-user";
import { api } from "@/lib/api";
import { tasksTabStore, useTasksTab } from "@/lib/tasks-tab";
import { cn } from "@/lib/utils";

import { AccountSwitcher } from "./sidebar/account-switcher";
import { LayoutControls, PreferencesPanel } from "./sidebar/layout-controls";
import { SearchDialog } from "./sidebar/search-dialog";
import { ThemeSwitcher } from "./sidebar/theme-switcher";
import { UpdateBadge } from "./update-badge";

// 任务详情页保持原样：它自带头部/Tabs 与内边距，这里不再叠加全局头部和 padding。
function isFullBleed(pathname: string) {
  const p = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  // 静态导出开了 trailingSlash，列表页自身的 pathname 是 "/function/tasks/"，
  // 先去掉尾斜杠再判前缀，否则列表页会被误判成详情页而丢掉全局头部。
  const normalized = p.replace(/\/+$/, "");
  return normalized.startsWith("/function/tasks/");
}
// 功能页多标签：标题注册表（与 sidebar-items.ts 导航项一致）。
// 全部侧边栏一级菜单（功能组 + 系统组 + 仪表盘/对话）都走标签页。
// 详情页（/function/tasks/<id>、/system/agents/detail）不走标签，保持原行为。
const ALL_TITLES: Record<string, string> = {
  "/dashboard": "仪表盘",
  "/chat": "对话",
  "/function/tasks": "任务",
  "/function/findings": "发现",
  "/function/traffic": "流量",
  "/function/commands": "工具执行",
  "/function/llm-records": "LLM 录制",
  "/function/assets": "资产",
  "/function/sync": "资产同步",
  "/function/workspace": "工作空间",
  "/system/llm": "LLM",
  "/system/agents": "Agent",
  "/system/mcp": "MCP",
  "/system/skills": "Skill",
  "/system/tools": "工具",
  "/system/notify": "通知推送",
  "/system/intercept": "拦截规则",
  "/system/intercept/assets": "资产拦截",
  "/system/intercept/approvals": "审批记录",
  "/system/logs": "日志",
  "/system/settings": "系统配置",
};

function normalizePath(pathname: string) {
  const p = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  return p.replace(/\/+$/, "");
}

export function MainContent({ children }: { children: ReactNode }) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const tasksTab = useTasksTab();
  const pathname = normalizePath(usePathname() || "");
  const [version, setVersion] = useState("");

  // 功能页 keep-alive：路由 → 该页最近一次渲染的 children。
  // children 元素类型不变、渲染位置稳定，React 复用同一实例，页面内部
  // state（筛选、选中、编辑中的报文）因此跨标签切换保留。
  const cache = useRef(new Map<string, ReactNode>());
  const [closed, setClosed] = useState<string[]>([]);
  const [, forceRender] = useState(0);

  const isTabbedPage = !!ALL_TITLES[pathname];
  if (isTabbedPage) {
    cache.current.set(pathname, children);
  }
  const openTabs = [...cache.current.keys()].filter((k) => ALL_TITLES[k] && !closed.includes(k));
  const activeFn = isTabbedPage ? pathname : null;

  function closeTab(key: string) {
    setClosed((prev) => (prev.includes(key) ? prev : [...prev, key]));
    cache.current.delete(key);
    forceRender((n) => n + 1);
    if (pathname === key) {
      const remaining = [...cache.current.keys()].filter((x) => ALL_TITLES[x] && !closed.includes(x) && x !== key);
      router.push(remaining.length ? remaining[remaining.length - 1] : "/function/traffic");
    }
  }

  useEffect(() => {
    api
      .health()
      .then((h) => setVersion((h.version ?? "").replace(/^v(?=\d)/, "")))
      .catch(() => setVersion(""));
  }, []);

  if (isFullBleed(pathname)) {
    // 任务详情等满幅页：不叠全局头部，但功能页 keep-alive 层保持挂载（隐藏）。
    return (
      <>
        {openTabs.map((k) => (
          <div key={k} style={{ display: "none" }}>
            {cache.current.get(k)}
          </div>
        ))}
        {children}
      </>
    );
  }

  return (
    <>
      <header
        className={cn(
          "flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12",
          "[html[data-navbar-style=sticky]_&]:sticky [html[data-navbar-style=sticky]_&]:top-0 [html[data-navbar-style=sticky]_&]:z-50 [html[data-navbar-style=sticky]_&]:overflow-hidden [html[data-navbar-style=sticky]_&]:rounded-t-[inherit] [html[data-navbar-style=sticky]_&]:bg-background/50 [html[data-navbar-style=sticky]_&]:backdrop-blur-md",
        )}
      >
        <div className="flex w-full items-center justify-between px-4 lg:px-6">
          <div className="flex items-center gap-1 lg:gap-2">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
            />
            {pathname === "/function/tasks" ? (
              <div className="flex overflow-hidden rounded-md border text-xs">
                {[
                  { v: "current", t: "当前任务" },
                  { v: "archived", t: "已归档" },
                ].map(({ v, t }) => (
                  <button
                    key={v}
                    className={cn(
                      "px-2.5 py-1",
                      tasksTab === v
                        ? "bg-primary/15 font-medium text-primary"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                    onClick={() => tasksTabStore.set(v)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            ) : null}
            {openTabs.length > 0 ? (
              <div className="ml-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {openTabs.map((k) => (
                  <div
                    key={k}
                    className={cn(
                      "group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs",
                      k === pathname
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    onClick={() => router.push(k)}
                  >
                    <span>{ALL_TITLES[k]}</span>
                    <button
                      aria-label={`关闭 ${ALL_TITLES[k]}`}
                      className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(k);
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <SearchDialog />
          </div>
          <div className="flex items-center gap-2">
            {version && (
              <span className="font-medium text-muted-foreground text-xs tabular-nums">版本 · {version}</span>
            )}
            <UpdateBadge />
            <ThemeSwitcher />
            <AccountSwitcher users={[currentUser]} />
          </div>
        </div>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden">
        {/* 非 function 活动页：直接渲染 children（切换即替换）；功能页走 keep-alive 标签 */}
        <div
          style={{ display: isTabbedPage ? "none" : undefined }}
          className="p-4 has-data-[content-padding=false]:p-0 md:p-6 md:has-data-[content-padding=false]:p-0"
        >
          {children}
        </div>
        {openTabs.map((k) => (
          <div
            key={k}
            style={{ display: k === pathname ? "block" : "none" }}
            className="min-h-0 p-4 has-data-[content-padding=false]:p-0 md:p-6 md:has-data-[content-padding=false]:p-0"
          >
            {cache.current.get(k)}
          </div>
        ))}
      </div>
    </>
  );
}
