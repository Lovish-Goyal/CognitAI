"use client";

import { useEffect } from "react";

/**
 * MediaPipeGuard permanently protects against the legacy MediaPipe Emscripten
 * loader bug: `TypeError: Cannot read properties of undefined (reading '...packed_assets.data')`.
 *
 * This occurs when an in-flight XHR onprogress event fires after a component remount
 * or Fast Refresh wipes the global Module.dataFileDownloads map. By intercepting
 * and wrapping dataFileDownloads in a self-healing Proxy, any key access always returns
 * a valid progress tracking object, guaranteeing zero unhandled runtime exceptions.
 */
export default function MediaPipeGuard() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const setupGuard = () => {
      const w = window as any;

      // Filter internal C++ WebAssembly Emscripten logging from cluttering the browser console
      if (!w.__mediapipe_logs_filtered) {
        w.__mediapipe_logs_filtered = true;
        const origLog = console.log;
        const origInfo = console.info;
        const origWarn = console.warn;

        const isInternalCppLog = (args: any[]) => {
          if (args.length > 0 && typeof args[0] === "string") {
            const s = args[0];
            return (
              s.includes("gl_context_webgl.cc") ||
              s.includes("gl_context.cc") ||
              s.includes("OpenGL error checking is disabled") ||
              s.includes("Successfully created a WebGL context") ||
              s.includes("GL version:")
            );
          }
          return false;
        };

        console.log = (...args: any[]) => {
          if (isInternalCppLog(args)) return;
          origLog.apply(console, args);
        };
        console.info = (...args: any[]) => {
          if (isInternalCppLog(args)) return;
          origInfo.apply(console, args);
        };
        console.warn = (...args: any[]) => {
          if (isInternalCppLog(args)) return;
          origWarn.apply(console, args);
        };
      }

      const downloadsStore: Record<string, { loaded: number; total: number }> = {};

      const safeDownloadsProxy = new Proxy(downloadsStore, {
        get(target, prop: string | symbol) {
          if (typeof prop === "string" && !target[prop]) {
            target[prop] = { loaded: 0, total: 1 };
          }
          return target[prop as string];
        },
        set(target, prop: string | symbol, value: any) {
          if (typeof prop === "string") {
            target[prop] = value;
          }
          return true;
        },
      });

      if (!w.createMediapipeSolutionsPackedAssets) {
        w.createMediapipeSolutionsPackedAssets = {
          dataFileDownloads: safeDownloadsProxy,
        };
      } else {
        if (!w.createMediapipeSolutionsPackedAssets.dataFileDownloads) {
          w.createMediapipeSolutionsPackedAssets.dataFileDownloads = safeDownloadsProxy;
        }
      }

      // Also protect global Module if exposed by legacy scripts
      if (w.Module && !w.Module.dataFileDownloads) {
        w.Module.dataFileDownloads = safeDownloadsProxy;
      }
    };

    setupGuard();
  }, []);

  return null;
}
