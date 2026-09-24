/**
 * Centralized resolver for MediaPipe FaceMesh assets.
 * Points to locally hosted static assets in /public/mediapipe/face_mesh/
 * to provide 0ms instant loading, complete offline capability, and
 * immunity against CDN xhr.onprogress race condition TypeErrors.
 */

// Install the defense proxy immediately whenever this module is imported in client-side code
if (typeof window !== "undefined") {
  const w = window as any;
  if (!w.createMediapipeSolutionsPackedAssets) {
    const safeDownloads: Record<string, { loaded: number; total: number }> = {};
    const safeProxy = new Proxy(safeDownloads, {
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

    w.createMediapipeSolutionsPackedAssets = {
      dataFileDownloads: safeProxy,
    };
  }
}

export function getFaceMeshLocateFile(file: string): string {
  // Use locally served assets from Next.js public directory
  return `/mediapipe/face_mesh/${file}`;
}

let sharedMeshInstance: FaceMesh | null = null;
let sharedMeshInitPromise: Promise<FaceMesh> | null = null;
let activeResultsCallback: ((results: Results) => void) | null = null;

import type { FaceMesh, Results } from "@mediapipe/face_mesh";

/**
 * Returns the singleton FaceMesh instance, creating and initializing it once.
 */
export async function getSharedFaceMesh(): Promise<FaceMesh> {
  if (sharedMeshInstance) {
    return sharedMeshInstance;
  }

  if (sharedMeshInitPromise) {
    return sharedMeshInitPromise;
  }

  sharedMeshInitPromise = (async () => {
    try {
      const { FaceMesh } = await import("@mediapipe/face_mesh");
      const fm = new FaceMesh({ locateFile: getFaceMeshLocateFile });
      fm.setOptions({
        maxNumFaces: 3,
        refineLandmarks: true,
        minDetectionConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });

      fm.onResults((results: Results) => {
        if (activeResultsCallback) {
          try {
            activeResultsCallback(results);
          } catch {
            // Callback execution caught safely
          }
        }
      });

      try {
        await fm.initialize();
      } catch {
        // Initialization completes on first frame send
      }

      sharedMeshInstance = fm;
      return fm;
    } catch (err) {
      sharedMeshInitPromise = null;
      throw err;
    }
  })();

  return sharedMeshInitPromise;
}

/**
 * Binds the active onResults callback to the shared FaceMesh singleton.
 * Returns an unbind function for clean component unmounts.
 */
export function setSharedFaceMeshCallback(callback: (results: Results) => void): () => void {
  activeResultsCallback = callback;
  return () => {
    if (activeResultsCallback === callback) {
      activeResultsCallback = null;
    }
  };
}

