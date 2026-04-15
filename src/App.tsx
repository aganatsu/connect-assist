import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import Chart from "./pages/Chart.tsx";
import IctAnalysis from "./pages/IctAnalysis.tsx";
import BotView from "./pages/BotView.tsx";
import Journal from "./pages/Journal.tsx";
import Backtest from "./pages/Backtest.tsx";
import SettingsPage from "./pages/Settings.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/chart" element={<Chart />} />
          <Route path="/ict-analysis" element={<IctAnalysis />} />
          <Route path="/bot" element={<BotView />} />
          <Route path="/journal" element={<Journal />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
