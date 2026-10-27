import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { zhCNWebui } from "@/lib/i18n/locales/zh-CN/webui";
import { I18nProvider } from "@/lib/i18n/provider";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: zhCNWebui.metadata.title,
  description: zhCNWebui.metadata.description,
  icons: {
    icon: [
      {
        url: "/logo-light.png",
        media: "(prefers-color-scheme: light)",
        type: "image/png",
      },
      {
        url: "/logo-dark.png",
        media: "(prefers-color-scheme: dark)",
        type: "image/png",
      },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
    >
      <body className="antialiased bg-background font-sans selection:bg-primary/20">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <I18nProvider>
            <ToastProvider>{children}</ToastProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
