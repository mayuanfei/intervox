import React, { useState } from "react";
import {
  Video,
  Languages,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  AudioLines,
  Terminal,
} from "lucide-react";
import { useIntervox } from "../hooks/useIntervox";
import { useI18n } from "../i18n";
import logoImg from "../logo.png";

export function Sidebar() {
  const { activePage, setActivePage } = useIntervox();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  const menuItems = [
    { id: "player", label: t("Player"), icon: Video },
    { id: "translate", label: t("Translate"), icon: Languages },
    { id: "tasks", label: t("Tasks"), icon: Terminal },
  ];

  return (
    <aside
      className={`h-screen flex flex-col border-r th-border th-bg-card transition-all duration-300 select-none ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      {collapsed ? (
        <div className="px-1 py-4 flex items-center justify-between border-b th-border min-h-[65px]">
          <img src={logoImg} className="w-8 h-8 object-contain" alt="Intervox" />
          <button
            onClick={() => setCollapsed(false)}
            className="p-1 rounded-md border th-border bg-[#0a101f]/80 text-cyan-400 hover:text-cyan-300 hover:border-cyan-500/50 hover:bg-cyan-950/20 transition-all flex items-center justify-center cursor-pointer shadow-sm shadow-cyan-500/5"
            title={t("Show playback history")}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="p-4 flex items-center justify-between border-b th-border min-h-[65px]">
          <div className="flex items-center gap-2.5">
            <img src={logoImg} className="w-8 h-8 object-contain" alt="Intervox" />
            <span className="font-extrabold text-lg tracking-wider text-glow text-cyan-400 select-none">
              INTERVOX
            </span>
          </div>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded-md border th-border bg-[#0a101f]/80 text-cyan-400 hover:text-cyan-300 hover:border-cyan-500/50 hover:bg-cyan-950/20 transition-all flex items-center justify-center cursor-pointer shadow-sm shadow-cyan-500/5"
            title={t("Hide playback history")}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      )}

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
          title={collapsed ? t("Settings") : undefined}
        >
          <SettingsIcon className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span>{t("Settings")}</span>}
        </button>
      </div>
    </aside>
  );
}

