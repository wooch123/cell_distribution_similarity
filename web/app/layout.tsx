import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://dove9999.com"),
  title: {
    default: "유사 산포 검색",
    template: "%s | 유사 산포 검색",
  },
  description:
    "로그 스케일 V-NAND VTH 그래프를 형상 중심으로 분석하고 유사한 분포 5~10개를 추천합니다.",
  openGraph: {
    type: "website",
    locale: "ko_KR",
    siteName: "유사 산포 검색",
    title: "유사 산포 검색",
    description:
      "축과 스타일을 제거하고 로그 VTH 분포의 peak, valley, tail 형상으로 검색합니다.",
    images: [
      {
        url: "/og.png",
        width: 1733,
        height: 908,
        alt: "유사 산포 검색",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "유사 산포 검색",
    description: "Log-scale VTH distribution similarity search.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
