/** Detect meaningful soft-keyboard occlusion without mistaking a narrow viewport for Mobile mode. */
export interface WritingViewportSample {
  editorFocused: boolean;
  lastUnfocusedHeight: number;
  windowHeight: number;
  visualHeight: number | null;
  visualScale: number;
}

export function isWritingKeyboardVisible(sample: WritingViewportSample): boolean {
  if (!sample.editorFocused || !Number.isFinite(sample.windowHeight) ||
      !Number.isFinite(sample.lastUnfocusedHeight) || sample.windowHeight <= 0 ||
      sample.lastUnfocusedHeight <= 0) return false;
  const windowOcclusion = Math.max(0, sample.lastUnfocusedHeight - sample.windowHeight);
  // Pinch zoom changes visualViewport.height without opening a keyboard.
  const zoomed = Number.isFinite(sample.visualScale) && sample.visualScale > 1.05;
  const visualOcclusion = !zoomed && sample.visualHeight !== null && Number.isFinite(sample.visualHeight)
    ? Math.max(0, sample.windowHeight - sample.visualHeight)
    : 0;
  // Browser address bars usually move by tens of pixels; the soft keyboard takes much more.
  return Math.max(windowOcclusion, visualOcclusion) >= 140;
}
