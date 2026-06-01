import React, { useState } from "react";
import {
  Video,
  Languages,
  Activity,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useIntervox } from "../hooks/useIntervox";

export function Sidebar() {
  const { activePage, setActivePage } = useIntervox();
  const [collapsed, setCollapsed] = useState(false);

  const menuItems = [
    { id: "player", label: "播放器 Player", icon: Video },
    { id: "translate", label: "翻译配置 Translate", icon: Languages },
    { id: "tasks", label: "任务状态 Tasks", icon: Activity },
  ];

  return (
    <aside
      className={`h-screen flex flex-col border-r th-border th-bg-card transition-all duration-300 select-none ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      {/* Header Info */}
      <div className="p-5 flex items-center justify-between border-b th-border">
        {!collapsed && (
          <div className="flex flex-col">
            <span className="font-extrabold text-xl tracking-wider text-glow text-cyan-400">
              INTERVOX
            </span>
            <span className="text-[10px] th-text-muted font-mono tracking-widest mt-0.5">
              V.2.0.4-BETA
            </span>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1 rounded th-hover-surface th-text-muted hover:th-text"
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* Nav List */}
      <nav className="flex-1 py-6 px-3 space-y-1.5">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activePage === item.id;

          return (
            <button
              key={item.id}
              onClick={() => setActivePage(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md font-medium font-mono text-[13px] transition-all border ${
                isActive
                  ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30 shadow-sm text-glow"
                  : "border-transparent th-text-3 th-hover-surface"
              } ${collapsed ? "justify-center" : ""}`}
              title={collapsed ? item.label : undefined}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Footer "Settings" Button */}
      <div className="p-4 border-t th-border">
        <button
          onClick={() => setActivePage("settings")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md font-medium font-mono text-[13px] transition-all border ${
            activePage === "settings"
              ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30 shadow-sm text-glow"
              : "border-transparent th-text-3 th-hover-surface"
          } ${collapsed ? "justify-center" : ""}`}
          title={collapsed ? "参数设置 Settings" : undefined}
        >
          <SettingsIcon className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span>参数设置 Settings</span>}
        </button>
      </div>
    </aside>
  );
}
