import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style class name helper. Combines `clsx`'s conditional class
 *  composition with `tailwind-merge`'s conflict resolution so the AI
 *  Elements components can layer Tailwind classes safely. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
