// Skiper UI "Progressive Blur" (skiper41), free component: https://skiper-ui.com
// Adapted: the demo is removed, the colour defaults to the theme background and the component is aria-hidden.
// Inspired by and adapted from https://devouringdetails.com/ (the original author's note is kept in the notices).
// License & usage (from the component's own header): free to use and modify in personal and commercial projects;
// attribution to Skiper UI is required when using the free version (see popup/THIRD_PARTY_NOTICES.txt and the
// notice in the extension page footer). Author: @gurvinder-singh02.

import React from "react";

type ProgressiveBlurProps = {
  className?: string;
  backgroundColor?: string;
  position?: "top" | "bottom";
  height?: string;
  blurAmount?: string;
};

const ProgressiveBlur = ({
  className = "",
  backgroundColor = "var(--background)",
  position = "top",
  height = "24px",
  blurAmount = "2px",
}: ProgressiveBlurProps) => {
  const isTop = position === "top";

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute left-0 w-full select-none ${className}`}
      style={{
        [isTop ? "top" : "bottom"]: 0,
        height,
        background: isTop
          ? `linear-gradient(to top, transparent, ${backgroundColor})`
          : `linear-gradient(to bottom, transparent, ${backgroundColor})`,
        maskImage: isTop
          ? `linear-gradient(to bottom, black 50%, transparent)`
          : `linear-gradient(to top, black 50%, transparent)`,
        WebkitBackdropFilter: `blur(${blurAmount})`,
        backdropFilter: `blur(${blurAmount})`,
        WebkitUserSelect: "none",
        userSelect: "none",
      }}
    />
  );
};

export { ProgressiveBlur };
