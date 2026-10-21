"use client";

import React from "react";
import { useMonitoring } from "../context/MonitoringContext";

interface CameraFaceOverlayProps {
  cameraActive: boolean;
  faceDetected: boolean;
  isHeadDown?: boolean;
  isMonitoring?: boolean;
  onStartMonitoring?: () => void;
  onConnectCamera?: () => void;
  title?: string;
  subtitle?: string;
}

export const CameraFaceOverlay: React.FC<CameraFaceOverlayProps> = ({
  cameraActive,
  faceDetected,
  isHeadDown = false,
  isMonitoring: propMonitoring,
  onStartMonitoring,
  onConnectCamera,
  title = "Place Face in Front of the Camera",
  subtitle = "Position yourself directly in front of the lens to activate real-time telemetry",
}) => {
  const monitoring = useMonitoring();
  const isMonitoring = propMonitoring !== undefined ? propMonitoring : monitoring.isMonitoring;

  // State 1: Monitoring Stopped / Standby (or Camera Inactive)
  // Clean placeholder with NO redundant button in the middle (user requested button ONLY on top)
  if (!isMonitoring || !cameraActive) {
    return (
      <div className="absolute inset-0 z-20 bg-slate-950/85 backdrop-blur-[2px] flex flex-col items-center justify-center p-6 text-center text-white space-y-2.5">
        <div className="w-12 h-12 rounded-full bg-slate-800/90 border border-slate-700 flex items-center justify-center text-xl text-slate-300 shadow-md">
          🛡️
        </div>
        <div>
          <h3 className="text-sm font-bold text-slate-200 tracking-wide">Monitoring System Standby</h3>
          <p className="text-xs text-slate-400 mt-1 max-w-xs leading-relaxed">
            Click <span className="text-emerald-400 font-bold font-mono">▶ Start Monitoring</span> in the top navigation bar to activate camera telemetry.
          </p>
        </div>
      </div>
    );
  }

  // State 2: HEAD DOWN / SLUMPED OVER EMERGENCY (Subtle frame highlight; main alert in GlobalAlarmModal)
  if (isHeadDown) {
    return (
      <div className="absolute inset-0 z-20 border-4 border-rose-600/80 bg-rose-950/40 pointer-events-none animate-pulse" />
    );
  }

  // State 3: Camera Active, but NO driver face detected in frame
  // ONLY show "Place Face in Front of the Camera" at START TIME before initial face is calibrated!
  // After start monitoring has calibrated, missing face is an emergency handled by GlobalAlarmModal.
  if (!faceDetected && !monitoring.initialFaceCalibrated) {
    return (
      <div className="absolute inset-0 z-20 bg-slate-950/70 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center text-white pointer-events-none animate-in fade-in duration-200">
        <div className="relative mb-3.5">
          {/* Target Reticle */}
          <div className="w-24 h-28 rounded-3xl border-2 border-dashed border-amber-400/90 flex items-center justify-center bg-amber-500/10 animate-pulse shadow-lg shadow-amber-500/10">
            <span className="text-3xl opacity-80">👤</span>
          </div>
          {/* Corner target ticks */}
          <div className="absolute -top-1 -left-1 w-3 h-3 border-t-2 border-l-2 border-amber-400" />
          <div className="absolute -top-1 -right-1 w-3 h-3 border-t-2 border-r-2 border-amber-400" />
          <div className="absolute -bottom-1 -left-1 w-3 h-3 border-b-2 border-l-2 border-amber-400" />
          <div className="absolute -bottom-1 -right-1 w-3 h-3 border-b-2 border-r-2 border-amber-400" />
        </div>

        <div className="space-y-1 max-w-xs">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 text-[11px] font-semibold uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
            Initial Verification
          </div>
          <h3 className="text-base font-bold text-white tracking-tight">
            {title}
          </h3>
          <p className="text-xs text-gray-300 leading-relaxed">
            {subtitle}
          </p>
        </div>
      </div>
    );
  }

  // State 4: Driver Face active & tracking, or post-start loss handled globally
  return null;
};
