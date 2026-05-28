import React, { useState } from "react";
import {
  Video,
  Languages,
  Activity,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  Plus,
} from "lucide-react";
import { useIntervox } from "../hooks/useIntervox";

export function Sidebar() {
  const { activePage, setActivePage, startFullPipeline, activeMediaInput } = useIntervox();
  const [collapsed, setCollapsed] = useState(false);

  const menuItems = [
    { id: "player", label: "播放器 Player", icon: Video },
    { id: "translate", label: "翻译配置 Translate", icon: Languages },
    { id: "tasks", label: "任务状态 Tasks", icon: Activity },
    { id: "settings", label: "参数设置 Settings", icon: SettingsIcon },
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

      {/* Footer "New Project" Button */}
      <div className="p-4 border-t th-border">
        {collapsed ? (
          <button
            onClick={startFullPipeline}
            disabled={!activeMediaInput}
            className={`w-8 h-8 rounded-full flex items-center justify-center border border-cyan-500 text-cyan-400 hover:bg-cyan-500 hover:text-black transition-all ${
              !activeMediaInput ? "opacity-30 cursor-not-allowed" : ""
            }`}
            title="开始完整翻译 Dubbing Pipeline"
          >
            <Plus className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={startFullPipeline}
            disabled={!activeMediaInput}
            className={`w-full flex items-center justify-center gap-2 py-2 px-4 border border-cyan-500 text-cyan-400 text-xs font-mono tracking-widest hover:bg-cyan-500 hover:text-black transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
              activeMediaInput ? "border-glow font-bold animate-pulse" : ""
            }`}
            title={
              activeMediaInput
                ? "一键提交 ASR+翻译+TTS+视频合成"
                : "请先在“播放器”或“翻译配置”页面输入视频源"
            }
          >
            <Plus className="w-3.5 h-3.5" />
            <span>NEW PROJECT</span>
          </button>
        )}
      </div>
    </aside>
  );
}
