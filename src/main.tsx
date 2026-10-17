import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import './i18n'
import { TRPCProvider } from "@/providers/trpc"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import App from './App.tsx'

// Local-first installs (V3 spec, L1): the server prints a sign-in URL that
// carries the local token (?auth_token=…). Store it where the app already
// expects it (localStorage "local_auth_token") and strip it from the
// address bar so it doesn't leak into copied links or screenshots.
const handoffToken = new URLSearchParams(window.location.search).get("auth_token");
if (handoffToken) {
  localStorage.setItem("local_auth_token", handoffToken);
  const url = new URL(window.location.href);
  url.searchParams.delete("auth_token");
  window.history.replaceState(null, "", url);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <TRPCProvider>
          <App />
        </TRPCProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
