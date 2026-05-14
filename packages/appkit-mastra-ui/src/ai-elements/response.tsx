"use client";

import { type ComponentProps, memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "../lib/utils.js";

// Vendored from https://github.com/mastra-ai/ui-dojo/blob/main/src/components/ai-elements/response.tsx
// (Apache-2.0). Renders streaming markdown via `streamdown`.

type ResponseProps = ComponentProps<typeof Streamdown>;

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>:first-child]:mt-0 [&>:last-child]:mb-0",
        className,
      )}
      {...props}
    />
  ),
  (prev, next) => prev.children === next.children,
);
Response.displayName = "Response";
