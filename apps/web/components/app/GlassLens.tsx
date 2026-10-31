"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * The selected-item marker: a clear glass capsule a little larger than the item it sits on.
 * Render it inside the selected item only; items sharing a `group` pass one lens between
 * them, and it travels on a spring that overshoots slightly before it settles. The item
 * needs `relative` and its label a `relative` wrapper so it sits above the glass.
 */
export function GlassLens({ group, className }: { group: string; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.span
      layoutId={`glass-lens-${group}`}
      aria-hidden="true"
      className={cn("glass-lens absolute -inset-[3px] rounded-full", className)}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 24 }}
    />
  );
}
