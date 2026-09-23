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
