// Butterchurn ships no types: the part of its API the MilkDrop visualizer uses (milkdrop.ts).
declare module 'butterchurn' {
  // A converted MilkDrop preset (butterchurn-presets), passed through as it is.
  export type Preset = Record<string, unknown>;
  export type AudioLevels = { timeByteArray: Uint8Array; timeByteArrayL: Uint8Array; timeByteArrayR: Uint8Array };
  export type Visualizer = {
    gl: WebGL2RenderingContext;
    // Only its blend state is read: true from a blended load until the blend has run its course.
    renderer: { readonly blending: boolean };
    loadPreset(preset: Preset, blendTime?: number): Promise<void>;
    setRendererSize(width: number, height: number, options?: { meshWidth?: number; meshHeight?: number; pixelRatio?: number; textureRatio?: number }): void;
    render(options: { audioLevels: AudioLevels; elapsedTime?: number }): void;
    loseGLContext(): void;
  };
  const butterchurn: {
    createVisualizer(context: BaseAudioContext | null, canvas: HTMLCanvasElement, options: { width: number; height: number; pixelRatio?: number; textureRatio?: number; meshWidth?: number; meshHeight?: number; onlyUseWASM?: boolean }): Visualizer;
  };
  export default butterchurn;
}
declare module 'butterchurn-presets/presets/converted/*' {
  const preset: import('butterchurn').Preset;
  export default preset;
}
