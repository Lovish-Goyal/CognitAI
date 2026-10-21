"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { releaseWebcamStream } from "../utils/camera";

export type AlarmReason = "MICROSLEEP" | "HEAD_DROP" | "FACE_LOST" | "GAZE_DISTRACTION" | "MANUAL_TEST";

export interface DriverProfile {
  driver_id: string;
  display_name: string;
  photo_base64?: string;
  license_class?: string;
  status?: string;
  created_at?: string;
}

interface MonitoringContextType {
  isMonitoring: boolean;
  startMonitoring: () => void;
  stopMonitoring: () => void;
  toggleMonitoring: () => void;

  // Driver Profile & Session
  currentDriver: DriverProfile | null;
  setCurrentDriver: (driver: DriverProfile | null) => void;
  logoutDriver: () => void;

  // Face presence tracking
  faceInFrame: boolean;
  setFaceInFrame: (inFrame: boolean) => void;
  initialFaceCalibrated: boolean;
  setInitialFaceCalibrated: (calibrated: boolean) => void;

  // Global Synchronized Alert State
  alarmActive: boolean;
  alarmReason: AlarmReason | null;
  alarmTitle: string;
  alarmDescription: string;
  autoRecovered: boolean;
  elapsedAlarmSeconds: number;
  triggerGlobalAlarm: (reason: AlarmReason, title?: string, description?: string) => void;
  stopGlobalAlarm: (autoRecover?: boolean) => void;
}

const MonitoringContext = createContext<MonitoringContextType>({
  isMonitoring: false,
  startMonitoring: () => {},
  stopMonitoring: () => {},
  toggleMonitoring: () => {},
  currentDriver: null,
  setCurrentDriver: () => {},
  logoutDriver: () => {},
  faceInFrame: true,
  setFaceInFrame: () => {},
  initialFaceCalibrated: false,
  setInitialFaceCalibrated: () => {},
  alarmActive: false,
  alarmReason: null,
  alarmTitle: "",
  alarmDescription: "",
  autoRecovered: false,
  elapsedAlarmSeconds: 0,
  triggerGlobalAlarm: () => {},
  stopGlobalAlarm: () => {},
});

import { getApiBaseUrl } from "../utils/api";

export function MonitoringProvider({ children }: { children: React.ReactNode }) {
  const [isMonitoring, setIsMonitoring] = useState<boolean>(false);
  const [initialFaceCalibrated, setInitialFaceCalibrated] = useState<boolean>(false);
  const [faceInFrame, setFaceInFrame] = useState<boolean>(true);

  // Driver Profile & Active Session
  const [currentDriver, setCurrentDriverState] = useState<DriverProfile | null>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = sessionStorage.getItem("cognitai_current_driver");
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return null;
  });

  const currentDriverRef = useRef<DriverProfile | null>(currentDriver);
  useEffect(() => {
    currentDriverRef.current = currentDriver;
  }, [currentDriver]);

  const setCurrentDriver = useCallback((driver: DriverProfile | null) => {
    setCurrentDriverState(driver);
    try {
      if (driver) {
        sessionStorage.setItem("cognitai_current_driver", JSON.stringify(driver));
      } else {
        sessionStorage.removeItem("cognitai_current_driver");
      }
    } catch {}
  }, []);

  // Global Alarm States
  const [alarmActive, setAlarmActive] = useState<boolean>(false);
  const [alarmReason, setAlarmReason] = useState<AlarmReason | null>(null);
  const [alarmTitle, setAlarmTitle] = useState<string>("");
  const [alarmDescription, setAlarmDescription] = useState<string>("");
  const [autoRecovered, setAutoRecovered] = useState<boolean>(false);
  const [elapsedAlarmSeconds, setElapsedAlarmSeconds] = useState<number>(0);

  const alarmActiveRef = useRef(false);
  const activeAlarmReasonRef = useRef<AlarmReason | null>(null);
  const activeOscRef = useRef<OscillatorNode | null>(null);
  const activeGainRef = useRef<GainNode | null>(null);
  const sirenIntervalRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const alarmStartTimeRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const autoRecoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const sessionStartTimeRef = useRef<number>(Date.now());

  // Web Audio Context initialization & resume
  const getAudioContext = useCallback(() => {
    try {
      if (!audioContextRef.current) {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioContextRef.current = new AudioCtx();
      }
      if (audioContextRef.current.state === "suspended") {
        void audioContextRef.current.resume();
      }
      return audioContextRef.current;
    } catch {
      return null;
    }
  }, []);

  // Unlock audio on first user gesture anywhere on the portal
  useEffect(() => {
    const unlock = () => {
      getAudioContext();
    };
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true });
    return () => {
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
  }, [getAudioContext]);

  // Audio Siren Chirp (Single-instance oscillator, 1050Hz -> 520Hz downward sweep, 0.26s)
  const playSirenChirp = useCallback(() => {
    try {
      if (!alarmActiveRef.current) return;

      const ctx = getAudioContext();
      if (!ctx) return;

      // Disconnect and clean up any lingering active oscillator
      if (activeOscRef.current) {
        try {
          activeOscRef.current.stop();
          activeOscRef.current.disconnect();
        } catch {}
        activeOscRef.current = null;
      }
      if (activeGainRef.current) {
        try {
          activeGainRef.current.disconnect();
        } catch {}
        activeGainRef.current = null;
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(1050, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(520, ctx.currentTime + 0.26);

      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);

      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.29);

      activeOscRef.current = osc;
      activeGainRef.current = gain;

      osc.onended = () => {
        if (activeOscRef.current === osc) {
          activeOscRef.current = null;
          activeGainRef.current = null;
        }
      };
    } catch {
      // Ignore audio synthesis errors
    }
  }, [getAudioContext]);

  // Stop siren audio loop & disconnect active sounds
  const stopSirenAudio = useCallback(() => {
    if (sirenIntervalRef.current) {
      window.clearInterval(sirenIntervalRef.current);
      sirenIntervalRef.current = null;
    }
    if (elapsedTimerRef.current) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (activeOscRef.current) {
      try {
        activeOscRef.current.stop();
        activeOscRef.current.disconnect();
      } catch {}
      activeOscRef.current = null;
    }
    if (activeGainRef.current) {
      try {
        activeGainRef.current.disconnect();
      } catch {}
      activeGainRef.current = null;
    }
  }, []);

  // Stop global alarm
  const stopGlobalAlarm = useCallback(
    (autoRecover: boolean = false) => {
      alarmActiveRef.current = false;
      activeAlarmReasonRef.current = null;
      setAlarmActive(false);
      setAlarmReason(null);
      stopSirenAudio();
      setElapsedAlarmSeconds(0);

      if (autoRecover) {
        setAutoRecovered(true);
        if (autoRecoverTimeoutRef.current) {
          clearTimeout(autoRecoverTimeoutRef.current);
        }
        autoRecoverTimeoutRef.current = setTimeout(() => {
          setAutoRecovered(false);
        }, 2200);
      } else {
        setAutoRecovered(false);
      }
    },
    [stopSirenAudio]
  );

  // Trigger global alarm (STRICT SINGLE-INSTANCE LOCK to prevent multiple alarms)
  const triggerGlobalAlarm = useCallback(
    (
      reason: AlarmReason,
      title?: string,
      description?: string
    ) => {
      // If alarm is ALREADY active, do not play multiple sounds or create extra intervals!
      if (alarmActiveRef.current) {
        // Only update text/state if reason category updated
        if (activeAlarmReasonRef.current !== reason) {
          activeAlarmReasonRef.current = reason;
          setAlarmReason(reason);
          if (title) setAlarmTitle(title);
          if (description) setAlarmDescription(description);
        }
        return; // Exit immediately — NO extra chirps or interval resets!
      }

      // First-time alarm engagement
      alarmActiveRef.current = true;
      activeAlarmReasonRef.current = reason;
      setAlarmActive(true);
      setAlarmReason(reason);

      if (autoRecoverTimeoutRef.current) {
        clearTimeout(autoRecoverTimeoutRef.current);
      }
      setAutoRecovered(false);

      const defaultTitle =
        reason === "MICROSLEEP"
          ? "CRITICAL ALERT: Prolonged Eye Closure / Microsleep!"
          : reason === "HEAD_DROP"
          ? "CRITICAL EMERGENCY: Driver Head Slump Detected!"
          : reason === "FACE_LOST"
          ? "CRITICAL EMERGENCY: Driver Face Lost / Absent!"
          : reason === "GAZE_DISTRACTION"
          ? "CRITICAL WARNING: Gaze Diverted From Windshield!"
          : "SAFETY ALERT: Driver Attention Incident";

      const defaultDesc =
        reason === "MICROSLEEP"
          ? "Driver eyes closed > 3.0 seconds while vehicle is in active transit. Acoustic siren active — WAKE UP & OPEN EYES!"
          : reason === "HEAD_DROP"
          ? "Sudden downward head collapse detected. Acoustic wake-up siren active — KEEP HEAD UPRIGHT!"
          : reason === "FACE_LOST"
          ? "Driver face is not detected in camera frame while vehicle is moving. Acoustic siren active — WAKE UP & FACE THE ROAD!"
          : reason === "GAZE_DISTRACTION"
          ? "Driver head pose deviated outside windshield safety cone for > 2.5 seconds. REFOCUS EYES FORWARD!"
          : "Driver safety threshold exceeded.";

      setAlarmTitle(title || defaultTitle);
      setAlarmDescription(description || defaultDesc);

      // Asynchronously log the alarm event to backend Audit History
      try {
        const activeDrv = currentDriverRef.current;
        fetch(`${getApiBaseUrl()}/api/audit-log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "ALARM",
            driver_id: activeDrv?.driver_id || "DRIVER-001",
            driver_name: activeDrv?.display_name || "Active Operator",
            reason: title ? `${title}: ${description || reason}` : `${defaultTitle}`,
            severity: "CRITICAL",
            duration_seconds: 0,
          }),
        }).catch(() => {});
      } catch {}

      // Play single initial siren chirp
      playSirenChirp();

      // Clear any prior interval before setting new single clean loop (480ms interval)
      if (sirenIntervalRef.current) {
        window.clearInterval(sirenIntervalRef.current);
      }
      sirenIntervalRef.current = window.setInterval(playSirenChirp, 480);

      // Track elapsed seconds
      alarmStartTimeRef.current = performance.now();
      if (elapsedTimerRef.current) {
        window.clearInterval(elapsedTimerRef.current);
      }
      elapsedTimerRef.current = window.setInterval(() => {
        const elapsed = (performance.now() - alarmStartTimeRef.current) / 1000;
        setElapsedAlarmSeconds(Number(elapsed.toFixed(1)));
      }, 100);

      // Log incident to backend (single dispatch per alarm event)
      const driverId = currentDriverRef.current?.driver_id || "DRIVER-001";
      fetch(`${getApiBaseUrl()}/api/report-incident`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driver_id: driverId,
          reason: `PORTAL_${reason}`,
          duration_seconds: reason === "HEAD_DROP" ? 1.5 : 2.5,
        }),
      }).catch(() => {});
    },
    [playSirenChirp]
  );

  // Restore session state if active during navigation
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("cognitai_portal_monitoring");
      if (saved === "true") {
        setIsMonitoring(true);
      }
    } catch {
      // Ignore
    }
  }, []);

  const startMonitoring = useCallback(() => {
    setIsMonitoring(true);
    setInitialFaceCalibrated(false);
    setFaceInFrame(true);
    sessionStartTimeRef.current = Date.now();
    try {
      sessionStorage.setItem("cognitai_portal_monitoring", "true");
    } catch {
      // Ignore
    }
  }, []);

  const logoutDriver = useCallback(() => {
    setCurrentDriver(null);
    setIsMonitoring(false);
    setInitialFaceCalibrated(false);
    setFaceInFrame(true);
    stopGlobalAlarm(false);
    try {
      sessionStorage.setItem("cognitai_portal_monitoring", "false");
    } catch {
      // Ignore
    }
    releaseWebcamStream(true);
  }, [setCurrentDriver, stopGlobalAlarm]);

  // When operator stops monitoring, terminate the active session:
  // 1. Record LOGOUT audit trail event in MongoDB/SQLite
  // 2. Clear currentDriver & session storage -> forces re-authentication/re-login!
  const stopMonitoring = useCallback(() => {
    const activeDrv = currentDriverRef.current;
    const duration = Math.max(1, Math.round((Date.now() - sessionStartTimeRef.current) / 1000));

    if (activeDrv) {
      try {
        fetch(`${getApiBaseUrl()}/api/audit-log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "LOGOUT",
            driver_id: activeDrv.driver_id,
            driver_name: activeDrv.display_name,
            reason: "Operator Stopped Monitoring & Terminated Active Session",
            severity: "INFO",
            duration_seconds: duration,
          }),
        }).catch(() => {});
      } catch {}
    }

    // Force driver logout and lock portal back to Entrance Gateway
    logoutDriver();
  }, [logoutDriver]);

  const toggleMonitoring = useCallback(() => {
    setIsMonitoring((prev) => {
      const next = !prev;
      setInitialFaceCalibrated(false);
      try {
        sessionStorage.setItem("cognitai_portal_monitoring", next ? "true" : "false");
      } catch {
        // Ignore
      }
      if (!next) {
        stopGlobalAlarm(false);
        releaseWebcamStream(true);
      }
      return next;
    });
  }, [stopGlobalAlarm]);

  return (
    <MonitoringContext.Provider
      value={{
        isMonitoring,
        startMonitoring,
        stopMonitoring,
        toggleMonitoring,
        currentDriver,
        setCurrentDriver,
        logoutDriver,
        faceInFrame,
        setFaceInFrame,
        initialFaceCalibrated,
        setInitialFaceCalibrated,
        alarmActive,
        alarmReason,
        alarmTitle,
        alarmDescription,
        autoRecovered,
        elapsedAlarmSeconds,
        triggerGlobalAlarm,
        stopGlobalAlarm,
      }}
    >
      {children}
    </MonitoringContext.Provider>
  );
}

export function useMonitoring() {
  return useContext(MonitoringContext);
}
