import type { Metadata } from "next";
import "./globals.css";
import MediaPipeGuard from "./components/MediaPipeGuard";
import { MonitoringProvider } from "./context/MonitoringContext";
import { GlobalAlarmModal } from "./components/GlobalAlarmModal";
import PortalGatekeeper from "./components/PortalGatekeeper";

export const metadata: Metadata = {
  title: "CognitAI - Autonomous Driver Attentiveness & Bio-Telemetry Console",
  description:
    "Real-time driver fatigue detection, rPPG cardiovascular telemetry, spatial gaze monitoring, and anti-spoof protection.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="bg-slate-50">
      <body className="min-h-screen bg-slate-50 text-[#202122] antialiased selection:bg-[#0066cc] selection:text-white">
        <MonitoringProvider>
          <GlobalAlarmModal />
          <MediaPipeGuard />
          <PortalGatekeeper>
            {children}
          </PortalGatekeeper>
        </MonitoringProvider>
      </body>
    </html>
  );
}
