import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "WhatsApp History API",
  description: "Protected, read-only WhatsApp history backend.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
