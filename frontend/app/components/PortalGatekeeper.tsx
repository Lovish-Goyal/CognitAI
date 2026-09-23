"use client";

import React, { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useMonitoring } from "../context/MonitoringContext";
import DriverNav from "./DriverNav";
import EntranceGateway from "./EntranceGateway";
import FaceMissingPortalOverlay from "./FaceMissingPortalOverlay";

import CustomLightLoader from "./CustomLightLoader";

export default function PortalGatekeeper({ children }: { children: React.ReactNode }) {
  const { currentDriver, isMonitoring, faceInFrame } = useMonitoring();
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Auto-redirect unauthenticated users to root "/"
  useEffect(() => {
    if (mounted && !currentDriver && pathname !== "/") {
      router.replace("/");
    }
  }, [mounted, currentDriver, pathname, router]);

  // Light theme custom loader during initial mount / hydration
  if (!mounted) {
    return <CustomLightLoader message="Initializing CognitAI Gateway..." />;
  }

  // If driver is not authenticated, render ONLY the full-screen Entrance Gateway!
  // No DriverNav (no top header), no left sidebar, no portal padding, no dashboard access.
  if (!currentDriver) {
    return <EntranceGateway />;
  }

  // When monitoring is active and driver face is not detected in front of camera,
  // disable and blur the background content
  const isBackgroundDisabled = isMonitoring && !faceInFrame;

  // Once authenticated via biometric verification:
  // Render the full portal shell (Top Nav + Sidebar + portal content)
  return (
    <>
      <DriverNav />
      <div
        className={`pb-20 lg:pb-8 lg:pl-72 bg-white min-h-screen transition-all duration-300 ${
          isBackgroundDisabled
            ? "filter blur-[4px] pointer-events-none opacity-25 select-none cursor-not-allowed"
            : ""
        }`}
      >
        {children}
      </div>
      <FaceMissingPortalOverlay />
    </>
  );
}
