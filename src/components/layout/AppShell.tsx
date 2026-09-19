import { Link, useLocation } from "react-router";
import { useAuth } from "@/hooks/useAuth";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { TierBadge } from "@/components/TierBadge";
import {
  LayoutDashboard,
  Settings,
  ChevronLeft,
  ChevronRight,
  Hexagon,
  Plus,
  Bug,
  User,
  LogOut,
  Bot,
  Workflow,
  Store,
  ClipboardCheck,
  Database,
  Users,
  Plug,
  Shield,
} from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { trpc } from "@/providers/trpc";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("common");
  const { user, logout } = useAuth();
  const { sidebarOpen, setSidebarOpen } = useWorkspaceStore();
  const location = useLocation();

  const { data: projects } = trpc.project.list.useQuery();

  const projectMatch = location.pathname.match(/\/projects\/(\d+)/);
  const currentProjectId = projectMatch ? projectMatch[1] : null;

  const navSections = [
    {
      label: t("nav.groups.studio", "Studio"),
      items: [
        { path: "/", icon: LayoutDashboard, label: t("nav.dashboard") },
        { path: "/pipelines", icon: Workflow, label: t("nav.myPipelines", "My Pipelines") },
        { path: "/agents", icon: Bot, label: t("nav.myAgents") },
      ],
    },
    {
      label: t("nav.groups.market", "Market"),
      items: [
        { path: "/marketplace", icon: Store, label: t("nav.marketplace", "Marketplace") },
        { path: "/reviewer/portal", icon: ClipboardCheck, label: t("nav.review", "Review") },
      ],
    },
    {
      label: t("nav.groups.teams", "Teams"),
      items: [
        { path: "/team", icon: Users, label: t("nav.teamDashboard", "Team Dashboard") },
        { path: "/team/connect", icon: Plug, label: t("nav.teamConnect", "Team Connect") },
      ],
    },
    {
      label: t("nav.groups.account", "Account"),
      items: [
        { path: "/my-data", icon: Database, label: t("nav.myData", "My Data") },
        { path: "/settings", icon: Settings, label: t("nav.settings") },
        ...(user?.role === "admin"
          ? [{ path: "/admin", icon: Shield, label: t("nav.admin", "Admin") }]
          : []),
      ],
    },
  ];

  const auditItem = currentProjectId
    ? { path: `/projects/${currentProjectId}/audit`, icon: Bug, label: t("nav.audit") }
    : null;

  const renderNavItem = (item: { path: string; icon: typeof LayoutDashboard; label: string }) => {
    const isActive = location.pathname === item.path;
    return (
      <Link
        key={item.path}
        to={item.path}
        className={`flex items-center gap-3 px-2 py-2 rounded-md text-sm transition-colors ${
          isActive
            ? "bg-blue-500/10 text-blue-400"
            : "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
        }`}
      >
        <item.icon className="w-4 h-4 flex-shrink-0" />
        {sidebarOpen && <span>{item.label}</span>}
      </Link>
    );
  };

  return (
    <div className="flex h-screen w-screen bg-neutral-950 text-neutral-100 overflow-hidden">
      <aside
        className={`flex flex-col border-r border-neutral-800 bg-neutral-900 transition-all duration-300 ${
          sidebarOpen ? "w-64" : "w-14"
        }`}
      >
        {/* Header */}
        <div className="flex items-center h-14 px-3 border-b border-neutral-800">
          <Hexagon className="w-6 h-6 text-blue-500 flex-shrink-0" />
          {sidebarOpen && (
            <span className="ml-2 font-semibold text-sm truncate">{t("appName")}</span>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-3 px-2 space-y-1 overflow-y-auto">
          {navSections.map((section) => (
            <div key={section.label} className="mb-3">
              {sidebarOpen && (
                <div className="px-2 mb-1">
                  <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                    {section.label}
                  </span>
                </div>
              )}
              <div className="space-y-1">{section.items.map(renderNavItem)}</div>
            </div>
          ))}

          {/* Contextual Audit link (current project only) */}
          {auditItem && renderNavItem(auditItem)}

          {/* Projects list */}
          {sidebarOpen && projects && projects.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center justify-between px-2 mb-2">
                <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  {t("nav.projects")}
                </span>
                <Link
                  to="/?new=true"
                  className="text-neutral-500 hover:text-blue-400 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                </Link>
              </div>
              <div className="space-y-0.5">
                {projects.map((project) => {
                  const isActive = location.pathname.startsWith(`/projects/${project.id}`);
                  return (
                    <Link
                      key={project.id}
                      to={`/projects/${project.id}`}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm truncate transition-colors ${
                        isActive
                          ? "bg-blue-500/10 text-blue-400"
                          : "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
                      }`}
                    >
                      <div className="w-2 h-2 rounded-full bg-neutral-600 flex-shrink-0" />
                      <span className="truncate">{project.name}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </nav>

        {/* Footer */}
        <div className="border-t border-neutral-800 p-2 space-y-1">
          <LanguageSwitcher />
          {user && sidebarOpen && (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <div className="w-5 h-5 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400">
                <User className="w-3 h-3" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="truncate text-neutral-300 text-xs">{user.name ?? t("nav.userFallback", "User")}</p>
              </div>
              <TierBadge size="sm" />
            </div>
          )}
          {user && !sidebarOpen && (
            <div className="flex justify-center py-1">
              <TierBadge size="sm" />
            </div>
          )}
          {user && (
            <button
              onClick={logout}
              className="flex items-center gap-3 px-2 py-2 w-full text-sm text-neutral-400 hover:text-red-400 hover:bg-neutral-800 rounded-md transition-colors"
            >
              <LogOut className="w-4 h-4" />
              {sidebarOpen && <span>{t("nav.logout")}</span>}
            </button>
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex items-center gap-3 px-2 py-2 w-full text-sm text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 rounded-md transition-colors"
          >
            {sidebarOpen ? (
              <>
                <ChevronLeft className="w-4 h-4" />
                <span>{t("nav.collapse")}</span>
              </>
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
