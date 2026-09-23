"use client";

import React, { useEffect, useState, useRef } from "react";
import { useMonitoring } from "../context/MonitoringContext";
import { requestWebcamStream } from "../utils/camera";

export default function FaceMissingPortalOverlay() {
  const { isMonitoring, faceInFrame, alarmActive, alarmReason, stopMonitoring } = useMonitoring();
  const [delayedTrigger, setDelayedTrigger] = useState<boolean>(false);
  const overlayVideoRef = useRef<HTMLVideoElement>(null);

  // Allow a 700ms grace period when face is initially lost before showing modal overlay
  // so transient frame drops (e.g. quick eye blink or head turn) don't flicker the overlay.
  useEffect(() => {
    if (!isMonitoring) {
      setDelayedTrigger(false);
      return;
    }

    if (!faceInFrame) {
      const timer = setTimeout(() => {
        setDelayedTrigger(true);
      }, 700);
      return () => clearTimeout(timer);
    } else {
      // Instantly dismiss as soon as face returns
      setDelayedTrigger(false);
    }
  }, [isMonitoring, faceInFrame]);

  // Connect live webcam stream directly into the popup's center viewfinder
  useEffect(() => {
    if (!delayedTrigger) return;
    let active = true;

    requestWebcamStream().then(({ stream }) => {
      if (active && stream && overlayVideoRef.current) {
        overlayVideoRef.current.srcObject = stream;
        void overlayVideoRef.current.play().catch(() => {});
      }
    });

    return () => {
      active = false;
      if (overlayVideoRef.current) {
        overlayVideoRef.current.srcObject = null;
      }
    };
  }, [delayedTrigger]);

  if (!isMonitoring || !delayedTrigger) {
    return null;
  }

  const isFaceLostAlarm = alarmActive && alarmReason === "FACE_LOST";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm animate-in fade-in duration-200 select-none">
      <div className="relative w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden text-center p-6 sm:p-7 space-y-4 animate-in zoom-in-95">
        
        {/* Status Indicators & Guidance (Eye button removed as requested) */}
        <div className="space-y-1.5 pt-1">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-semibold uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-600 animate-ping" />
            Sensor Alignment Required
          </div>

          {isFaceLostAlarm && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-700 text-[11px] font-semibold border border-rose-200">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-600 animate-ping" />
              Safety Alert Active
            </div>
          )}

          <h2 className="text-xl font-bold text-slate-900 tracking-tight">
            Face Not Detected in Camera
          </h2>

          <p className="text-xs sm:text-sm text-slate-600 leading-relaxed max-w-sm mx-auto">
            Please look directly into the camera viewfinder below. Monitoring will automatically resume once facial alignment is confirmed.
          </p>
        </div>

        {/* Live Active Center Scanning Viewfinder */}
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center space-y-2">
          <div className="relative w-48 h-36 sm:w-56 sm:h-40 mx-auto rounded-lg overflow-hidden bg-slate-900 border-2 border-dashed border-amber-500 shadow-inner">
            <video
              ref={overlayVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover transform -scale-x-100"
            />

            {/* Live Scanning Reticle Overlay */}
            <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-2">
              <div className="flex justify-between">
                <span className="w-3 h-3 border-t-2 border-l-2 border-emerald-400" />
                <span className="w-3 h-3 border-t-2 border-r-2 border-emerald-400" />
              </div>
              {/* Animated scanning laser bar */}
              <div className="w-full h-0.5 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,1)] animate-bounce" />
              <div className="flex justify-between">
                <span className="w-3 h-3 border-b-2 border-l-2 border-emerald-400" />
                <span className="w-3 h-3 border-b-2 border-r-2 border-emerald-400" />
              </div>
            </div>

            {/* Real-time Scanner Badge */}
            <div className="absolute bottom-1.5 inset-x-0 flex justify-center pointer-events-none">
              <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-slate-900/85 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                <span>ACTIVE SCANNER</span>
              </span>
            </div>
          </div>

          <p className="text-[11px] font-medium text-slate-500">
            Center your face inside this optical viewfinder
          </p>
        </div>

        {/* Auto-Recovery Footer & Red Exit Button */}
        <div className="pt-2 space-y-3">
          <div className="text-[11px] text-slate-500 flex items-center justify-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>Telemetry automatically resumes upon face detection</span>
          </div>

          {/* Exit Session Button with RED TEXT as requested */}
          <div className="flex items-center justify-center pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => stopMonitoring()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-700 border border-rose-200 text-xs font-semibold transition"
            >
              <svg className="w-3.5 h-3.5 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              <span className="text-rose-600 font-semibold">Stop Monitoring &amp; Exit Session</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
