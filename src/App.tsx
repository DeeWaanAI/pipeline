import { lazy, Suspense } from "react";
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
const MyData = lazy(() => import("./pages/MyData"));
const JudgingPrompts = lazy(() => import("./pages/JudgingPrompts"));
const NotFound = lazy(() => import("./pages/NotFound"));
const AdminPanel = lazy(() => import("./pages/AdminPanel"));
const TestFixtures = lazy(() => import("./pages/TestFixtures"));
const Connect = lazy(() => import("./pages/Connect"));
const OAuthConsent = lazy(() => import("./pages/OAuthConsent"));
const Pricing = lazy(() => import("./pages/Pricing"));
const LinkDevice = lazy(() => import("./pages/LinkDevice"));

export default function App() {
  return (
    <>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents" element={<MyAgents />} />
          <Route path="/pipelines" element={<MyPipelines />} />
          <Route path="/pipelines/new" element={<PipelineEditor />} />
          <Route path="/pipelines/:id/edit" element={<PipelineEditor />} />
          <Route path="/projects/:id" element={<ProjectWorkspace />} />
          <Route path="/projects/:id/settings" element={<ProjectSettings />} />
          <Route path="/projects/:id/audit" element={<AuditPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/my-data" element={<MyData />} />
          <Route path="/judging" element={<JudgingPrompts />} />
          <Route path="/test-fixtures" element={<TestFixtures />} />
          <Route path="/admin" element={<AdminPanel />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="/link" element={<LinkDevice />} />
          <Route path="/oauth/consent" element={<OAuthConsent />} />
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
