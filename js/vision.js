// Loads MediaPipe Tasks Vision models for hand and face tracking.
// The library is imported lazily so a blocked CDN produces a readable error in the UI
// instead of silently preventing the whole app from loading.
const LIB_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

async function createWithFallback(factory, vision, options) {
  // GPU delegate is much faster, but some browsers or drivers reject it; fall back to CPU.
  try {
    return await factory.createFromOptions(vision, { ...options, baseOptions: { ...options.baseOptions, delegate: "GPU" } });
  } catch (err) {
    console.warn("GPU delegate failed, using CPU", err);
    return await factory.createFromOptions(vision, { ...options, baseOptions: { ...options.baseOptions, delegate: "CPU" } });
  }
}

export async function loadVision(onProgress = () => {}) {
  onProgress("Loading vision library…");
  let FilesetResolver, HandLandmarker, FaceLandmarker;
  try {
    ({ FilesetResolver, HandLandmarker, FaceLandmarker } = await import(LIB_URL));
  } catch (err) {
    throw new Error(`could not download the vision library from ${LIB_URL}. Check your internet connection. (${err.message})`);
  }

  onProgress("Loading vision runtime…");
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);

  onProgress("Loading hand model…");
  const hands = await createWithFallback(HandLandmarker, vision, {
    baseOptions: { modelAssetPath: HAND_MODEL },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  onProgress("Loading face model…");
  const face = await createWithFallback(FaceLandmarker, vision, {
    baseOptions: { modelAssetPath: FACE_MODEL },
    runningMode: "VIDEO",
    numFaces: 2,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });

  return { hands, face };
}
