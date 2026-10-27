"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WallpaperPresetId =
  | "aurora"
  | "sequoia"
  | "zen-mist"
  | "ocean"
  | "cyber"
  | "none";

export interface WallpaperPreset {
  id: WallpaperPresetId;
  name: string;
  description: string;
  previewGradient: string;
  darkCss: string;
  lightCss: string;
}

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  {
    id: "aurora",
    name: "深空极光",
    description: "深邃暗夜靛蓝与翡翠流光，夜间阅读温和护眼，玻璃折射感极佳",
    previewGradient: "linear-gradient(135deg, #090d16 0%, #064e3b 50%, #1e1b4b 100%)",
    darkCss:
      "radial-gradient(circle at 15% 20%, rgba(16, 185, 129, 0.16) 0%, transparent 45%), radial-gradient(circle at 85% 75%, rgba(99, 102, 241, 0.18) 0%, transparent 50%), radial-gradient(circle at 50% 50%, rgba(14, 165, 233, 0.12) 0%, transparent 65%), linear-gradient(180deg, #070a13 0%, #0c1222 50%, #090e1a 100%)",
    lightCss:
      "radial-gradient(circle at 15% 20%, rgba(52, 211, 153, 0.12) 0%, transparent 45%), radial-gradient(circle at 85% 75%, rgba(129, 140, 248, 0.14) 0%, transparent 50%), linear-gradient(180deg, #f0fdf4 0%, #f8fafc 50%, #eef2ff 100%)",
  },
  {
    id: "sequoia",
    name: "晨曦红杉",
    description: "macOS Sequoia 标志性自然有机山峦晨曦，层次分明高雅质感",
    previewGradient: "linear-gradient(135deg, #1c1917 0%, #9a3412 50%, #0c0a09 100%)",
    darkCss:
      "radial-gradient(circle at 20% 15%, rgba(249, 115, 22, 0.15) 0%, transparent 45%), radial-gradient(circle at 80% 80%, rgba(225, 29, 72, 0.12) 0%, transparent 55%), radial-gradient(circle at 50% 60%, rgba(120, 53, 15, 0.15) 0%, transparent 60%), linear-gradient(180deg, #0c0a09 0%, #171412 50%, #0c0a09 100%)",
    lightCss:
      "radial-gradient(circle at 20% 15%, rgba(251, 146, 60, 0.14) 0%, transparent 45%), radial-gradient(circle at 80% 80%, rgba(251, 113, 133, 0.12) 0%, transparent 55%), linear-gradient(180deg, #fff7ed 0%, #fafaf9 50%, #fdf2f8 100%)",
  },
  {
    id: "zen-mist",
    name: "极简烟岚",
    description: "超低对比度柔和烟岚石墨，极致减少视觉干扰，长时间阅读首选",
    previewGradient: "linear-gradient(135deg, #1e293b 0%, #334155 50%, #0f172a 100%)",
    darkCss:
      "radial-gradient(circle at 50% 30%, rgba(148, 163, 184, 0.08) 0%, transparent 60%), linear-gradient(180deg, #0b0f17 0%, #111827 50%, #0b0f17 100%)",
    lightCss:
      "radial-gradient(circle at 50% 30%, rgba(203, 213, 225, 0.3) 0%, transparent 60%), linear-gradient(180deg, #f8fafc 0%, #f1f5f9 50%, #f8fafc 100%)",
  },
  {
    id: "ocean",
    name: "琉璃深海",
    description: "科技感深海蔚蓝与微光水波，如水下液态透镜般的清澈通透体验",
    previewGradient: "linear-gradient(135deg, #022c43 0%, #055170 50%, #021824 100%)",
    darkCss:
      "radial-gradient(circle at 25% 25%, rgba(6, 182, 212, 0.15) 0%, transparent 45%), radial-gradient(circle at 75% 75%, rgba(2, 132, 199, 0.16) 0%, transparent 50%), linear-gradient(180deg, #02121e 0%, #052136 50%, #02121e 100%)",
    lightCss:
      "radial-gradient(circle at 25% 25%, rgba(34, 211, 238, 0.12) 0%, transparent 45%), radial-gradient(circle at 75% 75%, rgba(56, 189, 248, 0.12) 0%, transparent 50%), linear-gradient(180deg, #ecfeff 0%, #f0f9ff 50%, #f8fafc 100%)",
  },
  {
    id: "cyber",
    name: "赛博棱镜",
    description: "流光溢彩的光学折射三棱镜光环，最大化展现物理液态玻璃色散",
    previewGradient: "linear-gradient(135deg, #180d2b 0%, #4c1d95 50%, #0f172a 100%)",
    darkCss:
      "radial-gradient(circle at 20% 30%, rgba(168, 85, 247, 0.16) 0%, transparent 45%), radial-gradient(circle at 80% 40%, rgba(236, 72, 153, 0.14) 0%, transparent 45%), radial-gradient(circle at 50% 85%, rgba(59, 130, 246, 0.15) 0%, transparent 50%), linear-gradient(180deg, #0c0817 0%, #130f24 50%, #0c0817 100%)",
    lightCss:
      "radial-gradient(circle at 20% 30%, rgba(192, 132, 252, 0.12) 0%, transparent 45%), radial-gradient(circle at 80% 40%, rgba(244, 114, 182, 0.12) 0%, transparent 45%), linear-gradient(180deg, #faf5ff 0%, #fdf2f8 50%, #f8fafc 100%)",
  },
  {
    id: "none",
    name: "原生极简",
    description: "无背景图案，回归经典的低调纯净控制台质感",
    previewGradient: "linear-gradient(135deg, #18181b 0%, #27272a 100%)",
    darkCss: "none",
    lightCss: "none",
  },
];

interface WallpaperState {
  currentPresetId: WallpaperPresetId;
  blurLevel: "low" | "medium" | "high";
  glassOpacity: number; // 0.4 to 0.95
  chromaticAberration: boolean;
  mouseLighting: boolean;
  setPreset: (id: WallpaperPresetId) => void;
  setBlurLevel: (level: "low" | "medium" | "high") => void;
  setGlassOpacity: (opacity: number) => void;
  setChromaticAberration: (enabled: boolean) => void;
  setMouseLighting: (enabled: boolean) => void;
}

export const useWallpaperStore = create<WallpaperState>()(
  persist(
    (set) => ({
      currentPresetId: "aurora",
      blurLevel: "medium",
      glassOpacity: 0.72,
      chromaticAberration: true,
      mouseLighting: true,
      setPreset: (id) => set({ currentPresetId: id }),
      setBlurLevel: (level) => set({ blurLevel: level }),
      setGlassOpacity: (glassOpacity) => set({ glassOpacity }),
      setChromaticAberration: (chromaticAberration) => set({ chromaticAberration }),
      setMouseLighting: (mouseLighting) => set({ mouseLighting }),
    }),
    {
      name: "oxidns:wallpaper-settings",
    },
  ),
);
