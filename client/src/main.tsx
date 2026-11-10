import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import "@xyflow/react/dist/style.css";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { URLS } from "./urls";
import "./index.css";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <header className="border-b border-line bg-surface px-6 py-3">
          <Link to={URLS.runs.list()} className="font-bold tracking-[-0.01em] text-ink">
            ratchet
          </Link>
        </header>
        <main className="mx-auto max-w-290 p-6 max-[720px]:p-4">
          <Routes>
            <Route path={URLS.runs.list()} element={<RunsPage />} />
            <Route path={URLS.runs.details({ id: ":id" })} element={<RunPage />} />
          </Routes>
        </main>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
