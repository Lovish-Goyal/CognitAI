"use client";

import React from "react";

export default function CustomLightLoader({
  message = "Initializing Security Gateway...",
}: {
  message?: string;
}) {
  return (
    <div className="min-h-screen w-full bg-slate-50 flex flex-col items-center justify-center p-6 relative overflow-hidden select-none">
      <div className="relative z-10 flex flex-col items-center max-w-sm w-full bg-white rounded-xl border border-slate-200 shadow-sm p-7 text-center space-y-4 animate-in fade-in zoom-in-95 duration-200">
        {/* Animated Brand Pulse Mark */}
        <div className="relative w-12 h-12">
          <div className="relative w-12 h-12 rounded-lg bg-[#0066cc] text-white flex items-center justify-center font-bold text-2xl shadow-sm">
            C
          </div>
        </div>

        {/* Brand Titles */}
        <div className="space-y-1">
          <h2 className="text-lg font-bold text-slate-900 tracking-tight">CognitAI Safety Portal</h2>
          <p className="text-xs text-slate-500 font-medium">Autonomous Bio-Telemetry &amp; Vigilance Suite</p>
        </div>

        {/* Light Theme Shimmer Progress Bar */}
        <div className="w-full max-w-[180px] h-1.5 bg-slate-100 rounded-full overflow-hidden relative mx-auto">
          <div className="h-full bg-[#0066cc] rounded-full w-2/3 animate-[pulse_1.2s_ease-in-out_infinite]" />
        </div>

        {/* Status Pill */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-blue-50 text-[#0066cc] text-xs font-semibold border border-blue-100">
          <span className="w-2 h-2 rounded-full bg-[#0066cc] animate-ping" />
          <span>{message}</span>
        </div>

        <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-400 font-medium">
          Zero-Password Biometric Verification
        </div>
      </div>
    </div>
  );
}
