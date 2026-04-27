import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Index from "./pages/Index";
import Chart from "./pages/Chart";
import IctAnalysis from "./pages/IctAnalysis";
import BotView from "./pages/BotView";
import Journal from "./pages/Journal";
import Backtest from "./pages/Backtest";
import SettingsPage from "./pages/Settings";
import BrokersPage from "./pages/Brokers";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import ResetPassword from "./pages/ResetPassword";
import NotFound from "./pages/NotFound";
import TradeReplay from "./pages/TradeReplay";
import Fundamentals from "./pages/Fundamentals";
import GamePlan from "./pages/GamePlan";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <ErrorBoundary>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/signup" element={<Signup />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/" element={<ProtectedRoute><Index /></ProtectedRoute>} />
                <Route path="/chart" element={<ProtectedRoute><Chart /></ProtectedRoute>} />
                <Route path="/ict-analysis" element={<ProtectedRoute><IctAnalysis /></ProtectedRoute>} />
                <Route path="/fundamentals" element={<ProtectedRoute><Fundamentals /></ProtectedRoute>} />
                <Route path="/game-plan" element={<ProtectedRoute><GamePlan /></ProtectedRoute>} />
                <Route path="/bot" element={<ProtectedRoute><ErrorBoundary><BotView /></ErrorBoundary></ProtectedRoute>} />
                <Route path="/journal" element={<ProtectedRoute><Journal /></ProtectedRoute>} />
                <Route path="/backtest" element={<ProtectedRoute><ErrorBoundary><Backtest /></ErrorBoundary></ProtectedRoute>} />
                <Route path="/brokers" element={<ProtectedRoute><BrokersPage /></ProtectedRoute>} />
                <Route path="/trade-replay" element={<ProtectedRoute><ErrorBoundary><TradeReplay /></ErrorBoundary></ProtectedRoute>} />
                <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </ErrorBoundary>
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
