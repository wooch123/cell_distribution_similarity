import type { Metadata } from "next";
import { VthSearchApp } from "./VthSearchApp";

export const metadata: Metadata = {
  title: {
    absolute: "유사 산포 검색",
  },
  description:
    "로그 스케일 V-NAND VTH 그래프를 업로드하고 형상이 유사한 분포와 이유를 확인하세요.",
};

export default function Home() {
  return <VthSearchApp />;
}
