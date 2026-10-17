"use client";

import Script from "next/script";

declare global {
  interface Window {
    magicMouse?: (options: Record<string, unknown>) => void;
  }
}

// MagicMouse.js (MIT, https://github.com/dshongphuc/magic-mouse-js), vendored under public/vendor/magicmouse.
export function MagicMouse() {
  return (
    <Script
      src="/vendor/magicmouse/magicmouse.min.js"
      strategy="afterInteractive"
      onLoad={() => window.magicMouse?.({ outerStyle: "circle", hoverEffect: "circle-move", hoverItemMove: false, defaultCursor: false, outerWidth: 30, outerHeight: 30 })}
    />
  );
}
