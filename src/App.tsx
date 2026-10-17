import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Routes, Route } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import RouteFallback from "@/components/RouteFallback";

// Lazy load all pages
const Dashboard = lazy(() => import("./pages/Dashboard"));
const ProjectWorkspace = lazy(() => import("./pages/ProjectWorkspace"));
const ProjectSettings = lazy(() => import("./pages/ProjectSettings"));
const Settings = lazy(() => import("./pages/Settings"));
const AuditPage = lazy(() => import("./pages/Audit"));
const MyAgents = lazy(() => import("./pages/MyAgents"));
const MyPipelines = lazy(() => import("./pages/MyPipelines"));
const PipelineEditor = lazy(() => import("./pages/PipelineEditor"));
const MarketplaceBrowse = lazy(() => import("./pages/MarketplaceBrowse"));
const MarketplaceDetail = lazy(() => import("./pages/MarketplaceDetail"));
const CreatorDashboard = lazy(() => import("./pages/CreatorDashboard"));
const MyData = lazy(() => import("./pages/MyData"));
const JudgingPrompts = lazy(() => import("./pages/JudgingPrompts"));
const NotFound = lazy(() => import("./pages/NotFound"));
const AdminPanel = lazy(() => import("./pages/AdminPanel"));
const TestFixtures = lazy(() => import("./pages/TestFixtures"));
const Connect = lazy(() => import("./pages/Connect"));
const OAuthConsent = lazy(() => import("./pages/OAuthConsent"));
const CertificationReport = lazy(() => import("./pages/CertificationReport"));
const PublicEvidence = lazy(() => import("./pages/PublicEvidence"));
const Pricing = lazy(() => import("./pages/Pricing"));
const LinkDevice = lazy(() => import("./pages/LinkDevice"));

// ─── Hosted strip-down (V3 L4) ─────────────────────────────────────
// When the server reports marketplaceOnly, this web app is the hosted
// marketplace: browse, evidence, account linking and listing management
// only. Creation/execution pages are replaced by a pointer to the local
// install.
function LocalOnlyNotice() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-neutral-950 p-6">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-xl font-semibold text-neutral-100">DeeWaanAI runs on your computer now</h1>
        <p className="text-sm text-neutral-400">
          This website is the marketplace — it stores listings and their evidence, nothing else.
          Creating and running pipelines happens in your own local install, with your own provider
          keys:
        </p>
        <code className="block bg-neutral-900 border border-neutral-800 rounded px-4 py-2 text-blue-400">
          npx deewaanai
        </code>
        <p className="text-xs text-neutral-500">
          Then open the printed local address, link it to this account (Settings → Marketplace
          account), and publish back here.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [marketplaceOnly, setMarketplaceOnly] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/public-config")
      .then((r) => r.json())
      .then((cfg) => setMarketplaceOnly(Boolean(cfg.marketplaceOnly)))
      .catch(() => setMarketplaceOnly(false));
  }, []);

  // While the config loads, render normally — the flag is a hosted-deploy
  // concern; local installs always answer false instantly.
  const gate = (node: ReactNode): ReactNode =>
    marketplaceOnly ? <LocalOnlyNotice /> : node;

  return (
    <>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents" element={gate(<MyAgents />)} />
          <Route path="/pipelines" element={gate(<MyPipelines />)} />
          <Route path="/pipelines/new" element={gate(<PipelineEditor />)} />
          <Route path="/pipelines/:id/edit" element={gate(<PipelineEditor />)} />
          <Route path="/projects/:id" element={gate(<ProjectWorkspace />)} />
          <Route path="/projects/:id/settings" element={gate(<ProjectSettings />)} />
          <Route path="/projects/:id/audit" element={gate(<AuditPage />)} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/marketplace" element={<MarketplaceBrowse />} />
          <Route path="/marketplace/:id" element={<MarketplaceDetail />} />
          <Route path="/creator/listings" element={<CreatorDashboard />} />
          <Route path="/my-data" element={<MyData />} />
          <Route path="/judging" element={gate(<JudgingPrompts />)} />
          <Route path="/test-fixtures" element={gate(<TestFixtures />)} />
          <Route path="/admin" element={<AdminPanel />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="/link" element={<LinkDevice />} />
          <Route path="/oauth/consent" element={<OAuthConsent />} />
          <Route path="/certification/:id" element={<CertificationReport />} />
          <Route path="/evidence/:manifestHash" element={<PublicEvidence />} />
          <Route path="/pricing" element={<Pricing />} />
          {/* /login renders Dashboard, which shows the auth form when unauthenticated (OAuth return path via ?next=) */}
          <Route path="/login" element={<Dashboard />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      <Toaster />
    </>
  );
}
