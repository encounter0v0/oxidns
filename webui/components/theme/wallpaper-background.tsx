"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useWallpaperStore, WALLPAPER_PRESETS } from "@/lib/wallpaper-store";

export function WallpaperBackground() {
  const { resolvedTheme } = useTheme();
  const currentPresetId = useWallpaperStore((s) => s.currentPresetId);
  const mouseLighting = useWallpaperStore((s) => s.mouseLighting);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // Global mouse position tracker to drive the liquid glass raytraced specular shimmer
  useEffect(() => {
    if (!mouseLighting) return;
    const handleMouseMove = (e: MouseEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      document.documentElement.style.setProperty("--mouse-x", `${x}px`);
      document.documentElement.style.setProperty("--mouse-y", `${y}px`);
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [mouseLighting]);

  if (!mounted) return null;

  const isDark = resolvedTheme === "dark";
  const preset = WALLPAPER_PRESETS.find((p) => p.id === currentPresetId) || WALLPAPER_PRESETS[0];

  if (preset.id === "none") return null;

  const bgStyle = isDark ? preset.darkCss : preset.lightCss;

  return (
    <div className="fixed inset-0 pointer-events-none -z-30 overflow-hidden transition-all duration-700 ease-out">
      {/* ── Layer 1: Primary Artful Gradient Scene ── */}
      <div
        className="absolute inset-0 transition-all duration-1000 ease-in-out"
        style={{ background: bgStyle }}
      />

      {/* ── Layer 2: Floating Organic Refractive Caustic Orbs ── */}
      <div
        className="absolute -top-[20%] -left-[10%] w-[55vw] h-[55vw] rounded-full blur-[100px] opacity-40 animate-pulse pointer-events-none"
        style={{
          background: isDark
            ? "radial-gradient(circle, rgba(14, 165, 233, 0.25) 0%, transparent 70%)"
            : "radial-gradient(circle, rgba(56, 189, 248, 0.2) 0%, transparent 70%)",
          animationDuration: "14s",
        }}
      />
      <div
        className="absolute -bottom-[20%] -right-[10%] w-[60vw] h-[60vw] rounded-full blur-[120px] opacity-35 animate-pulse pointer-events-none"
        style={{
          background: isDark
            ? "radial-gradient(circle, rgba(168, 85, 247, 0.22) 0%, transparent 70%)"
            : "radial-gradient(circle, rgba(192, 132, 252, 0.18) 0%, transparent 70%)",
          animationDuration: "18s",
        }}
      />

      {/* ── Layer 3: Micro-noise Tactile Glass Texture (Enhances text contrast and eliminates color banding) ── */}
      <div
        className="absolute inset-0 opacity-[0.025] dark:opacity-[0.04] pointer-events-none mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* ── Layer 4: Reading-Optimized Contrast Equalizer ── */}
      <div className="absolute inset-0 bg-background/20 dark:bg-background/30 backdrop-blur-[1px] pointer-events-none" />
    </div>
  );
}
