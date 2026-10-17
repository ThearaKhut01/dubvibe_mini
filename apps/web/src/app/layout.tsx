import type { Metadata } from "next";
import { IMPORT_MAP } from "@/plugin/platform";
import { MagicMouse } from "@/components/magic-mouse";
import "./globals.css";

export const metadata: Metadata = {
  title: "dubvibe_mini",
  description: "dubvibe_mini — AI video translation and dubbing studio",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="dark h-full antialiased"
      suppressHydrationWarning
    >
      <head>
        <script type="importmap" dangerouslySetInnerHTML={{ __html: JSON.stringify(IMPORT_MAP) }} />
      </head>
      <body className="min-h-full">
        {children}
        <MagicMouse />
      </body>
    </html>
  );
}
