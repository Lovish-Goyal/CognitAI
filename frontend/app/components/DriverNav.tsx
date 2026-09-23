"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useRef } from "react";

const navItems = [
  {
    href: "/",
    title: "Dashboard",
    subtitle: "Real-time Telemetry",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    href: "/fatigue-monitor",
    title: "Fatigue Monitor",
    subtitle: "Eye Aspect Ratio (EAR)",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    ),
  },
  {
    href: "/stress-analytics",
    title: "Stress Analytics",
    subtitle: "Cardiovascular rPPG",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    href: "/gaze-deviation",
    title: "Gaze Deviation",
    subtitle: "Head Pose & Windshield",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
      </svg>
    ),
  },
  {
    href: "/spoof-interceptor",
    title: "Spoof Interceptor",
    subtitle: "3D Planar Verification",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
  },
  {
    href: "/health-options",
    title: "Health Options",
    subtitle: "Biometrics & Vitality",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      </svg>
    ),
  },
  {
    href: "/history",
    title: "Audit & History",
    subtitle: "Logins, Logouts & Alarms",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

import { useMonitoring } from "../context/MonitoringContext";

export default function DriverNav() {
  const pathname = usePathname();
  const { isMonitoring, startMonitoring, stopMonitoring, currentDriver, logoutDriver } = useMonitoring();
  const [time, setTime] = useState<string>("");
  const [audioArmed, setAudioArmed] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Global Audio auto-unlock on first user interaction
  useEffect(() => {
    const unlockAudio = () => {
      try {
        if (!audioCtxRef.current) {
          const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          audioCtxRef.current = new AudioContextClass();
        }
        if (audioCtxRef.current.state === "suspended") {
          audioCtxRef.current.resume().then(() => setAudioArmed(true));
        } else {
          setAudioArmed(true);
        }
      } catch {
        setAudioArmed(true);
      }
    };

    window.addEventListener("click", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });
    window.addEventListener("touchstart", unlockAudio, { once: true });

    const update = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString("en-US", { hour12: false }));
    };
    update();
    const interval = setInterval(update, 1000);

    return () => {
      clearInterval(interval);
      window.removeEventListener("click", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
    };
  }, []);

  const manualArmOrTest = () => {
    try {
      if (!audioCtxRef.current) {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;
      ctx.resume().then(() => {
        setAudioArmed(true);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      });
    } catch {
      setAudioArmed(true);
    }
  };

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Top Header Bar: Pure white, clean Wikipedia-like flat design */}
      <header className="sticky top-0 z-50 flex items-center justify-between px-3 sm:px-6 lg:px-8 py-2.5 bg-white border-b border-gray-300">
        {/* Left: Mobile Toggle + Logo + Search */}
        <div className="flex items-center gap-3 sm:gap-6">
          {/* Mobile Menu Hamburger Button */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            className="lg:hidden p-1.5 text-gray-700 hover:text-gray-900 border border-gray-300 rounded bg-white hover:bg-gray-50 transition"
            aria-label="Toggle navigation menu"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {mobileMenuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>

          <Link href="/" className="flex items-center gap-2 group">
            <span className="w-7 h-7 rounded bg-[#0066cc] flex items-center justify-center text-white text-xs font-bold">
              C
            </span>
            <span className="text-base font-bold text-gray-900 tracking-tight">
              Cognit<span className="text-[#0066cc]">AI</span>
            </span>
          </Link>

          {/* Search Input */}
          <div className="relative w-44 sm:w-60 md:w-72 lg:w-80 hidden sm:block">
            <svg className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search metrics, telemetry..."
              className="w-full pl-9 pr-3 py-1 text-xs bg-white border border-gray-300 hover:border-gray-400 focus:border-[#0066cc] rounded text-gray-800 outline-none"
            />
          </div>
        </div>

        {/* Right Section: Status, Clock, Alarm, Driver profile */}
        <div className="flex items-center gap-2 sm:gap-3 text-xs">
          <div className="hidden md:flex items-center gap-1.5 text-gray-700">
            <span className={`w-2 h-2 rounded-full ${isMonitoring ? "bg-emerald-600 animate-pulse" : "bg-gray-400"}`} />
            <span className="font-medium">{isMonitoring ? "Monitoring Active" : "Standby"}</span>
          </div>

          {/* Master Portal Monitoring Control Button (Global for all tabs) */}
          {/* Master Portal Monitoring Control Button */}
          {isMonitoring ? (
            <button
              type="button"
              onClick={stopMonitoring}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition shadow-sm bg-rose-600 hover:bg-rose-700 text-white shadow-rose-200 cursor-pointer"
              title="Click to manually stop monitoring across the entire portal"
            >
              <span>⏹</span>
              <span>Stop Monitoring</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={startMonitoring}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition shadow-sm bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-200 cursor-pointer"
              title="Resume driver monitoring"
            >
              <span>▶</span>
              <span>Resume Monitoring</span>
            </button>
          )}

          <div className="hidden lg:flex items-center gap-1 text-gray-600 border-l border-gray-200 pl-3">
            <span>Clock:</span>
            <span className="font-mono text-gray-900">{time || "00:00:00"}</span>
          </div>

          <button
            type="button"
            onClick={manualArmOrTest}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs transition ${
              audioArmed
                ? "bg-[#0066cc] border-[#0066cc] text-white"
                : "bg-white border-gray-300 hover:bg-gray-100 text-gray-800"
            }`}
            title="Audio alert test"
          >
            <span>{audioArmed ? "🔊" : "🔈"}</span>
            <span className="hidden sm:inline">
              {audioArmed ? "Alarm Armed" : "Enable Alarm"}
            </span>
          </button>

          {/* User Profile Avatar */}
          <div className="flex items-center gap-2 pl-2 border-l border-gray-200">
            {currentDriver?.photo_base64 ? (
              <img
                src={currentDriver.photo_base64}
                alt={currentDriver.display_name}
                className="w-7 h-7 rounded-full object-cover border border-blue-400 shadow-sm"
              />
            ) : (
              <div className="w-7 h-7 rounded-full border border-blue-400 bg-blue-50 flex items-center justify-center text-xs font-bold text-[#0066cc]">
                {currentDriver?.display_name ? currentDriver.display_name.charAt(0).toUpperCase() : "DR"}
              </div>
            )}
            <div className="hidden xl:block text-left text-[11px] leading-tight max-w-[110px]">
              <div className="font-bold text-gray-800 truncate">
                {currentDriver?.display_name ? currentDriver.display_name.split(" ")[0] : "Driver 001"}
              </div>
              <div className="text-[10px] text-gray-500 font-mono truncate">
                {currentDriver?.driver_id || "DRIVER-001"}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile Drawer Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden transition-opacity"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Wider Sidebar (w-72 / 288px): Wikipedia TOC style with rich telemetry metadata */}
      <aside className={`fixed inset-y-0 left-0 z-45 w-72 pt-14 border-r border-gray-300 bg-white flex flex-col justify-between p-3.5 transition-transform duration-200 ease-in-out ${
        mobileMenuOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
      }`}>
        <div className="space-y-4 overflow-y-auto">
          <div>
            <div className="px-2 py-1 mb-2 border-b border-gray-200 flex items-center justify-between">
              <p className="text-xs font-bold text-gray-600 uppercase tracking-wider">
                Navigation
              </p>
              <span className="text-[10px] text-gray-500 font-mono">v2.4.0</span>
            </div>

            <nav className="space-y-1">
              {navItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex items-start gap-3 px-3 py-2.5 rounded text-xs transition ${
                      isActive
                        ? "border-l-2 border-[#0066cc] bg-blue-50/60 text-[#0066cc] font-semibold"
                        : "text-gray-700 hover:text-gray-900 hover:bg-gray-100 font-normal"
                    }`}
                  >
                    <div className={`mt-0.5 shrink-0 ${isActive ? "text-[#0066cc]" : "text-gray-500"}`}>
                      {item.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="leading-snug text-sm">{item.title}</p>
                      <p className="text-xs text-gray-500 font-normal">{item.subtitle}</p>
                    </div>
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Active Driver Profile Section in Sidebar */}
          <div className="pt-3 border-t border-gray-200 text-xs space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold text-gray-600 uppercase tracking-wider">Driver Session Info</p>
            </div>
            <div className="p-2.5 rounded border border-gray-200 bg-gray-50/60 space-y-1.5 text-xs">
              <div className="flex justify-between items-center">
                <span className="font-semibold text-gray-900 truncate max-w-[150px]" title={currentDriver?.display_name}>
                  {currentDriver?.display_name || "Alex Mercer"}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded font-medium">
                  {currentDriver?.status || "On Duty"}
                </span>
              </div>
              <div className="text-[11px] text-gray-600 space-y-0.5">
                <p className="flex justify-between">
                  <span className="text-gray-500">Driver ID:</span>
                  <span className="font-mono text-gray-800">{currentDriver?.driver_id || "DRIVER-001"}</span>
                </p>
                <p className="flex justify-between">
                  <span className="text-gray-500">License Class:</span>
                  <span className="font-mono text-gray-800 truncate max-w-[130px] text-right" title={currentDriver?.license_class}>
                    {currentDriver?.license_class || "Commercial A"}
                  </span>
                </p>
                <p className="flex justify-between">
                  <span className="text-gray-500">Security Cipher:</span>
                  <span className="font-mono text-[#0066cc]">AES-256 Fernet</span>
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar Footer with Live Hardware Engine Status */}
        <div className="pt-3 border-t border-gray-200 text-xs space-y-2">
          <div className="p-2.5 rounded border border-gray-200 bg-white text-gray-600 text-[11px] space-y-1">
            <p className="font-semibold text-gray-800 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-600" />
                <span>Edge AI Engine</span>
              </span>
              <span className="text-[10px] text-gray-500 font-mono">30 FPS</span>
            </p>
            <p className="text-gray-500">WebAssembly MediaPipe Mesh</p>
            <div className="pt-1 border-t border-gray-100 flex justify-between text-[10px] text-gray-500 font-mono">
              <span>Latency: 14ms</span>
              <span>Memory: 42MB</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="fixed inset-x-0 bottom-0 z-35 flex items-center justify-around border-t border-gray-300 bg-white px-2 py-1.5 lg:hidden">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-0.5 rounded px-2 py-1 transition ${
                isActive ? "text-[#0066cc] font-semibold" : "text-gray-600 hover:text-gray-900"
              }`}
            >
              <div className="w-4 h-4">{item.icon}</div>
              <span className="text-[10px] truncate max-w-[65px]">
                {item.title.split(" ")[0]}
              </span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
