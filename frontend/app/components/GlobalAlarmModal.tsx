"use client";

import React from "react";
import { useMonitoring } from "../context/MonitoringContext";

export const GlobalAlarmModal: React.FC = () => {
  const {
    alarmActive,
    alarmReason,
    alarmTitle,
    alarmDescription,
    autoRecovered,
    elapsedAlarmSeconds,
    stopGlobalAlarm,
  } = useMonitoring();

  // If no alarm is active and no auto-recovery notification, do not render
  if (!alarmActive && !autoRecovered) {
    return null;
  }

  // When face is lost, FaceMissingPortalOverlay handles the dedicated screen guidance
  if (alarmReason === "FACE_LOST") {
    return null;
  }

  // State A: Auto-Recovered / Auto-Silenced Success Popup (Driver rectified posture)
  if (autoRecovered && !alarmActive) {
    return (
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            stopGlobalAlarm(false);
          }
        }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 pointer-events-auto cursor-pointer"
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-md bg-white rounded-xl shadow-xl border border-emerald-300 overflow-hidden text-center p-6 space-y-4 animate-in zoom-in-95 cursor-default"
        >
          <div className="w-12 h-12 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 mx-auto shadow-sm">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold border border-emerald-200 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
              Siren Auto-Silenced
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              Nominal Posture Restored
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed max-w-sm mx-auto">
              Facial alignment and open eyes verified by optical telemetry. Safety alarm has been automatically silenced.
            </p>
          </div>

          <div className="pt-2">
            <button
              type="button"
              onClick={() => stopGlobalAlarm(false)}
              className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition shadow-sm"
            >
              Dismiss Notification
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          stopGlobalAlarm(false);
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm animate-in fade-in duration-150 pointer-events-auto cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md bg-white rounded-xl shadow-2xl border border-rose-300 overflow-hidden text-center p-6 space-y-4 animate-in zoom-in-95 cursor-default"
      >
        {/* Top Emergency Indicator */}
        <div className="w-12 h-12 mx-auto rounded-lg bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center shadow-sm">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>

        {/* Hazard Category Tag */}
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-800 text-[11px] font-semibold uppercase tracking-wider border border-rose-200">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-600 animate-ping" />
            Safety Alert
          </div>

          <h2 className="text-xl font-bold text-slate-900 tracking-tight leading-tight">
            {alarmTitle}
          </h2>

          <p className="text-xs sm:text-sm text-slate-600 leading-relaxed max-w-sm mx-auto">
            {alarmDescription}
          </p>
        </div>

        {/* Live Metrics & Telemetry Pill */}
        <div className="grid grid-cols-2 gap-3 py-2.5 border border-slate-200 bg-slate-50 rounded-lg text-left px-4 text-xs">
          <div>
            <span className="text-[10px] text-slate-500 uppercase font-semibold block">Duration</span>
            <span className="font-mono font-bold text-slate-900 text-base">
              {elapsedAlarmSeconds.toFixed(1)}s
            </span>
          </div>
          <div>
            <span className="text-[10px] text-slate-500 uppercase font-semibold block">Acoustic Signal</span>
            <span className="font-mono font-semibold text-rose-600 text-sm flex items-center gap-1.5 pt-0.5">
              <span className="w-2 h-2 rounded-full bg-rose-600 animate-pulse" />
              1100 Hz Sweep
            </span>
          </div>
        </div>

        {/* Action Controls & Auto-Silence Guidance */}
        <div className="space-y-2.5 pt-1">
          <p className="text-[11px] text-slate-500 text-center">
            Looking up towards the camera will automatically silence this alarm.
          </p>

          <button
            type="button"
            onClick={() => stopGlobalAlarm(false)}
            className="w-full py-2.5 px-4 rounded-lg bg-rose-600 hover:bg-rose-700 active:scale-[0.99] text-white text-xs font-semibold transition shadow-sm"
          >
            Acknowledge &amp; Silence Siren
          </button>
        </div>
      </div>
    </div>
  );
};
